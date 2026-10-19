// Batch intake: register, structurally validate, and stage a submission.
// Idempotency: a batch is identified by (tenant, source, SHA-256 of payload).
// Re-submitting identical content returns the original batch and records the
// attempt; it never creates a second batch or any additional business effect.

import { createHash, randomUUID } from 'node:crypto';
import { withTenant, type Tx } from '../platform/db.js';
import { badRequest, unprocessable } from '../platform/errors.js';
import { loadConfig } from '../platform/config.js';
import { metrics } from '../platform/metrics.js';
import { log } from '../platform/logger.js';
import type { Principal } from '../control/auth.js';
import { auditTx } from '../control/audit.js';
import { getActiveContract } from '../contracts/registry.js';
import { stableStringify } from '../contracts/compile.js';
import { parseCsv, parseJsonRecords, StructuralError, type ParsedPayload } from './adapters/index.js';
import { normalizeDecimal } from '../transform/coerce.js';

export interface Control { record_count?: number; sums?: Record<string, string> }

export interface Submission {
  tenantId: string;
  sourceId: string;
  format: 'csv' | 'json';
  body: Buffer | unknown[];        // CSV bytes or JSON records
  sourceReportedAt?: string | null;
  control?: Control | string | null;
}

export interface SubmitResult {
  batch_id: string;
  status: string;
  duplicate: boolean;
  received_count: number;
  structural_rejection?: unknown;
}

export function parseControl(raw: unknown, sumFields: string[]): Control | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let c: unknown = raw;
  if (typeof raw === 'string') { try { c = JSON.parse(raw); } catch { throw badRequest('invalid_control', 'control totals must be JSON'); } }
  if (typeof c !== 'object' || c === null) throw badRequest('invalid_control', 'control totals must be an object');
  const o = c as Record<string, unknown>;
  const out: Control = {};
  if (o.record_count !== undefined) {
    if (!Number.isInteger(o.record_count) || (o.record_count as number) < 0) throw badRequest('invalid_control', 'record_count must be a non-negative integer');
    out.record_count = o.record_count as number;
  }
  if (o.sums !== undefined) {
    if (typeof o.sums !== 'object' || o.sums === null) throw badRequest('invalid_control', 'sums must be an object');
    out.sums = {};
    for (const [k, v] of Object.entries(o.sums as Record<string, unknown>)) {
      if (!sumFields.includes(k)) throw badRequest('invalid_control', `"${k}" is not a declared control-total field for this source (allowed: ${sumFields.join(', ') || 'none'})`);
      const n = normalizeDecimal(String(v), 6);
      if (!n.ok) throw badRequest('invalid_control', `sum for ${k} is not a decimal`);
      out.sums[k] = String(v);
    }
  }
  for (const k of Object.keys(o)) if (k !== 'record_count' && k !== 'sums') throw badRequest('invalid_control', `unknown control property "${k}"`);
  return out;
}

function parseReportedAt(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest('invalid_source_reported_at', 'source_reported_at must be an ISO-8601 timestamp');
  return d.toISOString();
}

