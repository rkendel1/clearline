# Test results

Recorded from **one clean clone of commit `dc06c95`** (branch `claude/bold-mendel-wpkwup`): fresh `git clone`, `npm ci`, a cold `cargo build --release --locked`, a new PostgreSQL 16 database per suite, nothing reused from development. Raw outputs are in [`test-results/clean-clone/`](../test-results/clean-clone/). The same suites run in GitHub Actions ([workflow](../.github/workflows/ci.yml)): the `test` job (Node), the `native` job (Rust/GPUI under Xvfb), the `container` job (Compose) and the secret scan.

**Environment.** Linux VM, 4 vCPU (Intel Xeon @ 2.10 GHz), 16.9 GB RAM, no GPU (Mesa lavapipe software Vulkan, Xvfb + openbox), Node.js 22.22, Rust 1.97, PostgreSQL 16 on the same host, Docker 29.9.

## Summary

| Check | Command | Result | Raw output |
|---|---|---|---|
| Typecheck | `npm run typecheck` | pass | [typecheck.log](../test-results/clean-clone/typecheck.log) |
| Dependency audit, npm | `npm audit --omit=dev --audit-level=high`, `npm audit` | 0 vulnerabilities (production and all dependencies); no dependency was added | [audit.log](../test-results/clean-clone/audit.log) |
| Dependency audit, Rust | `cargo audit --file native/Cargo.lock` | 0 vulnerabilities in 779 crates; 14 "unmaintained" warnings, all transitive dependencies of GPUI | [cargo-audit.log](../test-results/clean-clone/cargo-audit.log) |
| Secret scan | gitleaks 8.21.2 over the full git history (`.gitleaks.toml`) | no leaks (22 commits) | — |
| Unit tests | `npm run test:unit` | **68 / 68 pass** (incl. analysis, recurrence/DST, delivery/SSRF) | [unit.log](../test-results/clean-clone/unit.log) |
| Integration tests (HTTP API, real DB and worker) | `npm run test:integration` | **13 / 13 pass** | [integration.log](../test-results/clean-clone/integration.log) |
| Demonstration scenarios A–T | `npm run test:scenarios` | **39 / 39 pass** (A–N unchanged: 20; saved analytics P–T: 19) | [scenarios.log](../test-results/clean-clone/scenarios.log), [JUnit](../test-results/scenarios.junit.xml), [evidence](../test-results/evidence.md) |
| Native client build | `cargo build --release --locked` | pass (cold build, 436 s) | [native-build.log](../test-results/clean-clone/native-build.log) |
| Native client unit tests | `cargo test --release --locked -p clearline-client` | pass | [native-test.log](../test-results/clean-clone/native-test.log) |
| Native end-to-end (real window, Xvfb) | `npm run test:e2e` | **5 / 5 pass**: Scenario J (native), Scenario O, Rust contract tests against the live API (incl. analytics endpoints for every role), measurements, Scenario U | [e2e.log](../test-results/clean-clone/e2e.log), [screenshots](../test-results/native/), [perf](../test-results/native-perf.json) |
| Mutation checks | `npm run test:mutation` | **31 / 31 planted defects caught** (9 new for saved analytics) | [mutation.log](../test-results/clean-clone/mutation.log), [mutation.json](../test-results/mutation.json) |
| Fresh migrations | every suite above | 0001–0004 applied to a new database per suite; Compose `migrate` applied all four | — |
| Container image + Compose stack | `docker compose up -d --wait && docker compose --profile demo run --rm demo` | all services healthy; demo: every metric and every checked query result matches ground truth; the eight saved-analytics steps ran, the planted anomaly was detected, the revoked identity was denied | [compose-demo.log](../test-results/clean-clone/compose-demo.log) |
| Scheduler without a client; restart | Compose: stop the worker, queue a run, start the worker | run stayed `queued` while the worker was down and `succeeded` 2 s after it started; `docker compose stop worker api` → both exited 0 | [compose-demo.log](../test-results/clean-clone/compose-demo.log) |
| Primary client is native | — | at this commit the API served JSON only; all new views were in the Rust/GPUI client (a web client was added later, see ADR 0017) | native e2e |
| Benchmarks | `npm run benchmark:analytics`, `npm run benchmark:query`, `BENCH_PUBLISH=1 npm run benchmark` | algorithms at three sizes, end-to-end runs with four deliveries, 40-run burst (40 succeeded) | [benchmark.md](benchmark.md) |

