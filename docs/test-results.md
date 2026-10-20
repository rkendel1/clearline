# Test results

Recorded from **one clean clone of commit `59085d7`** (branch `claude/bold-mendel-wpkwup`): fresh `git clone`, `npm ci`, a cold `cargo build --release --locked`, a new PostgreSQL 16 database per suite, nothing reused from development. Raw outputs are in [`test-results/clean-clone/`](../test-results/clean-clone/). The same suites run in GitHub Actions ([workflow](../.github/workflows/ci.yml)): the `test` job (Node), the `native` job (Rust/GPUI under Xvfb), the `container` job (Compose) and the secret scan.

**Environment.** Linux VM, 4 vCPU (Intel Xeon @ 2.10 GHz), 16.9 GB RAM, no GPU (Mesa lavapipe software Vulkan, Xvfb + openbox), Node.js 22.22, Rust 1.97, PostgreSQL 16.15 on the same host, Docker 29.9.

## Summary

| Check | Command | Result | Raw output |
|---|---|---|---|
| Typecheck | `npm run typecheck` | pass | [typecheck.log](../test-results/clean-clone/typecheck.log) |
| Dependency audit, npm (prod, high+) | `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities (also 0 including dev dependencies) | [audit.log](../test-results/clean-clone/audit.log) |
| Dependency audit, Rust | `cargo audit --file native/Cargo.lock` | 0 vulnerabilities in 779 crates; 14 "unmaintained" warnings, all transitive dependencies of GPUI (e.g. `async-std`, `paste`, `rustybuzz`, `ttf-parser`) | [cargo-audit.log](../test-results/clean-clone/cargo-audit.log) |
| Secret scan | gitleaks 8.21.2 over the full git history (`.gitleaks.toml`) | no leaks (15 commits) | — |
| Unit tests | `npm run test:unit` | **43 / 43 pass** | [unit.log](../test-results/clean-clone/unit.log) |
| Integration tests (HTTP API, real DB and worker) | `npm run test:integration` | **13 / 13 pass** | [integration.log](../test-results/clean-clone/integration.log) |
| Demonstration scenarios A–N | `npm run test:scenarios` | **20 / 20 pass** (F has two parts, K two, N five) | [scenarios.log](../test-results/clean-clone/scenarios.log), [JUnit](../test-results/scenarios.junit.xml), [evidence](../test-results/evidence.md) |
| Native client build | `cargo build --release --locked` | pass (cold build, 390 s) | [native-build.log](../test-results/clean-clone/native-build.log) |
| Native client unit tests | `cargo test --release --locked` | pass | [native-test.log](../test-results/clean-clone/native-test.log) |
| Native end-to-end (real window, Xvfb) | `npm run test:e2e` | **4 / 4 pass**: Scenario J (native), Scenario O, Rust contract test against the live API, measurements | [e2e.log](../test-results/clean-clone/e2e.log), [screenshots](../test-results/native/), [perf](../test-results/native-perf.json) |
| Mutation checks | `npm run test:mutation` | **22 / 22 planted defects caught** | [mutation.log](../test-results/clean-clone/mutation.log), [mutation.json](../test-results/mutation.json) |
| Container image + Compose stack | `docker build … && docker compose up -d && docker compose run --rm demo` | image built; all services healthy; demo: every metric and every checked query result matches ground truth; API and worker stopped with exit 0 | [compose-demo.log](../test-results/clean-clone/compose-demo.log) |
| Native client against the Compose stack | release binary, `--url http://localhost:8080` | signed in as reporter, NL question → validated proposal → run (457 claims) | — |
| Benchmarks | `npm run benchmark:query`, `BENCH_PUBLISH=1 npm run benchmark` | 0 failed batches; query and native measurements | [benchmark.md](benchmark.md) |

The Compose stack, cargo audit and benchmarks were run from the development checkout of the same commit, not from the clean clone.

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

## Mutation checks

Each mutation plants one realistic defect in a temporary copy, runs the tests that should notice, and records which ones failed. All 22 were caught; the catching tests are listed in [mutation.log](../test-results/clean-clone/mutation.log).

## Not covered by these results

- **Live Anthropic provider.** The supplied API key is not scoped to a workspace, and the API requires the `anthropic-workspace-id` header for such keys (`ANTHROPIC_WORKSPACE_ID`). No workspace ID was available, so the live path returned a 400, which is handled and surfaced as `503 provider_unavailable`. The deterministic provider and the unavailable path are tested.
- **macOS and Windows builds** of the native client, and rendering with a GPU (only software Vulkan was measured).
- See [production-readiness.md](production-readiness.md) for the full list: freshness thresholds, the attempt limit on repeated SIGTERM, checksum-mismatch detection for edited migrations, scale beyond the benchmark, multi-instance and multi-day operation.
