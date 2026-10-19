# Production-readiness report

Status of every capability the specification asks for, in four categories:

- **Tested**: implemented, and an automated test fails if it breaks (named). Where marked †, a planted defect in `npm run test:mutation` confirms the test catches the breakage ([results](../test-results/mutation.json)).
- **Implemented**: built and exercised, but without a dedicated automated assertion.
- **Unverified**: designed for but not demonstrated at the stated level (scale, duration, real infrastructure).
- **Missing**: not built.

Nothing here has run in production, so no uptime, scale or compliance claim is made. The full results of the latest run are in [test-results.md](test-results.md). This report was revised after an independent review of an earlier draft; the review's findings and their resolutions are listed at the end.

## Data lifecycle

| Capability | Status | Evidence / note |
|---|---|---|
| CSV and JSON API ingestion, separate source adapters | Tested | Scenarios A, B; unit tests (adapters) |
| Batch registration: digest, arrival and source-reported time, contract version, attempts, counts, outcomes, run id | Tested | Scenario A |
| Structural validation before transformation; structural vs business-rule separation | Tested | Scenario D; unit tests (engine) |
| Quarantine with actionable reasons and source row numbers | Tested | Scenario D; integration test (resolve) |
| Idempotent resubmission (sequential and 5 concurrent) | Tested † | Scenario C |
| Exact-duplicate records in a new file have no effect | Tested | Scenario C |
| A trusted resend re-establishes rows that only an untrusted batch delivered | Tested † | Scenario I (resend after in-transit loss: 250 accepted, 0 duplicates) |
| Corrections, late-arriving versions, conflicts | Tested | Scenario E |
| Point-in-time (`as_of`) extracts | Tested | Scenarios E, J |
| Deterministic transformation (same input + contract + engine → same hash) | Tested | Unit tests |
| Same extract parameters reproduce identical bytes | Tested, *qualified* | Scenario J. Holds while the underlying data and trust are unchanged. Trust changes, erasure and retention legitimately change what a given `as_of` returns. |
| Crash mid-transaction → no partial effects, automatic recovery | Tested | Scenario F1 (SIGKILL, separate process) |
| Graceful shutdown → abort, re-queue, exit 0 | Tested | Scenario F2 (interrupts a 25k-row batch). The CI Compose step checks exit 0 for an idle worker. |
| Repeated interruptions stop at `MAX_ATTEMPTS` | Implemented | Lease recovery is covered by F1; the SIGTERM path's attempt limit has no dedicated test |
| Failed batch inspectable and replayable | Tested | Integration test (injected failure → replay) |
| Batches queued across a contract migration: re-pinned if only compatible changes, failed without effects if breaking, replay under the active contract | Tested † | Scenario H steps 7–8 |
| Partially failed batch never appears fully successful | Tested † | Scenarios D, F, I |
| Lineage source row → version → reconciliation → metric → extract | Tested | Scenarios A, E, H, I (`trusted_record_id`) |

## Contracts

| Capability | Status | Evidence / note |
|---|---|---|
| Formal JSON Schema + semantic validation; unsupported declarations rejected | Tested | Unit tests (≈20 rejection cases); Scenario H |
| Two tenants with different canonical models on one codebase; third tenant created at runtime | Tested | Scenario B (includes a source grep for tenant names) |
| Generated DDL never drops tables or columns; views are dropped and regenerated, and listed in the plan | Tested | Unit tests; Scenario H (`plan.view_ddl`) |
| Compatible widenings (decimal precision, integer→decimal) actually apply | Tested | Scenario H step 7 |
| Compatibility classification, including source-level weakening (reject threshold, control totals, privacy scan) as breaking | Tested | Unit tests |
| Breaking change requires approval by an approver role that has no data access and that tenant admins cannot create | Tested † | Scenario H; integration test (platform admin) |
| Existing records keep their meaning (new versions, not edits) | Tested | Scenario H |
| Rollback window and refusal once new-version data exists | Tested | Scenario H |