export async function submitBatch(p: Principal, s: Submission): Promise<SubmitResult> {
  const cfg = loadConfig();
  const reportedAt = parseReportedAt(s.sourceReportedAt);
  const digest = createHash('sha256').update(Buffer.isBuffer(s.body) ? s.body : stableStringify(s.body)).digest('hex');
  const byteSize = Buffer.isBuffer(s.body) ? s.body.length : Buffer.byteLength(JSON.stringify(s.body));

  return withTenant(s.tenantId, async (tx) => {
    const active = await getActiveContract(tx, s.tenantId);
    if (!active) throw unprocessable('no_active_contract', `Tenant ${s.tenantId} has no active contract`);
    const source = active.document.sources[s.sourceId];
    if (!source) throw badRequest('unknown_source', `Source "${s.sourceId}" is not declared in contract ${active.version}`);
    if (!source.formats.includes(s.format)) throw badRequest('unsupported_format', `Source "${s.sourceId}" accepts ${source.formats.join(', ')}`);
    const control = parseControl(s.control, source.control_totals?.sum_fields ?? []);

    // Serialize submissions of identical content so concurrent duplicates resolve to one batch.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${s.tenantId}:${s.sourceId}:${digest}`]);
    const existing = await tx.query(`SELECT id, status, received_count, structural_rejection FROM core.batches WHERE tenant_id = $1 AND source_id = $2 AND payload_digest = $3`, [s.tenantId, s.sourceId, digest]);
    if (existing.rows[0]) {
      const b = existing.rows[0];
      await tx.query(`INSERT INTO core.batch_submissions (tenant_id, batch_id, outcome, submitted_by, correlation_id) VALUES ($1,$2,'duplicate',$3,$4)`, [s.tenantId, b.id, p.actor, p.correlationId]);
      await auditTx(tx, { tenantId: s.tenantId, actor: p.actor, role: p.role, action: 'batch.submit', resource: `batch:${b.id}`, outcome: 'succeeded', details: { duplicate: true, source: s.sourceId, digest }, correlationId: p.correlationId });
      metrics.batchesSubmitted.inc({ tenant: s.tenantId, outcome: 'duplicate' });
      return { batch_id: b.id, status: b.status, duplicate: true, received_count: b.received_count, structural_rejection: b.structural_rejection ?? undefined };
    }

    let parsed: ParsedPayload | null = null;
    let rejection: { reason: string; message: string; details?: unknown } | null = null;
    try {
      parsed = s.format === 'csv' ? parseCsv(s.body as Buffer, cfg.maxRowsPerBatch) : parseJsonRecords(s.body, cfg.maxRowsPerBatch);
      if (s.format === 'csv') {
        const entity = active.document.entities[source.entity];
        const missing = source.mappings.filter((m) => typeof m.from === 'string' && entity.fields[m.target].required && !parsed!.columns.includes(m.from)).map((m) => m.from as string);
        if (missing.length) throw new StructuralError('missing_required_columns', `CSV is missing required columns: ${missing.join(', ')}`, { missing, received_columns: parsed.columns });
      }
    } catch (err) {
      if (!(err instanceof StructuralError)) throw err;
      rejection = { reason: err.reason, message: err.message, details: err.details };
    }

    const id = randomUUID();
    const late = reportedAt ? (await tx.query(
      `SELECT max(source_reported_at) AS m FROM core.batches WHERE tenant_id = $1 AND source_id = $2 AND status <> 'rejected'`, [s.tenantId, s.sourceId])).rows[0].m : null;
    const isLate = !!(reportedAt && late && new Date(reportedAt) < new Date(late));
    await tx.query(
      `INSERT INTO core.batches (id, tenant_id, source_id, entity, contract_version_id, transform_version, format, payload_digest, byte_size,
         source_reported_at, is_late, control, status, received_count, structural_rejection, trust_status, max_attempts, submitted_by, correlation_id,
         completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, CASE WHEN $13 = 'rejected' THEN now() END)`,
      [id, s.tenantId, s.sourceId, source.entity, active.id, active.transform_version, s.format, digest, byteSize, reportedAt, isLate,
        control ? JSON.stringify(control) : null, rejection ? 'rejected' : 'queued', parsed?.rows.length ?? 0,
        rejection ? JSON.stringify(rejection) : null, rejection ? 'untrusted' : 'pending', cfg.maxAttempts, p.actor, p.correlationId]);
    if (parsed && !rejection) await stageRows(tx, s.tenantId, id, parsed);
    await tx.query(`INSERT INTO core.batch_submissions (tenant_id, batch_id, outcome, submitted_by, correlation_id) VALUES ($1,$2,$3,$4,$5)`,
      [s.tenantId, id, rejection ? 'rejected' : 'accepted', p.actor, p.correlationId]);
    await auditTx(tx, { tenantId: s.tenantId, actor: p.actor, role: p.role, action: 'batch.submit', resource: `batch:${id}`, outcome: rejection ? 'failed' : 'succeeded',
      details: { source: s.sourceId, digest, rows: parsed?.rows.length ?? 0, contract_version: active.version, rejection: rejection?.reason ?? null }, correlationId: p.correlationId });
    metrics.batchesSubmitted.inc({ tenant: s.tenantId, outcome: rejection ? 'rejected' : 'accepted' });
    log.info('batch submitted', { tenant: s.tenantId, batch_id: id, source: s.sourceId, rows: parsed?.rows.length ?? 0, status: rejection ? 'rejected' : 'queued', correlation_id: p.correlationId });
    return { batch_id: id, status: rejection ? 'rejected' : 'queued', duplicate: false, received_count: parsed?.rows.length ?? 0, structural_rejection: rejection ?? undefined };
  });
}

async function stageRows(tx: Tx, tenantId: string, batchId: string, parsed: ParsedPayload) {
  const CHUNK = 2000;
  for (let i = 0; i < parsed.rows.length; i += CHUNK) {
    const chunk = parsed.rows.slice(i, i + CHUNK);
    await tx.query(
      `INSERT INTO core.raw_records (tenant_id, batch_id, row_number, payload, row_hash, parse_error)
       SELECT $1, $2, r.n, r.p, r.h, r.e FROM unnest($3::int[], $4::jsonb[], $5::text[], $6::text[]) AS r(n, p, h, e)`,
      [tenantId, batchId, chunk.map((r) => r.row_number), chunk.map((r) => (r.payload ? JSON.stringify(r.payload) : null)),
        chunk.map((r) => createHash('sha256').update(stableStringify(r.payload)).digest('hex')), chunk.map((r) => r.parse_error)]);
  }
}
