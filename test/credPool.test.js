// Credential pool: quota-window detection, cooldown persistence, rotation.
//
// These tests are hermetic: no network. `fn` passed to requestWithRotation
// returns fake Response objects, and the credentials file lives in a temp dir.
// The retry knobs are narrowed via env before importing config/credPool so the
// transient-429 path doesn't sleep for seconds.
process.env.RETRY_429_BASE_MS = '1';
process.env.RETRY_429_MAX = '2';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { CredentialPool, parseQuotaFrom429, parseQuotaFromBilling } =
  await import('../src/credPool.js');

const TOKEN_A = 'user_aaa_test_token_aaaaaaaaaaaaaaaa';
const TOKEN_B = 'user_bbb_test_token_bbbbbbbbbbbbbbbb';

function tmpCredsFile(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'credpool-'));
  const file = join(dir, 'credentials.json');
  writeFileSync(file, JSON.stringify(entries, null, 2), 'utf8');
  return file;
}

function readCreds(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function mkRes(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: String(status),
    text: async () => body,
  };
}

function twoCreds() {
  return [
    { token: TOKEN_A, name: 'acct-a', enabled: true },
    { token: TOKEN_B, name: 'acct-b', enabled: true },
  ];
}

// Real upstream body captured from an exhausted weekly window.
function weekly429Body(resetSec) {
  return JSON.stringify({
    success: false,
    error: {
      code: 'RATE_LIMITED',
      status: 429,
      message: `You've reached your weekly usage limit for your plan. Your limit resets at ${new Date(resetSec * 1000).toISOString()}. Please wait for the window to reset or upgrade your plan to continue.`,
      docs: 'https://commandcode.ai/docs/reference/errors/rate_limited',
      rateLimit: { limit: 35, remaining: 0, reset: resetSec, window: 'weekly' },
    },
  });
}

test('parseQuotaFrom429 recognises an exhausted weekly window', () => {
  const now = 1793502543000;
  const resetSec = 1793541523;
  const q = parseQuotaFrom429(weekly429Body(resetSec), now);
  assert.ok(q);
  assert.equal(q.window, 'weekly');
  assert.equal(q.resetAt, resetSec * 1000);
  assert.equal(q.limit, 35);
  assert.equal(q.source, 'generate-429');
});

test('parseQuotaFrom429 recognises an exhausted five-hour window', () => {
  const now = 1700000000000;
  const resetSec = Math.floor((now + 3600_000) / 1000);
  const body = JSON.stringify({
    success: false,
    error: {
      code: 'RATE_LIMITED',
      status: 429,
      message: 'Five-hour usage limit reached. Your limit resets at 2023-11-14T22:20:00.000Z.',
      rateLimit: { limit: 3, remaining: 0, reset: resetSec, window: 'fiveHour' },
    },
  });
  const q = parseQuotaFrom429(body, now);
  assert.ok(q);
  assert.equal(q.window, 'fiveHour');
  assert.equal(q.resetAt, resetSec * 1000);
});

test('parseQuotaFrom429 ignores transient rate limits', () => {
  // No window information at all -> transient, must keep the retry path.
  assert.equal(parseQuotaFrom429(JSON.stringify({ error: { code: 'RATE_LIMITED', status: 429, message: 'Too many requests' } })), null);
  // Window info but quota left -> transient.
  assert.equal(parseQuotaFrom429(JSON.stringify({
    error: { code: 'RATE_LIMITED', status: 429, message: 'Slow down', rateLimit: { window: 'weekly', remaining: 12, reset: 1793541523 } },
  })), null);
  // Not JSON at all.
  assert.equal(parseQuotaFrom429('<html>429</html>'), null);
});

test('parseQuotaFromBilling recognises an exceeded window', () => {
  const now = 1793502543000;
  const resetAt = 1793541523009;
  const q = parseQuotaFromBilling({
    credits: { monthlyCredits: 17.0084431824 },
    windowLimits: {
      limited: true,
      exceeded: 'weekly',
      fiveHour: { used: 0.63, cap: 14, exceeded: false, resetAt: 1793512968084 },
      weekly: { used: 35.004, cap: 35, exceeded: true, resetAt },
    },
  }, now);
  assert.ok(q);
  assert.equal(q.window, 'weekly');
  assert.equal(q.resetAt, resetAt);
  assert.equal(q.limit, 35);
  assert.equal(q.source, 'billing');

  // `limited` is informational only: an exceeded window is enough.
  assert.ok(parseQuotaFromBilling({
    windowLimits: { exceeded: 'fiveHour', fiveHour: { used: 3, cap: 3, exceeded: true, resetAt: now + 3600_000 } },
  }, now));

  // Within limits -> null
  assert.equal(parseQuotaFromBilling({
    windowLimits: { limited: true, exceeded: null, weekly: { used: 1, cap: 6, exceeded: false, resetAt: now + 3600_000 } },
  }, now), null);

  // Already-reset window is not a blocker
  assert.equal(parseQuotaFromBilling({
    windowLimits: { limited: true, exceeded: 'weekly', weekly: { used: 35, cap: 35, exceeded: true, resetAt: now - 1000 } },
  }, now), null);
});

