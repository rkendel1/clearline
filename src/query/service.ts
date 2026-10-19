// The query workspace lifecycle. Every step re-derives identity, tenant and
// permissions from the authenticated principal; nothing from the client or the
// model is trusted.
//
//   propose   question -> permitted catalog -> provider -> UNTRUSTED SQL -> validate -> EXPLAIN estimate
//             (or hand-written / edited SQL -> validate -> EXPLAIN). Never executes the query.
//   execute   explicit request naming a stored proposal -> re-validate under the CURRENT policy ->
//             cost check -> read-only transaction as the tenant query role -> masked rows
//   history   proposals and execution metadata, re-validated for the viewer before serving
//
// Result rows are returned to the caller and never persisted. Audit events carry
// identifiers, hashes, counts and column names, never values.

import { createHash, randomUUID } from 'node:crypto';
import { stringify } from 'csv-stringify/sync';
import { cancelQueryBackend, withTenant, withQueryRole, type Tx } from '../platform/db.js';
import { loadConfig } from '../platform/config.js';
import { AppError, badRequest, notFound } from '../platform/errors.js';
import { log } from '../platform/logger.js';
import { can, type Principal } from '../control/auth.js';
import { audit, auditTx } from '../control/audit.js';
import { getActiveContract } from '../contracts/registry.js';
import { loadPolicies, type PolicySet } from '../policy/fields.js';
import { scrubSensitive } from '../quality/sensitive.js';
import { buildCatalog, catalogJson, type Catalog } from './catalog.js';
import { queryRole, querySurfaceCurrent, syncQuerySurface } from './surface.js';
import { validateSql, type ValidationResult } from './validate.js';
import { getProvider, ProviderUnavailable } from './providers/index.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface Ctx { set: PolicySet; catalog: Catalog; contractVersionId: number }

async function context(tx: Tx, p: Principal): Promise<Ctx> {
  const active = await getActiveContract(tx, p.tenantId!);
  if (!active) throw notFound('no active contract');
  const set = await loadPolicies(tx, p.tenantId!, active.document);
  return { set, catalog: buildCatalog(set, p.role), contractVersionId: active.id };
}

/** Make sure the database query surface matches the active contract and policies (regenerated lazily for older tenants). */
async function ensureSurface(tenant: string): Promise<void> {
  const stale = await withTenant(tenant, async (tx) => {
    const active = await getActiveContract(tx, tenant);
    if (!active) return false;
    const set = await loadPolicies(tx, tenant, active.document);
    return !(await querySurfaceCurrent(tx, tenant, active.id, set.epoch));
  });
  if (stale) await withTenant(tenant, (tx) => syncQuerySurface(tx, tenant));
}

export async function getCatalog(p: Principal) {
  await ensureSurface(p.tenantId!);
  return withTenant(p.tenantId!, async (tx) => {
    const c = await context(tx, p);
    return { ...catalogJson(c.catalog), policy_epoch: c.set.epoch, provider: { id: getProvider().id, model: getProvider().model } };
  });
}

// ------------------------------------------------------------------ database errors

interface ExecFailure { status: 'failed' | 'timed_out' | 'cancelled'; code: string; message: string }

/** Database errors are mapped to safe messages; only data errors over visible values pass their text through. */
function classify(err: unknown, cancelled: boolean): ExecFailure {
  const e = err as { code?: string; message?: string };
  const code = e.code ?? '';
  if (code === '57014') return cancelled ? { status: 'cancelled', code: 'cancelled', message: 'The query was cancelled.' } : { status: 'timed_out', code: 'timeout', message: 'The query exceeded the time limit and was stopped.' };
  if (code === '42501') return { status: 'failed', code: 'denied_by_database', message: 'The query referenced data that is not available to your role.' };
  if (code.startsWith('22')) return { status: 'failed', code: 'data_error', message: `Data error: ${String(e.message).slice(0, 300)}` };
  if (code.startsWith('42')) return { status: 'failed', code: 'invalid_query', message: `The query is not valid: ${String(e.message).slice(0, 300)}` };
  if (code.startsWith('53') || code.startsWith('54')) return { status: 'failed', code: 'resource_limit', message: 'The query exceeded a resource limit.' };
  return { status: 'failed', code: 'execution_failed', message: 'The query failed. Quote the execution id when reporting it.' };
}

