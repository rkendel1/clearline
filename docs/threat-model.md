# Privacy and tenant-isolation threat model

**Scope.** The Clearline API, worker, native desktop client, query workspace (including the optional external model provider) and PostgreSQL database as deployed by this repository. **Data.** Exclusively synthetic. SSNs use the never-issued 9xx range, names come from fixed word lists, and emails use `example.test`. Clearline must not be used with real member or patient information in its current form.

**This is not a HIPAA compliance claim.** The controls below are real and tested, but compliance depends on administrative, physical and organisational safeguards, contracts (BAAs) and audited operation that a repository cannot supply. The gap list at the end says what a regulated deployment would still need.

## Assets

| Asset | Where | Sensitivity |
|---|---|---|
| Canonical member/enrollee records with PII (SSN, names, email) and PHI (DOB, gender, diagnosis) | `t_<tenant>.*` | Highest |
| Raw staged payloads (all source columns, including unmapped ones) | `core.raw_records.payload` | Highest, retained `raw_payload_days` |
| Quarantined rows and findings | `core.quarantine`, `core.quality_findings` | High (messages exclude pii/phi values) |
| Extracts delivered to users | outside the system once downloaded | High |
| API tokens | `core.api_tokens` (SHA-256 hashes only) | Credential |
| Audit trail, export log, erasure log | `core.audit_events`, `core.export_log`, `core.erasure_log` | Integrity-critical |
| Contracts (which fields are sensitive) | `core.contract_versions` | Integrity-critical |
| Field policies (role access, sensitivity, redaction, unmask roles) and their history | `core.field_policies`, `core.field_policy_versions` | Integrity-critical: a wrong policy discloses data |
| Query proposals and execution metadata (questions, SQL, columns, timings; never result rows) | `core.query_proposals`, `core.query_executions` | High: SQL text can carry literals a user typed |
| Query surface: per-tenant views, query roles and their column grants, the query login | `q_<tenant>.*`, `clearline_q_<tenant>_<role>`, `clearline_query` | Enforcement-critical |
| Query results displayed or exported | native client memory; CSV downloads | High (already redacted for the role) |

## Actors and trust boundaries

