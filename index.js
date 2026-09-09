// Entry point: load config, credentials, warm up fingerprints, start server.
import config from './config.js';
import log from './logger.js';
import { CredentialPool } from './src/credPool.js';
import { warmup } from './src/fingerprint.js';
import { createServer } from './src/openaiServer.js';
import { init as initModels, getModelIds } from './src/modelProvider.js';

async function main() {
  if (!config.AUTH_TOKEN) {
    log.warn('[startup] AUTH_TOKEN not set — local authentication is DISABLED. Set AUTH_TOKEN to protect this endpoint.');
  }

  const credPool = new CredentialPool();
  try {
    credPool.load();
  } catch (e) {
    log.error(`[startup] ${e.message}`);
    process.exit(1);
  }

  // Warm up fingerprints in the background (best-effort) so the server
  // starts immediately and isn't blocked by network timeouts.
  const warmupCreds = credPool.creds.filter(c => c.enabled);
  log.info(`[startup] warming up ${warmupCreds.length} credential(s) in background...`);
  Promise.allSettled(warmupCreds.map(c => warmup(c.token, c.name)))
    .then(() => log.info('[startup] warmup complete'));

  // Fetch the upstream model list (best-effort; non-fatal on failure) and
  // start the periodic background refresher.
  await initModels();
  const modelIds = getModelIds();
  log.info(`[startup] models: ${modelIds.length ? modelIds.join(', ') : '(upstream fetch pending — passthrough active)'}`);

  const server = createServer(credPool);
  server.listen(config.PORT, config.HOST, () => {
    log.info(`[startup] listening on ${config.HOST}:${config.PORT}`);
  });

  const shutdown = (sig) => {
    log.info(`[shutdown] ${sig} received, closing server`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(e => {
  log.error(`[startup] fatal: ${e?.stack || e}`);
  process.exit(1);
});
