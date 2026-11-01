// Credential pool: load multiple credentials, round-robin, auto-disable on
// exhausted quota windows, retry transient 429s, rotate to the next credential.
//
// Two failure modes are treated differently:
//
//   * quota exhausted (upstream 429 with rateLimit.window = weekly | fiveHour,
//     or /alpha/billing/credits reporting windowLimits.exceeded)
//       -> the credential is disabled *until the window reset timestamp* and the
//          state is persisted back into credentials.json (enabled:false +
//          exhaustedUntil / exhaustedWindow / exhaustedAt). No backoff retries:
//          retrying a window that resets hours later only wastes wall clock.
//       -> when the reset timestamp passes the credential is re-enabled
//          automatically (in-process and across restarts).
//
//   * transient 429 (no window / remaining > 0)
//       -> exponential backoff on the same credential, then rotate.
//
// A 400 whose body mentions insufficient credits still permanently disables the
// credential for the lifetime of the process (no reset timestamp is known).
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import config from '../config.js';
import log from '../logger.js';

// Insufficient-credits detection: matches the captured 400 body while being
// tolerant of casing and whitespace differences.
const INSUFFICIENT_CREDITS_RE = /insufficient\s*credits/i;

// Upstream window ids -> human labels for logs/status.
const WINDOW_LABELS = {
  weekly: 'weekly',
  fiveHour: '5-hour',
  five_hour: '5-hour',
  '5h': '5-hour',
  monthly: 'monthly',
};

// Cooldown length used only when the upstream gives no reset timestamp at all.
const WINDOW_FALLBACK_MS = {
  weekly: 7 * 24 * 3600 * 1000,
  fiveHour: 5 * 3600 * 1000,
  monthly: 30 * 24 * 3600 * 1000,
};

// Never cool down for less than this (guards against a reset timestamp that is
// already in the past, e.g. clock skew or a stale upstream value).
const MIN_COOLDOWN_MS = 60 * 1000;

export function labelOf(cred) {
  return cred?.name || (cred?.token || '').slice(-6);
}

export function windowLabel(w) {
  return WINDOW_LABELS[w] || w || 'quota';
}

export function fmtReset(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? new Date(n).toISOString() : String(ms);
}

