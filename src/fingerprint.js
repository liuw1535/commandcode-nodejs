// Fingerprint simulation module.
// Mimics the Command Code CLI startup sequence per credential:
//   whoami -> lifecycle-events -> fingerprint/record -> billing/subscriptions -> billing/credits
// Also builds the request headers used for /alpha/generate.
import crypto from 'node:crypto';
import config from '../config.js';
import log from '../logger.js';
import { emitStartupSpans, emitWarmupApiSpans } from './telemetry.js';

const { randomUUID } = crypto;

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Random Windows-style username, e.g. "kytqcm3" — feeds the per-credential
// project slug (x-project-slug / workingDir) so accounts don't share one path.
const SLUG_USER_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
function randomSlugUser(len = 4 + Math.floor(Math.random() * 5)) {
  let s = '';
  for (let i = 0; i < len; i++) s += SLUG_USER_CHARS[Math.floor(Math.random() * SLUG_USER_CHARS.length)];
  return s;
}

// Per-credential session state cache: token -> session object.
const sessions = new Map();

function makeSession() {
  const sessionId = 'sess_' + randomHex(8);
  // Per-credential install id: each account looks like a separate CLI install
  // on a separate machine. A shared install id would correlate all accounts.
  const installId = randomUUID();
  // Per-credential thread id: stays stable across a "conversation" the way the
  // real CLI keeps one threadId / x-session-id for the session. Rotating it per
  // request is a tell; pin it per credential instead.
  const threadId = randomUUID();

  // Per-credential hardware profile, drawn from the machine pool so that N
  // accounts don't all report the identical CPU/RAM (a statistical outlier).
  const machine = pick(config.HW_MACHINE_POOL);
  const components = {
    macHashes: [sha256hex(randomHex(16))],
    osUserHash: sha256hex(randomHex(16)),
    hostnameHash: sha256hex(randomHex(16)),
    gitEmailHash: sha256hex(randomHex(16)),
    platform: config.FINGERPRINT.platform,
    arch: config.FINGERPRINT.arch,
    osRelease: pick(config.HW_OS_RELEASES),
    cpuModel: machine.cpuModel,
    cpuCount: machine.cpuCount,
    memGiB: pick(machine.memGiB),
    isContainer: false,
    timezone: config.FINGERPRINT.timezone,
    runtime: config.FINGERPRINT.runtime,
    collectorVersion: config.FINGERPRINT.collectorVersion,
  };
  const thumbmark = sha256hex(components.macHashes[0] + components.osUserHash);

  // Telemetry identity: per-credential node version + fake Windows pid, so OTel
  // spans don't all carry the same pid/runtime across accounts.
  const nodeVersion = pick(config.NODE_VERSION_POOL);
  const pid = 3000 + Math.floor(Math.random() * 12000);

  // Per-credential project slug: a random "c-users-<name>-desktop" per account
  // (matching what the real CLI derives from the working dir). Config can pin one.
  const projectSlug = config.PROJECT_SLUG || `c-users-${randomSlugUser()}-desktop`;

  return {
    sessionId, installId, threadId, components, thumbmark,
    nodeVersion, pid, projectSlug,
    user: null, warmed: false, warming: null,
  };
}

function getSession(token) {
  let s = sessions.get(token);
  if (!s) {
    s = makeSession();
    sessions.set(token, s);
  }
  return s;
}

// Common headers for commandcode.ai API calls (non-generate).
function baseHeaders(token, extra = {}) {
  return {
    'host': 'api.commandcode.ai',
    'connection': 'keep-alive',
    'content-type': 'application/json, application/json',
    'x-cli-environment': 'production',
    'Authorization': `Bearer ${token}`,
    'User-Agent': config.COMMANDCODE_USER_AGENT,
    'x-command-code-version': config.CLI_VERSION,
    'accept': '*/*',
    'accept-language': '*',
    'sec-fetch-mode': 'cors',
    'accept-encoding': 'br, gzip, deflate',
    ...extra,
  };
}

// time(method, path): run fetch and record (method, path, status, startNs, endNs)
// for the warmup telemetry burst. Best-effort; never throws on telemetry.
async function timedFetch(path, token, init, rec, label) {
  const startNs = BigInt(Date.now()) * 1000000n;
  const res = await ccFetch(path, token, init);
  const endNs = BigInt(Date.now()) * 1000000n;
  rec.push({ method: init?.method || 'GET', url: path, status: res.status, startNs, endNs });
  return res;
}

async function ccFetch(path, token, init = {}) {
  const url = config.COMMANDCODE_BASE + path;
  const headers = baseHeaders(token, init.headers);
  return fetch(url, { ...init, headers });
}

