// Saved queries: reusable, versioned analytics assets (docs/saved-analytics.md).
//
// A saved query is NOT an authorization grant. Saving validates the SQL under the saver's
// current role; every later execution (interactive, manual run or scheduled run) re-validates
// under the executing identity's role and the policy in force at that moment, through the same
// path as the query workspace (runSql). SQL, parameters, the observed output schema and the
// analysis configuration are immutable per version; runs record the exact version they used.

import { createHash, randomUUID } from 'node:crypto';
import { withTenant, type Tx } from '../platform/db.js';
import { loadConfig } from '../platform/config.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../platform/errors.js';
import { can, type Principal } from '../control/auth.js';
import { auditTx } from '../control/audit.js';
import { describeOutput, runSql, validateFor, type OutputSchemaColumn } from '../query/service.js';
import { normalizeConfig, checkAgainstSchema, type AnalysisConfig, type Limits } from '../analysis/index.js';
import { normalizeDeclarations, resolveValues, type ParamDeclaration } from './params.js';
import { describe as describeRecurrence, parseRule } from './recurrence.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ACCESS_CODES = new Set(['unknown_column', 'unknown_table', 'restricted_field']);

export function analysisLimits(): Limits {
  const c = loadConfig();
  return { maxRows: c.analysisMaxRows, maxFeatures: c.analysisMaxFeatures, maxPoints: c.analysisMaxPoints, maxHorizon: c.analysisMaxHorizon, timeoutMs: c.analysisTimeoutMs, maxMemoryMb: c.analysisMaxMemoryMb };
}

/** An analysis as stored on a version: the configuration plus whether it still fits the version's output. */
export type StoredAnalysis = AnalysisConfig & { state: 'active' | 'needs_revalidation'; state_reason?: string | null };

const uuid = (id: string) => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw notFound('saved query'); return id; };

/** Visible = the owner, or shared with the tenant. Writable = the owner, or saved_query:admin. Others get 404. */
export async function loadQuery(tx: Tx, p: Principal, id: string, mode: 'read' | 'write' = 'read') {
  const row = (await tx.query(`SELECT * FROM core.saved_queries WHERE id = $1 AND tenant_id = $2`, [uuid(id), p.tenantId])).rows[0];
  if (!row) throw notFound('saved query');
  const own = row.owner_actor === p.actor;
  if (!own && row.sharing !== 'tenant' && !can(p, 'saved_query:admin')) throw notFound('saved query');
  if (mode === 'write' && !own && !can(p, 'saved_query:admin')) throw new AppError(403, 'forbidden', 'Only the owner (or an administrator) can change this saved query.');
  return row;
}

export async function loadVersion(tx: Tx, queryId: string, version: number) {
  const v = (await tx.query(`SELECT * FROM core.saved_query_versions WHERE query_id = $1 AND version = $2`, [queryId, version])).rows[0];
  if (!v) throw notFound('saved query version');
  return v;
}

function text(v: unknown, field: string, max: number, required = false): string | null {
  if (v === undefined || v === null || v === '') { if (required) throw badRequest('invalid_field', `${field} is required.`); return null; }
  if (typeof v !== 'string') throw badRequest('invalid_field', `${field} must be text.`);
  const t = v.trim();
  if (required && !t) throw badRequest('invalid_field', `${field} is required.`);
  if (t.length > max) throw badRequest('invalid_field', `${field} is limited to ${max} characters.`);
  return t || null;
}

function tags(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 20 || v.some((t) => typeof t !== 'string' || !t.trim() || t.length > 40)) throw badRequest('invalid_field', 'tags must be up to 20 strings of at most 40 characters.');
  return [...new Set((v as string[]).map((t) => t.trim().toLowerCase()))];
}

function decls(raw: unknown): ParamDeclaration[] {
  const n = normalizeDeclarations(raw);
  if (n.issues.length) throw badRequest('invalid_parameters', n.issues.map((i) => `${i.name || 'parameters'}: ${i.message}`).join('; '), { issues: n.issues });
  return n.decls;
}