export function fmtDuration(ms) {
  const min = Math.max(0, Math.round(Number(ms) / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h${min % 60 ? `${min % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ''}`;
}

function fmtAmount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? (Math.round(n * 100) / 100).toString() : null;
}

// Epoch seconds (upstream `rateLimit.reset`) or ms -> ms.
function toMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function normalizeQuota(quota, now) {
  if (!quota) return null;
  const window = quota.window || null;
  let resetAt = toMs(quota.resetAt);
  if (!resetAt) resetAt = now + (WINDOW_FALLBACK_MS[window] || 3600 * 1000);
  return {
    window,
    resetAt: Math.max(resetAt, now + MIN_COOLDOWN_MS),
    limit: quota.limit ?? null,
    used: quota.used ?? null,
    remaining: quota.remaining ?? null,
    message: quota.message || null,
    source: quota.source || 'unknown',
  };
}

// Parse a 429 body for window-quota exhaustion. Returns a quota descriptor or
// null when this is a *transient* rate limit (retry/rotate as before).
//
// Captured shape (weekly example):
//   { success:false, error:{ code:"RATE_LIMITED", status:429,
//       message:"You've reached your weekly usage limit ... resets at <ISO>",
//       rateLimit:{ limit:35, remaining:0, reset:1793541523, window:"weekly" } } }
export function parseQuotaFrom429(text, now = Date.now()) {
  let body = null;
  try { body = JSON.parse(text); } catch { return null; }
  const err = body?.error || body || {};
  const rl = err?.rateLimit || body?.rateLimit || null;
  const message = String(err?.message || '');

  const window = rl?.window
    || (/five[- ]?hour|5[- ]?hour/i.test(message) ? 'fiveHour'
      : /weekly/i.test(message) ? 'weekly'
        : /monthly/i.test(message) ? 'monthly' : null);
  if (!window) return null;

  // Only treat it as window exhaustion with positive evidence: the upstream
  // reports remaining <= 0, or the message says the limit is reached.
  const zeroLeft = rl != null && Number.isFinite(Number(rl.remaining)) && Number(rl.remaining) <= 0;
  const mentionsLimit = /usage limit|limit reached|quota|exceeded|resets? (at|in)/i.test(message);
  if (!zeroLeft && !mentionsLimit) return null;

  let resetAt = toMs(rl?.reset);
  if (!resetAt) {
    const iso = message.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
    if (iso) resetAt = Date.parse(iso[0]);
  }
  return normalizeQuota({
    window,
    resetAt,
    limit: rl?.limit ?? null,
    used: rl?.used ?? null,
    remaining: rl?.remaining ?? null,
    message: message || null,
    source: 'generate-429',
  }, now);
}

// Parse /alpha/billing/credits for an already-exceeded window. Used by the
// fingerprint warmup so a credential that is out of quota is skipped *before*
// a (necessarily failing) /alpha/generate is sent.
//
// Captured shape:
//   { credits:{ monthlyCredits: 17.0 }, windowLimits:{ limited:true,
//       exceeded:"weekly",
//       fiveHour:{ used:0.63, cap:14, exceeded:false, resetAt:1793512968084 },
//       weekly:{ used:35.004, cap:35, exceeded:true, resetAt:1793541523009 } } }
export function parseQuotaFromBilling(json, now = Date.now()) {
  const wl = json?.windowLimits;
  if (!wl || !wl.exceeded) return null;
  const window = wl.exceeded;

  const win = wl[window]
    || wl[window === 'fiveHour' ? 'five_hour' : window]
    || Object.values(wl).find(v => v && typeof v === 'object' && v.exceeded);
  if (!win || win.exceeded === false) return null;

  const resetAt = toMs(win.resetAt);
  // A window whose reset time already passed is not a blocker.
  if (resetAt && resetAt <= now) return null;

  return normalizeQuota({
    window,
    resetAt,
    limit: win.cap ?? null,
    used: win.used ?? null,
    source: 'billing',
  }, now);
}

export class CredentialPool {
  constructor() {
    this.creds = [];
    this.entries = []; // original parsed objects, written back on persistence
    this.cursor = 0;
    this.file = config.CREDENTIALS_FILE;
  }

  load(file = config.CREDENTIALS_FILE) {
    this.file = file;
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      throw new Error(`failed to read credentials file ${file}: ${e.message}`);
    }
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch (e) {
      throw new Error(`credentials file ${file} is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(arr)) throw new Error('credentials file must be a JSON array');

    this.entries = arr;
    const valid = arr
      .filter(x => x && typeof x === 'object' && typeof x.token === 'string')
      .filter(x => x.token.startsWith('user_'));

    this.creds = valid.map(x => ({
      token: x.token,
      name: x.name || '',
      // `enabled` is the manual switch; quota cooldown flips it to false too,
      // but always together with an `exhaustedUntil` record (see below).
      enabled: x.enabled === undefined ? true : Boolean(x.enabled),
      disabled: false,  // runtime-only disable (insufficient credits / all retries failed)
      failures: 0,
      quota: null,      // { window, resetAt, limit, used, markedAt, source }
      entry: x,         // the object we write back to disk
    }));

    const skipped = arr.length - valid.length;
    if (skipped > 0) log.warn(`[credpool] skipped ${skipped} invalid/non-user_ credential entries`);

    const quarantined = this.#applyPersistedQuota();
    const manualDisabled = this.creds.filter(c => !c.enabled && !c.quota);
    if (manualDisabled.length > 0) {
      log.info(`[credpool] ${manualDisabled.length} credential(s) disabled by config: ${manualDisabled.map(c => labelOf(c)).join(', ')}`);
    }
    if (quarantined > 0) this.#persist();

    if (this.creds.length === 0) throw new Error('no valid user_ credentials loaded');
    log.info(`[credpool] loaded ${this.creds.length} credential(s): ${this.creds.map(c => labelOf(c)).join(', ')}`);
  }

  // Restore quota cooldowns persisted in credentials.json.
  //   exhaustedUntil in the future + enabled:false -> still cooling down
  //   exhaustedUntil in the past                   -> re-enable now
  //   exhaustedUntil in the future + enabled:true  -> manual override, drop it
  // Returns the number of entries that need a write-back.
  #applyPersistedQuota(now = Date.now()) {
    let dirty = 0;
    for (const c of this.creds) {
      const until = toMs(c.entry.exhaustedUntil);
      const hasRecord = c.entry.exhaustedUntil != null;
      if (!hasRecord) continue;

      if (!until) {
        this.#clearPersistedQuota(c);
        dirty++;
        continue;
      }
      if (until <= now) {
        const win = c.entry.exhaustedWindow;
        this.#restoreQuota(c);
        log.info(`[credpool] ${labelOf(c)} ${windowLabel(win)} quota cooldown already over — re-enabled`);
        dirty++;
        continue;
      }
      if (c.enabled) {
        // We always write enabled:false together with the cooldown record, so
        // enabled:true here means the operator edited the file: their intent
        // wins and the stale cooldown is dropped.
        log.info(`[credpool] ${labelOf(c)} quota cooldown until ${fmtReset(until)} ignored (enabled=true set manually)`);
        this.#clearPersistedQuota(c);
        dirty++;
        continue;
      }
      c.quota = {
        window: c.entry.exhaustedWindow || null,
        resetAt: until,
        limit: null,
        used: null,
        markedAt: toMs(c.entry.exhaustedAt),
        source: 'persisted',
      };
      log.warn(`[credpool] ${labelOf(c)} cooling down (${windowLabel(c.quota.window)} quota exhausted) until ${fmtReset(until)} (${fmtDuration(until - now)} left)`);
    }
    return dirty;
  }

  // Lift an expired cooldown: runtime state + credentials.json entry.
  #restoreQuota(c) {
    c.quota = null;
    c.enabled = true;
    this.#clearPersistedQuota(c);
  }

  #clearPersistedQuota(c) {
    c.quota = null;
    c.entry.enabled = true;
    delete c.entry.exhaustedUntil;
    delete c.entry.exhaustedWindow;
    delete c.entry.exhaustedAt;
  }

  // Re-enable credentials whose quota window has reset. Lazy: called from
  // next()/activeCount()/status(), so it costs nothing when idle.
  #expireQuota(now = Date.now()) {
    let dirty = false;
    for (const c of this.creds) {
      if (c.quota && c.quota.resetAt <= now) {
        log.info(`[credpool] ${labelOf(c)} ${windowLabel(c.quota.window)} quota window reset — re-enabled`);
        this.#restoreQuota(c);
        dirty = true;
      }
    }
    if (dirty) this.#persist();
  }

  // Atomically write the pool state back into credentials.json. Only the
  // fields this pool owns are touched (enabled / exhaustedUntil /
  // exhaustedWindow / exhaustedAt); everything else in the file is preserved.
  #persist() {
    try {
      const body = JSON.stringify(this.entries, null, 2) + '\n';
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, this.file); // atomic on the same filesystem
    } catch (e) {
      log.warn(`[credpool] failed to persist quota state to ${this.file}: ${e?.message || e}`);
    }
  }

  isAvailable(c) {
    return Boolean(c && c.enabled && !c.disabled && !c.quota);
  }

  availableCreds() {
    this.#expireQuota();
    return this.creds.filter(c => this.isAvailable(c));
  }

  activeCount() {
    return this.availableCreds().length;
  }

  // Get next active credential (round-robin). Returns null when none is
  // available (manually disabled, runtime-disabled, or cooling down).
  next() {
    this.#expireQuota();
    const hit = this.#peekFrom(this.cursor);
    if (!hit) return null;
    this.cursor = (hit.idx + 1) % this.creds.length;
    return hit.cred;
  }

  // First available credential at or after `start`, without moving the cursor.
  #peekFrom(start) {
    const n = this.creds.length;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      if (this.isAvailable(this.creds[idx])) return { cred: this.creds[idx], idx };
    }
    return null;
  }

  // Find a credential by token to disable it.
  find(token) {
    return this.creds.find(c => c.token === token);
  }

  // Permanent for this process: upstream says the account has no credits at all.
  markExhausted(token) {
    const c = this.find(token);
    if (!c) return;
    c.disabled = true;
    log.warn(`[credpool] disabled ${labelOf(c)} reason=insufficient_credits (no reset time — re-enable requires a restart)`);
  }

  // Disable a credential until its quota window resets, and persist that.
  markQuotaExhausted(token, quota) {
    const c = this.find(token);
    if (!c) return;
    const now = Date.now();
    const q = normalizeQuota(quota, now);
    if (!q) return;

    // Already cooling down for the same-or-later reset: don't rewrite/shrink it.
    if (c.quota && c.quota.resetAt >= q.resetAt) {
      c.enabled = false;
      return;
    }

    c.enabled = false;
    c.quota = { ...q, markedAt: now };
    c.entry.enabled = false;
    c.entry.exhaustedUntil = q.resetAt;
    c.entry.exhaustedWindow = q.window;
    c.entry.exhaustedAt = now;

    const usage = q.used != null && q.limit != null
      ? ` (${fmtAmount(q.used)}/${fmtAmount(q.limit)})`
      : q.limit != null && q.remaining != null
        ? ` (limit ${fmtAmount(q.limit)}, remaining ${fmtAmount(q.remaining)})`
        : q.limit != null ? ` (limit ${fmtAmount(q.limit)})` : '';
    log.warn(`[credpool] ${labelOf(c)} ${windowLabel(q.window)} quota exhausted${usage} — disabled until ${fmtReset(q.resetAt)} (${fmtDuration(q.resetAt - now)} left), persisted to ${this.file}`);
    if (q.message) log.warn(`[credpool] ${labelOf(c)} upstream: ${String(q.message).slice(0, 240)}`);
    this.#persist();
  }

  status() {
    this.#expireQuota();
    const now = Date.now();
    return this.creds.map(c => ({
      name: labelOf(c),
      enabled: c.enabled,
      disabled: c.disabled,
      available: this.isAvailable(c),
      failures: c.failures,
      exhausted: c.quota
        ? {
          window: c.quota.window,
          resetAt: c.quota.resetAt,
          resetAtISO: fmtReset(c.quota.resetAt),
          remainingMs: Math.max(0, c.quota.resetAt - now),
          limit: c.quota.limit,
          used: c.quota.used,
          source: c.quota.source,
        }
        : null,
    }));
  }

  #allUnavailableError() {
    const now = Date.now();
    const cooling = this.creds
      .filter(c => c.quota)
      .map(c => `${labelOf(c)}=${windowLabel(c.quota.window)} until ${fmtReset(c.quota.resetAt)}`);
    const off = this.creds
      .filter(c => !c.quota && (c.disabled || !c.enabled))
      .map(c => `${labelOf(c)}=${c.disabled ? 'insufficient_credits' : 'disabled'}`);
    const detail = [...cooling, ...off].join('; ');
    const err = new Error(`all credentials unavailable${detail ? ` (${detail})` : ''}`);
    err.statusCode = 503;
    const nextReset = this.creds
      .filter(c => c.quota)
      .reduce((min, c) => (min == null ? c.quota.resetAt : Math.min(min, c.quota.resetAt)), null);
    if (nextReset) err.retryAfterMs = Math.max(0, nextReset - now);
    return err;
  }

  // Serve one credential, applying the retry/quota policy.
  // Returns { res } when the caller should hand the Response back, or
  // { rotate: true } / { error } when the pool should move on / surface an error.
  async #serveWith(cred, fn) {
    let res;
    try {
      res = await fn(cred.token);
    } catch (e) {
      // Quota detected out-of-band (fingerprint warmup billing probe): treat it
      // exactly like an upstream 429 window limit — disable until reset.
      if (e?.code === 'QUOTA_EXHAUSTED' && e.quota) {
        this.markQuotaExhausted(cred.token, e.quota);
        return { rotate: true };
      }
      log.warn(`[credpool] ${labelOf(cred)} request error: ${e?.message || e}`);
      cred.failures++;
      return { rotate: true };
    }

    let retries = 0;
    while (true) {
      // 400 + insufficient credits -> disable + rotate
      if (res.status === 400) {
        const text = await res.text().catch(() => '');
        if (INSUFFICIENT_CREDITS_RE.test(text)) {
          this.markExhausted(cred.token);
          return { rotate: true };
        }
        return { error: mkUpstreamError(400, text, res.statusText) };
      }

      // 429: window quota exhaustion -> disable until reset; otherwise back off.
      if (res.status === 429) {
        const text = await res.text().catch(() => '');
        const quota = parseQuotaFrom429(text);
        if (quota) {
          this.markQuotaExhausted(cred.token, quota);
          return { rotate: true };
        }
        if (retries >= config.RETRY_429_MAX) {
          log.warn(`[credpool] ${labelOf(cred)} 429 (transient) persisted after ${retries} retries, rotating`);
          cred.failures++;
          return { rotate: true };
        }
        const delay = config.RETRY_429_BASE_MS * Math.pow(2, retries);
        retries++;
        log.warn(`[credpool] ${labelOf(cred)} 429 (transient rate limit), retry ${retries}/${config.RETRY_429_MAX} after ${delay}ms`);
        await sleep(delay);
        try {
          res = await fn(cred.token);
        } catch (e) {
          if (e?.code === 'QUOTA_EXHAUSTED' && e.quota) {
            this.markQuotaExhausted(cred.token, e.quota);
            return { rotate: true };
          }
          log.warn(`[credpool] ${labelOf(cred)} retry error: ${e?.message || e}`);
          cred.failures++;
          return { rotate: true };
        }
        continue;
      }

      // other 4xx/5xx: surface as upstream error
      if (res.status >= 400) {
        const text = await res.text().catch(() => '');
        return { error: mkUpstreamError(res.status, text, res.statusText) };
      }

      return { res };
    }
  }

  // Run fn(token) with rotation + retry policy.
  // fn(token) must return the fetch Response (or throw).
  // Resolves with { res, cred, attempts } — `attempts` > 1 means the request was
  // served by a credential other than the first one tried (i.e. rotation
  // happened), which callers use to log the credential that actually served it.
  async requestWithRotation(fn) {
    const total = this.creds.length;
    let attempts = 0;
    let lastCred = null;

    while (attempts < total) {
      const cred = this.next();
      if (!cred) throw this.#allUnavailableError();
      attempts++;
      lastCred = cred;

      const outcome = await this.#serveWith(cred, fn);
      if (outcome.res) {
        if (attempts > 1) {
          log.info(`[credpool] request served by ${labelOf(cred)} (credential attempt ${attempts}/${total})`);
        }
        return { res: outcome.res, cred, attempts };
      }
      if (outcome.error) throw outcome.error;

      // Rotated away from this credential — say so explicitly (silent switches
      // made it impossible to tell which account served a request).
      if (attempts < total) {
        const nextCred = this.#peekFrom(this.cursor)?.cred || null;
        log.warn(`[credpool] switching away from ${labelOf(cred)}${nextCred ? ` → ${labelOf(nextCred)}` : ' (no credential left)'}`);
      }
    }

    if (lastCred) log.warn(`[credpool] all ${total} credential attempt(s) exhausted, giving up`);
    throw this.#allUnavailableError();
  }
}

function mkUpstreamError(status, text, statusText) {
  const err = new Error(`upstream ${status}: ${text || statusText}`);
  err.statusCode = status;
  err.upstreamBody = text;
  return err;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export default { CredentialPool };
