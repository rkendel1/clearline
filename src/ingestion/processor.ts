// Batch processor. One batch = one database transaction:
//   transform + validate every staged row -> resolve keys/corrections ->
//   write canonical versions, quarantine, quality results, lineage ->
//   reconcile against the target -> set pipeline and trust status -> COMMIT.
// If anything fails or the process dies, the transaction rolls back and no
// partial business effect exists. The batch row is locked (FOR UPDATE) for the
// whole run, which fences it from lease-recovery while it is genuinely alive.

import type { Tx } from '../platform/db.js';
import { ident, withTenant } from '../platform/db.js';
import { loadConfig } from '../platform/config.js';
import { metrics } from '../platform/metrics.js';
import type { Logger } from '../platform/logger.js';
import { getActiveContract, getContractVersion, lockTenantShared } from '../contracts/registry.js';
import { table } from '../contracts/compile.js';
import type { Contract, EntityDef } from '../contracts/types.js';
import { auditTx } from '../control/audit.js';
import { primaryCategory, transformRow, type Finding, type RawRow, type RowResult } from '../transform/engine.js';
import { addDecimal, compareCanonical, type Canonical } from '../transform/coerce.js';
import { reconcileBatch, type BatchTallies } from '../reconciliation/batch.js';
import { detectSensitiveValue } from '../quality/sensitive.js';

export class LostLeaseError extends Error {}
export class InterruptedError extends Error {}
export class BatchTimeoutError extends Error {}
export class ContractSupersededError extends Error { override name = 'ContractSupersededError'; }

interface RawRec { id: number; row_number: number; payload: RawRow | null; parse_error: string | null }

interface Work {
  raw: RawRec;
  res: RowResult | null;
  errors: Finding[];
  warnings: Finding[];
  disposition?: 'accepted' | 'accepted_late' | 'quarantined' | 'duplicate';
  insertIdx?: number;          // index into inserts
  duplicateOf?: { recordId?: number; insertIdx?: number };
}

// `untrusted`: the version came from a batch that is not trusted. Such versions are kept and stay
// visible in 'all' outputs, but they never make a later delivery a duplicate, never cause a
// conflict and never outrank it: trusted evidence always gets to (re)establish a record.
interface Version { recordId?: number; insertIdx?: number; hash: string; order: Canonical; isCurrent: boolean; untrusted: boolean }
interface Insert { work: Work; isCurrent: boolean; isLate: boolean; recordId?: number }

export interface ProcessOutcome {
  status: 'completed' | 'completed_with_exceptions';
  trust_status: 'trusted' | 'untrusted';
  counts: Record<string, number>;
}

function faultAfterRows(): number | null {
  const m = /crash_after_rows=(\d+)/.exec(loadConfig().faultInjection);
  return m ? Number(m[1]) : null;
}
/** Test-only: throw an ordinary error (not a crash) mid-write for batches of this source. */
function faultFailSource(): string | null {
  return /fail_source=([a-z0-9_]+)/.exec(loadConfig().faultInjection)?.[1] ?? null;
}
export class InjectedFaultError extends Error { override name = 'InjectedFaultError'; }

function normalizeDb(type: string, v: unknown): Canonical {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (type === 'integer') return Number(v);
  return v as Canonical;
}

