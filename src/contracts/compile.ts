// Deterministic generation of tenant storage structures from a contract.
// Only DDL derived from validated declarations is produced; identifiers are
// pattern-checked by the schema and quoted again here.

import { createHash } from 'node:crypto';
import { ident } from '../platform/db.js';
import type { Contract, EntityDef, FieldDef } from './types.js';
import { SENSITIVE } from './types.js';
import { TRANSFORM_ENGINE_VERSION } from '../transform/transforms.js';

export const SYSTEM_COLUMNS = [
  '_record_id', '_key', '_record_hash', '_is_current', '_is_late', '_batch_id', '_raw_record_id',
  '_contract_version_id', '_transform_version', '_loaded_at', '_migration_id', '_supersedes_record_id',
] as const;

export function sqlType(f: FieldDef): string {
  switch (f.type) {
    case 'string': return 'text';
    case 'enum': return 'text';
    case 'integer': return 'bigint';
    case 'decimal': return `numeric(${f.precision},${f.scale})`;
    case 'date': return 'date';
    case 'timestamp': return 'timestamptz';
    case 'boolean': return 'boolean';
  }
}

export function contractHash(c: Contract): string {
  return createHash('sha256').update(stableStringify(c)).digest('hex');
}

export function transformVersion(c: Contract): string {
  return `engine@${TRANSFORM_ENGINE_VERSION}+contract@${c.version}#${contractHash(c).slice(0, 12)}`;
}

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function schemaName(tenant: string): string { return `t_${tenant}`; }
export function table(tenant: string, entity: string): string { return `${ident(schemaName(tenant))}.${ident(entity)}`; }
export function reportingRole(tenant: string): string { return `clearline_rpt_${tenant}`; }

export function createEntityTableDDL(tenant: string, entity: string, e: EntityDef): string[] {
  const t = table(tenant, entity);
  const cols = Object.entries(e.fields).map(([n, f]) => `  ${ident(n)} ${sqlType(f)}`);
  return [
    `CREATE TABLE IF NOT EXISTS ${t} (
  "_record_id" bigserial PRIMARY KEY,
  "_key" text NOT NULL,
  "_record_hash" text NOT NULL,
  "_is_current" boolean NOT NULL,
  "_is_late" boolean NOT NULL DEFAULT false,
  "_batch_id" uuid NOT NULL,
  "_raw_record_id" bigint,
  "_contract_version_id" bigint NOT NULL,
  "_transform_version" text NOT NULL,
  "_loaded_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "_migration_id" bigint,
  "_supersedes_record_id" bigint,
${cols.join(',\n')}
)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${ident(`${entity}_current_key`)} ON ${t} ("_key") WHERE "_is_current"`,
    `CREATE INDEX IF NOT EXISTS ${ident(`${entity}_key_hash`)} ON ${t} ("_key", "_record_hash")`,
    `CREATE INDEX IF NOT EXISTS ${ident(`${entity}_batch`)} ON ${t} ("_batch_id")`,
  ];
}

/** Views are fully regenerated for every active contract version. */
export function viewsDDL(tenant: string, c: Contract): string[] {
  const s = ident(schemaName(tenant));
  const role = ident(reportingRole(tenant));
  const out: string[] = [];
  for (const [en, e] of Object.entries(c.entities)) {
    const t = table(tenant, en);
    const fields = Object.keys(e.fields).map((f) => `r.${ident(f)}`);
    const publicFields = Object.entries(e.fields).filter(([, f]) => !SENSITIVE.has(f.sensitivity ?? 'internal')).map(([n]) => `r.${ident(n)}`);
    const lineage = `r."_record_id", r."_key", r."_batch_id", r."_raw_record_id", r."_contract_version_id", r."_transform_version", r."_loaded_at", r."_is_late", r."_migration_id", b.trust_status AS "_trust_status"`;
    const from = `FROM ${t} r JOIN core.batches b ON b.id = r."_batch_id" WHERE r."_is_current"`;
    out.push(`DROP VIEW IF EXISTS ${s}.${ident(`current_${en}`)}`);
    out.push(`CREATE VIEW ${s}.${ident(`current_${en}`)} AS SELECT ${lineage}, ${fields.join(', ')} ${from}`);
    out.push(`DROP VIEW IF EXISTS ${s}.${ident(`rpt_${en}`)}`);
    out.push(`CREATE VIEW ${s}.${ident(`rpt_${en}`)} AS SELECT ${lineage}${publicFields.length ? ', ' + publicFields.join(', ') : ''} ${from}`);
    out.push(`GRANT SELECT ON ${s}.${ident(`rpt_${en}`)} TO ${role}`);
    // Trusted state for BI: per key, the latest version from a trusted batch (same rule as trusted metrics and extracts).
    out.push(`DROP VIEW IF EXISTS ${s}.${ident(`rpt_trusted_${en}`)}`);
    out.push(`CREATE VIEW ${s}.${ident(`rpt_trusted_${en}`)} AS SELECT ${lineage}${publicFields.length ? ', ' + publicFields.join(', ') : ''}
      FROM (SELECT DISTINCT ON (x."_key") x.* FROM ${t} x JOIN core.batches xb ON xb.id = x."_batch_id" WHERE NOT x."_is_late" AND xb.trust_status = 'trusted' ORDER BY x."_key", x."_record_id" DESC) r
      JOIN core.batches b ON b.id = r."_batch_id"`);
    out.push(`GRANT SELECT ON ${s}.${ident(`rpt_trusted_${en}`)} TO ${role}`);
  }
  return out;
}

export function tenantBootstrapDDL(tenant: string): string[] {
  const role = reportingRole(tenant);
  return [
    `CREATE SCHEMA IF NOT EXISTS ${ident(schemaName(tenant))}`,
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${ident(role)} NOLOGIN; END IF; END $$`,
    `GRANT USAGE ON SCHEMA ${ident(schemaName(tenant))} TO ${ident(role)}`,
    `GRANT USAGE ON SCHEMA reporting TO ${ident(role)}`,
    // USAGE lets the row-level-security predicate functions resolve; no core table is granted.
    `GRANT USAGE ON SCHEMA core TO ${ident(role)}`,
    `GRANT EXECUTE ON FUNCTION core.can_see_tenant(text), core.reporting_tenant(name) TO ${ident(role)}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO ${ident(role)}`,
  ];
}
