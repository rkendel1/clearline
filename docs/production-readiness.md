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
| The client distinguishes ran from trusted, using the API's verdict | Tested | Native e2e (Scenario J native: verdict, untrusted batch detail) |

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
| API security headers on API responses (`default-src 'none'`, `frame-ancestors 'none'`, `no-store`). The web interface's static files are served with a separate policy (`script-src 'self'`, no inline script or style) | Tested (API headers); web hosting unit test | Integration test; `test/unit/web-hosting.test.ts` |
| RLS on canonical tenant tables; split DB roles; SSO/MFA; rate limiting; field encryption | **Missing** | See [threat-model.md](threat-model.md) |
| HIPAA compliance | **Not claimed** | See the threat model's final section |

## Query workspace and field policy

| Capability | Status | Evidence / note |
|---|---|---|
| Natural-language question → untrusted SQL proposal → validation → explicit execution; results equal independent SQL | Tested | Scenario K; Scenario O (native) |
| Provider abstraction: deterministic (default), Anthropic, none; unavailable provider fails with `503` and manual SQL keeps working | Tested (deterministic, unavailable) | Scenario K. **The live Anthropic path is Unverified here**: the supplied key needs `ANTHROPIC_WORKSPACE_ID`, which was not available, so the request returned a 400 (handled, surfaced as `provider_unavailable`). |
| AST allowlist validator: single read-only `SELECT`, functions, casts, names, limits; fails closed | Tested † | Unit tests (12 groups); Scenario N1 (24 attacks) |
| Restricted fields have no route into results (aliases, joins, subqueries, CTEs, aggregates, ordering, previews, history, exports, errors) | Tested † | Scenarios L, N; mutations `validator-restricted-check-removed`, `history-not-withheld` |
| Database enforcement independent of the validator: query login without privileges, per-tenant per-role roles, column grants mirroring policy, RLS, read-only | Tested † | Scenario N2 (validator bypassed); Scenario L (grants); mutation `hidden-columns-granted` |
| Re-validation at execution against the current policy | Tested † | Scenario K; mutation `execute-without-revalidation` |
| Timeouts, cancellation, cost limit, row and byte caps, concurrency limits | Tested | Scenarios N4, N5; [benchmark.md](benchmark.md) |
| Field sensitivity and redaction managed by stewards/admins, versioned, audited; stewards cannot widen | Tested † | Scenario M; mutations `steward-may-widen`, `sensitivity-does-not-mask` |
| One resolver redacts every surface (query results, records, lineage incl. raw source, exceptions, findings, extracts, contracts, metrics, BI views) | Tested † | Scenarios L, M, O; mutations `mask-rewrite-skipped`, `records-unredacted` |
| Audit distinguishes proposed from executed SQL; no values in audit | Tested | Scenarios K, L (SSN scan of the audit trail) |
| Concurrency limits across several API replicas | **Missing** | In-memory per process (threat model) |
| Small-cell suppression of aggregates | **Missing** | Threat model |

## Saved analytics, scheduling, analysis and delivery

