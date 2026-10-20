// The analytical query catalog: the logical tables a tenant's users can query,
// and, per role, only the tables and columns that role may discover. This is
// the ONLY schema information the SQL validator resolves names against and the
// ONLY schema information a model provider is ever given.

import type { Contract, FieldType } from '../contracts/types.js';
import type { Role } from '../control/auth.js';
import { isDataRole, type AccessLevel, type PolicySet } from '../policy/fields.js';
import type { RedactionStyle } from '../policy/mask.js';

export interface CatalogColumn {
  name: string;
  type: FieldType | 'uuid';
  description: string | null;
  level: AccessLevel;           // never 'hidden' in a catalog
  sensitive: boolean;
  redaction: RedactionStyle;
  entity: string | null;        // contract entity, or null for platform tables
  field: string;
}

export interface CatalogTable {
  name: string;
  kind: 'entity' | 'platform';
  description: string;
  key: string[];
  columns: Map<string, CatalogColumn>;
}

export interface Relationship { from: { table: string; column: string }; to: { table: string; column: string } }

export interface Catalog {
  tenant: string;
  role: Role;
  querySchema: string;
  tables: Map<string, CatalogTable>;
  relationships: Relationship[];
  metrics: { id: string; title: string; description: string; definition: string }[];
}

/** System columns exposed on every entity table. They carry no field values. */
export const ENTITY_SYSTEM_COLUMNS: { name: string; type: CatalogColumn['type']; description: string; sql: string }[] = [
  { name: '_batch_id', type: 'uuid', description: 'batch that produced this record version (joins batches.id)', sql: 'r."_batch_id"' },
  { name: '_trust_status', type: 'enum', description: "trust of that batch: trusted | untrusted | pending. Business metrics count trusted data only", sql: 'b.trust_status' },
  { name: '_loaded_at', type: 'timestamp', description: 'when this version was loaded', sql: 'r."_loaded_at"' },
];

type PlatformColumn = { name: string; type: CatalogColumn['type']; sql: string; description?: string };
interface PlatformTable { name: string; description: string; from: string; tenantSql: string; columns: PlatformColumn[] }