The Compose stack, cargo audit, gitleaks and the benchmarks were run from the development checkout of the same commit, not from the clean clone. Docker Hub rate-limited the `node:22-bookworm-slim` pull (HTTP 429), so the image was built with `NODE_IMAGE` set to a local Node 22 image derived from the previous build; the Dockerfile is unchanged. After the clean-clone run, one cosmetic change (the `info` severity chip) was made to the native client and the native end-to-end suite was re-run on it (5 / 5 pass); the screenshots are from that run.

## What each scenario demonstrated

The per-scenario observations, with batch ids, counts, amounts and explanations, are written by the tests themselves to [`test-results/evidence.md`](../test-results/evidence.md). Expected values come from the synthetic generator's ground truth or from independent SQL written in the test, never from the platform under test. In brief:

| Scenario | Demonstrated |
|---|---|
| A Normal ingestion | 1,000 claims → trusted batch, 9 reconciliation checks passed; `total_paid` equals generator truth; extract row count, sums and sha256 verified; lineage from source row to export |
| B Tenant customization | Two different canonical models; a third tenant created and processed at runtime with its own rule; no tenant names in `src/` |
| C Duplicate delivery | Identical resubmission → same batch, no effect; 5 concurrent duplicates → 1 batch; overlapping redelivery added only the new rows |
| D Bad data | 11 quarantined with exact rule and row; reject rate 5.45% > 5% → untrusted; SSN in an unmapped column scrubbed and absent from logs; trusted metrics exclude the batch |
| E Late data and corrections | Correction supersedes; late version kept as history; conflict quarantined; `as_of` vs current results differ as documented |
| F Interrupted processing | SIGKILL mid-transaction → nothing visible → recovered on restart; SIGTERM → rolled back, re-queued, exit 0 |
| G Privacy violation | Cross-tenant reads and sensitive exports → 403 and audited at the API and SQL layers; audit append-only |
| H Contract evolution | Unsafe change rejected; breaking change approved only by an approver; applied as new versions; rollback and its limit; widening applied; queued batches handled across migrations; drift in migration rows detected |
| I Reconciliation failure | In-transit loss, out-of-band drift and missing references detected and explained; metrics qualified; trust restored after repair; complete resend re-establishes data; untrusted correction does not displace trusted value |
| J Reporting correctness | 14 metrics: API = hand-written SQL = ground truth = native client (both tenants); operations totals, extracts, BI views agree |
| K Natural-language SQL | Question → validated proposal (nothing executed) → explicit run equals independent SQL; edits re-validated; unavailable provider → 503 with manual SQL still working; hostile model output never executed |
| L Role-restricted field | A hidden field is unreachable through catalog, queries, errors, previews, history, exports, records, lineage and audit; database grants mirror the policy |
| M Sensitivity and redaction | A steward marks a field sensitive: every surface redacts it at once; SQL and TypeScript masking agree; widening refused for stewards; versioned and audited |
| N Isolation and inference | 24 inference attacks rejected; with the validator bypassed the database refuses writes, other tenants, ungranted columns and `RESET ROLE`; timeouts, cancellation, cost and concurrency limits |
| O Native workflow | In the real GPUI window: NL question, edit, run, restricted fields, an administrator's sensitivity change, redaction in workspace, records and lineage |
| P Saved queries | Saved from a proposal and from SQL; typed parameters bound (malformed and unknown values rejected; an injection-shaped text value is bound as data and matches nothing); runs keep version 1 and 3; a renamed column flags the analysis `needs_revalidation` and the run records `stale_schema`; duplicate, share, archive; an admin's shared query over a restricted field is withheld from a reporter and refused |
| Q Scheduling | Due-time run exactly once with two racing schedulers; interrupted run recovered by another scheduler, missed occurrences coalesced; pause/resume/cancel; America/New_York across the spring gap (shifted forward) and the autumn overlap (runs once); revoked identity → denied before any query; failed query never reported as delivered; scheduler in a worker subprocess killed and restarted |
| R Delivery | In-app, email over a real SMTP conversation (CSV attached), signed webhook after two 503s, export; permanent failure, timeout, exhausted attempts, manual retry without re-query; a field made sensitive after the query → delivery blocked, nothing sent; interrupted delivery recovered and sent once |
| S ML analyses | Planted anomaly 2026-08-31 ranked first by both anomaly algorithms (observed 24,684.05 = ground truth, robust z 17.8); weekly forecast vs held-out weeks (3.6%, 1.8%, 0.3% error; the spike week 23.2%); seeded outliers ranked 1–3; k-means recovers the three generator profiles (purity 100%, silhouette 0.784, identical on rerun); sensitive inputs refused; ungrounded model text rejected |
| T End to end | Save → daily schedule → anomaly → insight → notification; revoke → pending delivery blocked, next occurrence denied, nothing exposed; 10 hostile webhook targets refused; no analytics object visible across tenants; audit links occurrence → execution → analysis → delivery without values |
| U Native saved analytics | In the real GPUI window: destinations and test delivery, private webhook refused; NL request saved; version with parameters; analysis builder; schedule editor with DST preview; run with insights and charts; notification opens the run; run history |