| Capability | Status | Evidence / note |
|---|---|---|
| Saved queries: versions (append-only), metadata, typed parameters bound safely, duplicate, disable/archive, favorites, sharing; runs keep their exact version | Tested | Scenario P; Rust contract test |
| Saving is not a grant: SQL re-validated for the run role at every run; withheld from viewers who may not use it | Tested † | Scenarios P, Q4, T1; mutations `revoked-identity-still-runs`, `run-as-role-not-delegation-checked` |
| Schema change flags dependent analyses (`needs_revalidation` / `stale_schema`) | Tested | Scenario P (column renamed → `needs_revalidation`, run records `stale_schema`) |
| Durable schedules (once, hourly, daily, weekly, monthly; time zone; start/end; pause/resume/cancel; run now) with explicit DST rules | Tested | Scenario Q3, unit tests (recurrence) |
| Each occurrence runs exactly once, also with racing schedulers; missed occurrences coalesced | Tested | Scenario Q1, Q2 |
| Scheduler in the worker, independent of any client; survives restart; interrupted runs and deliveries recovered | Tested | Scenarios Q2, Q5 (worker subprocess killed and restarted), R5 |
| Bounded concurrency (per process and per tenant), timeouts, retries with exponential backoff, failure classes for query / analysis / delivery | Tested | Scenarios Q4, R2; [benchmark.md](benchmark.md) burst |
| A failed delivery never reports the run as delivered; manual delivery retry without re-running the query | Tested † | Scenarios Q4, R2; mutation `failed-delivery-reported-success` |
| In-app notifications, recipient-scoped, status-only for recipients without access | Tested † | Scenarios R1, T1; mutation `notifications-not-recipient-scoped` |
| Email over SMTP (STARTTLS / implicit TLS), summary and CSV attachment | Tested (local SMTP receiver) | Scenario R1. **No real mail relay was used.** |
| Signed HTTPS webhooks; SSRF guard (address classes, every resolved address, pinned connection, no redirects); secrets by reference | Tested † | Scenarios R1, T2; unit tests; mutation `webhook-private-targets-allowed`. Delivered to a loopback receiver only. |
| Expiring CSV exports, downloads re-authorized and audited | Tested | Scenarios R1, R3 |
| Re-authorization before delivery; results that became restricted are not sent | Tested † | Scenario R3; mutation `delivery-not-reauthorized` |
| Anomaly detection (rolling MAD with seasonality; seasonal decomposition) | Tested | Scenario S1, unit tests (planted spike found; ordinary weekly variation not flagged) |
| Forecasting (naive, seasonal naive, drift, Holt; auto selection by rolling-origin backtest; empirical intervals) | Tested | Scenario S2 (held-out weeks), unit tests |
| Outlier detection (robust z / RMS distance within groups, contributions) | Tested | Scenario S3 (seeded claims ranked first) |
| Segmentation (seeded k-means++, silhouette, unnamed until reviewed) | Tested | Scenario S3 (three known claim profiles recovered), unit tests (determinism), native run view (naming) |
| Sensitive or redacted fields cannot enter analyses | Tested † | Scenario S4; mutation `sensitive-feature-allowed` |
| Optional model-written summaries grounded in evidence | Tested with a stub provider | Scenario S5; mutation `narrative-not-grounded`. **Live provider Unverified** (no `ANTHROPIC_WORKSPACE_ID`). |
| Native library, schedule editor, analysis builder, run view with charts, run history, notifications, destinations | Tested | Native Scenario U (screenshots 15–22) |
| Service identities for schedules (not tied to a person's token) | **Missing** | ADR 0014 |
| Analysis sandboxing (separate process/memory limits) | **Missing** | Caps and a memory estimate only |
| DKIM, OAuth SMTP, object storage for exports | **Missing** | [saved-analytics.md](saved-analytics.md#8-known-limitations) |

## Native client

| Capability | Status | Evidence / note |
|---|---|---|
| Rust/GPUI client replaces the React dashboard; all former views plus query workspace, history, field policies, records, audit | Tested | Native e2e (Scenarios J native, O) |
| Views follow the token's permissions; server remains authoritative | Tested | Native e2e (reporter, operator, approver, steward, admin) |
| API calls never block the UI thread; large results virtualized | Tested (measured) | Native e2e: no frame gap over 1 s while a long-running query executes (measured max ≈ 0.1 s); 5,000-row scroll |
| Rust API client decodes every endpoint for every role | Tested | `native/crates/clearline-client/tests/backend.rs`, run by the e2e suite |
| Linux (X11) build and run | Tested | CI and local |
| macOS and Windows builds | **Unverified** | Supported by GPUI; not built here |
| Rendering performance with a GPU | **Unverified** | Measured only with software Vulkan (lavapipe) |

## Web interface and assistant

Added after the recorded results at commit `dc06c95`; their evidence is smaller and is stated here, not inherited from the scenario table.

| Capability | Status | Evidence / note |
|---|---|---|
| Web client over the same API, served by the API from one origin; token in memory only | Implemented | Hosting unit test (traversal, fallback, API paths); headless-browser smoke run (not a committed suite) |
| Public landing page, interactive architecture diagram, capability, actor and decision content from one version-controlled source | Tested (content) | `test/unit/content.test.ts` (references, evidence paths, status rules); browser check of the landing, diagram and decision flows (not committed) |
| Grounded assistant: retrieval over an approved corpus, citations, extractive fallback, declines without evidence | Tested | `test/unit/assistant.test.ts`; `test/integration/assistant.test.ts` (needs pgvector); retrieval evaluation in [assistant-evaluation.md](assistant-evaluation.md) |
| Public/authenticated document classes; restricted documents not retrievable or servable anonymously | Tested | `test/unit/assistant.test.ts`, `test/integration/assistant.test.ts` |
| Rate limiting of the assistant (per client and global) | Tested (unit); in-memory per process | Not shared across API replicas |
| Assistant data tools: metric current value, by period, period comparison, quality, reconciliation; signed-in runs and insights | Tested | `test/integration/assistant-data.test.ts` (results equal the generator's integer-cent arithmetic and independent SQL; evidence and execution ids exist), `test/unit/data-tools.test.ts` (planner against a fixed clock, exact formatting); mutations in `npm run test:mutation` |
| Data tools cannot run arbitrary SQL or reach other tenants: unknown tools, extra arguments, malformed or out-of-range dates, unknown measures and dimensions rejected; the public identity is least-privileged, confined to the named demo tenant and refused the signed-in-only tools; a field hidden from the role yields no figure | Tested † | `test/integration/assistant-data.test.ts`; mutations `data-tool-extra-arguments-allowed`, `data-tool-signed-in-only-check-removed`, `public-identity-escalated` |
| Evidence of a signed-in answer is readable only by the identity that asked; anonymous evidence only by its id | Tested † | `test/integration/assistant-data.test.ts`; mutation `evidence-readable-by-anyone` |
| A failed calculation never yields a figure; failures are audited without values | Tested | `test/integration/assistant-data.test.ts` |
| End-to-end acceptance in a real browser: first-time visitor, public data question with evidence, tradeoff answer, unsupported question, public access boundary, mobile | Tested | `test/e2e/assistant-web.test.ts` (scenarios A to E; Chromium via Playwright; two planted defects confirmed caught) |
| Rendering of assistant text and destination links | Tested | `web/src/landing/Markdown.test.tsx`, `web/src/lib/content.test.ts` (no markup, no links, no unknown destinations) |
| Live model planning and live model answers | **Unverified in automated tests** | Exercised manually with a configured key; the suites use no model |
| Anonymous data answers with several API replicas or behind a proxy | **Unverified** | Rate limits are per process and per client address; see the threat model |
| Live model answers | **Unverified in automated tests** | Exercised manually with a configured key; tests use no model |

## Reporting

| Capability | Status | Evidence / note |
|---|---|---|
| Operations report, business summary, exception report | Tested | Scenarios A, I, J |
| Read-only SQL views, BI role scoping, `rpt_trusted_*` views | Tested | Scenarios G, J |
| CSV extracts: explicit schema, timestamps, filters, checksum, audit | Tested | Scenarios A, J |
| Documented metric definitions | Implemented | [metrics.md](metrics.md) generated from contracts and code |
| Declared metrics and operations totals equal independent SQL, ground truth and the native client | Tested | Scenario J; `test/e2e/native.test.ts`. Freshness, latency percentiles, the daily series and exception-report contents are not independently checked. |

## Operations and delivery

| Capability | Status | Evidence / note |
|---|---|---|
| Docker Compose startup and demo against the stack | Tested | CI `container` job; local runs in development |
| Versioned migrations with checksums | Tested | Every run migrates fresh databases; checksum-mismatch detection is implemented but untested |
| CI runs typecheck, audits, unit, integration, scenario, mutation, native build/tests and native e2e, and fails on failure | Tested | GitHub Actions; see [test-results.md](test-results.md) for the run |
| Dependency and secret scanning | Implemented | `npm audit` (high+), dependency review on PRs, gitleaks with an explicit allow-list |
| Liveness, readiness, Prometheus metrics | Tested | Integration test |
| Structured logs with correlation and run ids | Implemented | Emitted on every path; no test asserts log content beyond the safety unit test |
| Configurable resource and timeout limits | Implemented | [deployment.md](deployment.md); Compose CPU and memory limits |
| Backup, restore, recovery procedures | Implemented | [runbook.md](runbook.md); restore executed once in development (counts and totals matched); not automated |
| Benchmark with methodology | Implemented | [benchmark.md](benchmark.md): ingestion, query workspace, native client; one 4-vCPU machine without a GPU |
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
| Dashboard computed its own verdict | Fixed: the verdict comes from the API (the native client keeps this rule) |
| Duplicated orphan SQL | Fixed: shared `orphanWhere` |
| Plan impact double-counted rows | Fixed: distinct count |
| Edge-case inputs returned 500 | Fixed: 4xx; tested |
| Interruption re-queue ignored `MAX_ATTEMPTS` | Fixed (untested, see above) |
| Missing test-results record and stale evidence | Fixed: [test-results.md](test-results.md) from a single clean run |
| CI never ran; container job lacked a worker | Fixed: the workflow runs on GitHub; Compose now starts all services |
