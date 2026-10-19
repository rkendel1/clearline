// Worker healthcheck for container orchestrators: healthy when a worker on this
// host has a recent heartbeat, or is mid-batch (long batches do not heartbeat;
// their lease protects them). Exit 0 = healthy, 1 = unhealthy.

import { hostname } from 'node:os';
import { closePool, withSystem } from './platform/db.js';

const maxAge = Number(process.env.WORKER_HEALTH_MAX_AGE_SECONDS ?? 30);
let ok = false;
try {
  ok = await withSystem(async (tx) => (await tx.query(
    `SELECT 1 FROM core.worker_heartbeats WHERE hostname = $1 AND state <> 'stopped'
       AND (state = 'processing' OR last_seen > now() - make_interval(secs => $2)) LIMIT 1`, [hostname(), maxAge])).rows.length > 0);
} catch { ok = false; }
await closePool().catch(() => {});
process.exit(ok ? 0 : 1);
