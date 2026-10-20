// Validated data tools for the assistant. The model (or the rule-based planner) can only choose a tool and its
// arguments; it never writes SQL. Each tool has a strict argument schema, builds its SQL from validated values,
// and executes through the existing governed path (runSql: re-validation under the current policy for the
// principal's role, read-only database role, timeouts, row caps, audit). Every invocation is persisted as evidence.
//
// Anonymous visitors may only use the tools below against the tenant an operator names in
// ASSISTANT_PUBLIC_DATA_TENANT (synthetic demo data) and with the least-privileged role; unset means no public data.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from '../control/audit.js';
import type { Principal } from '../control/auth.js';
import type { Condition, MetricDef } from '../contracts/types.js';
import { getActiveContract } from '../contracts/registry.js';
import { getPool, requestTenant, withTenant } from '../platform/db.js';
import { log } from '../platform/logger.js';
import { metrics } from '../platform/metrics.js';
import { listRuns, getRun } from '../analytics/runs.js';
import { execute, getCatalog, propose } from '../query/service.js';
import { businessSummary } from '../reporting/reports.js';
import { contentDir } from './content.js';

export type ToolName = 'list_metrics' | 'metric_current' | 'measure_by_period' | 'compare_periods' | 'quality_summary' | 'reconciliation_status' | 'recent_runs' | 'run_insights';
export interface ToolCall { tool: ToolName; args: Record<string, unknown> }
export type ToolErrorCode = 'unknown_tool' | 'invalid_arguments' | 'not_permitted' | 'unavailable' | 'rejected' | 'timeout' | 'failed';
export class ToolError extends Error { constructor(readonly code: ToolErrorCode, message: string) { super(message); } }

export interface ToolContext { principal: Principal; audience: 'public' | 'authenticated' }
export interface Evidence {
  id: string; tool: ToolName; title: string; computed_at: string; source: 'query' | 'report' | 'run';
  measure?: { id: string; title: string; definition: string; unit: string; entity: string; aggregation: string };
  window?: { from: string; to: string }; compare?: { a: { from: string; to: string }; b: { from: string; to: string } };
  grouping?: string[]; trust_scope: string; execution_id?: string; sql_sha256?: string; sql?: string; policy_epoch?: number;
  columns: { name: string; type?: string }[]; rows: unknown[][]; row_count: number; truncated: boolean;
  qualifications: string[]; limitations: string[]; contract_version?: string;
}

interface DataToolConfig { date_fields: Record<string, string>; dimensions: Record<string, string[]>; limits: { max_span_days: number; max_groups: number; max_calls_per_question: number } }
let cfgCache: DataToolConfig | undefined;
export const dataToolConfig = (): DataToolConfig => (cfgCache ??= JSON.parse(readFileSync(join(contentDir(), 'data-tools.json'), 'utf8')) as DataToolConfig);

// ------------------------------------------------------------------ principals

/** The identity anonymous data questions run as: a fixed, least-privileged role on one explicitly named demo tenant. */
export function publicPrincipal(correlationId: string): Principal | null {
  const tenant = process.env.ASSISTANT_PUBLIC_DATA_TENANT;
  if (!tenant) return null;
  return { actor: 'public-assistant', tokenId: 0, tenantId: tenant, role: (process.env.ASSISTANT_PUBLIC_DATA_ROLE ?? 'reporter') as Principal['role'], correlationId };
}
export const publicDataEnabled = () => !!process.env.ASSISTANT_PUBLIC_DATA_TENANT;

// ------------------------------------------------------------------ argument validation

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function isoDate(v: unknown, what: string): string {
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) throw new ToolError('invalid_arguments', `${what} must be a calendar date (YYYY-MM-DD)`);
  return v;
}
const dayMs = 86_400_000;
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
function windowOf(v: unknown, what: string): { from: string; to: string } {
  const o = (v ?? {}) as Record<string, unknown>;
  const from = isoDate(o.from, `${what}.from`), to = isoDate(o.to, `${what}.to`);
  if (from > to) throw new ToolError('invalid_arguments', `${what}: from must not be after to`);
  const span = (Date.parse(to) - Date.parse(from)) / dayMs + 1;
  if (span > dataToolConfig().limits.max_span_days) throw new ToolError('invalid_arguments', `${what}: a window may span at most ${dataToolConfig().limits.max_span_days} days`);
  if (to > addDays(new Date().toISOString().slice(0, 10), 1)) throw new ToolError('invalid_arguments', `${what}: the window cannot end in the future`);
  return { from, to };
}
function only(args: Record<string, unknown>, allowed: string[]) {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) throw new ToolError('invalid_arguments', `unknown argument "${k}"`);
}
const ident = /^[a-z][a-z0-9_]{0,62}$/;
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ------------------------------------------------------------------ measures from the contract

