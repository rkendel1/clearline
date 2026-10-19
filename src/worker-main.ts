// Worker process entrypoint. Scale by running more of these; claiming uses
// SELECT ... FOR UPDATE SKIP LOCKED so workers never process the same batch.

import { loadConfig } from './platform/config.js';
import { closePool } from './platform/db.js';
import { log } from './platform/logger.js';
import { Worker } from './ingestion/worker.js';

const cfg = loadConfig();
const worker = new Worker().start();
log.info('worker process started', { worker_id: worker.id, env: cfg.env });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info('worker shutdown requested', { signal, grace_ms: cfg.shutdownGraceMs });
  await worker.stop();
  await closePool();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