/** Strictly validate analyses supplied by the user against an output schema. */
function analyses(raw: unknown, schema: OutputSchemaColumn[]): StoredAnalysis[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 10) throw badRequest('invalid_analyses', 'analyses must be an array of at most 10 configurations.');
  const out: StoredAnalysis[] = [];
  const issues: { key: string; field: string; message: string }[] = [];
  for (const r of raw) {
    const n = normalizeConfig(r, analysisLimits());
    if (!n.config) { issues.push(...n.issues.map((i) => ({ key: String((r as any)?.key ?? ''), field: i.field, message: i.message }))); continue; }
    if (out.some((a) => a.key === n.config!.key)) { issues.push({ key: n.config.key, field: 'key', message: 'Duplicate analysis key.' }); continue; }
    const s = checkAgainstSchema(n.config, schema);
    if (s.length) { issues.push(...s.map((i) => ({ key: n.config!.key, field: i.field, message: i.message }))); continue; }
    out.push({ ...n.config, state: 'active', state_reason: null });
  }
  if (issues.length) throw unprocessable('invalid_analysis', issues.map((i) => `${i.key}${i.field ? `.${i.field}` : ''}: ${i.message}`).join('; '), { issues });
  return out;
}

/** Carry analyses to a new version; those that no longer fit the output are flagged, never reinterpreted. */
function carryAnalyses(prev: StoredAnalysis[], schema: OutputSchemaColumn[]): { list: StoredAnalysis[]; invalidated: string[] } {
  const invalidated: string[] = [];
  const list = prev.map((a) => {
    const issues = checkAgainstSchema(a, schema, true);
    if (!issues.length) return { ...a, state: 'active' as const, state_reason: null };
    invalidated.push(a.key);
    return { ...a, state: 'needs_revalidation' as const, state_reason: issues.map((i) => i.message).join(' ') };
  });
  return { list, invalidated };
}

async function describeOrFail(p: Principal, sql: string, params: ParamDeclaration[]) {
  const d = await describeOutput(p, sql, params);
  if (!d.validation.ok) throw new AppError(422, 'query_not_permitted', d.validation.issues[0]?.message ?? 'The SQL is not permitted for your role.', { issues: d.validation.issues });
  return d;
}

// ------------------------------------------------------------------ create / version / metadata

