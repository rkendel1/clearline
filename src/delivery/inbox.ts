// In-app notifications and export downloads, read by the recipient.
//
// Notifications are scoped to the tenant and to the recipient token name. Their content is
// re-checked when read: if the recipient can no longer see the saved query, only a status
// line is returned. Export downloads re-validate the saved SQL for the downloader's role and
// refuse when that role would see any column more redacted than the export contains.

import { withTenant } from '../platform/db.js';
import { AppError, notFound } from '../platform/errors.js';
import { can, type Principal } from '../control/auth.js';
import { auditTx } from '../control/audit.js';
import { validateFor } from '../query/service.js';
import { appClock } from '../analytics/clock.js';

export async function listNotifications(p: Principal, f: { unread?: boolean; limit: number }) {
  return withTenant(p.tenantId!, async (tx) => {
    const { rows } = await tx.query(`SELECT n.*, q.owner_actor, q.sharing, q.name AS query_name FROM core.notifications n LEFT JOIN core.saved_queries q ON q.id = n.query_id
      WHERE n.tenant_id = $1 AND n.recipient = $2 AND ($3::boolean IS NOT TRUE OR n.read_at IS NULL) ORDER BY n.created_at DESC LIMIT $4`, [p.tenantId, p.actor, f.unread ?? null, f.limit]);
    const unread = Number((await tx.query(`SELECT count(*) AS n FROM core.notifications WHERE tenant_id = $1 AND recipient = $2 AND read_at IS NULL`, [p.tenantId, p.actor])).rows[0].n);
    return {
      unread,
      items: rows.map((n) => {
        const visible = !n.query_id || n.owner_actor === p.actor || n.sharing === 'tenant' || can(p, 'saved_query:admin');
        return { id: n.id, kind: n.kind, severity: n.severity, created_at: n.created_at, read_at: n.read_at, run_id: n.run_id, query_id: visible ? n.query_id : null,
          title: visible ? n.title : 'Notification withheld', body: visible ? n.body : 'You no longer have access to the saved query this notification is about.', links: visible ? n.links : {},
          query_name: visible ? n.query_name : null };
      }),
    };
  });
}

export async function markRead(p: Principal, id: string | 'all') {
  return withTenant(p.tenantId!, async (tx) => {
    const r = id === 'all'
      ? await tx.query(`UPDATE core.notifications SET read_at = clock_timestamp() WHERE tenant_id = $1 AND recipient = $2 AND read_at IS NULL`, [p.tenantId, p.actor])
      : await tx.query(`UPDATE core.notifications SET read_at = coalesce(read_at, clock_timestamp()) WHERE id = $3 AND tenant_id = $1 AND recipient = $2`, [p.tenantId, p.actor, /^[0-9a-f-]{36}$/.test(id) ? id : '00000000-0000-0000-0000-000000000000']);
    if (id !== 'all' && !r.rowCount) throw notFound('notification');
    return { marked: r.rowCount };
  });
}

export async function downloadExport(p: Principal, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('export');
  const x = await withTenant(p.tenantId!, async (tx) => {
    const e = (await tx.query(`SELECT e.*, q.owner_actor, q.sharing FROM core.exports e JOIN core.saved_queries q ON q.id = e.query_id WHERE e.id = $1 AND e.tenant_id = $2`, [id, p.tenantId])).rows[0];
    if (!e || (e.owner_actor !== p.actor && e.sharing !== 'tenant' && !can(p, 'saved_query:admin'))) throw notFound('export');
    const run = (await tx.query(`SELECT r.*, v.sql, v.parameters FROM core.analytics_runs r JOIN core.saved_query_versions v ON v.query_id = r.query_id AND v.version = r.query_version WHERE r.id = $1`, [e.run_id])).rows[0];
    return { e, run };
  });
  const { e, run } = x;
  const deny = async (code: string, message: string) => {
    await withTenant(p.tenantId!, (tx) => auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'export.download', resource: `export:${id}`, outcome: 'denied', details: { reason: code }, correlationId: p.correlationId }));
    throw new AppError(code === 'export_expired' ? 410 : 403, code, message);
  };
  if (!e.content || new Date(e.expires_at).getTime() <= appClock.now()) await deny('export_expired', 'This export has expired.');
  // The downloader's own access, now: same SQL, current policy, downloader's role.
  const { validation } = await validateFor(p, run.sql, run.parameters);
  if (!validation.ok) await deny('export_not_permitted', 'The data in this export is not available to your role under the current field policy.');
  const cols: { name: string; masked: string | null }[] = run.result_meta?.columns ?? [];
  if (cols.some((c, i) => validation.output[i]?.masked && validation.output[i]?.masked !== c.masked)) await deny('export_not_permitted', 'This export contains values that are redacted for your role.');
  await withTenant(p.tenantId!, async (tx) => {
    await tx.query(`UPDATE core.exports SET downloads = downloads + 1 WHERE id = $1`, [id]);
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'export.download', resource: `export:${id}`, outcome: 'succeeded',
      details: { run_id: e.run_id, rows: e.row_count, bytes: e.bytes, sha256: e.sha256 }, correlationId: p.correlationId });
  });
  return { file_name: e.file_name as string, content: e.content as Buffer, sha256: e.sha256 as string, rows: e.row_count as number };
}