export async function processBatch(batchId: string, tenantId: string, workerId: string, signal: AbortSignal, log: Logger): Promise<ProcessOutcome> {
  const cfg = loadConfig();
  const started = Date.now();
  const deadline = started + cfg.batchTimeoutMs;
  const checkpoint = () => {
    if (signal.aborted) throw new InterruptedError('processing interrupted by shutdown');
    if (Date.now() > deadline) throw new BatchTimeoutError(`batch exceeded BATCH_TIMEOUT_MS (${cfg.batchTimeoutMs} ms)`);
  };

  return withTenant(tenantId, async (tx) => {
    await lockTenantShared(tx, tenantId);
    const { rows: [batch] } = await tx.query(`SELECT * FROM core.batches WHERE id = $1 FOR UPDATE`, [batchId]);
    if (!batch || batch.status !== 'processing' || batch.lease_owner !== workerId) throw new LostLeaseError(`batch ${batchId} is no longer leased to ${workerId}`);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`clearline.entity.${tenantId}.${batch.entity}`]);

    let cv = await getContractVersion(tx, Number(batch.contract_version_id));
    // The contract may have changed while this batch waited in the queue.
    const active = await getActiveContract(tx, tenantId);
    if (active && active.id !== cv.id) {
      const between = (await tx.query(`SELECT id, classification FROM core.contract_migrations WHERE tenant_id = $1 AND status = 'applied' AND to_version_id > $2 AND to_version_id <= $3`, [tenantId, cv.id, active.id])).rows;
      const breaking = between.filter((m) => m.classification !== 'compatible');
      if (breaking.length) {
        throw new ContractSupersededError(`batch was submitted under contract ${cv.version}, but breaking migration(s) ${breaking.map((m) => m.id).join(', ')} have since been applied (active ${active.version}); replay re-processes it under ${active.version}`);
      }
      await tx.query(`UPDATE core.batches SET contract_version_id = $2, transform_version = $3 WHERE id = $1`, [batchId, active.id, active.transform_version]);
      await auditTx(tx, { tenantId, actor: `worker:${workerId}`, role: 'system', action: 'batch.repinned', resource: `batch:${batchId}`, outcome: 'succeeded', details: { from_version: cv.version, to_version: active.version, reason: 'only compatible migrations since submission' }, correlationId: batch.correlation_id });
      cv = active;
    }
    const contract = cv.document;
    const source = contract.sources[batch.source_id];
    const entity = contract.entities[source.entity];
    const t = table(tenantId, source.entity);
    const arrival: Date = batch.arrival_at;
    const ctx = { arrivalDate: arrival.toISOString().slice(0, 10), arrivalTs: arrival.toISOString() };

    const raws = (await tx.query(`SELECT id, row_number, payload, parse_error FROM core.raw_records WHERE batch_id = $1 ORDER BY row_number`, [batchId])).rows
      .map((r) => ({ ...r, id: Number(r.id) })) as RawRec[];

    // 1. Row-level transformation and validation (pure, deterministic).
    const crashAfter = faultAfterRows();
    const work: Work[] = raws.map((raw, i) => {
      if (i % 1000 === 0) checkpoint();
      if (raw.parse_error || !raw.payload) {
        const f: Finding = { rule_id: 'parse:row_shape', rule_kind: 'parse', category: 'structural', severity: 'error', message: raw.parse_error ?? 'row could not be parsed' };
        return { raw, res: null, errors: [f], warnings: [] };
      }
      const res = transformRow(contract, batch.source_id, raw.payload, ctx, new Set(Object.keys(raw.payload)));
      return { raw, res, errors: [...res.errors], warnings: res.findings.filter((f) => f.severity === 'warning') };
    });

    // 2. Referential integrity against existing canonical data (and this batch, for self-references).
    await checkRelationships(tx, tenantId, contract, entity, source.entity, work);

    // 3. Keys, duplicates, corrections, late arrivals, conflicts.
    const inserts: Insert[] = [];
    const supersededDbIds: number[] = [];
    const candidates = work.filter((w) => w.errors.length === 0 && w.res?.key && w.res.hash);
    const keys = [...new Set(candidates.map((w) => w.res!.key!))];
    const orderBy = entity.correction.order_by;
    const orderType = orderBy ? entity.fields[orderBy].type : 'integer';
    const state = new Map<string, Version[]>();
    for (let i = 0; i < keys.length; i += 5000) {
      const { rows } = await tx.query(
        `SELECT x."_record_id", x."_key", x."_record_hash", x."_is_current", xb.trust_status <> 'trusted' AS untrusted${orderBy ? `, x.${ident(orderBy)} AS o` : ''}
           FROM ${t} x JOIN core.batches xb ON xb.id = x."_batch_id" WHERE x."_key" = ANY($1)`, [keys.slice(i, i + 5000)]);
      for (const r of rows) {
        const list = state.get(r._key) ?? [];
        list.push({ recordId: Number(r._record_id), hash: r._record_hash, order: orderBy ? normalizeDb(orderType, r.o) : null, isCurrent: r._is_current, untrusted: r.untrusted });
        state.set(r._key, list);
      }
    }
    for (const w of work) {
      if (w.errors.length || !w.res?.key || !w.res.hash) continue;
      const key = w.res.key, hash = w.res.hash;
      const versions = state.get(key) ?? [];
      state.set(key, versions);
      const same = versions.find((v) => v.hash === hash && !v.untrusted);
      if (same) { w.disposition = 'duplicate'; w.duplicateOf = { recordId: same.recordId, insertIdx: same.insertIdx }; continue; }
      const current = versions.find((v) => v.isCurrent);
      const trusted = versions.filter((v) => !v.untrusted);
      // Reference point for ordering: the latest trusted version (not an untrusted current one).
      const ref = trusted.length ? trusted.reduce((a, b) => (compareCanonical(orderType, b.order, a.order) > 0 ? b : a)) : null;
      const order = orderBy ? w.res.values[orderBy] : null;
      const addVersion = (isCurrent: boolean, isLate: boolean) => {
        if (isCurrent && current) {
          current.isCurrent = false;
          if (current.recordId !== undefined) supersededDbIds.push(current.recordId);
          else inserts[current.insertIdx!].isCurrent = false;
        }
        const idx = inserts.push({ work: w, isCurrent, isLate }) - 1;
        versions.push({ insertIdx: idx, hash, order, isCurrent, untrusted: false });
        w.insertIdx = idx;
        w.disposition = isLate ? 'accepted_late' : 'accepted';
      };
      const conflictWith = (why: string) => {
        w.errors.push({ rule_id: 'conflict:key', rule_kind: 'conflict', category: 'conflict', severity: 'error', message: why });
      };
      if (!current || !ref) { addVersion(true, false); continue; }
      switch (entity.correction.strategy) {
        case 'immutable':
          conflictWith(`a record with this key already exists with different content and ${source.entity} records are immutable`);
          break;
        case 'last_arrival_wins':
          addVersion(true, false);
          break;
        case 'supersede_by_order': {
          if (trusted.some((v) => v.hash !== hash && compareCanonical(orderType, v.order, order) === 0)) {
            conflictWith(`another version with the same ${orderBy} exists with different content; cannot determine which is correct`);
            break;
          }
          const c = compareCanonical(orderType, order, ref.order);
          if (c > 0) addVersion(true, false);
          else addVersion(false, true); // older than current: retained as history, does not change current results
          break;
        }
      }
    }
    checkpoint();

    // 4. Writes. Superseded versions are flagged first so the "one current version per key" index holds.
    for (let i = 0; i < supersededDbIds.length; i += 5000) {
      await tx.query(`UPDATE ${t} SET "_is_current" = false WHERE "_record_id" = ANY($1)`, [supersededDbIds.slice(i, i + 5000)]);
    }
    const fields = Object.keys(entity.fields);
    const cols = ['_key', '_record_hash', '_is_current', '_is_late', '_batch_id', '_raw_record_id', '_contract_version_id', '_transform_version', ...fields];
    const perRow = cols.length;
    const chunk = Math.max(1, Math.floor(30000 / perRow));
    let written = 0;
    for (let i = 0; i < inserts.length; i += chunk) {
      const part = inserts.slice(i, i + chunk);
      const params: unknown[] = [];
      const tuples = part.map((ins) => {
        const v = ins.work.res!.values;
        const vals = [ins.work.res!.key, ins.work.res!.hash, ins.isCurrent, ins.isLate, batchId, ins.work.raw.id, cv.id, cv.transform_version, ...fields.map((f) => v[f])];
        const base = params.length;
        params.push(...vals);
        return `(${vals.map((_, j) => `$${base + j + 1}`).join(',')})`;
      });
      const { rows } = await tx.query(`INSERT INTO ${t} (${cols.map(ident).join(',')}) VALUES ${tuples.join(',')} RETURNING "_record_id", "_raw_record_id"`, params);
      const byRaw = new Map(rows.map((r) => [Number(r._raw_record_id), Number(r._record_id)]));
      for (const ins of part) ins.recordId = byRaw.get(ins.work.raw.id);
      written += part.length;
      if (crashAfter !== null && written >= crashAfter) {
        log.warn('FAULT INJECTION: terminating process mid-transaction', { batch_id: batchId, written });
        process.kill(process.pid, 'SIGKILL');
      }
      if (faultFailSource() === batch.source_id) throw new InjectedFaultError(`injected failure after writing ${written} rows (transaction will roll back)`);
      checkpoint();
    }

    // Quarantine, findings, dispositions.
    const quarantined = work.filter((w) => w.errors.length > 0);
    for (const w of quarantined) w.disposition = 'quarantined';
    await bulkInsert(tx, `INSERT INTO core.quarantine (tenant_id, batch_id, raw_record_id, entity, record_key, category, errors)
      SELECT $1, $2, q.r, $3, q.k, q.c, q.e FROM unnest($4::bigint[], $5::text[], $6::text[], $7::jsonb[]) AS q(r,k,c,e)`,
      quarantined, (part) => [tenantId, batchId, source.entity, part.map((w) => w.raw.id), part.map((w) => w.res?.key ?? null), part.map((w) => primaryCategory(w.errors)), part.map((w) => JSON.stringify(w.errors))]);
    const findingRows = work.flatMap((w) => [...w.errors, ...w.warnings].map((f) => ({ w, f })));
    await bulkInsert(tx, `INSERT INTO core.quality_findings (tenant_id, batch_id, raw_record_id, rule_id, severity, category, field, message)
      SELECT $1, $2, f.r, f.id, f.s, f.c, f.fl, f.m FROM unnest($3::bigint[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) AS f(r,id,s,c,fl,m)`,
      findingRows, (part) => [tenantId, batchId, part.map((x) => x.w.raw.id), part.map((x) => x.f.rule_id), part.map((x) => x.f.severity), part.map((x) => x.f.category), part.map((x) => x.f.field ?? null), part.map((x) => x.f.message)]);
    await bulkInsert(tx, `UPDATE core.raw_records r SET disposition = d.disp, canonical_record_id = d.cid
      FROM unnest($1::bigint[], $2::text[], $3::bigint[]) AS d(id, disp, cid) WHERE r.id = d.id`,
      work, (part) => [part.map((w) => w.raw.id), part.map((w) => w.disposition ?? 'quarantined'), part.map((w) => {
        if (w.insertIdx !== undefined) return inserts[w.insertIdx].recordId ?? null;
        if (w.duplicateOf) return w.duplicateOf.recordId ?? (w.duplicateOf.insertIdx !== undefined ? inserts[w.duplicateOf.insertIdx].recordId ?? null : null);
        return null;
      })]);
    // Sensitive values detected in unmapped columns are scrubbed from retained raw payloads.
    const scrubs = work.flatMap((w) => [...w.errors, ...w.warnings].filter((f) => f.rule_id === 'privacy:unmapped_sensitive')
      .map((f) => ({ id: w.raw.id, col: /column "([^"]+)"/.exec(f.message)?.[1] })).filter((s) => s.col));
    // Likewise for mapped columns feeding a non-sensitive field in which sensitive-looking data was found.
    for (const w of work) for (const f of [...w.errors, ...w.warnings]) {
      if (!f.rule_id.startsWith('privacy:') || f.rule_id === 'privacy:unmapped_sensitive' || !f.field) continue;
      const m = source.mappings.find((x) => x.target === f.field);
      for (const col of typeof m?.from === 'string' ? [m.from] : m?.from ?? []) scrubs.push({ id: w.raw.id, col });
    }
    for (const s of scrubs) await tx.query(`UPDATE core.raw_records SET payload = payload || jsonb_build_object($2::text, '[scrubbed: sensitive value detected]') WHERE id = $1 AND payload ? $2`, [s.id, s.col]);

    // 5. Quality results (one row per rule, including rules with zero failures).
    const counts = {
      received: work.length,
      accepted: inserts.length,
      quarantined: quarantined.length,
      duplicates: work.filter((w) => w.disposition === 'duplicate').length,
      late: inserts.filter((i) => i.isLate).length,
      corrections: 0,
      conflicts: work.filter((w) => w.errors.some((e) => e.category === 'conflict')).length,
      structural: quarantined.filter((w) => primaryCategory(w.errors) === 'structural').length,
      business: quarantined.filter((w) => ['business_rule', 'referential', 'privacy'].includes(primaryCategory(w.errors))).length,
      warnings: work.filter((w) => w.warnings.length > 0 && w.errors.length === 0).length,
    };
    counts.corrections = supersededDbIds.length + inserts.filter((i) => !i.isCurrent && !i.isLate).length;
    const structurallyValid = work.filter((w) => w.res && !w.errors.some((e) => e.category === 'structural')).length;
    await writeQualityResults(tx, tenantId, batchId, Number(batch.attempt_count), cv.id, entity, work, counts, structurallyValid);

    // 6. Reconciliation against what was actually persisted.
    const sumFields = source.control_totals?.sum_fields ?? [];
    const tallies: BatchTallies = { received: counts.received, accepted: counts.accepted, quarantined: counts.quarantined, duplicates: counts.duplicates, control: batch.control, sums: {}, target: { rows: 0, sums: {} } };
    for (const f of sumFields) {
      const s = { received: '0', unparseable_rows: 0, accepted: '0', quarantined: '0', duplicate: '0' };
      for (const w of work) {
        const v = w.res?.values[f];
        if (v === null || v === undefined) { if (w.res === null || w.errors.some((e) => e.field === f && e.category === 'structural')) s.unparseable_rows++; continue; }
        const d = String(v);
        s.received = addDecimal(s.received, d);
        if (w.disposition === 'quarantined') s.quarantined = addDecimal(s.quarantined, d);
        else if (w.disposition === 'duplicate') s.duplicate = addDecimal(s.duplicate, d);
        else s.accepted = addDecimal(s.accepted, d);
      }
      tallies.sums[f] = s;
    }
    const tgt = await tx.query(`SELECT count(*)::int AS n${sumFields.map((f, i) => `, coalesce(sum(${ident(f)}), 0)::text AS s${i}`).join('')} FROM ${t} WHERE "_batch_id" = $1 AND "_migration_id" IS NULL`, [batchId]);
    tallies.target.rows = tgt.rows[0].n;
    sumFields.forEach((f, i) => { tallies.target.sums[f] = tgt.rows[0][`s${i}`]; });
    const recon = reconcileBatch(tallies);
    const runId = `${batchId}#${batch.attempt_count}`;
    for (const r of recon) {
      await tx.query(`INSERT INTO core.reconciliation_results (tenant_id, batch_id, run_id, scope, check_id, status, expected, actual, difference, explanation, contract_version_id)
        VALUES ($1,$2,$3,'batch',$4,$5,$6,$7,$8,$9,$10)`, [tenantId, batchId, runId, r.check_id, r.status, JSON.stringify(r.expected), JSON.stringify(r.actual), JSON.stringify(r.difference), r.explanation, cv.id]);
    }

    // 7. Pipeline status vs. trust status: running successfully is not the same as being trustworthy.
    const maxReject = source.max_reject_rate ?? 0.05;
    const rejectRate = counts.received ? counts.quarantined / counts.received : 0;
    const reasons: string[] = [];
    const failedRecon = recon.filter((r) => r.status === 'failed');
    if (failedRecon.length) reasons.push(`reconciliation failed: ${failedRecon.map((r) => r.check_id).join(', ')}`);
    if (rejectRate > maxReject) reasons.push(`reject rate ${(rejectRate * 100).toFixed(2)}% exceeds threshold ${(maxReject * 100).toFixed(2)}%`);
    const qualityStatus = rejectRate > maxReject ? 'failed' : counts.quarantined > 0 || counts.warnings > 0 ? 'warning' : 'passed';
    const trust: 'trusted' | 'untrusted' = reasons.length ? 'untrusted' : 'trusted';
    const status = counts.quarantined > 0 ? 'completed_with_exceptions' : 'completed';
    const elapsedFromArrival = (Date.now() - arrival.getTime()) / 1000;
    if (source.max_processing_seconds !== undefined) {
      const breached = elapsedFromArrival > source.max_processing_seconds;
      await tx.query(`INSERT INTO core.quality_results (tenant_id, batch_id, attempt, contract_version_id, rule_id, rule_kind, category, severity, evaluated_count, failed_count, description)
        VALUES ($1,$2,$3,$4,'latency:end_to_end','latency','operational','warning',1,$5,$6)`,
        [tenantId, batchId, batch.attempt_count, cv.id, breached ? 1 : 0, `arrival-to-completion ${elapsedFromArrival.toFixed(1)}s vs threshold ${source.max_processing_seconds}s`]);
    }

    await tx.query(`UPDATE core.batches SET status = $2, accepted_count = $3, quarantined_count = $4, duplicate_count = $5, late_record_count = $6,
        correction_count = $7, conflict_count = $8, structural_error_count = $9, business_error_count = $10, warning_count = $11,
        quality_status = $12, reconciliation_status = $13, trust_status = $14, trust_reasons = $15, completed_at = now(),
        lease_owner = NULL, lease_expires_at = NULL, failure = NULL, failed_at = NULL WHERE id = $1`,
      [batchId, status, counts.accepted, counts.quarantined, counts.duplicates, counts.late, counts.corrections, counts.conflicts, counts.structural,
        counts.business, counts.warnings, qualityStatus, failedRecon.length ? 'failed' : 'passed', trust, JSON.stringify(reasons)]);
    await tx.query(`UPDATE core.batch_attempts SET outcome = 'succeeded', ended_at = now() WHERE batch_id = $1 AND attempt = $2`, [batchId, batch.attempt_count]);
    await auditTx(tx, { tenantId, actor: `worker:${workerId}`, role: 'system', action: 'batch.process', resource: `batch:${batchId}`, outcome: 'succeeded',
      details: { attempt: batch.attempt_count, status, trust, counts, contract_version: cv.version, transform_version: cv.transform_version }, correlationId: batch.correlation_id });

    const secs = (Date.now() - started) / 1000;
    metrics.batchDuration.observe(secs, { tenant: tenantId });
    for (const [k, v] of Object.entries({ accepted: counts.accepted, quarantined: counts.quarantined, duplicate: counts.duplicates })) metrics.rowsProcessed.inc({ tenant: tenantId, disposition: k }, v);
    log.info('batch processed', { batch_id: batchId, tenant: tenantId, attempt: batch.attempt_count, status, trust, seconds: secs, ...counts });
    return { status, trust_status: trust, counts };
  });
}