export async function createSavedQuery(p: Principal, b: Record<string, unknown>) {
  const name = text(b.name, 'name', 200, true)!;
  const sharing = (b.sharing ?? 'private') as string;
  if (!['private', 'tenant'].includes(sharing)) throw badRequest('invalid_field', 'sharing must be private or tenant.');
  if (sharing === 'tenant' && !can(p, 'saved_query:share')) throw new AppError(403, 'forbidden', `Role ${p.role} lacks permission saved_query:share`);
  let sql = typeof b.sql === 'string' ? b.sql : '';
  let question = text(b.question, 'question', 2000);
  let proposalId: string | null = null;
  if (typeof b.proposal_id === 'string') {
    // From the query workspace: the proposal must be one the saver can see; its SQL is re-validated below.
    const prop = await withTenant(p.tenantId!, async (tx) => (await tx.query(`SELECT * FROM core.query_proposals WHERE id = $1 AND tenant_id = $2`, [uuid(b.proposal_id as string), p.tenantId])).rows[0]);
    if (!prop || (prop.actor !== p.actor && !can(p, 'query:history_all'))) throw notFound('query proposal');
    if (!prop.proposed_sql) throw unprocessable('not_executable', 'That proposal has no SQL.');
    if (!sql) sql = prop.proposed_sql;
    question = question ?? prop.question;
    proposalId = prop.id;
  }
  if (!sql.trim()) throw badRequest('missing_sql', 'Provide sql or proposal_id.');
  const params = decls(b.parameters);
  const d = await describeOrFail(p, sql, params);
  const list = analyses(b.analyses, d.columns!);
  const id = randomUUID();
  await withTenant(p.tenantId!, async (tx) => {
    try {
      await tx.query(`INSERT INTO core.saved_queries (id, tenant_id, name, description, purpose, category, business_owner, tags, owner_actor, owner_role, sharing, current_version, updated_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$9)`, [id, p.tenantId, name, text(b.description, 'description', 2000), text(b.purpose, 'purpose', 2000), text(b.category, 'category', 80),
        text(b.business_owner, 'business_owner', 200), tags(b.tags), p.actor, p.role, sharing]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('name_exists', `A saved query named "${name}" already exists.`);
      throw err;
    }
    await tx.query(`INSERT INTO core.saved_query_versions (tenant_id, query_id, version, sql, sql_sha256, question, source_proposal_id, parameters, output_schema, analyses, change_note, created_by, created_role)
      VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [p.tenantId, id, sql, sha(sql), question, proposalId, JSON.stringify(params), JSON.stringify(d.columns), JSON.stringify(list),
      text(b.change_note, 'change_note', 500) ?? 'Created', p.actor, p.role]);
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'saved_query.create', resource: `saved_query:${id}`, outcome: 'succeeded',
      details: { version: 1, sql_sha256: sha(sql), source_proposal_id: proposalId, parameters: params.map((x) => x.name), analyses: list.map((a) => ({ key: a.key, algorithm: a.algorithm })), sharing, policy_epoch: d.policy_epoch },
      correlationId: p.correlationId });
  });
  return getSavedQuery(p, id);
}

export async function newVersion(p: Principal, id: string, b: Record<string, unknown>) {
  const { q, base } = await withTenant(p.tenantId!, async (tx) => {
    const q = await loadQuery(tx, p, id, 'write');
    if (q.status === 'archived') throw conflict('archived', 'An archived saved query cannot be changed; duplicate it instead.');
    return { q, base: await loadVersion(tx, id, q.current_version) };
  });
  const sql = typeof b.sql === 'string' && b.sql.trim() ? b.sql : base.sql;
  const params = b.parameters !== undefined ? decls(b.parameters) : (base.parameters as ParamDeclaration[]);
  const d = await describeOrFail(p, sql, params);
  let list: StoredAnalysis[];
  let invalidated: string[] = [];
  if (b.analyses !== undefined) list = analyses(b.analyses, d.columns!);
  else ({ list, invalidated } = carryAnalyses(base.analyses as StoredAnalysis[], d.columns!));
  const same = sql === base.sql && JSON.stringify(params) === JSON.stringify(base.parameters) && JSON.stringify(list) === JSON.stringify(base.analyses);
  if (same) throw conflict('no_change', 'Nothing changed: the SQL, parameters and analyses equal the current version.');
  const version = q.current_version + 1;
  await withTenant(p.tenantId!, async (tx) => {
    const upd = await tx.query(`UPDATE core.saved_queries SET current_version = $3, updated_at = clock_timestamp(), updated_by = $4, needs_revalidation = NULL WHERE id = $1 AND tenant_id = $2 AND current_version = $5`,
      [id, p.tenantId, version, p.actor, q.current_version]);
    if (!upd.rowCount) throw conflict('version_conflict', 'The saved query changed meanwhile; reload and try again.');
    await tx.query(`INSERT INTO core.saved_query_versions (tenant_id, query_id, version, sql, sql_sha256, question, source_proposal_id, parameters, output_schema, analyses, change_note, created_by, created_role)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [p.tenantId, id, version, sql, sha(sql), base.question, base.source_proposal_id, JSON.stringify(params), JSON.stringify(d.columns),
      JSON.stringify(list), text(b.change_note, 'change_note', 500), p.actor, p.role]);
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'saved_query.version', resource: `saved_query:${id}`, outcome: 'succeeded',
      details: { from_version: q.current_version, version, sql_changed: sql !== base.sql, parameters_changed: JSON.stringify(params) !== JSON.stringify(base.parameters),
        analyses_changed: JSON.stringify(list) !== JSON.stringify(base.analyses), analyses_needing_revalidation: invalidated, sql_sha256: sha(sql), policy_epoch: d.policy_epoch },
      correlationId: p.correlationId });
  });
  return getSavedQuery(p, id);
}

