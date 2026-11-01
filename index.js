// Entry point: load config, credentials, warm up fingerprints, start server.
import config from './config.js';
import log from './logger.js';
import { CredentialPool } from './src/credPool.js';
import { warmup, getSessionForToken } from './src/fingerprint.js';
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

  // Warm up fingerprints according to config.WARMUP_MODE:
  //   'startup'    -> fan out warmup for every enabled credential now (legacy).
  //   'lazy' / 'lazy-async' -> warm per credential on first rotation
  //                           (handled in openaiServer via ensureWarmed).
  //   'off'        -> no warmup at all.
  switch (config.WARMUP_MODE) {
    case 'lazy':
    case 'lazy-async':
      log.info(`[startup] warmup mode=${config.WARMUP_MODE} (on-demand at first rotation; ${config.WARMUP_MODE === 'lazy' ? 'blocking first request' : 'non-blocking'})`);
      break;
    case 'off':
      log.info('[startup] warmup mode=off (no fingerprint warmup)');
      break;
    case 'startup':
    default: {
      // Skip credentials already known to be out of quota (persisted cooldown):
      // re-warming them would only re-probe billing for an account we already
      // know is blocked until its window resets.
      const warmupCreds = credPool.availableCreds();
      const cooling = credPool.creds.length - warmupCreds.length;
      log.info(`[startup] warmup mode=startup, warming up ${warmupCreds.length} credential(s) in background${cooling > 0 ? ` (${cooling} cooling down, skipped)` : ''}...`);
      Promise.allSettled(warmupCreds.map(c => warmup(c.token, c.name)))
        .then(() => {
          // The warmup already fetched /alpha/billing/credits for each token;
          // apply any quota finding so the pool disables + persists it before
          // the first request arrives.
          for (const c of warmupCreds) {
            const quota = getSessionForToken(c.token, c.name)?.quota;
            if (quota) credPool.markQuotaExhausted(c.token, quota);
          }
          log.info('[startup] warmup complete');
        });
      break;
    }
  }

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
