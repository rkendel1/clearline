# Canonical data contracts

A contract is a versioned JSON document that defines, for one tenant, what its data **means**: entities and typed fields, sensitivity, how each source maps onto them, which rules a record must satisfy, how corrections work, which outputs exist, and which invariants must hold across the dataset. The platform stores and processes data only as the active contract declares. Tenant contracts are configuration, never code.

- **Formal definition:** [`contracts/contract.schema.json`](../contracts/contract.schema.json) (JSON Schema 2020-12), also served at `GET /api/v1/contract-schema`.
- **Examples:** [`contracts/northwind/v1.json`](../contracts/northwind/v1.json) (medical plan administrator), [`contracts/bluefin/v1.json`](../contracts/bluefin/v1.json) (pharmacy benefit manager), [`contracts/northwind/v2.json`](../contracts/northwind/v2.json) (breaking evolution), [`contracts/northwind/v2-unsafe.json`](../contracts/northwind/v2-unsafe.json) (rejected evolution).

## Document structure

| Property | Purpose |
|---|---|
| `contract_id`, `tenant`, `version` | Identity. `version` is semver; breaking changes require a major increment. Versions are immutable once published. |
| `entities.<name>` | `fields`, `key` (entity identity), `correction` (how new versions relate to old), `relationships`, `rules`, `freshness`. |
| `sources.<id>` | `entity`, accepted `formats` (`csv`, `json`), `mappings`, `control_totals.sum_fields`, `max_reject_rate`, `max_processing_seconds`, `sensitive_scan` policy. |
| `outputs.metrics[]` | Declared metrics: entity, aggregation, field, filter, unit. |
| `outputs.extracts[]` | Declared CSV extracts: entity, ordered field list, `filterable` fields. |
| `dataset_checks[]` | Invariants over the trusted dataset (left aggregate `op` right aggregate or constant, with tolerance). |
| `migration` | `backfill` values and enum `value_maps`, which make a breaking change mechanically safe for existing records. |

Lifecycle states: `pending_approval` → `active` → `superseded`, or `rejected` / `rolled_back`.

## Deliberately limited feature set

The first release supports a small, fully-specified vocabulary. Anything else is **rejected at validation** with a path and reason. Nothing is approximated, and no tenant-supplied code, regular expression or SQL is ever executed.

**Field types:** `string` (`max_length`, named `format`), `enum` (`values`), `integer` (`min`/`max`, safe-integer range), `decimal` (`precision`, `scale`; exact, never rounded on input), `date` (ISO), `timestamp` (ISO-8601 with zone, stored UTC), `boolean`.

**Named formats** (fixed regular expressions owned by the platform): `digits`, `alnum`, `zip5`, `npi10`, `ndc11`, `icd10`, `state2`.

**Field attributes:** `required` (the source must supply the column), `nullable` (default true), `sensitivity` (`public` | `internal` | `pii` | `phi`; default `internal`).

**Transforms** (applied in order; at most one `parse_*`, and it must come last):

| Op | Effect |
|---|---|
| `trim`, `upper`, `lower`, `strip_non_digits` | Text normalisation |
| `left_pad {length, char}` | Pad, e.g. NDC to 11 digits |
| `map_values {map, unmapped: keep\|null\|error}` | Code translation, e.g. `P` → `PAID` |
| `default {value}` | Substitute for empty |
| `parse_date {format: YYYY-MM-DD\|MM/DD/YYYY\|YYYYMMDD}` | Calendar-validated dates |
| `parse_timestamp {format: iso8601}` | Zone required |
| `parse_decimal {implied_scale?}` | `$1,234.50`, `(12.00)` and implied cents `12345` → `123.45` |
| `parse_integer`, `parse_boolean {true_values, false_values}` | Strict parsing |

