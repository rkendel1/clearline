# Production-readiness report

Honest status of every capability the specification asks for, in four categories:

- **Tested**: implemented and exercised by an automated test in this repository (named).
- **Implemented**: built and exercised manually or indirectly, but without a dedicated automated assertion.
- **Unverified**: designed for but not demonstrated at the stated level (scale, duration, real infrastructure).
- **Missing**: not built.

Nothing here has run in production, so no uptime, scale or compliance claim is made.

## Data lifecycle

| Capability | Status | Evidence / note |
|---|---|---|
| CSV and JSON API ingestion, separate source adapters | Tested | Scenarios A, B; unit tests (adapters) |
| Batch registration with digest, arrival and source-reported time, contract version, attempts, counts, outcomes | Tested | Scenario A asserts each field |
| Structural validation before transformation; structural vs business-rule separation | Tested | Scenario D; unit tests (engine) |
| Quarantine with actionable reasons and source row numbers | Tested | Scenario D; integration test (resolve) |
| Idempotent resubmission (sequential and concurrent) | Tested | Scenario C (5 concurrent identical submissions → 1 batch) |
| Exact-duplicate records within a new file have no effect | Tested | Scenario C (redelivery file) |
| Corrections, late-arriving versions, conflicts | Tested | Scenario E |
| Point-in-time (`as_of`) extracts | Tested | Scenarios E, J |
| Deterministic processing (same input + contract + engine → same hash) | Tested | Unit tests; Scenario J reproducible extract sha256 |
| Crash mid-transaction → no partial effects, automatic recovery | Tested | Scenario F1 (SIGKILL, separate process) |
| Graceful shutdown → abort, re-queue, exit 0 | Tested | Scenario F2; Compose shutdown check (manual, and in the CI container job) |
| Failed batch inspectable and replayable | Tested | Integration test (injected failure → replay) |
| Partially failed batch never appears fully successful | Tested | Scenarios D, F, I (pipeline vs trust status) |
| Lineage from source row → canonical version → reconciliation → metric → extract | Tested | Scenarios A, E, H |

## Contracts

| Capability | Status | Evidence / note |
|---|---|---|
| Formal JSON Schema + semantic validation; rejection of unsupported declarations | Tested | Unit tests (≈20 rejection cases); Scenario H |
| Two tenants with different canonical models, one codebase; third tenant at runtime | Tested | Scenario B (and source grep for tenant names) |
| Generated, deterministic DDL and views; no destructive DDL | Tested | Unit tests; Scenario H |
| Compatibility classification and reviewable migration plan | Tested | Unit tests; Scenario H (`test-results/scenario-h-migration-plan.json`) |
| Breaking change requires second-admin approval with version confirmation | Tested | Scenario H |
| Existing records keep their meaning (new versions, not edits) | Tested | Scenario H |
| Rollback window and refusal after new-version data exists | Tested | Scenario H |
| Contract changes to key, type narrowing, unmapped enum removal rejected | Tested | Unit tests; Scenario H |

## Quality and reconciliation

| Capability | Status | Evidence / note |
|---|---|---|
| Required/type, unique-key/duplicate, referential, date/status, cross-field rules | Tested | Scenarios D, E; unit tests |
| Row-count and financial reconciliation (source control totals, row accounting, target) | Tested | Scenarios A, I; unit tests |
| Missing / unexpected / conflicting record detection | Tested | Scenarios E (conflict), I (missing in transit, orphans) |
| Freshness and latency thresholds | Implemented | Computed in operations report and `/metrics`; latency rule recorded per batch. No test drives a source stale. |
| Post-load drift detection and audited trust restoration | Tested | Scenario I |
| Quality results identify rule, affected records, severity, contract version, run | Tested | Scenarios A, D |
| Dashboard distinguishes ran from trusted; failed reconciliation never green | Tested | e2e dashboard test; Scenario I |

## Privacy, security, isolation

