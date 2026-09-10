// Credential pool: load multiple credentials, round-robin, auto-disable on
// exhausted quota (400 insufficient credits), retry on 429, rotate to next.
import { readFileSync } from 'node:fs';
import config from '../config.js';
import log from '../logger.js';

// Insufficient-credits detection: matches the captured 400 body while being
// tolerant of casing and whitespace differences.
const INSUFFICIENT_CREDITS_RE = /insufficient\s*credits/i;

function labelOf(cred) {
  return cred.name || cred.token.slice(-6);
}

export class CredentialPool {
  constructor() {
    this.creds = [];
    this.cursor = 0;
  }

  load(file = config.CREDENTIALS_FILE) {
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

    const arr2 = arr
      .filter(x => x && typeof x === 'object' && typeof x.token === 'string')
      .filter(x => x.token.startsWith('user_'));

    this.creds = arr2.map(x => ({
      token: x.token,
      name: x.name || '',
      enabled: x.enabled === undefined ? true : Boolean(x.enabled),
      disabled: false,
      failures: 0,
    }));

    const skipped = arr.length - arr2.length;
    if (skipped > 0) log.warn(`[credpool] skipped ${skipped} invalid/non-user_ credential entries`);

    const manualDisabled = this.creds.filter(c => !c.enabled);
    if (manualDisabled.length > 0) {
      log.info(`[credpool] ${manualDisabled.length} credential(s) disabled by config: ${manualDisabled.map(c => labelOf(c)).join(', ')}`);
    }
    if (this.creds.length === 0) throw new Error('no valid user_ credentials loaded');
    log.info(`[credpool] loaded ${this.creds.length} credential(s): ${this.creds.map(c => labelOf(c)).join(', ')}`);
  }

  activeCount() {
    return this.creds.filter(c => !c.disabled && c.enabled).length;
  }

  // Get next active credential (round-robin). Returns null only when all
  // credentials are disabled; the activeCount() guard below ensures the
  // loop always finds a match, so the trailing return is unreachable.
  next() {
    if (this.activeCount() === 0) return null;
    const n = this.creds.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.cursor + i) % n;
      const c = this.creds[idx];
      if (!c.disabled && c.enabled) {
        this.cursor = (idx + 1) % n;
        return c;
      }
    }
  }

  // Find a credential by token to disable it.
  find(token) {
    return this.creds.find(c => c.token === token);
  }

  markExhausted(token) {
    const c = this.find(token);
    if (!c) return;
    c.disabled = true;
    log.warn(`[credpool] disabled ${labelOf(c)} reason=insufficient_credits`);
  }

  status() {
    return this.creds.map(c => ({
      name: c.name || c.token.slice(-6),
      enabled: c.enabled,
      disabled: c.disabled,
      failures: c.failures,
    }));
  }

  // Run fn(token) with rotation + retry policy.
  // fn(token) must return the fetch Response (or throw). Resolves with Response.
  async requestWithRotation(fn) {
    const total = this.creds.length;
    let attempts = 0;

    // We allow trying each active credential once; 429 retries happen on the
    // same credential before rotating.
    while (attempts < total) {
      const cred = this.next();
      if (!cred) {
        const err = new Error('all credentials exhausted or disabled');
        err.statusCode = 503;
        throw err;
      }
      attempts++;

      let res;
      try {
        res = await fn(cred.token);
      } catch (e) {
        log.warn(`[credpool] ${labelOf(cred)} request error: ${e?.message || e}`);
        cred.failures++;
        continue; // rotate to next
      }

      // 400 + insufficient credits -> disable + rotate
      if (res.status === 400) {
        const text = await res.text().catch(() => '');
        if (INSUFFICIENT_CREDITS_RE.test(text)) {
          this.markExhausted(cred.token);
          log.warn(`[credpool] ${labelOf(cred)} insufficient credits, rotating`);
          continue; // try next credential
        }
        // other 400: surface as-is
        const err = new Error(`upstream 400: ${text || res.statusText}`);
        err.statusCode = 400;
        err.upstreamBody = text;
        throw err;
      }

      // 429 -> exponential backoff retry on same credential, then rotate
      if (res.status === 429) {
        let retryRes = res;
        let attempt = 0;
        let gaveUp = false;
        while (attempt < config.RETRY_429_MAX) {
          const delay = config.RETRY_429_BASE_MS * Math.pow(2, attempt);
          log.warn(`[credpool] ${labelOf(cred)} 429, retry ${attempt + 1}/${config.RETRY_429_MAX} after ${delay}ms`);
          await sleep(delay);
          try {
            retryRes = await fn(cred.token);
          } catch (e) {
            log.warn(`[credpool] ${labelOf(cred)} retry error: ${e?.message || e}`);
            attempt++;
            continue;
          }
          if (retryRes.status !== 429) break;
          attempt++;
        }
        if (retryRes.status === 429) {
          log.warn(`[credpool] ${labelOf(cred)} 429 persisted after retries, rotating`);
          cred.failures++;
          continue; // rotate to next credential
        }
        return retryRes;
      }

      // other 4xx/5xx: surface as upstream error
      if (res.status >= 400) {
        const text = await res.text().catch(() => '');
        const err = new Error(`upstream ${res.status}: ${text || res.statusText}`);
        err.statusCode = res.status;
        err.upstreamBody = text;
        throw err;
      }

      return res;
    }

    const err = new Error('all credentials exhausted or disabled');
    err.statusCode = 503;
    throw err;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export default { CredentialPool };