A mapping takes `from` (one column, or several columns joined with `separator`, e.g. Bluefin's `SUB_ID-DEP_SEQ` enrollee key) or a `constant`.

**Conditions** (rules, metric filters, dataset-check filters): `eq ne lt lte gt gte` against a literal or `other_field`, `in`/`not_in`, `is_null`/`not_null`, `not_after_arrival` (relative to the batch's arrival, so results are deterministic), `within_days_of`, combined with `all`/`any`/`not` up to depth 6. Evaluation uses SQL three-valued logic: a comparison involving null is unknown and never fails a rule. Requiredness is enforced separately by `nullable`/`required`.

**Aggregations:** `count`, `count_distinct`, `sum`, `avg`.

## Processing semantics the contract controls

- **Validation order.** Structural checks (parse, type, nullability, constraints) come first. Business rules run only on structurally valid rows, so they never produce noise over garbage values. Each finding records rule id, category, severity, field and message. Messages never echo `pii`/`phi` values.
- **Severity.** `error` quarantines the row; `warning` admits it and records a finding.
- **Keys and duplicates.** `key` fields form `_key`. A row whose canonical values hash identically to an existing version of the same key is an exact duplicate: counted, linked, no effect.
- **Corrections** (`correction.strategy`):
  - `supersede_by_order` with `order_by` (integer, date or timestamp): a higher value becomes the current version. A lower value is stored as history (`_is_late`) without changing current results. The same order value with different content is a **conflict** and is quarantined, because the platform cannot know which version is right.
  - `last_arrival_wins`: each new distinct version becomes current.
  - `immutable`: a different version of an existing key is a conflict.
- **Relationships.** `on_missing: quarantine` rejects orphans. `warn` admits them, flags them, and lists them under dataset reconciliation and the exception report until the referenced record arrives.
- **Trust.** A batch is trusted only if every reconciliation check passes and its quarantine rate is at or below `max_reject_rate` (default 5%).
- **Sensitive data in unexpected places.** Unmapped columns whose values look like SSNs, emails or phone numbers (or whose names look sensitive), and non-sensitive string fields containing such values, are flagged or quarantined per `sensitive_scan` (default: quarantine). Values detected in unmapped columns are also scrubbed from the retained raw payload.

## What publishing does

`POST /api/v1/tenants/:tenant/contracts`:

1. **Validate**: JSON Schema, then semantic checks (cross-references, type compatibility, parse/type agreement, key and order-by rules, filterability, migration hints).
2. **Plan** against the active version: a deterministic, reviewable document listing each change with its classification, the table DDL, the view statements that will be regenerated (`view_ddl`), the data operations, the number of distinct current rows affected, and the rollback path. Dry-run with `POST …/contracts/validate`.
3. **Apply or hold**:
   - `initial` or `compatible` → applied immediately (DDL + regenerated views + lifecycle), HTTP 201.
   - `requires_approval` (any breaking change) → stored as `pending_approval`, HTTP 202. Nothing changes until an **approver** approves with `confirm_version`. Approvers are a separate role: they see no tenant data, and only the platform administrator can issue their tokens, so no tenant admin can approve their own change. Further publishes return 409 until it is decided.
   - `rejected` (any unsupported change) → nothing stored, HTTP 422, audited.

Generated DDL is limited to `CREATE SCHEMA/TABLE/INDEX IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` and safe `ALTER COLUMN TYPE` widenings. Generated views (`current_*`, `rpt_*`, `rpt_trusted_*`) are dropped and recreated around that DDL, because views pin the column types they read. Identifiers are pattern-validated and quoted. **No generated statement drops or truncates a table or column.**

### Compatibility rules

| Change | Classification | What happens |
|---|---|---|
| Add entity or source; add optional field; make a field optional or nullable; add enum values; widen integer→decimal or decimal precision/scale; enum→string; add a `warning` rule; change mappings, outputs, dataset checks or freshness; tighten a reject threshold, add control totals or strengthen the sensitive scan | compatible | Applied on publish. Existing records keep their contract and transform versions. |
| Add a non-nullable field **with** `migration.backfill`; make a field non-nullable **with** backfill; replace enum values **with** `migration.value_maps`; remove a field or entity; add/change/remove an `error` rule; change correction semantics, relationships, constraints or requiredness; **lower a field's sensitivity**; remove a source; **raise a source's `max_reject_rate`, remove a control-total field, or weaken `sensitive_scan` from quarantine to warn** | breaking: requires approval and a major version | Applied only after approval. Data operations write **new record versions** tagged `_migration_id`. Prior versions are never edited, so they keep their original meaning. Removed fields and entities keep their columns and data. |
| Change an entity key; change type in a way that can alter meaning (e.g. decimal→integer); narrow precision/scale; remove enum values or add non-nullable fields **without** a declared mapping/backfill; version not greater than active | unsupported | Rejected with reasons. |

**Rollback.** `POST …/migrations/:id/rollback` deletes the migration-created versions, makes the superseded ones current again and re-activates the previous contract. It is allowed only until a batch has been processed under the new version (409 `rollback_window_closed` afterwards), because after that rolling back would discard real data. Past that point the strategy is to roll forward with a new version. Added columns are retained, unused. Scenario H exercises the full path.

**Batches queued across a migration.** A batch is pinned to the contract that was active when it arrived. If a migration is applied while it waits, processing checks what changed. If every intervening migration was compatible, the batch is re-pinned to the active contract (audited as `batch.repinned`). If any was breaking, the batch fails with `ContractSupersededError` and has no effects; replaying it re-processes the staged rows under the active contract.

## The two demonstration tenants

| | Northwind (medical) | Bluefin (pharmacy) |
|---|---|---|
| Entities | plan, member, claim, pharmacy_fill | benefit_plan, enrollee, rx_claim |
| Keys | single-column ids | enrollee = `SUB_ID-DEP_SEQ` (concatenated) |
| Dates | `MM/DD/YYYY` (members), ISO (claims) | `YYYYMMDD` |
| Money | decimal strings | implied cents (`implied_scale: 2`) |
| Corrections | claims by `adjudication_seq`, members by `updated_at` | claims by `adjudicated_at`, enrollees by `record_version` |
| Sources | 3 CSV + 1 JSON API | 1 JSON API + 2 CSV |
| Sensitive | SSN, names (pii); DOB, gender, diagnosis (phi) | name, email (pii); birth date (phi) |

Both run through identical code. The full field-level definitions are in [data-dictionary.md](data-dictionary.md).
