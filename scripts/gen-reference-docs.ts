// Generates docs/data-dictionary.md and docs/metrics.md from the shipped
// contracts, the platform metric definitions and a migrated database's
// information_schema, so the reference matches what actually exists.
// Usage: npm run docs:reference  (uses DATABASE_URL, default the local dev DB)

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Contract } from '../src/contracts/types.js';
import { PLATFORM_METRIC_DEFINITIONS } from '../src/reporting/definitions.js';
import { SYSTEM_COLUMNS } from '../src/contracts/compile.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (t: string, f: string): Contract => JSON.parse(readFileSync(path.join(ROOT, 'contracts', t, f), 'utf8'));
const contracts: [string, Contract][] = [['northwind', load('northwind', 'v1.json')], ['bluefin', load('bluefin', 'v1.json')], ['northwind (2.0.0)', load('northwind', 'v2.json')]];
const esc = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

const CORE: Record<string, string> = {
  tenants: 'One row per tenant: id (also the schema suffix), retention policy and its reporting role.',
  reporting_roles: 'Maps database roles used by BI tools to exactly one tenant (used by row-level security).',
  api_tokens: 'Hashed API tokens with tenant, role and issuer. Readable only in system scope.',
  contract_versions: 'Immutable contract documents per tenant with lifecycle (pending_approval, active, superseded, rejected, rolled_back) and transform version.',
  contract_migrations: 'Migration plans between contract versions: classification, plan JSON (changes, DDL, data ops, impact, rollback), approval and application state.',
  batches: 'One row per submitted payload: provenance (digest, arrival, source-reported time), contract/transform version, pipeline status, trust status and reasons, counts, lease and failure details.',
  batch_submissions: 'Every submission attempt, including exact duplicates that resolved to an existing batch.',
  batch_attempts: 'Each processing attempt: worker, timings, outcome (running, succeeded, failed, interrupted) and error.',
  raw_records: 'Staged source rows (payload as column -> string), row hash, final disposition and the canonical record it produced. Payload may be purged by retention or erasure; hash and row number remain.',
  quarantine: 'Rows held out of canonical data, with category and the full list of errors; open until resolved.',
  quality_results: 'One row per rule per batch attempt: evaluated and failed counts, severity, contract version.',
  quality_findings: 'Per-record findings (rule, field, message) — the "affected records" for each quality result.',
  reconciliation_results: 'Batch, re-verification and dataset checks: expected, actual, difference, explanation, run id, contract version.',
  audit_events: 'Append-only audit trail. The trigger blocks UPDATE and TRUNCATE, and allows DELETE only in a retention run for rows older than the tenant audit_days.',
  export_log: 'Every extract produced: parameters, as_of, row count, content SHA-256 and the record versions included.',
  erasure_log: 'Subject erasures: SHA-256 of the key (never the key), counts and affected prior exports.',
  batch_adjustments: 'Per-batch record of legitimate changes (erasure, retention removals; versions created or removed by contract migrations) so re-verification can tell them from drift.',
  worker_heartbeats: 'Live worker registry (last seen, current batch, state).',
  schema_migrations: 'Applied platform migrations with checksums.',
};
const SYS: Record<string, string> = {
  _record_id: 'Surrogate id of this record version.', _key: 'Canonical entity key (key fields joined).', _record_hash: 'SHA-256 of the canonical values; identifies exact duplicates.',
  _is_current: 'True for the one current version per key.', _is_late: 'Version arrived after a newer one and is kept as history only.', _batch_id: 'Batch that produced the version.',
  _raw_record_id: 'Source row that produced it (null for migration-created versions).', _contract_version_id: 'Contract version under which it was produced.',
  _transform_version: 'Transform engine + contract hash (or migration#id).', _loaded_at: 'When the version was written.', _migration_id: 'Migration that created this version, if any.',
  _supersedes_record_id: 'Prior version replaced by a migration-created version.',
};