## Quality and reconciliation

| Capability | Status | Evidence / note |
|---|---|---|
| Required/type, duplicate, referential, date/status, cross-field rules | Tested | Scenarios D, E; unit tests |
| Row-count and financial reconciliation (control totals, row accounting, target) | Tested † | Scenarios A, I; unit tests |
| Missing / unexpected / conflicting record detection | Tested | Scenarios E, I |
| Freshness and latency thresholds | Implemented | Computed in the operations report and `/metrics`; no test drives a source stale |
| Post-load drift detection (row counts and control-total fields), including migration-created versions; audited trust restoration | Tested † | Scenarios H step 9, I. Drift in *other* fields of a row is not detected. |
| Failing dataset checks qualify trusted metrics and extracts | Tested † | Scenario I |
| Trusted outputs use the latest trusted version (an untrusted correction never displaces trusted data) | Tested † | Scenario I step 5 |
| Dashboard distinguishes ran from trusted, using the API's verdict | Tested | e2e dashboard test |

## Privacy, security, isolation

| Capability | Status | Evidence / note |
|---|---|---|
| Route authorization + request-bound tenant scope in the data layer + RLS on core tables | Tested † | Scenario G; integration tests. Each layer has its own mutation. |
| Roles, plus the platform admin limited to bootstrap (first admin, approvers) | Tested † | Integration tests; Scenario H |
| Redaction in extracts, records, lineage and views | Tested † | Scenarios A, G |
| Sensitive data in unexpected places: detected, not echoed in messages, scrubbed from raw payloads | Tested | Scenario D; integration test; unit tests |
| Sensitive fields cannot be declared filterable | Tested | Unit test |
| Audit events for access (subject keys hashed), exports, contract changes, token management, quarantine, retention, erasure | Tested | Scenarios G, H; integration tests |
| Audit cannot be updated, truncated, or deleted before its retention period, enforced by the database trigger | Tested † | Scenario G; integration test. A table owner or superuser can still disable triggers (see gaps). |
| Safe logging | Tested | Unit test; Scenario D captures worker logs |
| Retention and erasure, including findings and derived data | Tested | Integration tests |
| Token hashing, listing without secrets, immediate revocation | Tested | Integration tests |
| Browser security headers (CSP etc.) | Tested | Integration test; e2e asserts no CSP violations |
| RLS on canonical tenant tables; split DB roles; SSO/MFA; rate limiting; field encryption | **Missing** | See [threat-model.md](threat-model.md) |
| HIPAA compliance | **Not claimed** | See the threat model's final section |

## Reporting

| Capability | Status | Evidence / note |
|---|---|---|
| Operations report, business summary, exception report | Tested | Scenarios A, I, J |
| Read-only SQL views, BI role scoping, `rpt_trusted_*` views | Tested | Scenarios G, J |
| CSV extracts: explicit schema, timestamps, filters, checksum, audit | Tested | Scenarios A, J |
| Documented metric definitions | Implemented | [metrics.md](metrics.md) generated from contracts and code |
| Declared metrics and operations totals equal independent SQL, ground truth and the dashboard | Tested | Scenario J; `test/e2e/dashboard.test.ts`. Freshness, latency percentiles, the daily series and exception-report contents are not independently checked. |

## Operations and delivery

