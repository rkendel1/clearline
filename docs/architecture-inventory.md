# Architecture inventory

What the repository actually contains, established by reading the code and the recorded test evidence (not the aspirational diagram in a specification). The public landing page, the diagram and the assistant are generated from [`content/`](../content), which is checked against this inventory by `test/unit/content.test.ts`.

| Area | What exists | Where |
|---|---|---|
| Entry points | API process, worker process (scheduler runs inside it), CLI (`migrate`, `retention`, `assistant:index`), seed and demo scripts, native desktop client, web client | `src/main.ts`, `src/worker-main.ts`, `src/cli.ts`, `scripts/`, `native/`, `web/` |
| Authentication | Opaque bearer tokens, hashed at rest, one role per token (`admin`, `approver`, `steward`, `operator`, `reporter`; `platform_admin` for bootstrap only), immediate revocation. No SSO or MFA | `src/control/auth.ts`, `src/control/tenants.ts` |
| Data sources | Synthetic only: CSV files, a JSON API feed and plan reference data for two tenants (northwind, bluefin) | `synthetic/`, `scripts/demo.ts` |
| Ingestion | HTTP intake (JSON and CSV), per-source adapters, content digest idempotency, staging in `core.raw_records`, batch registered as a queue row | `src/ingestion/intake.ts`, `src/ingestion/adapters` |
| Transformation | Declarative, whitelisted operations compiled from each tenant's data contract; pure functions with no I/O | `src/transform`, `src/contracts` |
| Validation and quality | Structural, business, referential and privacy rules from the contract; failures quarantined with the rule id and source row | `src/quality`, `src/ingestion/processor.ts` |
| Reconciliation | Batch checks (counts, control totals, row accounting), dataset checks, post-load re-verification (drift) | `src/reconciliation` |
| Persistence | PostgreSQL only: `core` (batches, raw rows, quarantine, quality, reconciliation, contracts, audit, saved queries, runs), per-tenant `t_<tenant>` canonical tables generated from the contract, `q_<tenant>` query views, RLS-scoped reporting views | `db/migrations`, `src/contracts/compile.ts` |
| Reporting | Operations and business reports, metric definitions, extracts with checksums, lineage; one SQL compiler for the "trusted dataset" rule | `src/reporting` |
| Query workspace | Permitted catalog, SQL provider (deterministic rules or Claude) producing an untrusted proposal, AST allowlist validator, execution on a separate pool under a per-tenant per-role database role | `src/query` |
| ML and analytics | Deterministic anomaly detection (rolling MAD, seasonal decomposition), forecasting (naive, seasonal naive, drift, Holt, auto by backtest), outlier scoring, seeded k-means. Optional model narration behind a grounding check | `src/analysis` |
| Scheduling | Durable schedules (RRULE + time zone, DST rules) in PostgreSQL, executed by the worker, independent of any client; leases and recovery | `src/analytics` |
| Delivery | In-app, SMTP email, signed HTTPS webhooks (SSRF guard), expiring CSV exports; re-authorized before every send; retries with backoff | `src/delivery` |
| Security | Route authorization, request-bound tenant scope in the data layer, RLS on core tables, field policy resolver, query roles with column grants, append-only audit, safe logging | `src/control`, `src/policy`, `src/platform/db.ts` |
| Vector retrieval | **None existed.** Added for the assistant: pgvector in the same PostgreSQL, local embedding model | `src/assistant`, `db/Dockerfile` |
| Operations | Docker Compose stack, migrations with checksums, `/healthz` `/readyz` `/metrics`, structured logs, GitHub Actions CI, benchmarks | `docker-compose.yml`, `.github/workflows`, `docs/runbook.md` |
| Verification | 71 unit tests, integration tests, scenarios A to T, native end-to-end U, 31 mutation checks (recorded in [test-results.md](test-results.md) at commit `dc06c95`) | `test/`, `docs/test-results.md` |

## Where the code differs from the specification's logical diagram

- There is no separate "ML service": analyses are a pure module executed by the worker's scheduler (ADR 0016).
- The "query engine" is the query workspace and the same execution path the scheduler uses (`runSql`); there is no second engine.
- The "UI" was a native client only. A web client (`web/`, ADR 0017) now exists beside it; it was verified with a headless-browser smoke run and a hosting unit test, not with the recorded scenario suite.
- The assistant has retrieval (pgvector) but its structured data tools are not built yet (planned, ADR 0018).
- Dedicated warehouse, message queue and orchestrator are deliberately absent; see [scale-out.md](scale-out.md) for the triggers.
