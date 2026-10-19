# Test results

Recorded from **one clean checkout of commit `119ebf2`**: fresh `git clone`, `npm ci`, a new PostgreSQL 16 database per suite, nothing reused from development. Raw outputs are in [`test-results/`](../test-results/). The same suites run in GitHub Actions on every push and pull request ([workflow](../.github/workflows/ci.yml)). The first fully green run on GitHub, on commit `d471f21`, was [run 39337540767](https://github.com/rkendel1/clearline/actions/runs/39337540767): tests, image build with Compose smoke test, and secret scan.

**Environment.** Linux VM, 2 vCPU (Intel Xeon 2.8 GHz, KVM), 7.8 GB RAM, Node.js 22.22, PostgreSQL 16.15 on the same host, Chromium (Playwright 1.56).

## Summary

| Check | Command | Result | Raw output |
|---|---|---|---|
| Typecheck | `npm run typecheck` | pass | — |
| Dependency audit (prod, high+) | `npm audit --omit=dev --audit-level=high` (API and dashboard) | 0 vulnerabilities | — |
| Unit tests | `npm run test:unit` | **27 / 27 pass** | [unit.log](../test-results/unit.log) |
| Integration tests (HTTP API, real DB and worker) | `npm run test:integration` | **13 / 13 pass** | [integration.log](../test-results/integration.log) |
| Demonstration scenarios A–J | `npm run test:scenarios` | **11 / 11 pass** (F has two parts) | [scenarios.log](../test-results/scenarios.log), [JUnit](../test-results/scenarios.junit.xml), [evidence](../test-results/evidence.md) |
| Dashboard end-to-end (Chromium) | `npm run test:e2e` | **1 / 1 pass** | [e2e.log](../test-results/e2e.log) |
| Mutation checks | `npm run test:mutation` | **14 / 14 planted defects caught** | [mutation.json](../test-results/mutation.json), [mutation.log](../test-results/mutation.log) |
| Container image + Compose stack | `docker compose build && docker compose up -d --wait && docker compose run --rm demo` | image built; all services healthy; demo: every metric matches ground truth; API and worker stopped with exit 0 | [compose-demo.log](../test-results/compose-demo.log) |
| Benchmark | `BENCH_PUBLISH=1 npm run benchmark` | 0 failed batches | [benchmark.md](benchmark.md), [benchmark.json](../test-results/benchmark.json) |

## What each scenario demonstrated

The per-scenario observations, with batch ids, counts, amounts and explanations, are written by the tests themselves to [`test-results/evidence.md`](../test-results/evidence.md). Expected values come from the synthetic generator's ground truth, never from the platform under test. In brief:

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
| J Reporting correctness | 14 metrics: API = hand-written SQL = ground truth = dashboard (both tenants); operations totals, extracts, BI views agree |

## Mutation checks

Each mutation plants one realistic defect in a temporary copy, runs the tests that should notice, and records which ones failed. All 14 were caught:

| Mutation | Caught by |
|---|---|
| trust always granted | Scenarios D, I |
| route tenant check removed | Scenario G |
| data-layer tenant guard removed | integration: scope guard |
| idempotency removed | Scenario C |
| redaction removed | Scenarios A, G |
| control count ignored | Scenario I |
| untrusted versions count as duplicates | Scenario I |
| trusted view uses current version only | Scenario I |
| tenant admin can approve | Scenario H |
| platform admin escalation | integration: bootstrap-only |
| migration drift unchecked | Scenario H |
| queued batch uses superseded contract | Scenario H |
| dataset checks ignored by metrics | Scenario I |
| audit retention floor removed | integration: audit floor |

## Not covered by these results

See [production-readiness.md](production-readiness.md) for the full list: freshness thresholds, the attempt limit on repeated SIGTERM, checksum-mismatch detection for edited migrations, scale beyond the benchmark, multi-instance and multi-day operation.
