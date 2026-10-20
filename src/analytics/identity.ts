// Execution identity for scheduled and manual runs.
//
// A run executes AS { actor, role }: actor is an API token name in the tenant (for a schedule,
// the person who created it), role is the role the schedule was explicitly configured to run
// as. Before every run and before every delivery of its results:
//   1. the token must still be active (revoking it stops the schedule's runs);
//   2. the token's CURRENT role must be allowed to delegate the run role (DELEGABLE_ROLES), so
//      demoting the creator demotes the schedule, and an admin's schedule can run as a reporter;
//   3. the run role must hold query:run and saved_query:read;
//   4. the saved query must still be visible to the actor (owned or shared with the tenant).
// The SQL is then re-validated under the run role and the CURRENT field policy (runSql).

import { withSystem } from '../platform/db.js';
import { DELEGABLE_ROLES, ROLE_PERMISSIONS, type Principal, type Role } from '../control/auth.js';

export type IdentityCheck =
  | { ok: true; principal: Principal }
  | { ok: false; code: 'identity_revoked' | 'identity_role_changed' | 'identity_lacks_permission' | 'query_not_visible'; message: string };

export async function checkIdentity(tenant: string, actor: string, role: Role, query: Record<string, any> | null, correlationId: string): Promise<IdentityCheck> {
  const tok = await withSystem(async (tx) => (await tx.query(
    `SELECT id, role FROM core.api_tokens WHERE tenant_id = $1 AND name = $2 AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`, [tenant, actor])).rows[0]);
  if (!tok) return { ok: false, code: 'identity_revoked', message: `The execution identity "${actor}" no longer has an active token. Someone with schedule:manage must recreate the schedule under an active identity.` };
  if (!DELEGABLE_ROLES[tok.role as Role]?.includes(role)) {
    return { ok: false, code: 'identity_role_changed', message: `The execution identity "${actor}" now has role ${tok.role}, which may not run schedules as ${role}. Authorization needs attention.` };
  }
  const perms = ROLE_PERMISSIONS[role];
  if (!perms.has('query:run') || !perms.has('saved_query:read')) return { ok: false, code: 'identity_lacks_permission', message: `Role ${role} may not run saved queries.` };
  if (query && query.owner_actor !== actor && query.sharing !== 'tenant') return { ok: false, code: 'query_not_visible', message: `The saved query is no longer shared with "${actor}".` };
  return { ok: true, principal: { actor, tokenId: Number(tok.id), tenantId: tenant, role, correlationId } };
}