export async function updateMetadata(p: Principal, id: string, b: Record<string, unknown>) {
  await withTenant(p.tenantId!, async (tx) => {
    const q = await loadQuery(tx, p, id, 'write');
    if (q.status === 'archived') throw conflict('archived', 'An archived saved query cannot be changed.');
    const sets: string[] = []; const vals: unknown[] = [id, p.tenantId]; const changed: string[] = [];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); changed.push(col); };
    if (b.name !== undefined) set('name', text(b.name, 'name', 200, true));
    for (const [k, max] of [['description', 2000], ['purpose', 2000], ['category', 80], ['business_owner', 200]] as const) if (b[k] !== undefined) set(k, text(b[k], k, max));
    if (b.tags !== undefined) set('tags', tags(b.tags));
    if (b.sharing !== undefined) {
      if (!['private', 'tenant'].includes(b.sharing as string)) throw badRequest('invalid_field', 'sharing must be private or tenant.');
      if (!can(p, 'saved_query:share')) throw new AppError(403, 'forbidden', `Role ${p.role} lacks permission saved_query:share`);
      set('sharing', b.sharing);
    }
    if (!sets.length) throw badRequest('no_change', 'Nothing to update.');
    vals.push(p.actor); sets.push(`updated_by = $${vals.length}`, 'updated_at = clock_timestamp()');
    try { await tx.query(`UPDATE core.saved_queries SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`, vals); }
    catch (err) { if ((err as { code?: string }).code === '23505') throw conflict('name_exists', 'A saved query with that name already exists.'); throw err; }
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: b.sharing !== undefined && b.sharing !== q.sharing ? 'saved_query.share' : 'saved_query.update', resource: `saved_query:${id}`,
      outcome: 'succeeded', details: { fields: changed, sharing_from: q.sharing, sharing_to: b.sharing ?? q.sharing }, correlationId: p.correlationId });
  });
  return getSavedQuery(p, id);
}

export async function duplicateSavedQuery(p: Principal, id: string, b: Record<string, unknown>) {
  const { q, v } = await withTenant(p.tenantId!, async (tx) => { const q = await loadQuery(tx, p, id); return { q, v: await loadVersion(tx, id, q.current_version) }; });
  const created = await createSavedQuery(p, {
    name: b.name ?? `${q.name} (copy)`, description: q.description, purpose: q.purpose, category: q.category, business_owner: q.business_owner, tags: q.tags, sharing: 'private',
    sql: v.sql, question: v.question, parameters: v.parameters, analyses: (v.analyses as StoredAnalysis[]).filter((a) => a.state === 'active').map(({ state: _s, state_reason: _r, ...c }) => c),
    change_note: `Duplicated from ${q.name} v${q.current_version}`,
  });
  await withTenant(p.tenantId!, async (tx) => {
    await tx.query(`UPDATE core.saved_queries SET duplicated_from = $2 WHERE id = $1`, [created.id, id]);
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'saved_query.duplicate', resource: `saved_query:${created.id}`, outcome: 'succeeded',
      details: { from: id, from_version: q.current_version }, correlationId: p.correlationId });
  });
  return { ...created, duplicated_from: id };
}