/** Operational tables (no record values): same tenant-scoped data the reports use. */
export const PLATFORM_TABLES: PlatformTable[] = [
  { name: 'batches', description: 'One row per submitted batch: provenance, counts, pipeline and trust status.',
    from: 'core.batches b JOIN core.contract_versions cv ON cv.id = b.contract_version_id', tenantSql: 'b.tenant_id', columns: [
      { name: 'id', type: 'uuid', sql: 'b.id' }, { name: 'source_id', type: 'string', sql: 'b.source_id' }, { name: 'entity', type: 'string', sql: 'b.entity' },
      { name: 'contract_version', type: 'string', sql: 'cv.version' },
      { name: 'status', type: 'enum', sql: 'b.status', description: 'rejected | queued | processing | completed | completed_with_exceptions | failed' },
      { name: 'trust_status', type: 'enum', sql: 'b.trust_status', description: 'pending | trusted | untrusted' },
      { name: 'quality_status', type: 'enum', sql: 'b.quality_status', description: 'passed | warning | failed' },
      { name: 'reconciliation_status', type: 'enum', sql: 'b.reconciliation_status', description: 'passed | failed' },
      { name: 'received_count', type: 'integer', sql: 'b.received_count' }, { name: 'accepted_count', type: 'integer', sql: 'b.accepted_count' },
      { name: 'quarantined_count', type: 'integer', sql: 'b.quarantined_count' }, { name: 'duplicate_count', type: 'integer', sql: 'b.duplicate_count' },
      { name: 'correction_count', type: 'integer', sql: 'b.correction_count' }, { name: 'late_record_count', type: 'integer', sql: 'b.late_record_count' },
      { name: 'is_late', type: 'boolean', sql: 'b.is_late' }, { name: 'arrival_at', type: 'timestamp', sql: 'b.arrival_at' },
      { name: 'source_reported_at', type: 'timestamp', sql: 'b.source_reported_at' }, { name: 'completed_at', type: 'timestamp', sql: 'b.completed_at' },
    ] },
  { name: 'reconciliation_results', description: 'Batch and dataset reconciliation checks with their outcome and explanation.',
    from: 'core.reconciliation_results x', tenantSql: 'x.tenant_id', columns: [
      { name: 'batch_id', type: 'uuid', sql: 'x.batch_id', description: 'null for dataset-level checks' },
      { name: 'scope', type: 'enum', sql: 'x.scope', description: 'batch | dataset' }, { name: 'check_id', type: 'string', sql: 'x.check_id' },
      { name: 'status', type: 'enum', sql: 'x.status', description: 'passed | failed' }, { name: 'explanation', type: 'string', sql: 'x.explanation' },
      { name: 'run_id', type: 'string', sql: 'x.run_id' }, { name: 'created_at', type: 'timestamp', sql: 'x.created_at' },
    ] },
  { name: 'quality_results', description: 'Per batch and rule: how many records were evaluated and how many failed.',
    from: 'core.quality_results x', tenantSql: 'x.tenant_id', columns: [
      { name: 'batch_id', type: 'uuid', sql: 'x.batch_id' }, { name: 'rule_id', type: 'string', sql: 'x.rule_id' }, { name: 'rule_kind', type: 'string', sql: 'x.rule_kind' },
      { name: 'category', type: 'string', sql: 'x.category' }, { name: 'severity', type: 'enum', sql: 'x.severity' },
      { name: 'evaluated_count', type: 'integer', sql: 'x.evaluated_count' }, { name: 'failed_count', type: 'integer', sql: 'x.failed_count' },
      { name: 'created_at', type: 'timestamp', sql: 'x.created_at' },
    ] },
  { name: 'quarantine', description: 'Quarantined source rows (category and status only; record values and keys are not exposed here).',
    from: 'core.quarantine x', tenantSql: 'x.tenant_id', columns: [
      { name: 'batch_id', type: 'uuid', sql: 'x.batch_id' }, { name: 'entity', type: 'string', sql: 'x.entity' },
      { name: 'category', type: 'enum', sql: 'x.category', description: 'structural | business_rule | referential | conflict | privacy' },
      { name: 'status', type: 'enum', sql: 'x.status', description: 'open | resolved' }, { name: 'created_at', type: 'timestamp', sql: 'x.created_at' },
      { name: 'resolved_at', type: 'timestamp', sql: 'x.resolved_at' },
    ] },
];

/** Platform tables that do not collide with a contract entity name (an entity always wins). */
export const platformTablesFor = (c: Contract) => PLATFORM_TABLES.filter((t) => !Object.hasOwn(c.entities, t.name));

export const querySchemaName = (tenant: string) => `q_${tenant}`;

/** Effective access per column for one role: what the database grants and the validator resolves. */
export function entityColumnLevels(set: PolicySet, role: Role, entity: string): { name: string; level: AccessLevel }[] {
  const e = set.contract.entities[entity];
  const tableLevel = Object.keys(e.fields).some((f) => set.access(role, entity, f) !== 'hidden');
  return [
    ...Object.keys(e.fields).map((f) => ({ name: f, level: set.access(role, entity, f) })),
    ...ENTITY_SYSTEM_COLUMNS.map((s) => ({ name: s.name, level: (tableLevel ? 'full' : 'hidden') as AccessLevel })),
  ];
}