// Run the full startup telemetry sequence for a credential. Best-effort.
// Also emits OTel startup + api spans (axiom + claicode), mirroring the CLI.
export async function warmup(token, name) {
  const s = getSession(token);
  const label = name || token.slice(-6);
  const apiCalls = [];
  try {
    // Emit the session:cli + command:interactive startup span first, like the CLI.
    emitStartupSpans({ session: s, projectSlug: s.projectSlug }).catch(() => {});

    // 1. whoami
    const who = await timedFetch(config.COMMANDCODE_ENDPOINTS.whoami, token, { method: 'GET' }, apiCalls);
    if (who.ok) {
      const j = await who.json().catch(() => null);
      if (j?.user) s.user = j.user;
      log.info(`[fingerprint] ${label} whoami ok user=${j?.user?.userName || j?.user?.id || 'unknown'}`);
    } else {
      log.warn(`[fingerprint] ${label} whoami status=${who.status}`);
    }

    // 2. lifecycle-events
    const lifeBody = {
      eventType: 'cli_session_exists',
      metadata: {
        sessionId: s.sessionId,
        cliVersion: config.CLI_VERSION,
        mode: 'interactive',
        os: config.FINGERPRINT.os,
      },
    };
    const life = await timedFetch(config.COMMANDCODE_ENDPOINTS.lifecycleEvents, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json, application/json' },
      body: JSON.stringify(lifeBody),
    }, apiCalls);
    log.info(`[fingerprint] ${label} lifecycle-events status=${life.status}`);

    // 3. fingerprint/record
    const fpBody = { thumbmark: s.thumbmark, components: s.components };
    const fp = await timedFetch(config.COMMANDCODE_ENDPOINTS.fingerprintRecord, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fpBody),
    }, apiCalls);
    log.info(`[fingerprint] ${label} fingerprint/record status=${fp.status}`);

    // 4. billing探测 (non-blocking)
    const subs = await timedFetch(config.COMMANDCODE_ENDPOINTS.billingSubscriptions, token, { method: 'GET' }, apiCalls).catch(e => {
      log.warn(`[fingerprint] ${label} subscriptions error: ${e?.message || e}`); return null;
    });
    const cred = await timedFetch(config.COMMANDCODE_ENDPOINTS.billingCredits, token, { method: 'GET' }, apiCalls).catch(e => {
      log.warn(`[fingerprint] ${label} credits error: ${e?.message || e}`); return null;
    });
    if (subs?.ok) {
      const j = await subs.json().catch(() => null);
      log.info(`[fingerprint] ${label} subscription plan=${j?.data?.planId || 'unknown'} status=${j?.data?.status || 'unknown'}`);
    }
    if (cred?.ok) {
      const j = await cred.json().catch(() => null);
      const c = j?.credits;
      if (c) log.info(`[fingerprint] ${label} credits monthly=${c.monthlyCredits} weeklyUsed=${j?.windowLimits?.weekly?.used}/${j?.windowLimits?.weekly?.cap}`);
    }

    s.warmed = true;
  } catch (e) {
    log.warn(`[fingerprint] ${label} warmup error: ${e?.message || e}`);
  }

  // Emit one api:METHOD:url span per commandcode call made above (axiom+claicode).
  emitWarmupApiSpans({ session: s, user: s.user, apiCalls }).catch(() => {});
  return s;
}

// Headers for /alpha/generate requests. x-session-id uses the threadId (UUID),
// matching the captured CLI (the header carries the thread/conversation id,
// NOT the sess_ session id). Returns traceId + chatSpanId so the OTel span
// emitted afterwards shares the same traceparent identity.
export function buildGenerateHeaders(token, sessionId, threadId) {
  const s = getSession(token);
  const traceId = randomHex(16);
  const spanId = randomHex(8);
  const traceparent = `00-${traceId}-${spanId}-01`;
  return {
    'host': 'api.commandcode.ai',
    'connection': 'keep-alive',
    'content-type': 'application/json, application/json',
    'User-Agent': config.COMMANDCODE_USER_AGENT,
    'x-command-code-version': config.CLI_VERSION,
    'x-cli-environment': 'production',
    'x-project-slug': s.projectSlug,
    'x-taste-learning': 'true',
    'x-session-id': threadId,
    'Authorization': `Bearer ${token}`,
    'traceparent': traceparent,
    'accept': '*/*',
    'accept-language': '*',
    'sec-fetch-mode': 'cors',
    'accept-encoding': 'br, gzip, deflate',
    _trace: { traceId, spanId },
  };
}

// Ensure a credential is warmed up according to the configured policy.
// Returns the session (so callers can reuse it for generate headers).
//   mode 'lazy'       : on first use, AWAIT warmup completion before returning
//                       (the first /alpha/generate on this token waits for the
//                        whoami/lifecycle/fingerprint/billing sequence).
//   mode 'lazy-async' : on first use, KICK OFF warmup in the background and
//                       return immediately — generate is sent right away while
//                       warmup races alongside. The session object (sessionId /
//                       installId / threadId / fingerprint) is built synchronously
//                       by getSession, so generate headers don't depend on
//                       warmup's network results.
//   mode 'startup'    : warmup already ran at boot; no-op here.
//   mode 'off'        : never warm; no-op.
// Idempotent: an in-flight warmup promise is stored on the session and reused,
// so concurrent first-uses of the same token don't trigger duplicate warmups.
// A failed warmup leaves s.warmed=false, so the next lazy use retries.
export async function ensureWarmed(token, name, mode) {
  const s = getSession(token);
  if (mode !== 'lazy' && mode !== 'lazy-async') return s; // startup / off: no-op
  if (s.warmed) return s;
  if (!s.warming) {
    const label = name || token.slice(-6);
    log.info(`[fingerprint] ${label} on-demand warmup triggered (mode=${mode})`);
    s.warming = warmup(token, name)
      .catch(() => {}) // warmup logs internally; swallow to always settle
      .finally(() => { s.warming = null; });
  }
  if (mode === 'lazy') await s.warming;
  return s;
}

export function getSessionForToken(token) {
  return getSession(token);
}

export default { warmup, ensureWarmed, buildGenerateHeaders, getSessionForToken };
