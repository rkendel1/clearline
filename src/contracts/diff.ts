// Compatibility analysis between contract versions and migration planning.
// The plan is a reviewable, deterministic document: every change is listed
// with its classification, the exact DDL, any data operations, and how the
// change would be rolled back. Unsupported changes are rejected outright.

import type { Contract, EntityDef, FieldDef } from './types.js';
import { SENSITIVE } from './types.js';
import { createEntityTableDDL, sqlType, table } from './compile.js';
import { ident } from '../platform/db.js';
import { stableStringify } from './compile.js';

export type ChangeClass = 'compatible' | 'breaking' | 'unsupported';

export interface Change {
  kind: string;
  entity?: string;
  field?: string;
  classification: ChangeClass;
  description: string;
  action: string;
}

export interface DataOp {
  type: 'backfill' | 'value_map';
  entity: string;
  field: string;
  backfill_value?: string;
  value_map?: Record<string, string>;
}

export interface MigrationPlan {
  from_version: string | null;
  to_version: string;
  classification: 'initial' | 'compatible' | 'requires_approval' | 'rejected';
  changes: Change[];
  ddl: string[];
  /** View statements executed on apply (views are dropped and regenerated; tables and columns are never dropped). */
  view_ddl?: string[];
  data_ops: DataOp[];
  rejected_reasons: string[];
  rollback: string[];
  notes: string[];
  impact?: Record<string, { current_rows: number; affected_rows?: number }>;
}

