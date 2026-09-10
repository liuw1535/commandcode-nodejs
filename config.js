// Unified configuration loader.
//
// Precedence (highest wins): environment variable > config.json > built-in DEFAULTS.
//
// - DEFAULTS below is the fallback: the app still runs if config.json is absent
//   or omits a field. config.json is the maintainable, editable source of truth
//   for data values (telemetry tokens, CLI version, hardware pools, model map,
//   API endpoints, ...). Environment variables override either for ops/deploy.
// - Secrets (e.g. AUTH_TOKEN) are env-only and intentionally not in config.json.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const env = process.env;
const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = env.CONFIG_FILE ? resolve(env.CONFIG_FILE) : join(__dirname, 'config.json');

// --- built-in default fallback (mirrors config.json; used when a field is missing) ---
const DEFAULTS = {
  server: {
    port: 3000,
    host: '0.0.0.0',
    maxBodyBytes: 100 * 1024 * 1024,
  },
  commandcode: {
    base: 'https://api.commandcode.ai',
    cliVersion: '1.50.1',
    userAgent: 'cli',
    endpoints: {
      whoami: '/alpha/whoami',
      lifecycleEvents: '/alpha/lifecycle-events',
      fingerprintRecord: '/alpha/fingerprint/record',
      billingSubscriptions: '/alpha/billing/subscriptions',
      billingCredits: '/alpha/billing/credits',
      generate: '/alpha/generate',
      models: '/provider/v1/models',
    },
  },
  models: {
    // Used only as the fallback when a chat request omits `model`.
    // The real model list comes from the upstream /provider/v1/models endpoint
    // (see src/modelProvider.js); this default should be a valid upstream id.
    defaultModel: 'claude-sonnet-5',
    // How often to refresh the cached upstream model list (ms). 0 disables.
    refreshMs: 600000,
  },
  generation: { reasoningEffort: 'high', maxTokens: 64000 },
  retry: { '429': { max: 3, baseMs: 1000 } },
  credentialsFile: './credentials.json',
  stateDir: './.state',
  projectSlug: '',
  warmup: {
    // Credential fingerprint warmup policy.
    //   'startup'    : warm all enabled creds in background at boot (legacy).
    //   'lazy'       : warm on first rotation, await before first generate.
    //   'lazy-async' : warm on first rotation in background (non-blocking).
    //   'off'        : never warm up.
    mode: 'startup',
  },
  hardware: {
    machinePool: [
      { cpuModel: 'Intel(R) Core(TM) i3-1005G1 CPU @ 1.20GHz', cpuCount: 4, memGiB: [8, 12, 16, 20] },
      { cpuModel: 'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz', cpuCount: 8, memGiB: [8, 16, 20] },
      { cpuModel: 'Intel(R) Core(TM) i7-8550U CPU @ 1.80GHz', cpuCount: 8, memGiB: [8, 16, 20] },
      { cpuModel: 'AMD Ryzen 5 5500U with Radeon Graphics', cpuCount: 8, memGiB: [8, 16, 20] },
      { cpuModel: 'Intel(R) Core(TM) i5-9400 CPU @ 2.90GHz', cpuCount: 6, memGiB: [8, 16, 24] },
      { cpuModel: 'Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz', cpuCount: 12, memGiB: [16, 24, 32] },
      { cpuModel: 'Intel(R) Core(TM) i5-12400 CPU @ 2.50GHz', cpuCount: 12, memGiB: [16, 24, 32] },
      { cpuModel: 'AMD Ryzen 5 5600X 6-Core Processor', cpuCount: 12, memGiB: [16, 24, 32] },
      { cpuModel: 'Intel(R) Core(TM) i7-11700 CPU @ 2.50GHz', cpuCount: 16, memGiB: [16, 32, 64] },
      { cpuModel: 'AMD Ryzen 7 5800X 8-Core Processor', cpuCount: 16, memGiB: [16, 32, 64] },
    ],
    osReleases: ['10.0.26200', '10.0.26100', '10.0.22631', '10.0.22621', '10.0.19045'],
    nodeVersionPool: ['v20.18.2', 'v20.19.0', 'v22.14.0', 'v22.15.0', 'v24.3.0', 'v24.19.0'],
  },
  fingerprint: {
    platform: 'win32',
    arch: 'x64',
    timezone: 'Asia/Shanghai',
    runtime: 'cli',
    collectorVersion: 1,
    os: 'win32-x64',
  },
  telemetry: {
    otelUserAgent: 'OTel-OTLP-Exporter-JavaScript/0.221.0',
    serviceName: 'command-code-cli',
    processExecutableName: 'node.exe',
    axiom: {
      url: 'https://api.axiom.co/v1/traces',
      token: 'xaat-818bfed7-bc54-45bc-8bfa-d1198174064a',
      dataset: 'command_code_cli_tracing',
    },
    claicode: {
      url: 'https://ingestion.claicode.com/v1/inference-events',
      token: 'ccotlp-cli-prod-v1-7fc68c07c6f4449f9a4f71d03645a57e',
    },
  },
};

// --- helpers ---
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep merge `over` onto `base`. Plain objects merge recursively; arrays and
// primitives are replaced wholesale (no element-wise merge).
function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = isPlainObject(base[k]) && isPlainObject(over[k])
      ? deepMerge(base[k], over[k])
      : over[k];
  }
  return out;
}

function loadJsonFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {}; // missing file -> fall back to DEFAULTS
    throw new Error(`failed to read config file ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`config file ${file} is not valid JSON: ${e.message}`);
  }
}

function num(v, def) {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function str(v, def) {
  return v === undefined || v === '' ? def : v;
}
function jsonEnv(v, def) {
  if (v === undefined || v === '') return def;
  try {
    return JSON.parse(v) ?? def;
  } catch {
    return def;
  }
}

// --- load + merge ---
const fileCfg = loadJsonFile(CONFIG_FILE);
const cfg = deepMerge(DEFAULTS, fileCfg);

// --- environment overrides (env > config.json > defaults) ---
// Server
const PORT = num(env.PORT, cfg.server.port);
const HOST = str(env.HOST, cfg.server.host);
const MAX_BODY_BYTES = num(env.MAX_BODY_BYTES, cfg.server.maxBodyBytes);
// AUTH_TOKEN is a secret: env-only, never read from config.json.
const AUTH_TOKEN = str(env.AUTH_TOKEN, '');

// Command Code upstream
const COMMANDCODE_BASE = str(env.COMMANDCODE_BASE, cfg.commandcode.base);
const CLI_VERSION = str(env.CLI_VERSION, cfg.commandcode.cliVersion);
const COMMANDCODE_USER_AGENT = str(env.COMMANDCODE_USER_AGENT, cfg.commandcode.userAgent);
const COMMANDCODE_ENDPOINTS = cfg.commandcode.endpoints;

// Project slug + credentials file
const PROJECT_SLUG = str(env.PROJECT_SLUG, cfg.projectSlug);
const CREDENTIALS_FILE = str(env.CREDENTIALS_FILE, cfg.credentialsFile);
const STATE_DIR = str(env.STATE_DIR, cfg.stateDir);

// Credential warmup policy (see config.json warmup.mode).
const WARMUP_MODE = str(env.WARMUP_MODE, cfg.warmup.mode);

// Upstream model list refresh interval (the list itself is fetched from
// /provider/v1/models at startup and on this timer; see src/modelProvider.js).
const MODELS_REFRESH_MS = num(env.MODELS_REFRESH_MS, cfg.models.refreshMs);

// Generation defaults
const REASONING_EFFORT = str(env.REASONING_EFFORT, cfg.generation.reasoningEffort);
const MAX_TOKENS = num(env.MAX_TOKENS, cfg.generation.maxTokens);

// Retry policy
const RETRY_429_MAX = num(env.RETRY_429_MAX, cfg.retry['429'].max);
const RETRY_429_BASE_MS = num(env.RETRY_429_BASE_MS, cfg.retry['429'].baseMs);

// Hardware pools (JSON env overridable; replaces the whole pool)
const HW_MACHINE_POOL = jsonEnv(env.HW_MACHINE_POOL, cfg.hardware.machinePool);
const HW_OS_RELEASES = jsonEnv(env.HW_OS_RELEASES, cfg.hardware.osReleases);
const NODE_VERSION_POOL = jsonEnv(env.NODE_VERSION_POOL, cfg.hardware.nodeVersionPool);

// Telemetry + fingerprint: env not overridable as a whole (edit config.json).
// Individual telemetry tokens *can* be overridden by env for rotation, though.
const TELEMETRY = {
  ...cfg.telemetry,
  axiom: {
    ...cfg.telemetry.axiom,
    url: str(env.TELEMETRY_AXIOM_URL, cfg.telemetry.axiom.url),
    token: str(env.TELEMETRY_AXIOM_TOKEN, cfg.telemetry.axiom.token),
    dataset: str(env.TELEMETRY_AXIOM_DATASET, cfg.telemetry.axiom.dataset),
  },
  claicode: {
    ...cfg.telemetry.claicode,
    url: str(env.TELEMETRY_CLAICODE_URL, cfg.telemetry.claicode.url),
    token: str(env.TELEMETRY_CLAICODE_TOKEN, cfg.telemetry.claicode.token),
  },
};

const FINGERPRINT = cfg.fingerprint;

export const config = {
  // Server
  PORT,
  HOST,
  AUTH_TOKEN,
  MAX_BODY_BYTES,

  // Command Code upstream
  COMMANDCODE_BASE,
  COMMANDCODE_USER_AGENT,
  COMMANDCODE_ENDPOINTS,
  CLI_VERSION,
  PROJECT_SLUG,

  // Credentials
  CREDENTIALS_FILE,

  // Persisted state (per-credential fingerprint identity)
  STATE_DIR,

  // Warmup policy
  WARMUP_MODE,

  // Models
  MODELS: { defaultModel: cfg.models.defaultModel },
  MODELS_REFRESH_MS,

  // Generation defaults
  REASONING_EFFORT,
  MAX_TOKENS,

  // Retry
  RETRY_429_MAX,
  RETRY_429_BASE_MS,

  // Hardware pools
  HW_MACHINE_POOL,
  HW_OS_RELEASES,
  NODE_VERSION_POOL,

  // Fingerprint + telemetry
  FINGERPRINT,
  TELEMETRY,
};

export default config;