export interface Measure { def: MetricDef; dateField: string | null; dimensions: string[]; where: string | null }
/** Compile the metric's declared condition for the query view. Anything outside this subset disables period queries for the measure. */
function cond(c: Condition, entityFields: Set<string>): string {
  const col = (f: string) => { if (!entityFields.has(f) || !ident.test(f)) throw new ToolError('unavailable', `field ${f} is not part of the entity`); return `c.${f}`; };
  const lit = (v: unknown) => (typeof v === 'number' ? String(v) : typeof v === 'boolean' ? String(v) : quote(String(v)));
  const x = c as Record<string, unknown>;
  if ('all' in x) return `(${(x.all as Condition[]).map((k) => cond(k, entityFields)).join(' AND ')})`;
  if ('any' in x) return `(${(x.any as Condition[]).map((k) => cond(k, entityFields)).join(' OR ')})`;
  if ('not' in x) return `(NOT ${cond(x.not as Condition, entityFields)})`;
  const f = col(x.field as string);
  switch (x.op) {
    case 'eq': if ('value' in x) return `${f} = ${lit(x.value)}`; break;
    case 'ne': if ('value' in x) return `${f} <> ${lit(x.value)}`; break;
    case 'lt': case 'lte': case 'gt': case 'gte': if ('value' in x) return `${f} ${({ lt: '<', lte: '<=', gt: '>', gte: '>=' } as Record<string, string>)[x.op as string]} ${lit(x.value)}`; break;
    case 'in': return `${f} IN (${(x.values as unknown[]).map(lit).join(', ')})`;
    case 'not_in': return `${f} NOT IN (${(x.values as unknown[]).map(lit).join(', ')})`;
    case 'is_null': return `${f} IS NULL`;
    case 'not_null': return `${f} IS NOT NULL`;
  }
  throw new ToolError('unavailable', 'the metric condition is not supported for period queries');
}

export async function contractMeasures(p: Principal): Promise<{ version: string; measures: Measure[]; metrics: MetricDef[] }> {
  const active = await withTenant(p.tenantId!, (tx) => getActiveContract(tx, p.tenantId!));
  if (!active) throw new ToolError('unavailable', 'This tenant has no active contract.');
  const doc = active.document;
  const out: Measure[] = [];
  for (const m of doc.outputs.metrics) {
    const ent = doc.entities[m.entity];
    if (!ent) continue;
    const fields = new Set(Object.keys(ent.fields));
    let where: string | null = null;
    let ok = true;
    try { where = m.filter ? cond(m.filter, fields) : null; } catch { ok = false; }
    const df = dataToolConfig().date_fields[m.entity];
    const dateField = ok && df && fields.has(df) && (m.aggregation === 'count' || (m.field && fields.has(m.field)) ) ? df : null;
    out.push({ def: m, dateField, dimensions: (dataToolConfig().dimensions[m.entity] ?? []).filter((d) => fields.has(d)), where });
  }
  return { version: active.version, measures: out, metrics: doc.outputs.metrics };
}

async function visibleColumns(p: Principal): Promise<Map<string, Set<string>>> {
  const cat = await getCatalog(p);
  const m = new Map<string, Set<string>>();
  for (const t of cat.tables) m.set(t.name, new Set(t.columns.filter((c: { access: string }) => c.access === 'full').map((c: { name: string }) => c.name)));
  return m;
}
const tableCols = (vis: Map<string, Set<string>>, t: string) => vis.get(t) ?? new Set<string>();

// ------------------------------------------------------------------ evidence