function semver(v: string): [number, number, number] {
  const [a, b, c] = v.split('.').map(Number); return [a, b, c];
}
function semverGt(a: string, b: string): boolean {
  const x = semver(a), y = semver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

const eq = (a: unknown, b: unknown) => stableStringify(a ?? null) === stableStringify(b ?? null);

export function planMigration(tenant: string, prev: Contract | null, next: Contract): MigrationPlan {
  const plan: MigrationPlan = {
    from_version: prev?.version ?? null, to_version: next.version, classification: 'compatible',
    changes: [], ddl: [], data_ops: [], rejected_reasons: [], rollback: [], notes: [],
  };
  const ch = (c: Change) => plan.changes.push(c);

  if (!prev) {
    plan.classification = 'initial';
    for (const [en, e] of Object.entries(next.entities)) {
      ch({ kind: 'entity_added', entity: en, classification: 'compatible', description: `create entity ${en} with ${Object.keys(e.fields).length} fields`, action: 'create table' });
      plan.ddl.push(...createEntityTableDDL(tenant, en, e));
    }
    plan.rollback.push('Initial version: no prior state. Rolling back means deactivating the tenant contract; tables are retained.');
    return plan;
  }

  if (!semverGt(next.version, prev.version)) plan.rejected_reasons.push(`version ${next.version} must be greater than active version ${prev.version}`);

  for (const [en, e] of Object.entries(next.entities)) {
    const pe = prev.entities[en];
    if (!pe) {
      ch({ kind: 'entity_added', entity: en, classification: 'compatible', description: `new entity ${en}`, action: 'create table' });
      plan.ddl.push(...createEntityTableDDL(tenant, en, e));
      continue;
    }
    diffEntity(tenant, en, pe, e, next, plan);
  }
  for (const en of Object.keys(prev.entities)) {
    if (!next.entities[en]) ch({ kind: 'entity_removed', entity: en, classification: 'breaking', description: `entity ${en} removed from contract`, action: 'table and data retained (never dropped automatically); no longer accepted, validated or served' });
  }

  // Processing-level changes: always recorded so reviewers see them, never data-affecting.
  diffSources(prev, next, plan);
  if (!eq(prev.outputs, next.outputs)) ch({ kind: 'outputs_changed', classification: 'compatible', description: 'declared metrics/extracts changed', action: 'reporting definitions regenerated' });
  if (!eq(prev.dataset_checks, next.dataset_checks)) ch({ kind: 'dataset_checks_changed', classification: 'compatible', description: 'dataset reconciliation checks changed', action: 'applies from next reconciliation run' });

  const breaking = plan.changes.filter((c) => c.classification === 'breaking');
  const unsupported = plan.changes.filter((c) => c.classification === 'unsupported');
  for (const u of unsupported) plan.rejected_reasons.push(`${u.entity ? u.entity + (u.field ? '.' + u.field : '') + ': ' : ''}${u.description} — ${u.action}`);
  if (breaking.length && semver(next.version)[0] === semver(prev.version)[0]) {
    plan.rejected_reasons.push(`breaking changes require a major version increment (${prev.version} -> ${next.version})`);
  }

  plan.classification = plan.rejected_reasons.length ? 'rejected' : breaking.length ? 'requires_approval' : 'compatible';

  plan.rollback.push(
    'Rollback is available until any batch is processed under the new version.',
    'Records created by data operations (tagged _migration_id) are deleted and the versions they superseded become current again.',
    'The previous contract version is re-activated; added columns are retained (nullable) and simply unused, so no data is dropped.',
  );
  if (plan.data_ops.length) plan.notes.push('Data operations never update rows in place: they write new record versions tagged with the migration id, so prior versions keep their original meaning and contract version.');
  return plan;
}

/** Source-level changes. Anything that weakens a trust or privacy control is breaking (needs approval). */
function diffSources(prev: Contract, next: Contract, plan: MigrationPlan) {
  const ch = (c: Change) => plan.changes.push(c);
  const scanRank = (v?: string) => (v === 'warn' ? 0 : 1); // default is quarantine
  for (const [sid, s] of Object.entries(next.sources)) {
    const ps = prev.sources[sid];
    if (!ps) { ch({ kind: 'source_added', classification: 'compatible', description: `source ${sid} added`, action: 'accepts batches from activation' }); continue; }
    const pr = ps.max_reject_rate ?? 0.05, nr = s.max_reject_rate ?? 0.05;
    if (nr > pr) ch({ kind: 'reject_threshold_raised', classification: 'breaking', description: `${sid}: max_reject_rate ${pr} -> ${nr}`, action: 'batches with more rejected rows will be trusted; requires approval' });
    else if (nr < pr) ch({ kind: 'reject_threshold_lowered', classification: 'compatible', description: `${sid}: max_reject_rate ${pr} -> ${nr}`, action: 'stricter trust for new batches' });
    const pf = ps.control_totals?.sum_fields ?? [], nf = s.control_totals?.sum_fields ?? [];
    const dropped = pf.filter((f) => !nf.includes(f));
    if (dropped.length) ch({ kind: 'control_totals_removed', classification: 'breaking', description: `${sid}: control totals no longer reconciled for [${dropped.join(', ')}]`, action: 'financial reconciliation coverage is reduced; requires approval' });
    const added = nf.filter((f) => !pf.includes(f));
    if (added.length) ch({ kind: 'control_totals_added', classification: 'compatible', description: `${sid}: control totals added for [${added.join(', ')}]`, action: 'reconciled from the next batch' });
    for (const k of ['unmapped_columns', 'classified_fields'] as const) {
      const a = ps.sensitive_scan?.[k], b = s.sensitive_scan?.[k];
      if (scanRank(b) < scanRank(a)) ch({ kind: 'sensitive_scan_weakened', classification: 'breaking', description: `${sid}: sensitive_scan.${k} ${a ?? 'quarantine'} -> ${b}`, action: 'sensitive-looking data will be admitted with a warning instead of quarantined; requires privacy approval' });
      else if (a !== b) ch({ kind: 'sensitive_scan_changed', classification: 'compatible', description: `${sid}: sensitive_scan.${k} ${a ?? 'quarantine'} -> ${b ?? 'quarantine'}`, action: 'stricter' });
    }
    if (!eq(ps.mappings, s.mappings) || !eq(ps.formats, s.formats) || ps.entity !== s.entity || ps.max_processing_seconds !== s.max_processing_seconds) {
      ch({ kind: 'source_processing_changed', classification: 'compatible', description: `${sid}: mappings, formats or processing limits changed`, action: 'new batches use the new transform version; existing records keep the transform version that produced them' });
    }
  }
  for (const sid of Object.keys(prev.sources)) {
    if (!next.sources[sid]) ch({ kind: 'source_removed', classification: 'breaking', description: `source ${sid} removed`, action: 'batches from this source will be refused' });
  }
}

function diffEntity(tenant: string, en: string, pe: EntityDef, e: EntityDef, next: Contract, plan: MigrationPlan) {
  const ch = (c: Omit<Change, 'entity'>) => plan.changes.push({ entity: en, ...c });
  const t = table(tenant, en);

  if (!eq(pe.key, e.key)) ch({ kind: 'key_changed', classification: 'unsupported', description: `key changed from [${pe.key}] to [${e.key}]`, action: 'changing entity identity is not supported; create a new entity instead' });
  if (!eq(pe.correction, e.correction)) ch({ kind: 'correction_changed', classification: 'breaking', description: `correction semantics changed (${pe.correction.strategy} -> ${e.correction.strategy})`, action: 'applies to records arriving after activation; existing versions unchanged' });

  for (const [fn, f] of Object.entries(e.fields)) {
    const pf = pe.fields[fn];
    if (!pf) {
      const mustHave = f.nullable === false;
      const backfill = next.migration?.backfill?.[en]?.[fn];
      plan.ddl.push(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${ident(fn)} ${sqlType(f)}`);
      if (!mustHave) ch({ field: fn, kind: 'field_added', classification: 'compatible', description: `optional field ${fn} (${f.type}) added`, action: 'add nullable column; existing records hold null' });
      else if (backfill !== undefined) {
        ch({ field: fn, kind: 'field_added_required', classification: 'breaking', description: `non-nullable field ${fn} (${f.type}) added`, action: `add column; existing current records get new versions with ${fn} = "${backfill}" (declared backfill)` });
        plan.data_ops.push({ type: 'backfill', entity: en, field: fn, backfill_value: backfill });
      } else ch({ field: fn, kind: 'field_added_required', classification: 'unsupported', description: `non-nullable field ${fn} added without a backfill value`, action: `declare migration.backfill.${en}.${fn} so existing records have a defined value` });
      continue;
    }
    diffField(t, en, fn, pf, f, next, plan);
  }
  for (const fn of Object.keys(pe.fields)) {
    if (!e.fields[fn]) ch({ field: fn, kind: 'field_removed', classification: 'breaking', description: `field ${fn} removed`, action: 'column and historical values retained; field no longer populated, validated or served' });
  }

  const rules = (x: EntityDef) => new Map((x.rules ?? []).map((r) => [r.id, r]));
  const pr = rules(pe), nr = rules(e);
  for (const [id, r] of nr) {
    const old = pr.get(id);
    if (!old) ch({ kind: 'rule_added', classification: r.severity === 'error' ? 'breaking' : 'compatible', description: `rule ${id} (${r.severity}) added`, action: 'applies to new batches; existing records are not re-validated' });
    else if (!eq(old, r)) ch({ kind: 'rule_changed', classification: r.severity === 'error' || old.severity === 'error' ? 'breaking' : 'compatible', description: `rule ${id} changed`, action: 'applies to new batches; existing records are not re-validated' });
  }
  for (const [id, r] of pr) if (!nr.has(id)) ch({ kind: 'rule_removed', classification: r.severity === 'error' ? 'breaking' : 'compatible', description: `rule ${id} removed`, action: 'records previously quarantined by this rule are not automatically re-admitted' });
  if (!eq(pe.relationships, e.relationships)) ch({ kind: 'relationships_changed', classification: 'breaking', description: 'referential integrity rules changed', action: 'applies to new batches' });
  if (!eq(pe.freshness, e.freshness)) ch({ kind: 'freshness_changed', classification: 'compatible', description: `freshness limit ${pe.freshness?.max_age_hours ?? 'none'} -> ${e.freshness?.max_age_hours ?? 'none'} h`, action: 'freshness status recomputed at query time' });
}

function diffField(t: string, en: string, fn: string, pf: FieldDef, f: FieldDef, next: Contract, plan: MigrationPlan) {
  const ch = (c: Omit<Change, 'entity' | 'field'>) => plan.changes.push({ entity: en, field: fn, ...c });
  if (pf.type !== f.type) {
    if (pf.type === 'integer' && f.type === 'decimal') {
      ch({ kind: 'type_widened', classification: 'compatible', description: `${fn}: integer -> decimal(${f.precision},${f.scale})`, action: 'alter column type; values preserved exactly' });
      plan.ddl.push(`ALTER TABLE ${t} ALTER COLUMN ${ident(fn)} TYPE ${sqlType(f)}`);
    } else if (pf.type === 'enum' && f.type === 'string') {
      ch({ kind: 'type_relaxed', classification: 'compatible', description: `${fn}: enum -> string`, action: 'no storage change' });
    } else {
      ch({ kind: 'type_changed', classification: 'unsupported', description: `${fn}: ${pf.type} -> ${f.type}`, action: 'type changes that can alter meaning are not supported; add a new field and deprecate the old one' });
    }
    return;
  }
  if (f.type === 'decimal' && (pf.precision !== f.precision || pf.scale !== f.scale)) {
    const intDigits = (x: FieldDef) => (x.precision ?? 0) - (x.scale ?? 0);
    if ((f.scale ?? 0) >= (pf.scale ?? 0) && intDigits(f) >= intDigits(pf)) {
      ch({ kind: 'decimal_widened', classification: 'compatible', description: `${fn}: numeric(${pf.precision},${pf.scale}) -> numeric(${f.precision},${f.scale})`, action: 'alter column type; values preserved exactly' });
      plan.ddl.push(`ALTER TABLE ${t} ALTER COLUMN ${ident(fn)} TYPE ${sqlType(f)}`);
    } else ch({ kind: 'decimal_narrowed', classification: 'unsupported', description: `${fn}: precision/scale reduced`, action: 'narrowing could round or overflow existing values' });
  }
  if (f.type === 'enum') {
    const removed = (pf.values ?? []).filter((v) => !(f.values ?? []).includes(v));
    const added = (f.values ?? []).filter((v) => !(pf.values ?? []).includes(v));
    if (added.length) ch({ kind: 'enum_values_added', classification: 'compatible', description: `${fn}: values added [${added.join(', ')}]`, action: 'none' });
    if (removed.length) {
      const map = next.migration?.value_maps?.[en]?.[fn];
      const uncovered = removed.filter((v) => !map || !(v in map));
      if (uncovered.length) ch({ kind: 'enum_values_removed', classification: 'unsupported', description: `${fn}: values removed [${removed.join(', ')}] without a mapping for [${uncovered.join(', ')}]`, action: `declare migration.value_maps.${en}.${fn} so existing records keep a valid, equivalent value` });
      else {
        ch({ kind: 'enum_values_remapped', classification: 'breaking', description: `${fn}: values [${removed.join(', ')}] replaced`, action: `existing current records get new versions with mapped values (${removed.map((r) => `${r}->${map![r]}`).join(', ')})` });
        plan.data_ops.push({ type: 'value_map', entity: en, field: fn, value_map: Object.fromEntries(removed.map((r) => [r, map![r]])) });
      }
    }
  }
  if ((pf.nullable ?? true) && f.nullable === false) {
    const backfill = next.migration?.backfill?.[en]?.[fn];
    if (backfill === undefined) ch({ kind: 'made_non_nullable', classification: 'unsupported', description: `${fn} became non-nullable without a backfill`, action: `declare migration.backfill.${en}.${fn}` });
    else { ch({ kind: 'made_non_nullable', classification: 'breaking', description: `${fn} became non-nullable`, action: `existing null values get new versions with "${backfill}"` }); plan.data_ops.push({ type: 'backfill', entity: en, field: fn, backfill_value: backfill }); }
  }
  if (!(pf.required ?? false) && f.required) ch({ kind: 'made_required', classification: 'breaking', description: `${fn} is now required from sources`, action: 'batches missing the column will be quarantined' });
  if ((pf.required ?? false) && !f.required) ch({ kind: 'made_optional', classification: 'compatible', description: `${fn} is no longer required from sources`, action: 'batches may omit the column' });
  if (pf.nullable === false && (f.nullable ?? true)) ch({ kind: 'made_nullable', classification: 'compatible', description: `${fn} may now be empty`, action: 'new records may hold null; existing records unchanged' });
  const sens = (x: FieldDef) => SENSITIVE.has(x.sensitivity ?? 'internal');
  if (sens(pf) && !sens(f)) ch({ kind: 'sensitivity_lowered', classification: 'breaking', description: `${fn}: ${pf.sensitivity} -> ${f.sensitivity ?? 'internal'}`, action: 'field becomes visible in reporting views and default extracts; requires privacy review' });
  else if (!eq(pf.sensitivity, f.sensitivity)) ch({ kind: 'sensitivity_changed', classification: 'compatible', description: `${fn}: ${pf.sensitivity ?? 'internal'} -> ${f.sensitivity ?? 'internal'}`, action: 'reporting views regenerated' });
  const constraintKeys: (keyof FieldDef)[] = ['max_length', 'min', 'max', 'format'];
  for (const k of constraintKeys) {
    if (!eq(pf[k], f[k])) ch({ kind: 'constraint_changed', classification: 'breaking', description: `${fn}.${k}: ${JSON.stringify(pf[k] ?? null)} -> ${JSON.stringify(f[k] ?? null)}`, action: 'applies to new batches; existing records are not re-validated' });
  }
}
