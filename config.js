// Central configuration. All values can be overridden by environment variables.
const env = process.env;

function num(key, def) {
  const v = env[key];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function str(key, def) {
  const v = env[key];
  return v === undefined || v === '' ? def : v;
}

// Model whitelist mapping: OpenAI-facing model name -> commandcode model id.
// Keys are matched case-insensitively. Unmatched model names pass through.
const MODEL_MAP_RAW = str('MODEL_MAP', '') // e.g. "glm-5.2=zai-org/GLM-5.2,gpt-5.2=zai-org/GLM-5.2"
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .reduce((acc, pair) => {
    const [k, v] = pair.split('=');
    if (k && v) acc[k.trim().toLowerCase()] = v.trim();
    return acc;
  }, {});

// Built-in default mappings (can be overridden by MODEL_MAP env entries).
const DEFAULT_MODEL_MAP = {
  'glm-5.2': 'zai-org/GLM-5.2',
  'gl-5.2': 'zai-org/GLM-5.2',
  'gpt-5.2': 'zai-org/GLM-5.2',
  'zai-org/glm-5.2': 'zai-org/GLM-5.2',
};
const MODEL_MAP = { ...DEFAULT_MODEL_MAP, ...MODEL_MAP_RAW };

// Stable install id per credential is generated in fingerprint.js (makeSession).
// A process-wide install id would correlate all accounts as one machine.

// Machine-profile pools used to build a per-credential hardware identity.
// Each credential session picks one profile at creation and keeps it for its
// lifetime, so N accounts look like N unrelated real machines instead of N
// clones of a single machine. Override via JSON env vars if needed.
const DEFAULT_MACHINE_POOL = [
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
];
const DEFAULT_OS_RELEASES = ['10.0.26200', '10.0.26100', '10.0.22631', '10.0.22621', '10.0.19045'];
const DEFAULT_NODE_VERSIONS = ['v20.18.2', 'v20.19.0', 'v22.14.0', 'v22.15.0', 'v24.3.0', 'v24.19.0'];

function jsonEnv(key, def) {
  const v = env[key];
  if (v === undefined || v === '') return def;
  try {
    const parsed = JSON.parse(v);
    return parsed ?? def;
  } catch {
    return def;
  }
}

// Fixed telemetry tokens (from packet capture). Not user-provided.
const TELEMETRY = {
  axiom: {
    url: 'https://api.axiom.co/v1/traces',
    token: 'xaat-818bfed7-bc54-45bc-8bfa-d1198174064a',
    dataset: 'command_code_cli_tracing',
  },
  claicode: {
    url: 'https://ingestion.claicode.com/v1/inference-events',
    token: 'ccotlp-cli-prod-v1-7fc68c07c6f4449f9a4f71d03645a57e',
  },
};

export const config = {
  PORT: num('PORT', 3000),
  HOST: str('HOST', '0.0.0.0'),
  AUTH_TOKEN: str('AUTH_TOKEN', ''),
  MAX_BODY_BYTES: num('MAX_BODY_BYTES', 10 * 1024 * 1024),

  COMMANDCODE_BASE: str('COMMANDCODE_BASE', 'https://api.commandcode.ai'),
  CLI_VERSION: str('CLI_VERSION', '1.50.1'),
  // Empty (default) = per-credential random "c-users-<name>-desktop". Set to pin
  // one slug for all credentials (accepting the cross-account correlation).
  PROJECT_SLUG: str('PROJECT_SLUG', ''),

  CREDENTIALS_FILE: str('CREDENTIALS_FILE', './credentials.json'),

  MODEL_MAP,
  // Reverse map for responses (commandcode id -> first matching openai name)
  MODEL_REVERSE: Object.entries(MODEL_MAP).reduce((acc, [k, v]) => {
    if (!(v in acc)) acc[v] = k;
    return acc;
  }, {}),

  RETRY_429_MAX: num('RETRY_429_MAX', 3),
  RETRY_429_BASE_MS: num('RETRY_429_BASE_MS', 1000),

  REASONING_EFFORT: str('REASONING_EFFORT', 'high'),
  MAX_TOKENS: num('MAX_TOKENS', 64000),

  // Per-credential hardware pools (JSON env overridable).
  HW_MACHINE_POOL: jsonEnv('HW_MACHINE_POOL', DEFAULT_MACHINE_POOL),
  HW_OS_RELEASES: jsonEnv('HW_OS_RELEASES', DEFAULT_OS_RELEASES),
  NODE_VERSION_POOL: jsonEnv('NODE_VERSION_POOL', DEFAULT_NODE_VERSIONS),

  TELEMETRY,

  // Static fingerprint fields shared by all credentials. Timezone deliberately
  // stays global: it should match the operator's real IP geolocation, not vary.
  FINGERPRINT: {
    platform: 'win32',
    arch: 'x64',
    timezone: 'Asia/Shanghai',
    runtime: 'cli',
    collectorVersion: 1,
    os: 'win32-x64',
  },
};

export default config;
