# Privacy and tenant-isolation threat model

**Scope.** The Clearline API, worker, dashboard and PostgreSQL database as deployed by this repository. **Data.** Exclusively synthetic. SSNs use the never-issued 9xx range, names come from fixed word lists, and emails use `example.test`. Clearline must not be used with real member or patient information in its current form.

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

## Actors and trust boundaries

1. **Tenant users** (admin, operator, reporter) via API tokens: trusted only within their tenant and role.
2. **Platform administrator**: creates tenants and issues first tokens. **No tenant data permissions by design.**
3. **BI users** via a database login granted a tenant reporting role: may read only `reporting.*` and `t_<tenant>.rpt_*`.
4. **Source systems**: submit data with an operator token; payload contents are untrusted input.
5. **The service itself** (DB role `clearline`, member of `clearline_service`): fully trusted; compromise is out of scope beyond the noted gaps.

## Threats and controls

| # | Threat | Control | Evidence |
|---|---|---|---|
| T1 | A tenant user reads another tenant's data via the API | Every tenant-scoped route is authorized against `:tenant` **before** the handler runs; every data access runs in a transaction scoped by `app.tenant_id`; core tables enforce **row-level security** (`FORCE RLS`, policy `core.can_see_tenant`) as a second, independent layer | Scenario G: 4 endpoints × 2 roles → 403 `cross_tenant_denied`; platform admin → 403 |
| T2 | A BI user reads another tenant's data via SQL | Reporting roles are NOLOGIN groups mapped to exactly one tenant; RLS resolves the session user's tenant through a SECURITY DEFINER function; setting `app.tenant_id` does not widen visibility; base tables and raw records are not granted | Scenario G (SQL section); Scenario J BI login |
| T3 | Unauthorized sensitive-field export | Extracts redact `pii`/`phi` fields by default; `include_sensitive` requires `extract:sensitive` (admin only); denied attempts are audited with parameters | Scenario G; integration tests |
| T4 | Sensitive data leaks through reporting views | `rpt_*` views are generated without `pii`/`phi` columns; lowering a field's sensitivity is a breaking change requiring approval | Scenario G column check; unit test `storage generation…` |
| T5 | Sensitive data arrives in an unexpected column or field | Unmapped columns and non-sensitive string fields are scanned for SSN/email/phone patterns and suspicious names → quarantine (default) or warning; detected raw values are scrubbed from the retained payload | Scenario D |
| T6 | Sensitive values leak into logs or error messages | Structured logger replaces payload-like keys (`payload`, `row`, `values`, `authorization`, …); validation messages omit values of `pii`/`phi` fields; audit details carry ids and counts, never record values | Scenario D (log capture), Scenario G (audit scan), unit test |
| T7 | Audit trail tampering | `audit_events` rejects UPDATE/DELETE/TRUNCATE by trigger; retention may delete only rows older than `audit_days`, which must be ≥ every data retention period; denials are written outside the failing transaction | Scenario G (trigger), integration test |
| T8 | Stolen or leaked token | Tokens are stored as SHA-256; listing never returns secrets; revocation is immediate and audited; well-known demo tokens are created only by the seed script, which refuses to run with `NODE_ENV=production` | Integration tests |
| T9 | Privilege escalation inside a tenant | Role → permission table enforced by the backend; breaking contract migrations require a **second** administrator and an explicit version confirmation | Integration role matrix; Scenario H |
| T10 | Malicious contract (code execution, SQL injection via identifiers) | Contracts are data: JSON Schema with `additionalProperties: false`, whitelisted transforms and formats only, no regex/code/SQL fields; identifiers pattern-checked and quoted; generated DDL never drops | Unit tests (contracts), Scenario H |
| T11 | Malicious payload (injection, resource exhaustion) | All values are bound parameters; size and row limits (`MAX_UPLOAD_BYTES`, `MAX_ROWS_PER_BATCH`); statement and batch timeouts; JSON records must be flat scalars | Unit tests (adapters), config |
| T12 | Browser-side token theft (XSS) or clickjacking | Strict CSP (`default-src 'self'`, no inline script, no third-party origins, fonts self-hosted), `frame-ancestors 'none'`, `nosniff`, `no-referrer`; token kept in `sessionStorage` only; API responses `no-store` | Integration test (headers); e2e (no CSP violations) |
| T13 | Data outlives its purpose | Configurable retention per tenant (raw payloads, resolved quarantine, superseded versions, audit); subject erasure removes all versions, raw payloads and quarantine entries, records only a hash of the key, lists prior exports that contained the subject, and records adjustments so reconciliation stays honest | Integration tests (erasure, retention) |

## Treatment of derived data on deletion

| Derived artefact | On erasure / retention |
|---|---|
| Metrics | Computed live, so the next query excludes erased records. No stored aggregates to purge. |
| Reporting views | Views over live tables; nothing to purge. |
| Extracts already delivered | Cannot be recalled. `erasure_log.affected_exports` lists them for follow-up with recipients. |
| Export log | Retains record ids (not values) as evidence of what was delivered. |
| Audit events | Retained to `audit_days`. They contain no record values, so they do not need erasing. |
| Backups | **Not handled by the platform.** Erased data persists in backups until they expire; backup retention must be set accordingly. |

## Known gaps (not implemented)

- **Canonical tenant tables (`t_<tenant>.*`) are protected by schema separation and application-level scoping, not by RLS.** The service role can read all tenant schemas. A bug that builds the wrong schema name in service code would not be stopped by the database. A per-tenant service role (`SET ROLE` per transaction) would close this.
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
