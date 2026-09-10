// Per-credential fingerprint persistence.
//
// The hardware fingerprint (mac/osUser/hostname/gitEmail hashes -> thumbmark,
// installId, nodeVersion, projectSlug) describes a *machine* and must stay
// stable across process restarts — a real CLI install on the same box reports
// the same fingerprint every launch. Regenerating it per restart made every
// reboot look like a brand-new machine for the same token, a strong tell.
//
// This store keeps the machine-identity portion on disk, keyed by a hash of
// the credential token (never the token itself). Per-launch ephemera (sessionId,
// threadId, pid) are NOT persisted — they're regenerated each process, matching
// the real CLI (one session/conversation per launch).
//
//   load(token)   -> identity object | null   (sync; tiny file, called once per token)
//   save(token, i) -> void                    (sync; atomic write)
//
// Storage layout: <STATE_DIR>/sessions/<sha256(token)>.json
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import config from '../config.js';
import log from '../logger.js';

function tokenKey(token) {
  // sha256 so the token itself never lands on disk.
  return createHash('sha256').update(token).digest('hex');
}

function filePathFor(token) {
  return join(config.STATE_DIR, 'sessions', `${tokenKey(token)}.json`);
}

// Read the persisted machine identity for a credential, or null if absent.
export function load(token) {
  const file = filePathFor(token);
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    // Minimal sanity check: a valid identity has the fields makeSession produces.
    if (!obj || typeof obj !== 'object' || !obj.thumbmark || !obj.components) return null;
    return obj;
  } catch (e) {
    log.warn(`[sessionstore] failed to read ${file}: ${e?.message || e}`);
    return null;
  }
}

// Persist the machine identity for a credential (best-effort, atomic).
export function save(token, identity) {
  const file = filePathFor(token);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(identity, null, 2), 'utf8');
    renameSync(tmp, file); // atomic on same fs
  } catch (e) {
    log.warn(`[sessionstore] failed to write ${file}: ${e?.message || e}`);
  }
}

export default { load, save };