async function main() {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://clearline:clearline@localhost:5432/clearline' });
  await db.connect();
  const cols = (await db.query(`SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema IN ('core','reporting') ORDER BY table_schema, table_name, ordinal_position`)).rows;
  const migs = (await db.query(`SELECT * FROM public.schema_migrations ORDER BY 1`).catch(() => ({ rows: [] }))).rows;
  await db.end();

  const d: string[] = ['# Data dictionary', '', '<!-- Generated by `npm run docs:reference`. Do not edit by hand. -->', '',
    'Three layers: **platform tables** in schema `core` (fixed, versioned migrations in `db/migrations`), **tenant canonical tables** in schema `t_<tenant>` (generated from that tenant\'s contract), and **read-only views** in `reporting` and `t_<tenant>.rpt_*` / `current_*`.', '',
    '## Migration history', '', '| Migration | Applied | Checksum |', '|---|---|---|',
    ...migs.map((m) => `| ${m.name ?? m.version ?? Object.values(m)[0]} | ${m.applied_at ? new Date(m.applied_at).toISOString().slice(0, 10) : ''} | \`${String(m.checksum ?? '').slice(0, 16)}…\` |`),
    '', 'Tenant storage changes are not platform migrations: they are contract migrations, planned and recorded in `core.contract_migrations` (see docs/contracts.md).', '',
    '## Platform tables (`core`)', ''];
  const byTable = new Map<string, typeof cols>();
  for (const c of cols) { const k = `${c.table_schema}.${c.table_name}`; byTable.set(k, [...(byTable.get(k) ?? []), c]); }
  for (const [t, cs] of byTable) {
    if (!t.startsWith('core.')) continue;
    d.push(`### ${t}`, '', CORE[t.slice(5)] ?? '', '', '| Column | Type | Nullable |', '|---|---|---|', ...cs.map((c) => `| ${c.column_name} | ${c.data_type} | ${c.is_nullable === 'YES' ? 'yes' : 'no'} |`), '');
  }
  d.push('## Reporting views (`reporting`)', '', 'Readable by tenant reporting roles; row-level security limits every row to the role\'s tenant.', '');
  for (const [t, cs] of byTable) if (t.startsWith('reporting.')) d.push(`- **${t}**: ${cs.map((c) => c.column_name).join(', ')}`);
  d.push('', '## System columns on every canonical table', '', '| Column | Meaning |', '|---|---|', ...SYSTEM_COLUMNS.map((c) => `| ${c} | ${SYS[c]} |`), '',
    'Each entity also gets three views: `current_<entity>` (all fields, current versions), `rpt_<entity>` (non-sensitive fields, current versions) and `rpt_trusted_<entity>` (non-sensitive fields, latest version from a trusted batch per key: the same rule as trusted metrics). The `rpt_` views are granted to the tenant reporting role and carry `_trust_status`.', '');
  for (const [tenant, c] of contracts) {
    d.push(`## Canonical model: ${tenant} (contract ${c.version})`, '', c.description ?? '', '');
    for (const [en, e] of Object.entries(c.entities)) {
      d.push(`### ${en}`, '', `${e.description ?? ''} Key: \`${e.key.join(' + ')}\`. Corrections: \`${e.correction.strategy}\`${e.correction.order_by ? ` by \`${e.correction.order_by}\`` : ''}.${e.freshness ? ` Freshness limit ${e.freshness.max_age_hours} h.` : ''}`, '',
        '| Field | Type | Required | Nullable | Sensitivity | Constraints | Description |', '|---|---|---|---|---|---|---|');
      for (const [fn, f] of Object.entries(e.fields)) {
        const cons = [f.values ? `one of ${f.values.join(', ')}` : '', f.format ? `format ${f.format}` : '', f.max_length ? `max ${f.max_length} chars` : '', f.min !== undefined ? `min ${f.min}` : '', f.max !== undefined ? `max ${f.max}` : ''].filter(Boolean).join('; ');
        const type = f.type === 'decimal' ? `decimal(${f.precision},${f.scale})` : f.type;
        d.push(`| ${fn} | ${type} | ${f.required ? 'yes' : 'no'} | ${f.nullable === false ? 'no' : 'yes'} | ${f.sensitivity ?? 'internal'} | ${esc(cons)} | ${esc(f.description)} |`);
      }
      if (e.relationships?.length) d.push('', `References: ${e.relationships.map((r) => `\`${r.field}\` → ${r.references.entity} (${r.on_missing})`).join('; ')}.`);
      if (e.rules?.length) d.push('', 'Rules:', ...e.rules.map((r) => `- \`${r.id}\` (${r.severity}): ${r.description}`));
      d.push('');
    }
    d.push(`**Sources**: ${Object.entries(c.sources).map(([s, x]) => `\`${s}\` (${x.formats.join('/')} → ${x.entity}${x.control_totals?.sum_fields?.length ? `; control sums ${x.control_totals.sum_fields.join(', ')}` : ''})`).join('; ')}.`, '');
  }
  writeFileSync(path.join(ROOT, 'docs/data-dictionary.md'), d.join('\n'));

  const m: string[] = ['# Metric definitions', '', '<!-- Generated by `npm run docs:reference`. Do not edit by hand. -->', '',
    'Every number in the native client comes from an API response, and every API number from one of the definitions below. The client formats values (digit grouping, currency sign) but never computes them. The same SQL compiler (`src/reporting/sql.ts`) serves metrics, extracts and dataset checks, so they cannot disagree about a definition. A metric computed over a field the viewer may not see in full is withheld for that role. Scenario J and `test/e2e/native.test.ts` verify that the client, the API, extracts and independent SQL agree.', '',
    '## How tenant-declared metrics are computed', '',
    '- **Source**: the entity\'s current canonical versions (`_is_current`) joined to `core.batches`.',
    '- **Trust scope**: `value` uses, per key, the latest version from a batch with `trust_status = trusted`. `value_including_untrusted` counts all processed batches; `untrusted_records_excluded` is the number of current records held back; `trusted = true` only when nothing was held back **and** no dataset check involving the entity is failing (failing checks are listed in `dataset_checks_failing`).',
    '- **Filters**: the metric\'s declared condition, compiled to SQL with three-valued logic (a null never satisfies a comparison).',
    '- **Aggregation**: `count`, `count_distinct(field)`, `sum(field)` rounded to the field\'s scale, `avg(field)` rounded to 4 places. Decimal sums are exact (PostgreSQL numeric).',
    '- **Refresh**: computed at query time from committed data. A batch\'s effects become visible atomically when its transaction commits.', ''];
  for (const [tenant, c] of contracts.slice(0, 2)) {
    m.push(`## ${tenant} (contract ${c.version})`, '', '| Metric | Definition | Entity | Aggregation | Filter | Unit |', '|---|---|---|---|---|---|');
    for (const x of c.outputs.metrics) m.push(`| **${esc(x.title)}** \`${x.id}\` | ${esc(x.description)} | ${x.entity} | ${x.aggregation}${x.field ? `(${x.field})` : ''} | \`${esc(x.filter ? JSON.stringify(x.filter) : 'none')}\` | ${x.unit ?? 'count'} |`);
    m.push('');
  }
  m.push('## Platform operational metrics', '', '| Metric | Definition | Source | Filters | Aggregation | Refresh |', '|---|---|---|---|---|---|',
    ...PLATFORM_METRIC_DEFINITIONS.map((x) => `| \`${x.id}\` | ${esc(x.definition)} | ${esc(x.source)} | ${esc(x.filters)} | ${esc(x.aggregation)} | ${esc(x.refresh)} |`), '',
    '## Prometheus metrics (`/metrics`)', '', '| Name | Type | Meaning |', '|---|---|---|',
    '| clearline_http_requests_total | counter | Requests by method, route, status |', '| clearline_http_request_duration_seconds | histogram | Request latency by route |',
    '| clearline_batches_submitted_total | counter | Submissions by tenant and outcome (accepted, duplicate, rejected) |', '| clearline_batches_processed_total | counter | Processing attempts by tenant, status and trust |',
    '| clearline_rows_processed_total | counter | Rows by tenant and disposition |', '| clearline_batch_processing_seconds | histogram | Claim-to-commit processing time |',
    '| clearline_authorization_denials_total | counter | Denials by reason (invalid_token, missing_permission, cross_tenant) |', '| clearline_backlog_batches | gauge | Queued and processing batches per tenant |',
    '| clearline_oldest_queued_seconds | gauge | Age of the oldest queued batch |', '| clearline_data_freshness_seconds | gauge | Seconds since the last trusted batch per source |',
    '| clearline_batches | gauge | All-time batches by pipeline status and trust |', '| clearline_workers_live | gauge | Workers with a heartbeat in the last 60 s |', '',
    'Counters and histograms are per process (API and each worker expose their own when scraped); gauges are computed from the database at scrape time and are therefore identical on every instance.', '');
  writeFileSync(path.join(ROOT, 'docs/metrics.md'), m.join('\n'));
  console.log('wrote docs/data-dictionary.md and docs/metrics.md');
}
await main();
