// API process entrypoint. Optionally runs an in-process worker (RUN_WORKER_IN_API=true)
// for single-container deployments; production runs workers separately.

import { buildServer } from './api/server.js';
import { loadConfig } from './platform/config.js';
import { closePool } from './platform/db.js';
import { log } from './platform/logger.js';
import { migrate } from './platform/migrate.js';
import { Worker } from './ingestion/worker.js';

const cfg = loadConfig();
if (process.env.MIGRATE_ON_START === 'true') await migrate();
const app = await buildServer();
const worker = cfg.runWorkerInApi ? new Worker().start() : null;
await app.listen({ port: cfg.port, host: cfg.host });
log.info('api listening', { port: cfg.port, env: cfg.env, in_process_worker: !!worker });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutdown requested', { signal });
  const force = setTimeout(() => { log.error('forced exit after grace period'); process.exit(1); }, cfg.shutdownGraceMs + 5000);
  await app.close();           // stop accepting requests, finish in-flight ones
  await worker?.stop();        // finish or abort (and re-queue) the in-flight batch
  await closePool();
  clearTimeout(force);
  log.info('shutdown complete');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