1. **Tenant users** (admin, steward, operator, reporter) via API tokens: trusted only within their tenant and role. The **steward** classifies data: it may tighten field policies but not widen them (that needs `policy:grant`, admin only), and it sees original sensitive values only where a policy names it.
2. **Platform administrator**: creates tenants, issues each tenant's *first* admin token, and issues approver tokens. It has no tenant data permissions, cannot issue further admin, operator or reporter tokens once a tenant has an admin, and cannot revoke admins (which would let it re-bootstrap).
3. **Approvers**: decide breaking contract migrations. They can read contracts and migration plans only, with no tenant data. Their tokens come only from the platform administrator, so no tenant admin can approve their own change.
4. **BI users** via a database login granted a tenant reporting role: may read only `reporting.*` and `t_<tenant>.rpt_*`.
5. **Source systems**: submit data with an operator token; payload contents are untrusted input.
6. **The model provider** (optional, e.g. Anthropic): receives the question and the *role-filtered* catalog (table, column and type names, descriptions, the role's access levels; never values, never fields hidden from the role). Its output is **untrusted**: it is treated exactly like SQL typed by the user.
7. **The query login** `clearline_query`: owns no privileges and can only `SET ROLE` to the query roles; queries run under it on a separate pool.
8. **Native client**: runs on the user's machine with the user's token; trusted to display what the server sends and nothing more. It holds no authorization logic, so a modified client gains nothing the API would not give the same token.
9. **The service itself** (DB role `clearline`, member of `clearline_service`): fully trusted; compromise is out of scope beyond the noted gaps.

## Threats and controls

| # | Threat | Control | Evidence |
|---|---|---|---|
| T1 | A tenant user reads another tenant's data via the API | Three layers. (1) Every tenant-scoped route is authorized against `:tenant` before the handler runs. (2) The authenticated tenant is bound to the request (`AsyncLocalStorage`), and the data layer refuses to open a transaction for any other tenant, so a route that skips or mis-applies authorization still cannot read another tenant (audited as `authz.scope_violation`). (3) Core tables enforce **row-level security** (`FORCE RLS`, `core.can_see_tenant`) keyed on the transaction's tenant, which catches queries that forget a `tenant_id` filter. | Scenario G: 4 endpoints × 2 roles → 403 `cross_tenant_denied`; platform admin → 403. Integration test for layer 2. Mutation check: with layer 1 deleted, the same requests still returned 403 with no data returned |
| T2 | A BI user reads another tenant's data via SQL | Reporting roles are NOLOGIN groups mapped to exactly one tenant; RLS resolves the session user's tenant through a SECURITY DEFINER function; setting `app.tenant_id` does not widen visibility; base tables and raw records are not granted | Scenario G (SQL section); Scenario J BI login |
| T3 | Unauthorized sensitive-field export, or inference of redacted values | Extracts redact `pii`/`phi` fields by default; `include_sensitive` requires `extract:sensitive` (admin only); denied attempts are audited with parameters; contracts cannot declare `pii`/`phi` fields filterable (range filters would leak values) | Scenario G; integration and unit tests; mutation `redaction-removed` |
| T4 | Sensitive data leaks through reporting views | `rpt_*` views are generated without `pii`/`phi` columns; lowering a field's sensitivity is a breaking change requiring approval | Scenario G column check; unit test `storage generation…` |
| T5 | Sensitive data arrives in an unexpected column or field | Unmapped columns and non-sensitive string fields are scanned for SSN, email and phone patterns and suspicious column names → quarantine (default) or warning. Detected values are scrubbed from the retained raw payload, both for unmapped columns and for the mapped source column of a flagged field. | Scenario D; integration test |
| T6 | Sensitive values leak into logs, error messages, quarantine or findings | Structured logger replaces payload-like keys (`payload`, `row`, `values`, `authorization`, …). Validation messages never echo values of `pii`/`phi` fields, nor any value that *looks* like an SSN, email or phone number, whatever its field. Audit details carry ids and counts, never record values, and subject keys in access events are hashed. | Unit tests; integration tests; Scenario G (audit scan) |
| T7 | Audit trail tampering | `audit_events` rejects UPDATE and TRUNCATE outright. The trigger allows DELETE only inside a retention run **and** only for rows older than the tenant's `audit_days`, which must be ≥ every data retention period. Denials are written outside the failing transaction. | Scenario G (trigger); integration test (young rows cannot be deleted even in a retention session); mutation `audit-floor-removed` |
| T8 | Stolen or leaked token | Tokens stored as SHA-256 with their issuer; listing never returns secrets; revocation is immediate and audited; well-known demo tokens come only from the seed script, which refuses `NODE_ENV=production` | Integration tests |
| T9 | Privilege escalation | Role → permission table enforced by the backend. The platform admin is bootstrap-only (above). Breaking contract migrations need an **approver**, a separate role with no data access that tenant admins cannot create, plus an explicit version confirmation. A single person therefore cannot both make and approve a breaking change without the platform administrator's cooperation. | Integration tests; Scenario H; mutations `platform-admin-escalation`, `self-approval-allowed` |
| T10 | Malicious contract (code execution, SQL injection via identifiers) | Contracts are data: JSON Schema with `additionalProperties: false`, whitelisted transforms and formats only, no regex/code/SQL fields; identifiers pattern-checked and quoted; generated DDL never drops | Unit tests (contracts), Scenario H |
| T11 | Malicious payload (injection, resource exhaustion) | All values are bound parameters; size and row limits (`MAX_UPLOAD_BYTES`, `MAX_ROWS_PER_BATCH`); statement and batch timeouts; JSON records must be flat scalars | Unit tests (adapters), config |
| T12 | Client-side token theft or a browser being used against the API | There is no browser surface: the web dashboard was removed and the API serves JSON only, with `default-src 'none'; frame-ancestors 'none'`, `nosniff`, `no-referrer` and `no-store`. The native client keeps the token in process memory only (never on disk; `CLEARLINE_TOKEN` is a development convenience) and drops it on sign-out or on any `401`. | Integration test (headers); native e2e (sign-out, role navigation) |
| T13 | Data outlives its purpose | Configurable retention per tenant (raw payloads, resolved quarantine, superseded versions, audit). Subject erasure removes all versions, the raw payloads that produced them, quarantine entries and per-record findings; records only a hash of the key in the erasure log; lists prior exports that contained the subject; and records adjustments so reconciliation stays honest. | Integration tests (erasure, retention) |
| T14 | Model output is malicious or wrong (prompt injection through the question or through descriptions; SQL that writes, escapes the tenant or touches restricted fields) | The proposal is never trusted. Every proposal, generated or edited, goes through the same AST allowlist validator (`src/query/validate.ts`, libpg-query; no regex decisions), is rewritten onto the role's views, deparsed, **re-parsed and re-checked**, and is re-validated again at execution against the policy in force then. Nothing runs without an explicit run or preview by the user. The model's explanation is displayed as unverified; the structural summary shown beside it is computed by the server. | Unit tests (12 validator groups); Scenario K (lifecycle, hostile model output never executed), Scenario N1 (24 attacks); mutations `validator-restricted-check-removed`, `execute-without-revalidation` |
| T15 | A role reaches a restricted field indirectly: aliases, joins, subqueries, CTEs, aggregates, `ORDER BY`, `CASE`, functions, error messages, previews, history, exports | Column **lineage** is tracked through aliases, subqueries and CTEs; restricted fields are allowed only in the explicitly documented forms (related-key equality, `IS NULL`, key `IN (subquery)`, pass-through) and masked outputs are rewritten to `core.mask_value`. Hidden fields fail with the *same* message as nonexistent ones. Database errors are classified so no message carries a value the role cannot see. History re-validates each entry for the viewer and withholds other users' SQL that the viewer may not use; exports re-run the validated query under the viewer's role. | Scenario L (catalog, errors, history, export, audit), Scenario N1/N3; mutations `validator-restricted-check-removed`, `mask-rewrite-skipped`, `history-not-withheld`, `records-unredacted` |
| T16 | Validator bypass (a parser or validator bug, or a code path that forgets to validate) | **The database is the second boundary.** Queries run as `clearline_query` → `SET LOCAL ROLE clearline_q_<tenant>_<role>`, `BEGIN READ ONLY`, `search_path=pg_catalog`, statement timeout, with `current_user`/`session_user`/read-only verified before the SQL runs. The query role can read only its tenant's `q_<tenant>` views (RLS through `core.reporting_roles`) and only the columns its policy grants; hidden and discover-only columns are not granted at all. `RESET ROLE` lands in a login that can read nothing. Grants are regenerated in the same transaction as every policy or contract change. | Scenario N2 (validator bypassed: writes, other tenant, ungranted column, `RESET ROLE`); Scenario L (grants mirror policy); mutation `hidden-columns-granted` |
| T17 | Query resource exhaustion (expensive joins, huge results, many parallel runs, runaway queries) | Planner cost limit (`EXPLAIN`, `QUERY_MAX_COST`) checked before running; statement timeout; row and serialized-byte caps; per-tenant and global concurrency limits that refuse with `429` instead of queueing; user cancellation via `pg_cancel_backend`; validator size, depth, subquery and `FROM` limits; separate connection pool so queries cannot starve ingestion. | Scenario N4/N5 (timeout, cancel, cost, caps, concurrency); `docs/benchmark.md` (concurrency) |
| T18 | Data exposure to the model provider | Off by default (`NL_SQL_PROVIDER=deterministic`; `none` disables generation). When enabled, the provider receives only the role-filtered catalog and the question; identifier-like strings (SSN, email, phone patterns) are scrubbed from the question before it is sent and audited as kinds only. No rows or values are ever sent. Provider failures return `503 provider_unavailable`, and manual SQL keeps working. | Scenario K (role-filtered catalog, provider unavailable → 503 with manual SQL still working) |
| T19 | Policy tampering or silent widening | Policies are versioned append-only with before/after; every change is audited with whether it narrowed or widened access. Widening needs `policy:grant` (admin); stewards are refused and the refusal is audited. Optimistic version checks prevent lost updates. Results computed under an older policy are flagged (`stale_policy`) and never persisted. | Scenario M; unit tests (policy); mutations `steward-may-widen`, `sensitivity-does-not-mask` |

## Treatment of derived data on deletion

| Derived artefact | On erasure / retention |
|---|---|
| Metrics | Computed live, so the next query excludes erased records. No stored aggregates to purge. |
| Reporting views | Views over live tables; nothing to purge. |
| Extracts already delivered | Cannot be recalled. `erasure_log.affected_exports` lists them for follow-up with recipients. |
| Export log | Retains record ids (not values) as evidence of what was delivered. |
| Audit events | Retained to `audit_days`. They contain no record values; subject keys in access events are hashed. Extract **filter literals** (e.g. `member_id = …`) are kept as given in `extract.run` details and `export_log.params` (see gaps). |
| Backups | **Not handled by the platform.** Erased data persists in backups until they expire; backup retention must be set accordingly. |

## Known gaps (not implemented)

Query workspace and field policy:

- **Query roles can read `pg_catalog`** (PostgreSQL grants it to `PUBLIC`). The validator rejects every catalog-qualified name, and the catalog reveals structure rather than values, but a validator bypass would let a query role read the names of other tenants' schemas and roles. Revoking `PUBLIC` catalog access is not practical in PostgreSQL; a separate database per tenant would be.
- **No small-cell suppression or differential-privacy noise.** Aggregates over fields a role may see in full are returned exactly, so carefully chosen filters over *unrestricted* fields can narrow a group to one person. Restricted fields cannot be aggregated, grouped or compared.
- **Filter-level access discloses presence and key equality** by design (`IS NULL`, related-key joins), as documented in [query-workspace.md](query-workspace.md).
- **Concurrency limits are per API process** (in memory). With several API replicas the effective limit is multiplied; a shared limiter (advisory locks or a counter table) would be needed.
- **The model provider sees catalog metadata** (names, descriptions, access levels) for the asking role. Column descriptions written into contracts are therefore disclosed to the provider when it is enabled.
- **Question text and SQL are stored** in `core.query_proposals` and may contain literals the user typed (for example a member id). They are subject to tenant RLS and to `query:history` permissions, but not to field-level redaction or subject erasure.
- **The deterministic provider understands a fixed set of intents**; anything else returns "cannot answer" and needs the external provider or hand-written SQL.

Platform:

- **The database cannot protect the audit trail from its own owner.** A table owner or superuser can disable triggers. Production should run the service as a non-owner role and ship audit events to external write-once storage.
- **Extract filter values are stored verbatim** in `export_log.params` and `extract.run` audit details, so a filter on a subject's id survives that subject's erasure.
- **Erasure covers processed data.** Raw rows of batches that are still queued or failed, and quarantined rows whose key could not be parsed, are not located by key.
- **`/metrics` is unauthenticated unless `METRICS_TOKEN` is set**, and exposes tenant ids, source names, backlog and freshness.

- **Canonical tenant tables (`t_<tenant>.*`) are protected by schema separation and the request-bound tenant scope, not by RLS.** The service role can read all tenant schemas, so a bug that builds the wrong schema name *inside an otherwise correctly scoped transaction* would not be stopped by the database. A per-tenant runtime role (`SET ROLE` per transaction) would close this.
- `withSystem` (platform scope, used for authentication and token management) is not restricted by the request binding. Its call sites are few and reviewed, but a misuse would bypass tenant RLS.
- **Single database role** for migrations and runtime. Production should split an owner/migration role from a least-privilege runtime role.
- **No encryption of individual fields** at rest; at-rest protection relies on the database volume or managed service. No application-level key management.
- **Static bearer tokens**: no expiry, no SSO/OIDC, no MFA, no per-token scopes beyond role. Revocation exists, rotation is manual.
- **No rate limiting or lockout** on authentication failures (failures are counted in metrics).
- **Read-access audit is best-effort.** Write and denial audits are transactional, but if writing the `access.read` event fails the response still succeeds. A regulated deployment should fail closed or buffer.
- **TLS is not terminated by the application.** Deploy behind a TLS-terminating proxy or load balancer. The compose file binds to 127.0.0.1 only.
- **Raw payloads retain all source columns** (including unmapped ones) for `raw_payload_days` (default 90) for provenance and replay. Shorten the period, or drop unmapped columns at intake, if that is unacceptable.
- **Sensitive-data detection is pattern-based** (SSN, email, phone, column names) and will miss free-text PHI.
- **No data-loss-prevention on extracts** beyond redaction and audit (no watermarking, no download limits).

## What a regulated (HIPAA) deployment would additionally require

Risk analysis and management program; BAAs with every subprocessor (cloud, monitoring, backup); workforce training and sanctions; SSO with MFA and access reviews; least-privilege database roles and RLS on canonical tables; encryption at rest with managed keys and encrypted backups with tested restore and erasure handling; centralized tamper-evident log retention; intrusion detection and vulnerability management; incident response and breach notification procedures; documented minimum-necessary policies per role and extract; contingency planning (backup, disaster recovery, emergency mode); and periodic independent assessment.
