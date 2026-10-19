// Operational CLI: migrate | retention <tenant>. Demo seeding lives in scripts/seed.ts
// so application code contains no tenant-specific names or branches.

import { migrate } from './platform/migrate.js';
import { closePool } from './platform/db.js';
import { runRetention } from './control/retention.js';


if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'migrate') console.log(JSON.stringify({ applied: await migrate() }));
    else if (cmd === 'retention') console.log(JSON.stringify(await runRetention({ actor: 'system:retention-cli', role: 'system', correlationId: 'cli' } as never, process.argv[3])));
    else { console.error('usage: cli.ts migrate | retention <tenant>'); process.exitCode = 2; }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
