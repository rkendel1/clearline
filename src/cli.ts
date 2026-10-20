// Operational CLI: migrate | retention <tenant> | assistant-index [--rebuild] | platform-admin [name]. Demo seeding lives in scripts/seed.ts
// so application code contains no tenant-specific names or branches.

import { migrate } from './platform/migrate.js';
import { closePool } from './platform/db.js';
import { runRetention } from './control/retention.js';
import { indexCorpus } from './assistant/store.js';
import { getEmbedder } from './assistant/embed.js';
import { hashToken, newToken } from './control/auth.js';
import { withSystem } from './platform/db.js';


if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'migrate') console.log(JSON.stringify({ applied: await migrate() }));
    else if (cmd === 'retention') console.log(JSON.stringify(await runRetention({ actor: 'system:retention-cli', role: 'system', correlationId: 'cli' } as never, process.argv[3])));
    else if (cmd === 'assistant-index') console.log(JSON.stringify(await indexCorpus(getEmbedder(), { rebuild: process.argv.includes('--rebuild') })));
    else if (cmd === 'platform-admin') {
      // Production has no seed: this mints the first platform-admin token (bootstrap only: it creates tenants and issues each tenant's first tokens).
      const name = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'platform-admin';
      const token = newToken();
      await withSystem(async (tx) => {
        const exists = await tx.query(`SELECT 1 FROM core.api_tokens WHERE role = 'platform_admin' AND revoked_at IS NULL LIMIT 1`);
        if (exists.rowCount && !process.argv.includes('--force')) throw new Error('A platform-admin token already exists. Revoke it first, or pass --force to add another.');
        await tx.query(`INSERT INTO core.api_tokens (token_hash, name, tenant_id, role) VALUES ($1, $2, NULL, 'platform_admin')`, [hashToken(token), name]);
      });
      console.log(JSON.stringify({ name, role: 'platform_admin', token, note: 'Shown once. Store it in your secret manager; only its hash is kept.' }));
    }
    else { console.error('usage: cli.ts migrate | retention <tenant> | assistant-index [--rebuild] | platform-admin [name] [--force]'); process.exitCode = 2; }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