| Capability | Status | Evidence / note |
|---|---|---|
| Docker Compose startup and demo against the stack | Tested | CI `container` job; local runs in development |
| Versioned migrations with checksums | Tested | Every run migrates fresh databases; checksum-mismatch detection is implemented but untested |
| CI runs typecheck, audits, unit, integration, scenario, mutation and e2e tests, and fails on failure | Tested | GitHub Actions; see [test-results.md](test-results.md) for the run |
| Dependency and secret scanning | Implemented | `npm audit` (high+), dependency review on PRs, gitleaks with an explicit allow-list |
| Liveness, readiness, Prometheus metrics | Tested | Integration test |
| Structured logs with correlation and run ids | Implemented | Emitted on every path; no test asserts log content beyond the safety unit test |
| Configurable resource and timeout limits | Implemented | [deployment.md](deployment.md); Compose CPU and memory limits |
| Backup, restore, recovery procedures | Implemented | [runbook.md](runbook.md); restore executed once in development (counts and totals matched); not automated |
| Benchmark with methodology | Implemented | [benchmark.md](benchmark.md); one 2-vCPU machine |
| More than 100k rows per batch, or 200k rows across parallel workers | **Unverified** | Not measured |
| Multiple API instances behind a load balancer | **Unverified** | Stateless by design; not run |
| Multi-day soak test (memory, connection churn) | **Unverified** | Not run |
| Alerting rules; dashboards in a monitoring system | **Missing** | Suggested alerts are in the runbook |
| Automated backups / PITR, restore drills | **Missing** | Documented, not automated |
| Scheduled retention and re-verification | **Missing** (scheduling) | The CLI and API exist; no scheduler ships |
| Cloud infrastructure as code | **Missing** | Mapping documented in deployment.md |

## Known functional limitations

- A batch is one transaction. Very large files mean long transactions (capped by `MAX_ROWS_PER_BATCH`).
- Batches for the same tenant entity are processed one at a time, to keep supersession correct.
- Failed batches need an operator to replay them. Only interruptions retry automatically.
- Quarantined rows are never re-admitted. Corrected data must be resubmitted.
- `/metrics` is unauthenticated unless `METRICS_TOKEN` is set, and exposes tenant ids and source names.
- Read-access audit events are best-effort (see the threat model).
- There is no in-app user management or contract editor; both are API operations.

## Independent review: findings and resolution

An independent reviewer read an earlier draft against the code. Its findings, and what changed:

| Finding | Resolution |
|---|---|
| Platform admin could mint an admin token for any tenant | Fixed: bootstrap-only issuance (first admin, approvers); cannot revoke admins † |
| An admin could mint a second admin token and self-approve | Fixed: separate approver role, issued only by the platform admin, with no data access † |
| Audit trigger bypassable with one session setting | Fixed: the trigger enforces the retention age; owner/superuser bypass documented † |
| Compatible widenings failed at apply time (views) | Fixed: views dropped and regenerated around the DDL; tested |
| View DDL missing from the "exact DDL" plan | Fixed: `plan.view_ddl` |
| Source-level weakening of trust and privacy controls auto-applied | Fixed: classified as breaking |
| An untrusted batch could permanently remove good rows from trusted outputs | Fixed: latest-trusted-version semantics; trusted resends re-establish rows † |
| Batches queued before a breaking migration processed under the old contract | Fixed: re-pin or fail, then replay † |
| Drift undetected after a data-changing migration | Fixed: migration-created versions are re-verified † |
| SSN-like values in non-sensitive fields echoed into quarantine and findings | Fixed: masked; mapped source column scrubbed |
| Dataset-check failures never affected trust | Fixed: metrics and extracts are qualified † |
| Sensitive fields could be declared filterable | Fixed: rejected by validation |
| Erasure left keys in access audit and findings | Fixed: keys hashed in access audit; findings deleted. Filter literals in `export_log.params` remain (gap) |
| Dashboard computed its own verdict | Fixed: the verdict comes from the API |
| Duplicated orphan SQL | Fixed: shared `orphanWhere` |
| Plan impact double-counted rows | Fixed: distinct count |
| Edge-case inputs returned 500 | Fixed: 4xx; tested |
| Interruption re-queue ignored `MAX_ATTEMPTS` | Fixed (untested, see above) |
| Missing test-results record and stale evidence | Fixed: [test-results.md](test-results.md) from a single clean run |
| CI never ran; container job lacked a worker | Fixed: the workflow runs on GitHub; Compose now starts all services |