async function persist(ctx: ToolContext, ev: Evidence, args: Record<string, unknown>) {
  const pool = getPool();
  await pool.query(`INSERT INTO assistant.tool_calls (id, audience, tenant_id, actor, tool, args, execution_id, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [ev.id, ctx.audience, ctx.principal.tenantId, ctx.principal.actor, ev.tool, JSON.stringify(args), ev.execution_id ?? null, JSON.stringify(ev)]);
  if (Math.random() < 0.02) await pool.query(`DELETE FROM assistant.tool_calls WHERE created_at < now() - interval '30 days'`).catch(() => {});
}

/** Public evidence is readable by its unguessable id; everything else only by the identity that made it. */
export async function readEvidence(id: string, viewer: Principal | null): Promise<Evidence | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
  const r = await getPool().query(`SELECT audience, tenant_id, actor, evidence FROM assistant.tool_calls WHERE id = $1`, [id]);
  const row = r.rows[0];
  if (!row) return null;
  if (row.audience === 'public') return row.evidence as Evidence;
  return viewer && viewer.tenantId === row.tenant_id && viewer.actor === row.actor ? (row.evidence as Evidence) : null;
}

// ------------------------------------------------------------------ SQL execution

async function runQuery(ctx: ToolContext, tool: ToolName, sql: string): Promise<{ columns: { name: string; type?: string }[]; rows: unknown[][]; row_count: number; truncated: boolean; execution_id: string; sql_sha256: string; policy_epoch: number }> {
  // The same governed flow as a person's query: a validated proposal, then an explicit execution that re-validates under the current policy.
  const pr = await propose(ctx.principal, { sql });
  if (!pr.executable) throw new ToolError('rejected', 'The calculation was not permitted for this role.');
  const res = await execute(ctx.principal, pr.id, 'run');
  if (res.status !== 'succeeded') {
    const code = res.error?.code ?? '';
    if (res.status === 'timed_out') throw new ToolError('timeout', 'The calculation exceeded its time limit.');
    if (code === 'query_not_permitted' || code === 'denied_by_database') throw new ToolError('not_permitted', 'The data needed for this answer is not available to this role.');
    throw new ToolError('failed', 'The calculation could not be completed.');
  }
  return { columns: res.columns.map((c) => ({ name: c.name, type: c.type })), rows: res.rows as unknown[][], row_count: res.row_count, truncated: res.truncated, execution_id: res.execution_id, sql_sha256: res.executed_sql_sha256, policy_epoch: res.policy_epoch };
}

const TRUST = 'Trusted batches only: for each record the latest version from a trusted batch.';
const LIMITS_COMMON = ['Aggregates over committed data at the time shown; a later answer may differ if data changes.'];

function aggExpr(m: MetricDef): string {
  const f = m.field ? `c.${m.field}` : '*';
  if (m.field && !ident.test(m.field)) throw new ToolError('unavailable', 'unsupported field');
  switch (m.aggregation) {
    case 'count': return 'count(*)';
    case 'count_distinct': return `count(DISTINCT ${f})`;
    case 'sum': return `sum(${f})`;
    case 'avg': return `round(avg(${f}), 4)`;
  }
}
const inWin = (d: string, w: { from: string; to: string }) => `(${d} >= ${quote(w.from)}::date AND ${d} <= ${quote(w.to)}::date)`;

// ------------------------------------------------------------------ tools

interface Tool { name: ToolName; description: string; authenticatedOnly?: boolean; schema: Record<string, unknown>; run(ctx: ToolContext, args: Record<string, unknown>): Promise<Evidence> }
const base = (tool: ToolName, title: string, source: Evidence['source']): Pick<Evidence, 'id' | 'tool' | 'title' | 'computed_at' | 'source' | 'trust_scope' | 'qualifications' | 'limitations'> =>
  ({ id: randomUUID(), tool, title, computed_at: new Date().toISOString(), source, trust_scope: TRUST, qualifications: [], limitations: [...LIMITS_COMMON] });

async function findMeasure(ctx: ToolContext, id: unknown): Promise<{ m: Measure; version: string }> {
  if (typeof id !== 'string' || !ident.test(id)) throw new ToolError('invalid_arguments', 'measure must be a metric id');
  const { measures, version } = await contractMeasures(ctx.principal);
  const m = measures.find((x) => x.def.id === id);
  if (!m) throw new ToolError('invalid_arguments', `unknown measure "${id}"; use list_metrics`);
  return { m, version };
}
async function checkVisible(ctx: ToolContext, m: Measure, dims: string[]) {
  const vis = tableCols(await visibleColumns(ctx.principal), m.def.entity);
  const needed = [m.dateField, m.def.field, ...dims].filter((x): x is string => !!x);
  for (const f of needed) if (!vis.has(f)) throw new ToolError('not_permitted', `The field ${f} is not available to this role.`);
  if (m.where && !vis.size) throw new ToolError('not_permitted', 'The data is not available to this role.');
}
const measureInfo = (m: Measure): NonNullable<Evidence['measure']> => ({ id: m.def.id, title: m.def.title, definition: m.def.description, unit: m.def.unit ?? 'count', entity: m.def.entity, aggregation: m.def.field ? `${m.def.aggregation}(${m.def.field})` : m.def.aggregation });

const TOOLS: Tool[] = [
  {
    name: 'list_metrics', description: 'List the business metrics (ids, titles and definitions) this tenant declares, and which support period queries.', schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx, args) {
      only(args, []);
      const { measures, version } = await contractMeasures(ctx.principal);
      return { ...base('list_metrics', 'Declared business metrics', 'report'), contract_version: version, columns: [{ name: 'id' }, { name: 'title' }, { name: 'definition' }, { name: 'supports_periods' }], rows: measures.map((m) => [m.def.id, m.def.title, m.def.description, m.dateField !== null]), row_count: measures.length, truncated: false };
    },
  },
  {
    name: 'metric_current', description: 'The current value of one declared business metric over trusted data (all time), with its definition and any qualification from failing dataset checks.',
    schema: { type: 'object', properties: { measure: { type: 'string', description: 'metric id from list_metrics' } }, required: ['measure'], additionalProperties: false },
    async run(ctx, args) {
      only(args, ['measure']);
      const { m, version } = await findMeasure(ctx, args.measure);
      const s = await businessSummary(ctx.principal.tenantId!, ctx.principal.role);
      const x = s.metrics.find((k: { id: string }) => k.id === m.def.id);
      if (!x) throw new ToolError('unavailable', 'The metric is not available.');
      const q: string[] = [];
      if (x.withheld) throw new ToolError('not_permitted', String(x.withheld));
      for (const c of x.dataset_checks_failing ?? []) q.push(`Qualified: dataset check ${c.check_id} is failing (${c.explanation}).`);
      if (Number(x.untrusted_records_excluded) > 0) q.push(`${x.untrusted_records_excluded} current records from untrusted batches are excluded from the trusted value.`);
      return { ...base('metric_current', `${m.def.title}: current value`, 'report'), measure: measureInfo(m), contract_version: version, window: undefined, columns: [{ name: 'value' }, { name: 'value_including_untrusted' }, { name: 'untrusted_records_excluded' }],
        rows: [[x.value, x.value_including_untrusted, x.untrusted_records_excluded]], row_count: 1, truncated: false, qualifications: q };
    },
  },
  {
    name: 'measure_by_period', description: 'A declared metric over a date window, optionally grouped by month, week or day, or by an allowed dimension. Computed from trusted data by a validated query.',
    schema: { type: 'object', properties: { measure: { type: 'string' }, from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' }, grain: { type: 'string', enum: ['none', 'day', 'week', 'month'] }, dimension: { type: 'string', description: 'an allowed dimension such as status' } }, required: ['measure', 'from', 'to'], additionalProperties: false },
    async run(ctx, args) {
      only(args, ['measure', 'from', 'to', 'grain', 'dimension']);
      const { m, version } = await findMeasure(ctx, args.measure);
      if (!m.dateField) throw new ToolError('unavailable', `${m.def.title} supports current values only, not periods.`);
      const w = windowOf({ from: args.from, to: args.to }, 'window');
      const grain = (args.grain ?? 'none') as string;
      if (!['none', 'day', 'week', 'month'].includes(grain)) throw new ToolError('invalid_arguments', 'grain must be none, day, week or month');
      const dim = args.dimension === undefined || args.dimension === 'none' ? null : String(args.dimension);
      if (dim !== null && !m.dimensions.includes(dim)) throw new ToolError('invalid_arguments', `dimension must be one of: ${m.dimensions.join(', ') || 'none available'}`);
      await checkVisible(ctx, m, dim ? [dim] : []);
      const d = `c.${m.dateField}`;
      const sel: string[] = [], grp: string[] = [];
      if (grain !== 'none') { sel.push(`date_trunc('${grain}', ${d})::date AS period`); grp.push('1'); }
      if (dim) { sel.push(`c.${dim} AS ${dim}`); grp.push(String(grp.length + 1)); }
      sel.push(`${aggExpr(m.def)} AS value`, 'count(*) AS records');
      const sql = `SELECT ${sel.join(', ')}\nFROM ${m.def.entity} c\nWHERE c._trust_status = 'trusted' AND ${inWin(d, w)}${m.where ? `\n  AND ${m.where}` : ''}${grp.length ? `\nGROUP BY ${grp.join(', ')}\nORDER BY ${grp.join(', ')}` : ''}\nLIMIT ${dataToolConfig().limits.max_groups}`;
      const r = await runQuery(ctx, 'measure_by_period', sql);
      const q = r.truncated || r.rows.length >= dataToolConfig().limits.max_groups ? [`The result is limited to ${dataToolConfig().limits.max_groups} groups and may be incomplete; use a narrower window or a coarser grouping.`] : [];
      return { ...base('measure_by_period', `${m.def.title}, ${w.from} to ${w.to}`, 'query'), measure: measureInfo(m), contract_version: version, window: w, grouping: [grain !== 'none' ? grain : '', dim ?? ''].filter(Boolean), sql, ...r, qualifications: q,
        limitations: [...LIMITS_COMMON, `The window is by ${m.dateField} (inclusive of both dates).`] };
    },
  },
  {
    name: 'compare_periods', description: 'Compare one declared metric between two date windows (a = baseline, b = comparison): both values, the difference and the percentage change, computed by a validated query.',
    schema: { type: 'object', properties: { measure: { type: 'string' }, a_from: { type: 'string' }, a_to: { type: 'string' }, b_from: { type: 'string' }, b_to: { type: 'string' } }, required: ['measure', 'a_from', 'a_to', 'b_from', 'b_to'], additionalProperties: false },
    async run(ctx, args) {
      only(args, ['measure', 'a_from', 'a_to', 'b_from', 'b_to']);
      const { m, version } = await findMeasure(ctx, args.measure);
      if (!m.dateField) throw new ToolError('unavailable', `${m.def.title} supports current values only, not periods.`);
      const a = windowOf({ from: args.a_from, to: args.a_to }, 'baseline'), b = windowOf({ from: args.b_from, to: args.b_to }, 'comparison');
      await checkVisible(ctx, m, []);
      const d = `c.${m.dateField}`;
      const part = (w: { from: string; to: string }) => {
        const f = m.def.aggregation === 'count' ? '1' : m.def.field ? `c.${m.def.field}` : '1';
        const when = `CASE WHEN ${inWin(d, w)} THEN ${f} END`;
        return m.def.aggregation === 'count' ? `count(${when})` : m.def.aggregation === 'count_distinct' ? `count(DISTINCT ${when})` : m.def.aggregation === 'sum' ? `sum(${when})` : `round(avg(${when}), 4)`;
      };
      const sql = `SELECT a_value, b_value, b_value - a_value AS change, CASE WHEN a_value <> 0 THEN round((b_value - a_value) * 100.0 / a_value, 2) END AS pct_change\nFROM (SELECT ${part(a)} AS a_value, ${part(b)} AS b_value\n  FROM ${m.def.entity} c\n  WHERE c._trust_status = 'trusted'${m.where ? ` AND ${m.where}` : ''}) t`;
      const r = await runQuery(ctx, 'compare_periods', sql);
      return { ...base('compare_periods', `${m.def.title}: ${b.from} to ${b.to} versus ${a.from} to ${a.to}`, 'query'), measure: measureInfo(m), contract_version: version, compare: { a, b }, sql, ...r,
        limitations: [...LIMITS_COMMON, 'A difference between two windows is a measurement, not an explanation; windows of different length or seasonality are not directly comparable.'] };
    },
  },
  {
    name: 'quality_summary', description: 'Rows received, rows quarantined and the exception (rejection) rate across processed batches arriving in a date window.',
    schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'], additionalProperties: false },
    async run(ctx, args) {
      only(args, ['from', 'to']);
      const w = windowOf(args, 'window');
      const vis = tableCols(await visibleColumns(ctx.principal), 'batches');
      for (const c of ['received_count', 'quarantined_count', 'arrival_at', 'status']) if (!vis.has(c)) throw new ToolError('not_permitted', 'Batch quality figures are not available to this role.');
      const sql = `SELECT count(*) AS batches, sum(b.received_count) AS rows_received, sum(b.quarantined_count) AS rows_quarantined,\n  round(sum(b.quarantined_count) * 100.0 / nullif(sum(b.received_count), 0), 2) AS exception_rate_pct\nFROM batches b\nWHERE b.status IN ('completed', 'completed_with_exceptions') AND b.arrival_at >= ${quote(w.from)}::date AND b.arrival_at < ${quote(addDays(w.to, 1))}::date`;
      const r = await runQuery(ctx, 'quality_summary', sql);
      return { ...base('quality_summary', `Data quality, batches arriving ${w.from} to ${w.to}`, 'query'), window: w, sql, ...r,
        measure: { id: 'exception_rate', title: 'Exception rate', definition: 'rows_quarantined divided by rows_received across processed batches (completed or completed with exceptions), by batch arrival date.', unit: 'percent', entity: 'batches', aggregation: 'sum/sum' },
        trust_scope: 'All processed batches in the window, trusted or not: this measures intake quality, not reported figures.', limitations: [...LIMITS_COMMON, 'The window is by batch arrival time, not by the date inside the records.'] };
    },
  },
  {
    name: 'reconciliation_status', description: 'The latest dataset-level reconciliation run: each check with its status and explanation.', schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx, args) {
      only(args, []);
      const vis = tableCols(await visibleColumns(ctx.principal), 'reconciliation_results');
      for (const c of ['check_id', 'status', 'explanation', 'scope', 'run_id', 'created_at']) if (!vis.has(c)) throw new ToolError('not_permitted', 'Reconciliation results are not available to this role.');
      const sql = `SELECT r.check_id, r.status, r.explanation\nFROM reconciliation_results r\nWHERE r.scope = 'dataset' AND r.run_id = (SELECT x.run_id FROM reconciliation_results x WHERE x.scope = 'dataset' ORDER BY x.created_at DESC LIMIT 1)\nORDER BY r.check_id\nLIMIT 60`;
      const r = await runQuery(ctx, 'reconciliation_status', sql);
      return { ...base('reconciliation_status', 'Latest dataset reconciliation', 'query'), sql, ...r, trust_scope: 'Dataset-level checks from the most recent run.', limitations: ['Agreement between checks shows the data is consistent with its control totals; it does not prove the source data was correct.'] };
    },
  },
  {
    name: 'recent_runs', description: 'Your most recent saved-query runs (status, rows, time). Signed-in users only; limited to runs you may see.', authenticatedOnly: true, schema: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx, args) {
      only(args, []);
      const r = await listRuns(ctx.principal, { limit: 5 });
      return { ...base('recent_runs', 'Recent runs', 'run'), trust_scope: 'Runs visible to you.', columns: [{ name: 'run_id' }, { name: 'query' }, { name: 'status' }, { name: 'created_at' }, { name: 'row_count' }],
        rows: r.items.map((x: any) => [x.id, x.query_name, x.status, x.created_at, x.result?.row_count ?? null]), row_count: r.items.length, truncated: false };  // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  },
  {
    name: 'run_insights', description: 'The recorded analyses and insights of one run, with their method, quality and limitations. Signed-in users only; re-authorized for your role.', authenticatedOnly: true,
    schema: { type: 'object', properties: { run_id: { type: 'string', description: 'run uuid' } }, required: ['run_id'], additionalProperties: false },
    async run(ctx, args) {
      only(args, ['run_id']);
      if (typeof args.run_id !== 'string' || !/^[0-9a-f-]{36}$/.test(args.run_id)) throw new ToolError('invalid_arguments', 'run_id must be a run uuid');
      const d: any = await getRun(ctx.principal, args.run_id);   // eslint-disable-line @typescript-eslint/no-explicit-any
      const q: string[] = [];
      if (!d.access.data) q.push(`Result data is withheld for your role: ${d.access.reason ?? 'your access has narrowed since this run'}.`);
      if (d.insights_withheld > 0) q.push(`${d.insights_withheld} insights are withheld because they depend on columns redacted for you.`);
      return { ...base('run_insights', `Run ${String(d.run.id).slice(0, 8)} of "${d.query.name}"`, 'run'), trust_scope: 'As recorded by the run, re-authorized for your role now.',
        columns: [{ name: 'analysis' }, { name: 'method' }, { name: 'status' }, { name: 'severity' }, { name: 'insight' }],
        rows: [...d.analyses.map((a: any) => [a.key, `${a.algorithm} v${a.algorithm_version}`, a.status, null, a.message ?? null]), ...d.insights.map((i: any) => [i.analysis_run_id ? 'insight' : 'status', i.kind, null, i.severity, `${i.title}. ${i.body}`])],
        row_count: d.analyses.length + d.insights.length, truncated: false, qualifications: q,
        limitations: ['Insights are statistical deviations or projections computed by the listed methods. They are not explanations of cause.', ...d.analyses.flatMap((a: any) => (Array.isArray(a.result?.limitations) ? a.result.limitations.slice(0, 2) : []))] };
    },
  },
];

export const toolNames = () => TOOLS.map((t) => t.name);
export function toolSchemas(audience: 'public' | 'authenticated') {
  return TOOLS.filter((t) => audience === 'authenticated' || !t.authenticatedOnly).map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
}

/** Validate, authorize, execute and record one tool call. Throws ToolError; never returns a value that was not computed. */
export async function executeTool(ctx: ToolContext, call: ToolCall): Promise<Evidence> {
  const t0 = performance.now();
  const tool = TOOLS.find((t) => t.name === call.tool);
  const fail = (e: ToolError, tenant = ctx.principal.tenantId) => {
    metrics.assistantToolCalls.inc({ tool: String(call.tool), outcome: e.code });
    void audit({ tenantId: tenant ?? 'platform', actor: ctx.principal.actor, role: ctx.principal.role, action: 'assistant.tool', resource: String(call.tool), outcome: e.code === 'not_permitted' ? 'denied' : 'failed', details: { audience: ctx.audience, code: e.code }, correlationId: ctx.principal.correlationId });
    return e;
  };
  if (!tool) throw fail(new ToolError('unknown_tool', `unknown tool "${String(call.tool)}"`));
  if (!ctx.principal.tenantId) throw fail(new ToolError('unavailable', 'No tenant data is available to this identity.'));
  if (tool.authenticatedOnly && ctx.audience !== 'authenticated') throw fail(new ToolError('not_permitted', 'This information needs a signed-in session.'));
  if (typeof call.args !== 'object' || call.args === null || Array.isArray(call.args)) throw fail(new ToolError('invalid_arguments', 'arguments must be an object'));
  try {
    // The request-bound tenant scope makes the data layer refuse any other tenant, whatever the arguments say.
    const ev = await requestTenant.run({ tenantId: ctx.principal.tenantId, actor: ctx.principal.actor }, () => tool.run(ctx, call.args));
    await persist(ctx, ev, call.args);
    metrics.assistantToolCalls.inc({ tool: call.tool, outcome: 'ok' });
    metrics.assistantToolSeconds.observe((performance.now() - t0) / 1000, { tool: call.tool });
    void audit({ tenantId: ctx.principal.tenantId, actor: ctx.principal.actor, role: ctx.principal.role, action: 'assistant.tool', resource: call.tool, outcome: 'allowed', details: { audience: ctx.audience, evidence_id: ev.id, execution_id: ev.execution_id ?? null, rows: ev.row_count }, correlationId: ctx.principal.correlationId });
    return ev;
  } catch (e) {
    if (e instanceof ToolError) throw fail(e);
    const code = (e as { status?: number; code?: string }).code;
    if ((e as { status?: number }).status === 403 || code === 'query_not_permitted') throw fail(new ToolError('not_permitted', 'This information is not available to your role.'));
    if ((e as { status?: number }).status === 404) throw fail(new ToolError('unavailable', 'The requested information was not found.'));
    log.warn('assistant tool failed', { tool: call.tool, error: (e as Error).message.slice(0, 200) });
    throw fail(new ToolError('failed', 'The calculation could not be completed.'));
  }
}