async function estimate(tenant: string, dbRole: string, sql: string): Promise<{ cost: number; rows: number } | ExecFailure> {
  const cfg = loadConfig();
  try {
    return await withQueryRole(tenant, dbRole, cfg.queryTimeoutMs, async (c) => {
      const plan = (await c.query(`EXPLAIN (FORMAT JSON) ${sql}`)).rows[0]['QUERY PLAN'][0].Plan;
      return { cost: Number(plan['Total Cost']), rows: Number(plan['Plan Rows']) };
    });
  } catch (err) {
    const f = classify(err, false);
    if (f.code === 'denied_by_database') log.error('query denied by database privileges after validation passed', { tenant, role: dbRole });
    return f;
  }
}

// ------------------------------------------------------------------ proposals

export interface ProposeInput { question?: unknown; sql?: unknown; parent_id?: unknown }

function validationJson(v: ValidationResult) {
  return { ok: v.ok, issues: v.issues, tables: v.tables, columns: v.columns, joins: v.joins, output: v.output, summary: v.summary };
}

async function visibleProposal(tx: Tx, p: Principal, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('query proposal');
  const row = (await tx.query(`SELECT * FROM core.query_proposals WHERE id = $1 AND tenant_id = $2`, [id, p.tenantId])).rows[0];
  if (!row || (row.actor !== p.actor && !can(p, 'query:history_all'))) throw notFound('query proposal');
  return row;
}