## Mutation checks

Each mutation plants one realistic defect in a temporary copy, runs the tests that should notice, and records which ones failed. All 31 were caught (the 9 new ones: revoked identity still runs, run-as role not delegation-checked, delivery not re-authorized, private webhook targets allowed, failed delivery reported as success, sensitive feature allowed, ungrounded narrative accepted, run results not re-masked, notifications not recipient-scoped); the catching tests are listed in [mutation.log](../test-results/clean-clone/mutation.log).

## Not covered by these results

- **Live Anthropic provider.** The supplied API key is not scoped to a workspace, and the API requires the `anthropic-workspace-id` header for such keys (`ANTHROPIC_WORKSPACE_ID`). No workspace ID was available, so the live path returned a 400, which is handled and surfaced as `503 provider_unavailable`. The deterministic provider and the unavailable path are tested.
- **Live model narrator** for insights: tested only with a stub provider (same workspace-ID limitation).
- **Real mail relay and remote webhook endpoints**: email was exercised against a local SMTP receiver and webhooks against a loopback receiver.
- **macOS and Windows builds** of the native client, and rendering with a GPU (only software Vulkan was measured).
- See [production-readiness.md](production-readiness.md) for the full list: freshness thresholds, the attempt limit on repeated SIGTERM, checksum-mismatch detection for edited migrations, scale beyond the benchmark, multi-instance and multi-day operation.

## Later additions: web interface, public walkthrough and assistant

Everything above was recorded from one clean clone at commit `dc06c95`. The web client, the public landing page and the assistant were added afterwards and are **not** part of that recorded run. They were run from a development checkout (not a clean clone, and not yet committed) on macOS (arm64), Node.js 24.9, against a CI-equivalent PostgreSQL: the `pgvector/pgvector:pg16` image with a non-superuser `clearline` role that has only `CREATEROLE` (the Docker Compose database role is a superuser, which bypasses row-level security, and scenarios G, J and T3 fail against it for that reason).

| Check | Command | Result |
|---|---|---|
| Typecheck (API and web) | `npm run typecheck`; `npx tsc --noEmit` in `web/` | pass |
| Unit tests | `npm run test:unit` | **93 / 93** (new: content model, assistant building blocks, planner and data formatting, web hosting) |
| Integration tests | `npm run test:integration` | **34 / 34** (13 existing; 9 retrieval and boundary tests; 12 data-tool tests compared with generator arithmetic and independent SQL) |
| Scenarios A to T | `npm run test:scenarios` | **39 / 39** (unchanged by the additions) |
| Web unit tests | `npm test --prefix web` | **7 / 7** (assistant text cannot render as markup or links; destinations are validated) |
| Web end-to-end (Chromium, real API and data) | `npm run test:e2e:web` | **6 / 6**: acceptance scenarios A to E from the assistant specification plus a mobile check. A planted wrong-figure defect and a planted access-control defect were each confirmed to fail them |
| Mutation checks | `npm run test:mutation` | **40 / 40 planted defects caught** (the 31 recorded earlier plus 9 for the assistant). One of the 9 first survived because the fixtures had no untrusted batch; a test was added and it is now caught. The runner was also fixed to request TAP output: on Node 24 it defaulted to another reporter when piped, so no failure was ever detected |
| Dependency audit | `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| Retrieval evaluation | `npm run assistant:eval` | see [assistant-evaluation.md](assistant-evaluation.md): measured on a small question set; recall is high for questions near the documents' vocabulary and lower for paraphrases |

Not covered by these results: the native client suites (not re-run), live Anthropic answers and live model tool selection (the suites run without a key; the live path was exercised manually only), several API replicas or a proxy in front (rate limits are per process and client address), and a clean-clone run of any of the above.