test('quota exhaustion disables, persists to credentials.json, and is honoured on reload', () => {
  const file = tmpCredsFile(twoCreds());
  const pool = new CredentialPool();
  pool.load(file);
  assert.equal(pool.activeCount(), 2);

  const resetAt = Date.now() + 3 * 3600_000;
  pool.markQuotaExhausted(TOKEN_A, { window: 'weekly', resetAt, limit: 35, used: 35.004 });

  // Runtime: acct-a is unavailable, acct-b serves.
  assert.equal(pool.activeCount(), 1);
  assert.equal(pool.next().name, 'acct-b');
  assert.equal(pool.status()[0].enabled, false);
  assert.equal(pool.status()[0].exhausted.window, 'weekly');
  assert.equal(pool.status()[0].exhausted.resetAt, resetAt);

  // Persisted: enabled:false + timestamp fields, other fields untouched.
  const saved = readCreds(file);
  assert.equal(saved[0].token, TOKEN_A);
  assert.equal(saved[0].name, 'acct-a');
  assert.equal(saved[0].enabled, false);
  assert.equal(saved[0].exhaustedUntil, resetAt);
  assert.equal(saved[0].exhaustedWindow, 'weekly');
  assert.ok(typeof saved[0].exhaustedAt === 'number');
  assert.equal(saved[1].enabled, true);

  // A restart must not retry a credential that is still cooling down.
  const reloaded = new CredentialPool();
  reloaded.load(file);
  assert.equal(reloaded.activeCount(), 1);
  assert.equal(reloaded.next().name, 'acct-b');
  assert.equal(reloaded.status()[0].exhausted.window, 'weekly');
});

test('an expired cooldown is lifted and cleaned out of credentials.json', () => {
  const entries = twoCreds();
  entries[0].enabled = false;
  entries[0].exhaustedUntil = Date.now() - 60_000;
  entries[0].exhaustedWindow = 'weekly';
  entries[0].exhaustedAt = Date.now() - 7200_000;
  const file = tmpCredsFile(entries);

  const pool = new CredentialPool();
  pool.load(file);

  assert.equal(pool.activeCount(), 2);
  assert.equal(pool.status()[0].enabled, true);
  assert.equal(pool.status()[0].exhausted, null);

  const saved = readCreds(file);
  assert.equal(saved[0].enabled, true);
  assert.equal(saved[0].exhaustedUntil, undefined);
  assert.equal(saved[0].exhaustedWindow, undefined);
  assert.equal(saved[0].exhaustedAt, undefined);
});

test('manual enabled:true overrides a stale future cooldown', () => {
  const entries = twoCreds();
  entries[0].exhaustedUntil = Date.now() + 3600_000;
  entries[0].exhaustedWindow = 'weekly';
  const file = tmpCredsFile(entries);

  const pool = new CredentialPool();
  pool.load(file);

  assert.equal(pool.activeCount(), 2);
  assert.equal(pool.status()[0].enabled, true);
  assert.equal(pool.status()[0].exhausted, null);
  assert.equal(readCreds(file)[0].exhaustedUntil, undefined);
});

test('requestWithRotation rotates immediately on a quota 429 (no backoff) and names the server', async () => {
  const file = tmpCredsFile(twoCreds());
  const pool = new CredentialPool();
  pool.load(file);

  const resetSec = Math.floor((Date.now() + 3600_000) / 1000);
  const calls = [];
  const { res, cred, attempts } = await pool.requestWithRotation(async (token) => {
    calls.push(token);
    if (token === TOKEN_A) return mkRes(429, weekly429Body(resetSec));
    return mkRes(200, '{"type":"start"}');
  });

  assert.equal(res.status, 200);
  assert.equal(cred.name, 'acct-b');
  assert.equal(attempts, 2);
  assert.deepEqual(calls, [TOKEN_A, TOKEN_B], 'exhausted credential must be tried exactly once');
  assert.equal(readCreds(file)[0].exhaustedUntil, resetSec * 1000);
});

test('requestWithRotation retries a transient 429 on the same credential', async () => {
  const file = tmpCredsFile(twoCreds());
  const pool = new CredentialPool();
  pool.load(file);

  const transient = JSON.stringify({ error: { code: 'RATE_LIMITED', status: 429, message: 'Too many requests' } });
  const calls = [];
  const { res, cred, attempts } = await pool.requestWithRotation(async (token) => {
    calls.push(token);
    if (calls.length === 1) return mkRes(429, transient);
    return mkRes(200, 'ok');
  });

  assert.equal(res.status, 200);
  assert.equal(cred.name, 'acct-a');
  assert.equal(attempts, 1, 'a retry within the same credential does not count as rotation');
  assert.deepEqual(calls, [TOKEN_A, TOKEN_A]);
});

test('requestWithRotation reports every credential unavailable', async () => {
  const entries = twoCreds();
  entries[0].enabled = false;
  entries[1].enabled = false;
  const file = tmpCredsFile(entries);
  const pool = new CredentialPool();
  pool.load(file);

  await assert.rejects(
    () => pool.requestWithRotation(async () => mkRes(200, 'ok')),
    (e) => e.statusCode === 503 && /all credentials unavailable/.test(e.message),
  );
});

test('QUOTA_EXHAUSTED from warmup disables the credential exactly like a 429 window', async () => {
  const file = tmpCredsFile(twoCreds());
  const pool = new CredentialPool();
  pool.load(file);

  const resetAt = Date.now() + 3600_000;
  const calls = [];
  const { res, cred, attempts } = await pool.requestWithRotation(async (token) => {
    calls.push(token);
    if (token === TOKEN_A) {
      const e = new Error('quota exhausted (weekly limit) detected during warmup');
      e.code = 'QUOTA_EXHAUSTED';
      e.quota = { window: 'weekly', resetAt, limit: 35, used: 35.004, source: 'billing' };
      throw e;
    }
    return mkRes(200, 'ok');
  });

  assert.equal(res.status, 200);
  assert.equal(cred.name, 'acct-b');
  assert.equal(attempts, 2);
  const saved = readCreds(file);
  assert.equal(saved[0].enabled, false);
  assert.equal(saved[0].exhaustedUntil, resetAt);
  assert.equal(saved[0].exhaustedWindow, 'weekly');
});