async function bulkInsert<T>(tx: Tx, sql: string, items: T[], params: (part: T[]) => unknown[], size = 5000) {
  for (let i = 0; i < items.length; i += size) await tx.query(sql, params(items.slice(i, i + size)));
}

async function checkRelationships(tx: Tx, tenantId: string, contract: Contract, entity: EntityDef, entityName: string, work: Work[]) {
  for (const rel of entity.relationships ?? []) {
    const eligible = work.filter((w) => w.res && !w.errors.some((e) => e.category === 'structural') && w.res.values[rel.field] !== null);
    const refs = [...new Set(eligible.map((w) => String(w.res!.values[rel.field])))];
    const found = new Set<string>();
    for (let i = 0; i < refs.length; i += 5000) {
      const { rows } = await tx.query(`SELECT DISTINCT "_key" FROM ${table(tenantId, rel.references.entity)} WHERE "_key" = ANY($1)`, [refs.slice(i, i + 5000)]);
      rows.forEach((r) => found.add(r._key));
    }
    if (rel.references.entity === entityName) eligible.forEach((w) => { if (w.res!.key) found.add(w.res!.key); });
    for (const w of eligible) {
      if (found.has(String(w.res!.values[rel.field]))) continue;
      const f: Finding = {
        rule_id: `relationship:${rel.id}`, rule_kind: 'relationship', category: 'referential', severity: rel.on_missing === 'quarantine' ? 'error' : 'warning', field: rel.field,
        message: `${rel.field} references a ${rel.references.entity} that does not exist${SENSITIVE_SAFE(contract, entityName, rel.field) && !detectSensitiveValue(String(w.res!.values[rel.field])) ? ` ("${w.res!.values[rel.field]}")` : ''}`,
      };
      (f.severity === 'error' ? w.errors : w.warnings).push(f);
    }
  }
}