export async function propose(p: Principal, input: ProposeInput) {
  const tenant = p.tenantId!;
  const cfg = loadConfig();
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  const sqlIn = typeof input.sql === 'string' ? input.sql : '';
  if (!question && !sqlIn.trim()) throw badRequest('missing_input', 'Provide a question or SQL.');
  if (question.length > 2000) throw badRequest('question_too_long', 'Questions are limited to 2000 characters.');
  const parentId = typeof input.parent_id === 'string' ? input.parent_id : null;
  await ensureSurface(tenant);

  const ctx = await withTenant(tenant, async (tx) => {
    if (parentId) await visibleProposal(tx, p, parentId);
    return context(tx, p);
  });
  const id = randomUUID();
  const provider = getProvider();
  const scrubbed = scrubSensitive(question);
  let source: 'generated' | 'edited' | 'manual';
  let proposedSql: string | null = null;
  let explanation: string | null = null;
  let assumptions: string[] = [];

  if (sqlIn.trim()) {
    source = parentId ? 'edited' : 'manual';
    proposedSql = sqlIn;
  } else {
    source = 'generated';
    await audit({ tenantId: tenant, actor: p.actor, role: p.role, action: 'query.request', resource: `query:${id}`, outcome: 'succeeded',
      details: { question_sha256: sha(question), question_length: question.length, identifiers_scrubbed: scrubbed.kinds, provider: provider.id, model: provider.model }, correlationId: p.correlationId });
    try {
      const out = await provider.generate({ question: scrubbed.text, catalog: catalogJson(ctx.catalog), dialect: 'postgresql', today: new Date().toISOString().slice(0, 10) });
      if (out.kind === 'cannot_answer') explanation = out.explanation;
      else { proposedSql = out.sql; explanation = out.explanation; assumptions = out.assumptions; }
    } catch (err) {
      if (!(err instanceof ProviderUnavailable)) throw err;
      await withTenant(tenant, async (tx) => {
        await tx.query(`INSERT INTO core.query_proposals (id, tenant_id, actor, role, source, parent_id, question, provider, model, status, validation, policy_epoch, correlation_id)
          VALUES ($1,$2,$3,$4,'generated',$5,$6,$7,$8,'generation_failed',$9,$10,$11)`,
          [id, tenant, p.actor, p.role, parentId, scrubbed.text, provider.id, provider.model, JSON.stringify({ ok: false, issues: [{ code: 'provider_unavailable', message: err.message }] }), ctx.set.epoch, p.correlationId]);
        await auditTx(tx, { tenantId: tenant, actor: p.actor, role: p.role, action: 'query.proposal.generated', resource: `query:${id}`, outcome: 'failed',
          details: { provider: provider.id, reason: 'provider_unavailable', retryable: err.retryable }, correlationId: p.correlationId });
      });
      throw new AppError(503, 'provider_unavailable', err.message, { provider: provider.id, retryable: err.retryable, proposal_id: id, hint: 'You can still write or paste SQL and validate it.' });
    }
  }

  // Validate the actual SQL structure (never the question), then estimate without executing.
  let v: ValidationResult | null = null;
  let est: { cost: number; rows: number } | null = null;
  const issues = [];
  if (proposedSql !== null) {
    v = await validateSql(proposedSql, ctx.catalog, { maxRows: cfg.queryMaxRows });
    if (v.ok) {
      const e = await estimate(tenant, queryRole(tenant, p.role), v.validated_sql!);
      if ('cost' in e) {
        est = e;
        if (e.cost > cfg.queryMaxCost) issues.push({ code: 'too_expensive', message: `The estimated cost (${Math.round(e.cost)}) exceeds the limit (${cfg.queryMaxCost}); add filters or aggregate.` });
      } else issues.push({ code: e.code, message: e.message });
    }
  } else {
    issues.push({ code: 'cannot_answer', message: explanation ?? 'No SQL was proposed.' });
  }
  const validation = v ? { ...validationJson(v), ok: v.ok && !issues.length, issues: [...v.issues, ...issues] } : { ok: false, issues, tables: [], columns: [], joins: [], output: [], summary: [] };
  const ok = validation.ok;

  await withTenant(tenant, async (tx) => {
    await tx.query(`INSERT INTO core.query_proposals (id, tenant_id, actor, role, source, parent_id, question, provider, model, proposed_sql, explanation, status, validation,
        validated_sql, validated_sql_sha256, estimate, policy_epoch, correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, tenant, p.actor, p.role, source, parentId, question ? scrubbed.text : null, source === 'generated' ? provider.id : null, source === 'generated' ? provider.model : null,
        proposedSql, explanation, ok ? 'valid' : 'rejected', JSON.stringify({ ...validation, assumptions }), ok ? v!.validated_sql : null, ok ? v!.validated_sql_sha256 : null,
        est ? JSON.stringify(est) : null, ctx.set.epoch, p.correlationId]);
    if (source === 'generated') {
      await auditTx(tx, { tenantId: tenant, actor: p.actor, role: p.role, action: 'query.proposal.generated', resource: `query:${id}`, outcome: proposedSql ? 'succeeded' : 'failed',
        details: { provider: provider.id, model: provider.model, proposed_sql_sha256: proposedSql ? sha(proposedSql) : null, cannot_answer: !proposedSql }, correlationId: p.correlationId });
    }
    if (proposedSql !== null) {
      await auditTx(tx, { tenantId: tenant, actor: p.actor, role: p.role, action: 'query.validation', resource: `query:${id}`, outcome: ok ? 'succeeded' : 'failed',
        details: { source, parent_id: parentId, issue_codes: validation.issues.map((i) => i.code), tables: validation.tables, columns: validation.columns.map((c) => `${c.table}.${c.column}`),
          masked_output: validation.output.filter((o) => o.masked).map((o) => o.name), validated_sql_sha256: ok ? v!.validated_sql_sha256 : null, estimate: est, policy_epoch: ctx.set.epoch },
        correlationId: p.correlationId });
    }
  });
  return {
    id, source, parent_id: parentId, question: question ? scrubbed.text : null, provider: source === 'generated' ? { id: provider.id, model: provider.model } : null,
    proposed_sql: proposedSql, model_explanation: explanation, assumptions, validation, validated_sql: ok ? v!.validated_sql : null, estimate: est,
    executable: ok, executed: false, policy_epoch: ctx.set.epoch,
  };
}

export async function getProposal(p: Principal, id: string) {
  return withTenant(p.tenantId!, async (tx) => serializeProposal(p, await visibleProposal(tx, p, id), await context(tx, p)));
}

// ------------------------------------------------------------------ execution

const running = new Map<string, { pid: number | null; cancelled: boolean; tenant: string; actor: string }>();
const perTenant = new Map<string, number>();
let total = 0;

export interface ExecuteResult {
  execution_id: string; proposal_id: string; mode: string; status: string; columns: { name: string; type: string; masked: string | null }[];
  rows: unknown[][]; row_count: number; truncated: boolean; duration_ms: number; executed_sql: string; executed_sql_sha256: string; policy_epoch: number;
  error?: { code: string; message: string };
}

const PG_TYPES: Record<number, string> = { 16: 'boolean', 20: 'integer', 21: 'integer', 23: 'integer', 25: 'string', 700: 'decimal', 701: 'decimal', 1043: 'string', 1082: 'date',
  1114: 'timestamp', 1184: 'timestamp', 1186: 'interval', 1700: 'decimal', 2950: 'uuid' };

export async function execute(p: Principal, proposalId: string, mode: 'preview' | 'run' | 'export'): Promise<ExecuteResult> {
  const tenant = p.tenantId!;
  const cfg = loadConfig();
  if (!['preview', 'run', 'export'].includes(mode)) throw badRequest('invalid_mode', 'mode must be preview, run or export');
  await ensureSurface(tenant);
  const { row, ctx } = await withTenant(tenant, async (tx) => ({ row: await visibleProposal(tx, p, proposalId), ctx: await context(tx, p) }));
  if (!row.proposed_sql) throw new AppError(422, 'not_executable', 'This proposal has no SQL to run.');

  await audit({ tenantId: tenant, actor: p.actor, role: p.role, action: 'query.execution.requested', resource: `query:${proposalId}`, outcome: 'allowed',
    details: { mode, policy_epoch: ctx.set.epoch }, correlationId: p.correlationId });
  // Re-validate under the current policy: a proposal validated earlier (or by someone else) is not trusted.
  const cap = mode === 'preview' ? cfg.queryPreviewRows : cfg.queryMaxRows;
  const v = await validateSql(row.proposed_sql, ctx.catalog, { maxRows: cfg.queryMaxRows });
  if (!v.ok) {
    await audit({ tenantId: tenant, actor: p.actor, role: p.role, action: 'query.validation', resource: `query:${proposalId}`, outcome: 'denied',
      details: { stage: 'execute', issue_codes: v.issues.map((i) => i.code), policy_epoch: ctx.set.epoch }, correlationId: p.correlationId });
    throw new AppError(403, 'query_not_permitted', v.issues[0]?.message ?? 'The query is not permitted.', { issues: v.issues });
  }
  const executedSql = await v.withLimit!(cap + 1);
  const dbRole = queryRole(tenant, p.role);
  const est = await estimate(tenant, dbRole, executedSql);
  if (!('cost' in est)) throw new AppError(422, est.code, est.message);
  if (est.cost > cfg.queryMaxCost) throw new AppError(422, 'too_expensive', `The estimated cost (${Math.round(est.cost)}) exceeds the limit (${cfg.queryMaxCost}).`);

  const n = perTenant.get(tenant) ?? 0;
  if (n >= cfg.queryMaxConcurrentPerTenant || total >= cfg.queryMaxConcurrent) {
    throw new AppError(429, 'query_concurrency_limit', 'Too many queries are running; wait for one to finish or cancel it.');
  }
  perTenant.set(tenant, n + 1); total++;
  const id = randomUUID();
  const masked = v.output.filter((o) => o.masked).map((o) => ({ column: o.name, field: `${o.table}.${o.column}`, redaction: o.masked }));
  await withTenant(tenant, (tx) => tx.query(`INSERT INTO core.query_executions (id, tenant_id, proposal_id, actor, role, mode, executed_sql, executed_sql_sha256, status, masked_columns, policy_epoch, correlation_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,$10,$11)`, [id, tenant, proposalId, p.actor, p.role, mode, executedSql, sha(executedSql), JSON.stringify(masked), ctx.set.epoch, p.correlationId]));
  const state = { pid: null as number | null, cancelled: false, tenant, actor: p.actor };
  running.set(id, state);
  const started = performance.now();
  let result: ExecuteResult;
  try {
    const res = await withQueryRole(tenant, dbRole, cfg.queryTimeoutMs, async (c) => {
      if (state.cancelled) throw Object.assign(new Error('cancelled before start'), { code: '57014' });
      return c.query({ text: executedSql, rowMode: 'array' });
    }, (pid) => { state.pid = pid; });
    const columns = res.fields.map((f, i) => ({ name: f.name, type: PG_TYPES[f.dataTypeID] ?? 'string', masked: v.output[i]?.masked ?? null }));
    let rows = res.rows as unknown[][];
    let truncated = rows.length > cap;
    if (truncated) rows = rows.slice(0, cap);
    // Result size cap (serialized), applied on whole rows.
    let bytes = 0;
    for (let i = 0; i < rows.length; i++) {
      bytes += JSON.stringify(rows[i]).length;
      if (bytes > cfg.queryMaxResultBytes) { rows = rows.slice(0, i); truncated = true; break; }
    }
    rows = rows.map((r) => r.map((x) => (x instanceof Date ? x.toISOString() : x)));
    const ms = Math.round(performance.now() - started);
    result = { execution_id: id, proposal_id: proposalId, mode, status: 'succeeded', columns, rows, row_count: rows.length, truncated, duration_ms: ms, executed_sql: executedSql, executed_sql_sha256: sha(executedSql), policy_epoch: ctx.set.epoch };
  } catch (err) {
    const f = classify(err, state.cancelled);
    if (f.code === 'denied_by_database') log.error('query denied by database privileges after validation passed', { tenant, role: p.role, execution: id });
    if (f.code === 'execution_failed') log.error('query execution failed', { execution: id, error: err as Error });
    result = { execution_id: id, proposal_id: proposalId, mode, status: f.status, columns: [], rows: [], row_count: 0, truncated: false, duration_ms: Math.round(performance.now() - started),
      executed_sql: executedSql, executed_sql_sha256: sha(executedSql), policy_epoch: ctx.set.epoch, error: { code: f.code, message: f.message } };
  } finally {
    running.delete(id);
    perTenant.set(tenant, (perTenant.get(tenant) ?? 1) - 1); total--;
  }
  await withTenant(tenant, async (tx) => {
    await tx.query(`UPDATE core.query_executions SET status = $2, row_count = $3, truncated = $4, duration_ms = $5, columns = $6, error_code = $7, finished_at = clock_timestamp() WHERE id = $1`,
      [id, result.status, result.row_count, result.truncated, result.duration_ms, JSON.stringify(result.columns), result.error?.code ?? null]);
    await auditTx(tx, { tenantId: tenant, actor: p.actor, role: p.role, action: 'query.execution', resource: `query:${proposalId}`, outcome: result.status === 'succeeded' ? 'succeeded' : 'failed',
      details: { execution_id: id, mode, status: result.status, error_code: result.error?.code ?? null, row_count: result.row_count, truncated: result.truncated, duration_ms: result.duration_ms,
        proposed_sql_sha256: sha(row.proposed_sql), executed_sql_sha256: result.executed_sql_sha256, columns: result.columns.map((c) => c.name), redaction_applied: masked, policy_epoch: ctx.set.epoch },
      correlationId: p.correlationId });
  });
  return result;
}

export async function cancel(p: Principal, executionId: string) {
  const s = running.get(executionId);
  if (!s || s.tenant !== p.tenantId || (s.actor !== p.actor && !can(p, 'query:history_all'))) throw notFound('running query');
  s.cancelled = true;
  if (s.pid) await cancelQueryBackend(s.pid);
  await audit({ tenantId: p.tenantId, actor: p.actor, role: p.role, action: 'query.execution.cancel', resource: `execution:${executionId}`, outcome: 'succeeded', details: {}, correlationId: p.correlationId });
  return { execution_id: executionId, cancelling: true };
}

export async function exportCsv(p: Principal, proposalId: string) {
  const r = await execute(p, proposalId, 'export');
  if (r.status !== 'succeeded') throw new AppError(422, r.error!.code, r.error!.message);
  const csv = stringify([r.columns.map((c) => c.name), ...r.rows.map((row) => row.map((x) => (x === null ? '' : String(x))))]);
  return { csv, meta: { execution_id: r.execution_id, row_count: r.row_count, truncated: r.truncated, redacted_columns: r.columns.filter((c) => c.masked).map((c) => c.name), sha256: sha(csv) } };
}

// ------------------------------------------------------------------ history

const ACCESS_CODES = new Set(['unknown_column', 'unknown_table', 'restricted_field']);

async function serializeProposal(p: Principal, row: Record<string, any>, ctx: Ctx) {
  const executions = (row._executions ?? []) as Record<string, any>[];
  const own = row.actor === p.actor;
  // Re-evaluate stored SQL against the viewer's CURRENT access before showing it: someone else's
  // query that references data this viewer may not use (or not use that way) is withheld.
  let executableNow = false;
  let withheld = false;
  if (row.proposed_sql) {
    const v = await validateSql(row.proposed_sql, ctx.catalog, { maxRows: 10 });
    executableNow = v.ok;
    withheld = !own && !v.ok && ACCESS_CODES.has(v.issues[0]?.code);
  }
  return {
    id: row.id, actor: row.actor, role: row.role, source: row.source, parent_id: row.parent_id, created_at: row.created_at, status: row.status,
    question: withheld ? null : row.question,
    provider: row.provider ? { id: row.provider, model: row.model } : null,
    proposed_sql: withheld ? null : row.proposed_sql, model_explanation: withheld ? null : row.explanation,
    validated_sql: withheld ? null : row.validated_sql,
    validation: withheld ? { ok: false, issues: [{ code: 'withheld', message: 'This query references data that is not available to your role under the current policy.' }] } : row.validation,
    estimate: row.estimate, policy_epoch: Number(row.policy_epoch), current_policy_epoch: ctx.set.epoch, stale_policy: Number(row.policy_epoch) !== ctx.set.epoch,
    withheld, executable_now: executableNow,
    executions: executions.map((e) => ({ id: e.id, mode: e.mode, status: e.status, row_count: e.row_count, truncated: e.truncated, duration_ms: e.duration_ms, started_at: e.started_at,
      error_code: e.error_code, executed_sql: withheld ? null : e.executed_sql, columns: withheld ? null : e.columns, policy_epoch: Number(e.policy_epoch) })),
  };
}

export async function history(p: Principal, opts: { limit: number; all: boolean }) {
  return withTenant(p.tenantId!, async (tx) => {
    const ctx = await context(tx, p);
    const everyone = opts.all && can(p, 'query:history_all');
    const { rows } = await tx.query(`SELECT * FROM core.query_proposals WHERE tenant_id = $1 AND ($2 OR actor = $3) ORDER BY created_at DESC LIMIT $4`,
      [p.tenantId, everyone, p.actor, opts.limit]);
    const ids = rows.map((r) => r.id);
    const ex = ids.length ? (await tx.query(`SELECT * FROM core.query_executions WHERE proposal_id = ANY($1) ORDER BY started_at DESC`, [ids])).rows : [];
    for (const r of rows) r._executions = ex.filter((e) => e.proposal_id === r.id);
    return { policy_epoch: ctx.set.epoch, items: await Promise.all(rows.map((r) => serializeProposal(p, r, ctx))) };
  });
}