export async function setStatus(p: Principal, id: string, status: 'active' | 'disabled' | 'archived') {
  if (!['active', 'disabled', 'archived'].includes(status)) throw badRequest('invalid_status', 'status must be active, disabled or archived.');
  await withTenant(p.tenantId!, async (tx) => {
    const q = await loadQuery(tx, p, id, 'write');
    if (q.status === 'archived' && status !== 'archived') throw conflict('archived', 'Archived saved queries cannot be reactivated; duplicate it instead.');
    if (q.status === status) return;
    await tx.query(`UPDATE core.saved_queries SET status = $3, updated_at = clock_timestamp(), updated_by = $4 WHERE id = $1 AND tenant_id = $2`, [id, p.tenantId, status, p.actor]);
    // Schedules of a disabled or archived query stop; they are not silently resumed later.
    const paused = status === 'active' ? { rows: [] } : await tx.query(`UPDATE core.schedules SET status = 'paused', next_run_at = NULL, attention = $3, updated_at = clock_timestamp(), updated_by = $4
      WHERE query_id = $1 AND tenant_id = $2 AND status = 'active' RETURNING id`, [id, p.tenantId, `saved query ${status}`, p.actor]);
    await auditTx(tx, { tenantId: p.tenantId, actor: p.actor, role: p.role, action: `saved_query.${status === 'active' ? 'enable' : status === 'disabled' ? 'disable' : 'archive'}`, resource: `saved_query:${id}`,
      outcome: 'succeeded', details: { from: q.status, to: status, schedules_paused: paused.rows.map((r: any) => r.id) }, correlationId: p.correlationId });
  });
  return getSavedQuery(p, id);
}

