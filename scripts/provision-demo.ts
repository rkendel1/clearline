// Production-safe demo provisioning: the two synthetic tenants (northwind, bluefin) with their v1 contracts and a full
// set of role tokens, created through the same service functions the API uses. Unlike seed.ts it generates RANDOM
// tokens (never the well-known cl_dev_* ones), so it may run against a real deployment. Tokens are printed once as JSON
// on stdout; store them. Idempotent: a tenant that already exists is left alone and its tokens are not reissued.
//   node dist/scripts/provision-demo.js > demo-tokens.json
// Then load data over HTTP with:  DEMO_TOKENS_JSON="$(cat demo-tokens.json)" CLEARLINE_URL=http://127.0.0.1:8080 node dist/scripts/demo.js

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, withSystem } from '../src/platform/db.js';
import { migrate } from '../src/platform/migrate.js';
import { newToken, type Principal } from '../src/control/auth.js';
import { createTenant, issueToken } from '../src/control/tenants.js';
import { publishContract } from '../src/contracts/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/[\\/]dist$/, '');
const TENANTS = [{ id: 'northwind', name: 'Northwind Health Plan (synthetic)' }, { id: 'bluefin', name: 'Bluefin Benefits (synthetic)' }] as const;

try {
  await migrate();
  const system: Principal = { actor: 'system:provision-demo', tokenId: 0, tenantId: null, role: 'platform_admin', correlationId: 'provision-demo' };
  const out: Record<string, Record<string, string> | string> = {};
  for (const t of TENANTS) {
    const exists = await withSystem(async (tx) => (await tx.query(`SELECT 1 FROM core.tenants WHERE id = $1`, [t.id])).rows.length > 0);
    if (exists) { process.stderr.write(`${t.id}: already exists, left unchanged (no tokens reissued)\n`); out[t.id] = 'exists'; continue; }
    await createTenant(system, { id: t.id, name: t.name });
    const tok = { admin: newToken(), approver: newToken(), steward: newToken(), operator: newToken(), reporter: newToken() };
    // Bootstrap exactly as an operator would: the platform admin issues the first admin and the approver; the tenant admin issues the rest.
    await issueToken(system, t.id, `${t.id}-admin`, 'admin', tok.admin);
    await issueToken(system, t.id, `${t.id}-approver`, 'approver', tok.approver);
    const admin: Principal = { actor: `${t.id}-admin`, tokenId: 0, tenantId: t.id, role: 'admin', correlationId: 'provision-demo' };
    await issueToken(admin, t.id, `${t.id}-operator`, 'operator', tok.operator);
    await issueToken(admin, t.id, `${t.id}-reporter`, 'reporter', tok.reporter);
    await issueToken(admin, t.id, `${t.id}-steward`, 'steward', tok.steward);
    await publishContract(admin, t.id, JSON.parse(await readFile(path.join(root, 'contracts', t.id, 'v1.json'), 'utf8')));
    out[t.id] = tok;
  }
  console.log(JSON.stringify(out, null, 2));
} catch (err) { console.error((err as Error).message); process.exitCode = 1; }
finally { await closePool(); }
