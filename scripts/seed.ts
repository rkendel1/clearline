// Demo seeding: two synthetic tenants, well-known DEV tokens and their v1
// contracts, created through the same service functions the API uses.
// Refuses to run in production. This is configuration, not application code.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, withSystem } from '../src/platform/db.js';
import { loadConfig } from '../src/platform/config.js';
import { migrate } from '../src/platform/migrate.js';
import { hashToken, type Principal } from '../src/control/auth.js';
import { createTenant, issueToken } from '../src/control/tenants.js';
import { publishContract } from '../src/contracts/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/[\\/]dist$/, '');

export const DEV_TOKENS = {
  platform: 'cl_dev_platform_admin',
  northwind: { admin: 'cl_dev_northwind_admin', approver: 'cl_dev_northwind_approver', steward: 'cl_dev_northwind_steward', operator: 'cl_dev_northwind_operator', reporter: 'cl_dev_northwind_reporter' },
  bluefin: { admin: 'cl_dev_bluefin_admin', approver: 'cl_dev_bluefin_approver', steward: 'cl_dev_bluefin_steward', operator: 'cl_dev_bluefin_operator', reporter: 'cl_dev_bluefin_reporter' },
} as const;

export async function seed(opts: { contracts?: boolean } = {}) {
  const cfg = loadConfig();
  if (cfg.env === 'production') throw new Error('seed creates well-known demo tokens and must not run in production');
  const system: Principal = { actor: 'system:seed', tokenId: 0, tenantId: null, role: 'platform_admin', correlationId: 'seed' };
  await withSystem(async (tx) => {
    await tx.query(`INSERT INTO core.api_tokens (token_hash, name, tenant_id, role) VALUES ($1, 'platform-admin', NULL, 'platform_admin') ON CONFLICT (token_hash) DO NOTHING`, [hashToken(DEV_TOKENS.platform)]);
  });
  const tenants = [
    { id: 'northwind', name: 'Northwind Health Plan (synthetic)' },
    { id: 'bluefin', name: 'Bluefin Benefits (synthetic)' },
  ] as const;
  for (const t of tenants) {
    const exists = await withSystem(async (tx) => (await tx.query(`SELECT 1 FROM core.tenants WHERE id = $1`, [t.id])).rows.length > 0);
    if (exists) continue;
    await createTenant(system, { id: t.id, name: t.name });
    const toks = DEV_TOKENS[t.id];
    // Bootstrap exactly as an operator would: the platform admin issues the first admin and the
    // approver; the tenant admin issues everything else.
    await issueToken(system, t.id, `${t.id}-admin`, 'admin', toks.admin);
    await issueToken(system, t.id, `${t.id}-approver`, 'approver', toks.approver);
    const tenantAdmin: Principal = { actor: `${t.id}-admin`, tokenId: 0, tenantId: t.id, role: 'admin', correlationId: 'seed' };
    await issueToken(tenantAdmin, t.id, `${t.id}-operator`, 'operator', toks.operator);
    await issueToken(tenantAdmin, t.id, `${t.id}-reporter`, 'reporter', toks.reporter);
    await issueToken(tenantAdmin, t.id, `${t.id}-steward`, 'steward', toks.steward);
    if (opts.contracts !== false) {
      const doc = JSON.parse(await readFile(path.join(root, 'contracts', t.id, 'v1.json'), 'utf8'));
      const admin: Principal = { actor: `${t.id}-admin`, tokenId: 0, tenantId: t.id, role: 'admin', correlationId: 'seed' };
      await publishContract(admin, t.id, doc);
    }
  }
}


if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  try { await migrate(); await seed(); console.log(JSON.stringify({ seeded: true, tokens: DEV_TOKENS }, null, 2)); }
  catch (err) { console.error((err as Error).message); process.exitCode = 1; }
  finally { await closePool(); }
}
