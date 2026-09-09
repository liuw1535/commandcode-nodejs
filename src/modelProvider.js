// Upstream model list provider.
//
// Fetches `${COMMANDCODE_BASE}/provider/v1/models` (an OpenAI-format model
// array: `{object:"list", data:[{id, object, owned_by, ...}]}`), caches it,
// and refreshes on a timer. The `/v1/models` endpoint serves the cache
// verbatim; chat completions resolve the requested model name against the
// cache (case-insensitive) and pass unknown names through verbatim.
//
// First fetch is best-effort: if it fails, the cache simply stays empty
// (chat completions still work via passthrough) and the periodic refresher
// keeps trying in the background.
import config from '../config.js';
import log from '../logger.js';

let cache = [];        // upstream `data` array (OpenAI model objects, as-is)
let idIndex = new Map(); // lowercased id -> canonical upstream id
let timer = null;

function modelsUrl() {
  return config.COMMANDCODE_BASE + config.COMMANDCODE_ENDPOINTS.models;
}

async function fetchOnce() {
  const res = await fetch(modelsUrl(), {
    method: 'GET',
    headers: {
      'user-agent': config.COMMANDCODE_USER_AGENT,
      'accept': 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`upstream models HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
  cache = data.filter(m => m && m.id);
  idIndex = new Map();
  for (const m of cache) idIndex.set(String(m.id).toLowerCase(), m.id);
  log.info(`[models] fetched ${cache.length} model(s) from upstream`);
}

// Pull the upstream list once into the cache. Returns true on success.
export async function refresh() {
  try {
    await fetchOnce();
    return true;
  } catch (e) {
    log.warn(`[models] refresh failed: ${e?.message || e}`);
    return false;
  }
}

// First fetch (awaited) + start the periodic background refresher.
// Non-fatal: startup proceeds even if the first fetch fails.
export async function init() {
  await refresh();
  const ms = config.MODELS_REFRESH_MS;
  if (ms > 0 && !timer) {
    timer = setInterval(() => { refresh().catch(() => {}); }, ms);
    timer.unref?.();
  }
}

export function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

// The cached upstream `data` array (OpenAI model objects), as-is.
export function getModels() {
  return cache;
}

// Canonical upstream ids (original casing).
export function getModelIds() {
  return cache.map(m => m.id);
}

// Resolve an OpenAI-facing model name to the upstream model id.
// - empty -> configured default model
// - case-insensitive match against the upstream list -> canonical upstream id
// - no match -> passthrough verbatim (commandcode will reject if invalid)
export function resolveModel(openaiModel) {
  if (!openaiModel) return config.MODELS.defaultModel;
  const k = String(openaiModel).toLowerCase();
  if (idIndex.has(k)) return idIndex.get(k);
  return openaiModel;
}

export default { init, stop, refresh, getModels, getModelIds, resolveModel };