| Capability | Status | Evidence / note |
|---|---|---|
| Backend tenant authorization; request-bound tenant scope in the data layer; RLS on core tables; per-tenant schemas | Tested | Scenario G; integration role matrix and scope-guard test; mutation checks (see test-results.md) |
| Roles (admin, operator, reporter) and platform admin without data access | Tested | Integration tests; Scenario G |
| Sensitive-field classification, redaction in extracts, records, lineage, views | Tested | Scenarios A, G |
| Sensitive data in unexpected locations | Tested | Scenario D |
| Audit for access, exports, contract changes, admin actions; append-only | Tested | Scenarios G, H; integration tests |
| Safe logging | Tested | Scenario D (captured logs), unit test |
| Retention and erasure incl. derived data | Tested | Integration tests |
| Token hashing, listing without secrets, immediate revocation | Tested | Integration test |
| Browser security headers (CSP etc.) | Tested | Integration test; e2e (no CSP violations) |
| RLS on canonical tenant tables; split DB roles; SSO/MFA; rate limiting; field encryption | **Missing** | See [threat-model.md](threat-model.md) gaps |
| HIPAA compliance | **Not claimed** | See threat model, final section |

## Reporting

| Capability | Status | Evidence / note |
|---|---|---|
| Operations report, business summary, exception report (API) | Tested | Scenarios A, I, J |
| Read-only SQL reporting views, BI role scoping | Tested | Scenarios G, J |
| CSV extracts: explicit schema, timestamps, reproducible filters, checksum, audit | Tested | Scenarios A, J |
| Documented metric definitions | Implemented | [metrics.md](metrics.md) generated from contracts and code; `GET …/metrics/definitions` |
| Dashboard numbers equal independent queries | Tested | Scenario J + `test/e2e/dashboard.test.ts` (Chromium) |

## Operations and delivery

| Capability | Status | Evidence / note |
|---|---|---|
| Docker Compose reproducible startup | Tested | Built and run in this session; CI `container` job runs the demo against the stack |
| Versioned migrations with checksums | Tested | Every test run migrates a fresh database; checksum mismatch detection is implemented but not tested |
| Unit, integration, scenario (contract) and e2e tests in CI; CI fails on failure | Implemented | `.github/workflows/ci.yml`. **The workflow has not yet run on GitHub**; each step was run locally. |
| Dependency and secret scanning | Implemented | `npm audit` (high+) in CI, dependency-review on PRs, gitleaks with an explicit allow-list; local audits report 0 vulnerabilities |
| Liveness/readiness, structured logs with correlation and run ids, Prometheus metrics | Tested | Integration test (endpoints); logs observed in all runs |
| Configurable resource and timeout limits | Implemented | Config reference in [deployment.md](deployment.md); Compose CPU/memory limits |
| Backup, restore, recovery procedures | Implemented | [runbook.md](runbook.md). Restore procedure executed once in this session (counts and totals matched); not automated. |
| Benchmark with methodology | Implemented | [benchmark.md](benchmark.md); one machine, 2 vCPU |
| Throughput beyond 100k-row batches or 200k rows across parallel workers | **Unverified** | Not measured |
| Multi-instance API behind a load balancer | **Unverified** | Stateless by design; not run |
| Long-running soak (days), memory stability, connection churn | **Unverified** | Not run |
| Alerting rules, dashboards in a monitoring system | **Missing** | Suggested alerts listed in the runbook |
| Automated backups / PITR, restore drills | **Missing** | Documented, not automated |
| Scheduled retention and reconciliation re-verification | **Missing** (scheduling) | CLI and API exist; no scheduler is shipped |
| Cloud infrastructure as code | **Missing** | Mapping documented in deployment.md |

## Known functional limitations

- A batch is one transaction. Very large files hold long transactions (cap: `MAX_ROWS_PER_BATCH`).
- Batches for the same tenant entity are processed one at a time (correctness of supersession).
- Failed batches need an operator to replay. Only interruptions retry automatically.
- Quarantined rows are never re-admitted. Corrected data must be resubmitted.
- A late *batch* is detected by its source-reported time; late *records* by the entity's correction order.
- Read-access audit events are best-effort (see threat model).
- The dashboard has no in-app user management or contract editor; those are API operations.
