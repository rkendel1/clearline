# Clearline

A contract-driven, production-style healthcare data platform that runs on **synthetic data only**.

Clearline ingests eligibility, claims, pharmacy and plan data from independent sources. It transforms each tenant's data into that tenant's own canonical model as declared in a versioned **data contract**, then validates, reconciles and versions every record. It serves the results through authorized APIs, read-only SQL views, reproducible CSV extracts, a governed **natural-language query workspace**, and a native desktop client (Rust + [GPUI](https://gpui.rs)).

> Data contracts define the meaning of the data; the platform enforces the contracts; execution evidence establishes what actually happened.

The tests check more than that data moved. Every declared business metric and the operations totals are compared with independent SQL, the generator's own answers and what the native client displays. A batch that ran is never confused with one that can be trusted, and failures leave no partial effects. A mutation suite plants 31 realistic defects and confirms the tests catch every one.

**Query workspace.** Ask a question in plain language; a model provider (deterministic rules by default, Anthropic optionally) proposes SQL, which is treated as **untrusted**. The server validates it structurally against the role's field policy, shows exactly what will run, and executes it only on explicit request, read-only, as a per-tenant, per-role database role that can read only what the policy grants. Restricted fields have no route into results: not through aliases, joins, subqueries, aggregates, ordering, previews, history, exports or error messages. Field sensitivity and redaction are managed by stewards and administrators and enforced by the server on every surface. See [docs/query-workspace.md](docs/query-workspace.md).

**Saved analytics.** A validated query can be saved as a versioned asset with typed parameters, scheduled (once, hourly, daily, weekly, monthly, in any time zone, with explicit daylight-saving rules) and analysed after each run by deterministic, offline algorithms: robust anomaly detection, backtested forecasts with empirical intervals, outlier ranking and seeded k-means segmentation. Evidence-backed insights are delivered in-app, by email, to signed webhooks (with SSRF protection) or as expiring exports. The scheduler is durable and runs in the worker. Saving and scheduling grant nothing: every run and every delivery is re-authorized under the current policy and an explicit execution identity. See [docs/saved-analytics.md](docs/saved-analytics.md).

![Native client: a natural-language question, the validated proposal and the role's catalog](docs/demo/query-workspace.png)

## Architecture walkthrough and assistant

Opening <http://localhost:8080> without signing in shows a public walkthrough: why the architecture matters, an interactive diagram generated from the real components, a capability catalog whose status labels come from recorded evidence, actor-based use cases, decision records with alternatives and tradeoffs, the recorded demonstration scenarios, and the limitations. **Ask Clearline** is available on every screen, signed in or not.

- **One content source.** [`content/`](content) (components, diagram, capabilities, decisions, actors, limitations) powers the page, the diagram and the assistant. `test/unit/content.test.ts` checks that every reference and evidence path exists and that a capability cannot be labelled "verified" without test evidence and a recorded result. The code inventory is in [docs/architecture-inventory.md](docs/architecture-inventory.md).
- **How the assistant answers.** Explanation questions (design, decisions, security, capabilities) use vector retrieval over an approved corpus (content plus selected documents) and return cited sources. With `ANTHROPIC_API_KEY` set in `.env.local` a model phrases the answer from those sources and must cite them; otherwise the answer is labelled excerpts. Questions about *current values* in the demo data (a metric, a period, a comparison, data quality, reconciliation) are answered by **validated data tools**: arguments are strictly validated, the query is generated from them (never written by a model), it runs through the same governed path as a person's query, and each answer links to its recorded evidence (definition, window, execution id, limitations). Anonymous data answers are enabled only for the tenant named in `ASSISTANT_PUBLIC_DATA_TENANT` (the compose demo tenant); signed-in users are answered as themselves.
- **Vector store.** pgvector inside the same PostgreSQL (the `db/Dockerfile` image), with a small local embedding model baked into the application image. Nothing is sent to an embedding service. Build or refresh the index with `docker compose run --rm index` (or `npm run assistant:index`); changing the embedding model needs `-- --rebuild`.
- **Public vs signed in.** Anonymous visitors retrieve public documents only. `docs/runbook.md` and `docs/deployment.md` are classified for signed-in users and are neither retrieved nor served to anonymous callers. Public requests are rate limited.
- **Measured, not claimed.** `npm run assistant:eval` measures retrieval on a version-controlled question set; results and their limits are in [docs/assistant-evaluation.md](docs/assistant-evaluation.md).
- **Tests.** `npm run test:unit` (content, routing, corpus allow-list, limiter, validation, planner), `npm run test:integration` (indexing, access classes, grounded and declined answers, injection, public HTTP boundary, data tools against independent calculations; the assistant tests need a PostgreSQL with pgvector and skip otherwise), `npm test --prefix web` (safe rendering of assistant text and links) and `npm run test:e2e:web` (scenarios A to E in a real browser; needs `npm run build --prefix web` and `npx playwright install chromium`). `npm run test:mutation` includes planted assistant defects.
- **Still open:** live model answers and live model tool selection are not covered by automated tests; rate limits are per process; no small-cell suppression. See [docs/production-readiness.md](docs/production-readiness.md) and [docs/threat-model.md](docs/threat-model.md).

## Quick start (Docker)

Requires Docker with Compose v2.

```sh
docker compose up -d              # Postgres → migrations → demo seed → API + worker on :8080
docker compose run --rm demo      # load the reference dataset; prints platform results next to ground truth,
                                  # then the same question asked under four roles
open http://localhost:8080         # the web interface (served by the API; sign in with a demo token below)
npm run native:build              # the desktop client (Rust 1.88+, see native/README.md for system libraries)
native/target/release/clearline --url http://localhost:8080
```

The web app (`web/`, React + Vite + TypeScript) is a parallel interface to the same API with the same views and permissions as the desktop client. See [web/README.md](web/README.md).

Put optional settings (for example `ANTHROPIC_API_KEY`, `NL_SQL_PROVIDER=anthropic`) in `.env.local`; Compose loads it and git ignores it.

Sign in with a demo token (seeded only outside production, synthetic tenants only):

| Token | Tenant | Role | Can |
|---|---|---|---|
| `cl_dev_northwind_operator` | northwind | operator | submit, replay, see quarantine and lineage (redacted); query; read field policies |
| `cl_dev_northwind_reporter` | northwind | reporter | reports, redacted extracts, query workspace (no record-level views) |
| `cl_dev_northwind_steward` | northwind | steward | classify fields: mark sensitive, choose stricter redaction, restrict roles (never widen); everyone's query history; audit |
| `cl_dev_northwind_admin` | northwind | admin | everything in the tenant, incl. publishing contracts, sensitive exports and widening field access |
| `cl_dev_northwind_approver` | northwind | approver | approve or reject breaking contract changes; **no tenant data** (issued by the platform admin only) |
| `cl_dev_bluefin_*` | bluefin | same five roles | |
| `cl_dev_platform_admin` | none | platform admin | create tenants, issue each tenant's first admin and its approvers; **no tenant data** |

`docker compose run --rm demo node dist/scripts/demo.js --with-migration` also publishes Northwind contract 2.0.0 (a breaking change), so you can review and approve it in the client's Contracts view, signed in as the approver. Reset everything with `docker compose down -v`.

The demo script and the screenshots of the native client are described in [docs/demo/README.md](docs/demo/README.md).

**Optional live model provider.** `NL_SQL_PROVIDER=anthropic ANTHROPIC_API_KEY=… docker compose up -d` (plus `ANTHROPIC_WORKSPACE_ID` for workspace-scoped keys). The key is read from the environment only; never put it in a file in this repository. Without it the deterministic provider answers the supported question shapes and manual SQL always works.

## Local development (no Docker)

Requires Node.js 22+ and PostgreSQL 16 with a role that can create databases and roles.

```sh
createuser --createrole --login clearline -P      # password: clearline  (or set DATABASE_URL)
createdb -O clearline clearline
npm ci
npm run migrate && npm run seed
RUN_WORKER_IN_API=true npm run dev:api            # API + worker on :8080
npm run demo                                      # in another terminal
npm run native:build && npm run native:run -- --url http://localhost:8080
```

Tests create and drop their own databases (`clearline_test`, …). Set `PG_ADMIN_URL` (default `postgres://postgres@localhost:5432/postgres`) to a superuser connection and `PGHOST_URL` (default `postgres://clearline:clearline@localhost:5432`).

## Tests and the required demonstrations

```sh
npm run typecheck
npm run test:unit          # transforms, decimal math, contract validation, migration planning, engine, adapters, reconciliation
npm run test:integration   # HTTP API: health, roles, platform-admin limits, rejection, failure+replay, quarantine, erasure, retention, tokens, audit, scope guard
npm run test:scenarios     # A–T against a real database and worker; writes test-results/evidence.md
npm run native:test        # Rust client unit tests
npm run native:build && npm run test:e2e   # native client under X (Xvfb if DISPLAY is unset): Scenario J (native), O, U, contract tests, measurements
npm run test:mutation      # plant 31 defects in a temp copy; every one must be caught
npm run benchmark:query    # query workspace latency, limits and concurrency
npm run benchmark:analytics # algorithms (small/medium/large), end-to-end runs with deliveries, scheduler burst
```

| Scenario | Test | What is verified |
|---|---|---|
| A Normal ingestion | `test/scenarios/a-normal-ingestion.test.ts` | batch → transform → reconcile → metric → extract → lineage, against generator truth |
| B Tenant customization | `b-tenant-customization.test.ts` | two different canonical models; a third tenant created and processed at runtime; no tenant names in `src/` |
| C Duplicate delivery | `c-duplicate-delivery.test.ts` | identical resubmission and 5 concurrent duplicates → one batch; overlapping redelivery adds only new rows |
| D Bad data | `d-bad-data.test.ts` | structural vs business-rule quarantine with exact reasons; reject threshold → untrusted; SSN in unmapped column scrubbed, absent from logs |
| E Late data and corrections | `e-late-data-corrections.test.ts` | supersession, late versions kept as history, conflicts quarantined, `as_of` vs current results |
| F Interrupted processing | `f-interrupted-processing.test.ts` | SIGKILL mid-transaction → nothing visible → recovered; SIGTERM → abort, re-queue, exit 0 |
| G Privacy violation | `g-privacy-violation.test.ts` | cross-tenant and sensitive-export attempts denied and audited at API and SQL layers |
| H Contract evolution | `h-contract-evolution.test.ts` | unsafe change rejected; breaking change planned, admin approval refused, approver applies it as new versions; rollback and its limit; widening applied; queued batches across migrations; drift in migration rows |
| I Reconciliation failure | `i-reconciliation-failure.test.ts` | in-transit loss, out-of-band drift and missing references detected and explained; metrics qualified; trust restored after repair; complete resend re-establishes data; untrusted corrections never displace trusted values |
| J Reporting correctness | `j-reporting-correctness.test.ts`, `test/e2e/native.test.ts` | 14 metrics: API = hand-written SQL = ground truth = native client; extracts and BI views agree |
| K Natural-language SQL | `k-natural-language-sql.test.ts` | question → inspectable proposal → explicit run; results equal independent SQL; edits re-validated; unavailable provider fails clearly; hostile model output never runs |
| L Role-restricted field | `l-role-restricted-field.test.ts` | a hidden field is unreachable through catalog, queries, errors, previews, history, exports, records, lineage and audit; database grants mirror the policy |
| M Sensitivity and redaction | `m-sensitivity-redaction.test.ts` | a steward marks a field sensitive: every surface redacts it at once (SQL and TypeScript masking agree); stewards cannot widen; versioned and audited |
| N Isolation and inference | `n-tenant-isolation-inference.test.ts` | 24 inference attacks rejected; with the validator bypassed the database still refuses writes, other tenants, ungranted columns and `RESET ROLE`; timeouts, cancellation, cost and concurrency limits |
| O Native workflow | `test/e2e/native.test.ts` | in the real GPUI window: NL question, edit, run, restricted fields, an administrator's sensitivity change, redaction in workspace, records and lineage |
| P Saved queries | `p-saved-queries.test.ts` | create from a proposal or SQL, typed parameters bound (invalid values rejected), versions kept by runs, schema change flags analyses, duplicate, share, archive; saving grants nothing |
| Q Scheduling | `q-scheduling.test.ts` | due-time runs exactly once with racing schedulers; interrupted run recovered; pause/resume/cancel; time zones and DST; revoked identity denied; failed query never reported delivered; scheduler in a worker subprocess survives restart (controllable clock) |
| R Delivery | `r-delivery.test.ts` | in-app, email over SMTP, signed webhooks, exports; retries, timeouts, permanent failure, duplicate protection, manual retry without re-query; results that became restricted are never delivered; interrupted delivery recovered |
| S ML analyses | `s-ml-analyses.test.ts` | planted anomaly found with grounded evidence; forecast vs held-out weeks; seeded outliers ranked first; known clusters recovered; sensitive inputs and insufficient data refused; model text cannot override computed values |
| T Analytics end to end | `t-analytics-end-to-end.test.ts` | save → schedule daily → anomaly → insight → notification; revoke → next run denied, nothing exposed; webhook SSRF targets refused; tenant isolation of all analytics objects |
| U Native saved analytics | `test/e2e/native.test.ts` | in the real GPUI window: save from the workspace, version with parameters, analysis builder, schedule editor with DST preview, run, insights and charts, notification opens the run, destinations and test delivery |

The latest recorded results are in [`docs/test-results.md`](docs/test-results.md) and `test-results/`.

## Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/architecture.md) | Components, diagram, module boundaries and dependency direction, batch lifecycle, transaction boundaries |
| [Query workspace and field policy](docs/query-workspace.md) | Proposal lifecycle, provider abstraction, authorization semantics, validation rules and limits, database enforcement, redaction, audit events |
| [Saved analytics](docs/saved-analytics.md) | Saved-query lifecycle and versions, schedules and recurrence, scheduler and recovery, execution identity, analyses and insights, delivery and its security, limits, monitoring |
| [Native client](native/README.md) | GPUI prerequisites per platform, build, run, behaviour, tests, measurements |
| [Contracts](docs/contracts.md) | Contract format, supported types/transforms/conditions, processing semantics, compatibility rules, migrations |
| [Data dictionary](docs/data-dictionary.md) | Every platform table, system column and canonical field (generated) |
| [Metric definitions](docs/metrics.md) | Definition, source, filters, aggregation and refresh for every metric (generated) |
| [API reference](docs/api.md) | Every endpoint with roles (generated from the route table); examples in [docs/examples](docs/examples) |
| [Threat model](docs/threat-model.md) | Privacy, tenant isolation, model output, inference and query abuse: assets, threats, controls, evidence, gaps, HIPAA delta |
| [Runbook](docs/runbook.md) | Failure handling and recovery, backup/restore, retention, erasure |
| [Deployment](docs/deployment.md) | Configuration reference, secrets management, cloud path |
| [Benchmark](docs/benchmark.md) | Measured ingestion throughput, query latency and limits, analysis and run latency, native client rendering, with environment and method |
| [Scale-out design](docs/scale-out.md) | When a queue, distributed engine, warehouse or orchestrator becomes justified, and at what cost |
| [ADRs](docs/adr/README.md) | Key decisions and trade-offs |
| [Production readiness](docs/production-readiness.md) | Tested / implemented / unverified / missing |

## Repository layout

```
src/
  api/             HTTP layer: route table, auth, error mapping (no business logic)
  contracts/       contract types, validation, storage compilation, version diff, registry
  ingestion/       source adapters, intake (idempotency, staging), worker, batch processor
  transform/       whitelisted transforms, coercion, exact decimals, rule evaluation (pure)
  quality/         sensitive-data detection
  reconciliation/  batch checks, dataset checks, post-load re-verification
  reporting/       reports, extracts, lineage, the single SQL compiler for metrics/filters
  policy/          field policies: access levels, sensitivity, redaction (the one resolver every surface uses)
  query/           role catalog, SQL validator, model providers, query surface (views, roles, grants), execution
  analytics/       saved queries and versions, parameters, recurrence, schedules, execution identity, scheduler, runs
  analysis/        deterministic anomaly, forecast, outlier and clustering algorithms; insights; optional grounded narrator
  delivery/        destinations, re-authorization, in-app inbox, SMTP email, signed webhooks + SSRF guard, exports
  control/         tokens and roles, tenants, audit, retention and erasure
  platform/        config, database scopes, migrations, logging, metrics
contracts/         JSON Schema + tenant contracts (northwind v1/v2/v2-unsafe, bluefin v1)
db/migrations/     versioned platform schema
native/            Rust/GPUI desktop client (clearline-client: API; clearline-desktop: the application)
synthetic/         deterministic synthetic data generator and the reference dataset with ground truth
scripts/           seed, demo, benchmarks, mutation check, doc generators
test/              unit, integration, scenarios (A–T), e2e (native client, Scenarios O and U)
docs/              everything above
```

## Scope and non-goals

No real PHI, no real healthcare integration, no regulatory certification claim, no generalized warehouse. The only model-assisted feature is SQL proposal, and a model's output is never trusted or executed without validation and an explicit request. It depends on no proprietary project. Production-readiness gaps are listed explicitly in [docs/production-readiness.md](docs/production-readiness.md) and [docs/threat-model.md](docs/threat-model.md).