function SENSITIVE_SAFE(c: Contract, en: string, field: string): boolean {
  const s = c.entities[en].fields[field].sensitivity ?? 'internal';
  return s === 'public' || s === 'internal';
}

async function writeQualityResults(tx: Tx, tenantId: string, batchId: string, attempt: number, cvId: number, entity: EntityDef, work: Work[], counts: Record<string, number>, structurallyValid: number) {
  const agg = new Map<string, { kind: string; category: string; severity: string; failed: Set<number>; evaluated: number; description: string }>();
  const ensure = (id: string, kind: string, category: string, severity: string, evaluated: number, description: string) => {
    if (!agg.has(id)) agg.set(id, { kind, category, severity, failed: new Set(), evaluated, description });
    return agg.get(id)!;
  };
  ensure('structural:all', 'summary', 'structural', 'error', counts.received, 'rows failing any parse, type, nullability or field constraint check');
  for (const r of entity.rules ?? []) ensure(`rule:${r.id}`, 'rule', 'business_rule', r.severity, structurallyValid, r.description);
  for (const rel of entity.relationships ?? []) ensure(`relationship:${rel.id}`, 'relationship', 'referential', rel.on_missing === 'quarantine' ? 'error' : 'warning', structurallyValid, `${rel.field} must reference an existing ${rel.references.entity}`);
  ensure('conflict:key', 'conflict', 'conflict', 'error', counts.received, 'same key and ordering value with different content');
  for (const w of work) {
    for (const f of [...w.errors, ...w.warnings]) {
      const a = ensure(f.rule_id, f.rule_kind, f.category, f.severity, f.category === 'structural' || f.category === 'privacy' ? counts.received : structurallyValid, f.message.split(':')[0]);
      a.failed.add(w.raw.id);
    }
    if (w.errors.some((e) => e.category === 'structural')) agg.get('structural:all')!.failed.add(w.raw.id);
  }
  const rows = [...agg.entries()];
  rows.push(['duplicate:exact', { kind: 'duplicate', category: 'duplicate', severity: 'info', failed: new Set(work.filter((w) => w.disposition === 'duplicate').map((w) => w.raw.id)), evaluated: counts.received, description: 'exact duplicates of existing versions (no business effect)' }]);
  rows.push(['late:historical_version', { kind: 'late', category: 'timeliness', severity: 'info', failed: new Set(work.filter((w) => w.disposition === 'accepted_late').map((w) => w.raw.id)), evaluated: counts.received, description: 'late-arriving versions older than the current version (kept as history)' }]);
  await tx.query(`INSERT INTO core.quality_results (tenant_id, batch_id, attempt, contract_version_id, rule_id, rule_kind, category, severity, evaluated_count, failed_count, description)
    SELECT $1, $2, $3, $4, q.id, q.k, q.c, q.s, q.e, q.f, q.d FROM unnest($5::text[], $6::text[], $7::text[], $8::text[], $9::int[], $10::int[], $11::text[]) AS q(id,k,c,s,e,f,d)`,
    [tenantId, batchId, attempt, cvId, rows.map(([id]) => id), rows.map(([, a]) => a.kind), rows.map(([, a]) => a.category), rows.map(([, a]) => a.severity),
      rows.map(([, a]) => a.evaluated), rows.map(([, a]) => a.failed.size), rows.map(([, a]) => a.description)]);
}