export function buildCatalog(set: PolicySet, role: Role): Catalog {
  const c = set.contract;
  const tables = new Map<string, CatalogTable>();
  for (const [en, e] of Object.entries(c.entities)) {
    const columns = new Map<string, CatalogColumn>();
    for (const { name, level } of entityColumnLevels(set, role, en)) {
      if (level === 'hidden') continue;
      const f = e.fields[name];
      const sys = ENTITY_SYSTEM_COLUMNS.find((s) => s.name === name);
      const p = f ? set.policy(en, name) : null;
      columns.set(name, { name, type: f?.type ?? sys!.type, description: f?.description ?? sys?.description ?? null, level,
        sensitive: !!p?.sensitive, redaction: p?.redaction ?? 'full', entity: f ? en : null, field: name });
    }
    if (![...columns.values()].some((col) => col.entity)) continue; // no discoverable field: the table is hidden
    tables.set(en, { name: en, kind: 'entity', description: e.description ?? `${en} records (current version of each key)`, key: e.key.filter((k) => columns.has(k)), columns });
  }
  if (isDataRole(role)) {
    for (const t of platformTablesFor(c)) {
      tables.set(t.name, { name: t.name, kind: 'platform', description: t.description, key: [], columns: new Map(t.columns.map((col) => [col.name, {
        name: col.name, type: col.type, description: col.description ?? null, level: 'full' as AccessLevel, sensitive: false, redaction: 'full' as RedactionStyle, entity: null, field: col.name }])) });
    }
  }
  const relationships: Relationship[] = [];
  for (const [en, e] of Object.entries(c.entities)) {
    for (const r of e.relationships ?? []) {
      if (tables.get(en)?.columns.has(r.field) && tables.get(r.references.entity)?.columns.has(r.references.field)) {
        relationships.push({ from: { table: en, column: r.field }, to: { table: r.references.entity, column: r.references.field } });
      }
    }
    if (tables.has(en) && tables.has('batches')) relationships.push({ from: { table: en, column: '_batch_id' }, to: { table: 'batches', column: 'id' } });
  }
  for (const t of ['reconciliation_results', 'quality_results', 'quarantine']) {
    if (tables.has(t) && tables.has('batches')) relationships.push({ from: { table: t, column: 'batch_id' }, to: { table: 'batches', column: 'id' } });
  }
  // Business definitions, only when every field they depend on is fully visible to the role.
  const metrics = c.outputs.metrics.filter((m) => {
    const used = new Set<string>(m.field ? [m.field] : []);
    JSON.stringify(m.filter ?? {}, (k, v) => { if ((k === 'field' || k === 'other_field') && typeof v === 'string') used.add(v); return v; });
    return [...used].every((f) => tables.get(m.entity)?.columns.get(f)?.level === 'full');
  }).map((m) => ({ id: m.id, title: m.title, description: m.description,
    definition: `${m.aggregation}(${m.field ?? '*'}) over ${m.entity}${m.filter ? ` where ${JSON.stringify(m.filter)}` : ''}; reported metrics count records from trusted batches only (_trust_status = 'trusted')` }));
  return { tenant: set.tenant, role, querySchema: querySchemaName(set.tenant), tables, relationships, metrics };
}

/** JSON form of the catalog for the API, the UI and model providers. Contains metadata only, never values. */
export function catalogJson(cat: Catalog) {
  return {
    tenant: cat.tenant, role: cat.role,
    tables: [...cat.tables.values()].map((t) => ({
      name: t.name, kind: t.kind, description: t.description, key: t.key,
      columns: [...t.columns.values()].map((c) => ({ name: c.name, type: c.type, description: c.description, access: c.level,
        ...(c.sensitive ? { sensitive: true, redaction: c.redaction } : {}) })),
    })),
    relationships: cat.relationships,
    metrics: cat.metrics,
    access_levels: {
      full: 'may be returned, grouped, sorted, aggregated and used in any expression',
      masked: 'returned only in redacted form; usable only in relationship joins and IS [NOT] NULL tests',
      filter: 'never returned; usable only in relationship joins and IS [NOT] NULL tests',
      discover: 'listed for reference; cannot be used in queries',
    },
  };
}