export async function setFavorite(p: Principal, id: string, on: boolean) {
  await withTenant(p.tenantId!, async (tx) => {
    await loadQuery(tx, p, id);
    if (on) await tx.query(`INSERT INTO core.saved_query_favorites (tenant_id, query_id, actor) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [p.tenantId, id, p.actor]);
    else await tx.query(`DELETE FROM core.saved_query_favorites WHERE query_id = $1 AND actor = $2`, [id, p.actor]);
  });
  return { id, favorite: on };
}

// ------------------------------------------------------------------ read

export interface ListFilters { scope?: string; q?: string; tag?: string; category?: string; status?: string; favorite?: boolean; sort?: string; limit: number; offset: number }

export async function listSavedQueries(p: Principal, f: ListFilters) {
  const where = ['q.tenant_id = $1'];
  const vals: unknown[] = [p.tenantId, p.actor];
  const add = (sql: string, v: unknown) => { vals.push(v); where.push(sql.replace('?', `$${vals.length}`)); };
  // Visibility (as for a single query): own queries, queries shared with the tenant, and for
  // saved_query:admin every query in the tenant. Execution is still authorized per run.
  if (!can(p, 'saved_query:admin')) where.push(`(q.owner_actor = $2 OR q.sharing = 'tenant')`);
  if (f.scope === 'mine') where.push('q.owner_actor = $2');
  else if (f.scope === 'shared') where.push(`q.owner_actor <> $2 AND q.sharing = 'tenant'`);
  if (f.status) add('q.status = ?', f.status); else where.push(`q.status <> 'archived'`);
  if (f.q) add(`(q.name ILIKE ? OR coalesce(q.description,'') ILIKE $${vals.length} OR coalesce(q.category,'') ILIKE $${vals.length} OR array_to_string(q.tags, ' ') ILIKE $${vals.length})`, `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  if (f.tag) add('? = ANY(q.tags)', f.tag.toLowerCase());
  if (f.category) add('q.category = ?', f.category);
  if (f.favorite) where.push('fav.actor IS NOT NULL');
  const order = { name: 'lower(q.name)', created: 'q.created_at DESC', last_run: 'lr.created_at DESC NULLS LAST', recent: 'greatest(q.updated_at, coalesce(lr.created_at, q.updated_at)) DESC' }[f.sort ?? ''] ?? 'q.updated_at DESC';
  vals.push(f.limit, f.offset);
  return withTenant(p.tenantId!, async (tx) => {
    const { rows } = await tx.query(`SELECT q.*, fav.actor IS NOT NULL AS favorite,
        lr.id AS last_run_id, lr.status AS last_run_status, lr.created_at AS last_run_at, lr.result_meta AS last_run_meta, lr.timings AS last_run_timings,
        (SELECT count(*) FROM core.schedules s WHERE s.query_id = q.id AND s.status = 'active')::int AS active_schedules,
        (SELECT min(next_run_at) FROM core.schedules s WHERE s.query_id = q.id AND s.status = 'active') AS next_run_at,
        (SELECT jsonb_array_length(analyses) FROM core.saved_query_versions v WHERE v.query_id = q.id AND v.version = q.current_version) AS analyses
      FROM core.saved_queries q
      LEFT JOIN core.saved_query_favorites fav ON fav.query_id = q.id AND fav.actor = $2
      LEFT JOIN LATERAL (SELECT * FROM core.analytics_runs r WHERE r.query_id = q.id ORDER BY r.created_at DESC LIMIT 1) lr ON true
      WHERE ${where.join(' AND ')} ORDER BY ${order}, q.id LIMIT $${vals.length - 1} OFFSET $${vals.length}`, vals);
    return { items: rows.map((r) => ({
      id: r.id, name: r.name, description: r.description, category: r.category, tags: r.tags, owner: r.owner_actor, mine: r.owner_actor === p.actor, sharing: r.sharing, status: r.status,
      version: r.current_version, favorite: r.favorite, updated_at: r.updated_at, needs_revalidation: r.needs_revalidation, analyses: r.analyses ?? 0,
      active_schedules: r.active_schedules, next_run_at: r.next_run_at,
      last_run: r.last_run_id ? { id: r.last_run_id, status: r.last_run_status, at: r.last_run_at, row_count: r.last_run_meta?.row_count ?? null, duration_ms: r.last_run_timings?.query_ms ?? null } : null,
    })) };
  });
}

/** Saved SQL is shown to a viewer only if they may use it now, or it is their own (as in query history). */
async function viewerCanSee(p: Principal, row: Record<string, any>, sql: string, params: ParamDeclaration[]) {
  const v = (await validateFor(p, sql, params)).validation;
  const withheld = row.owner_actor !== p.actor && !v.ok && ACCESS_CODES.has(v.issues[0]?.code);
  return { executable_now: v.ok, withheld, issues: v.ok ? [] : withheld ? [{ code: 'withheld', message: 'This query uses data that is not available to your role under the current field policy.' }] : v.issues };
}

export async function getSavedQuery(p: Principal, id: string) {
  const data = await withTenant(p.tenantId!, async (tx) => {
    const q = await loadQuery(tx, p, id);
    const v = await loadVersion(tx, id, q.current_version);
    const versions = (await tx.query(`SELECT version, sql_sha256, change_note, created_by, created_at, jsonb_array_length(analyses) AS analyses FROM core.saved_query_versions WHERE query_id = $1 ORDER BY version DESC`, [id])).rows;
    const schedules = (await tx.query(`SELECT id, name, status, rrule, start_local, timezone, next_run_at, attention, run_as_actor, run_as_role, last_run_id FROM core.schedules WHERE query_id = $1 AND status <> 'cancelled' ORDER BY created_at`, [id])).rows;
    const runs = (await tx.query(`SELECT id, trigger, status, query_status, analysis_status, delivery_status, failure_class, query_version, created_at, finished_at, result_meta->'row_count' AS row_count, timings
      FROM core.analytics_runs WHERE query_id = $1 ORDER BY created_at DESC LIMIT 10`, [id])).rows;
    const latest = (await tx.query(`SELECT DISTINCT ON (analysis_key) id, analysis_key, analysis_type, algorithm, algorithm_version, status, message, created_at, run_id
      FROM core.analysis_runs WHERE query_id = $1 ORDER BY analysis_key, created_at DESC`, [id])).rows;
    const fav = (await tx.query(`SELECT 1 FROM core.saved_query_favorites WHERE query_id = $1 AND actor = $2`, [id, p.actor])).rows.length > 0;
    return { q, v, versions, schedules, runs, latest, fav };
  });
  const { q, v } = data;
  const see = await viewerCanSee(p, q, v.sql, v.parameters);
  return {
    id: q.id, name: q.name, description: q.description, purpose: q.purpose, category: q.category, business_owner: q.business_owner, tags: q.tags,
    owner: q.owner_actor, owner_role: q.owner_role, mine: q.owner_actor === p.actor, sharing: q.sharing, status: q.status, favorite: data.fav,
    created_at: q.created_at, updated_at: q.updated_at, updated_by: q.updated_by, duplicated_from: q.duplicated_from, needs_revalidation: q.needs_revalidation,
    version: q.current_version, executable_now: see.executable_now, withheld: see.withheld, issues: see.issues,
    current: {
      version: v.version, sql: see.withheld ? null : v.sql, sql_sha256: v.sql_sha256, question: see.withheld ? null : v.question, source_proposal_id: v.source_proposal_id,
      parameters: v.parameters, output_schema: see.withheld ? null : v.output_schema, analyses: v.analyses, change_note: v.change_note, created_by: v.created_by, created_at: v.created_at,
    },
    versions: data.versions,
    schedules: data.schedules.map((x: any) => ({ ...x, description: describeRecurrence({ rule: parseRule(x.rrule), startLocal: x.start_local, timezone: x.timezone, untilLocal: null }) })), recent_runs: data.runs, latest_analyses: data.latest,
  };
}

export async function getVersion(p: Principal, id: string, version: number) {
  const { q, v } = await withTenant(p.tenantId!, async (tx) => { const q = await loadQuery(tx, p, id); return { q, v: await loadVersion(tx, id, version) }; });
  const see = await viewerCanSee(p, q, v.sql, v.parameters);
  return { ...v, sql: see.withheld ? null : v.sql, question: see.withheld ? null : v.question, output_schema: see.withheld ? null : v.output_schema, withheld: see.withheld };
}

/** Interactive execution of a saved query by the viewer, under the viewer's own role (no analyses, no delivery). */
export async function executeSaved(p: Principal, id: string, b: Record<string, unknown>) {
  const mode = (b.mode ?? 'preview') as 'preview' | 'run';
  if (!['preview', 'run'].includes(mode)) throw badRequest('invalid_mode', 'mode must be preview or run.');
  const { q, v } = await withTenant(p.tenantId!, async (tx) => {
    const q = await loadQuery(tx, p, id);
    return { q, v: await loadVersion(tx, id, typeof b.version === 'number' ? b.version : q.current_version) };
  });
  if (q.status !== 'active') throw conflict('not_active', `This saved query is ${q.status}.`);
  const { values, effective } = resolveValues(v.parameters, b.parameters as Record<string, unknown>, Date.now());
  const r = await runSql({ principal: p, sql: v.sql, params: v.parameters, values, mode, origin: { savedQueryId: id, savedQueryVersion: v.version, resource: `saved_query:${id}` },
    executionId: typeof b.execution_id === 'string' ? b.execution_id : undefined });
  const { validation: _v, ...result } = r;
  return { ...result, saved_query_id: id, version: v.version, parameters: effective };
}

/** Check an analysis configuration against the current version's output schema (for the analysis builder). */
export async function validateAnalysis(p: Principal, id: string, b: Record<string, unknown>) {
  const v = await withTenant(p.tenantId!, async (tx) => { const q = await loadQuery(tx, p, id); return loadVersion(tx, id, q.current_version); });
  const n = normalizeConfig(b.config, analysisLimits());
  const issues = n.config ? checkAgainstSchema(n.config, v.output_schema ?? []) : n.issues;
  return { ok: !issues.length, config: n.config, issues, output_schema: v.output_schema };
}
