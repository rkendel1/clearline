# Clearline

A contract-driven, production-style healthcare data platform that runs on **synthetic data only**.

Clearline ingests eligibility, claims, pharmacy and plan data from independent sources. It transforms each tenant's data into that tenant's own canonical model as declared in a versioned **data contract**, then validates, reconciles and versions every record. It serves the results through authorized APIs, read-only SQL views, reproducible CSV extracts and an operations dashboard.

> Data contracts define the meaning of the data; the platform enforces the contracts; execution evidence establishes what actually happened.

The tests check more than that data moved. Every declared business metric and the operations totals are compared with independent SQL, the generator's own answers and the rendered dashboard. A batch that ran is never confused with one that can be trusted, and failures leave no partial effects. A mutation suite plants 14 realistic defects and confirms the tests catch every one.

![Operations dashboard](docs/demo/overview.png)

## Quick start (Docker)

Requires Docker with Compose v2.

```sh
docker compose up -d              # Postgres → migrations → demo seed → API + worker
docker compose run --rm demo      # load the reference dataset; prints platform results next to ground truth
open http://localhost:8080        # dashboard
```

Sign in with a demo token (seeded only outside production, synthetic tenants only):

| Token | Tenant | Role | Can |
|---|---|---|---|
| `cl_dev_northwind_operator` | northwind | operator | submit, replay, see quarantine and lineage (redacted) |
| `cl_dev_northwind_reporter` | northwind | reporter | reports and redacted extracts |
| `cl_dev_northwind_admin` | northwind | admin | everything in the tenant, incl. publishing contracts and sensitive exports |
| `cl_dev_northwind_approver` | northwind | approver | approve or reject breaking contract changes; **no tenant data** (issued by the platform admin only) |
| `cl_dev_bluefin_*` | bluefin | same four roles | |
| `cl_dev_platform_admin` | none | platform admin | create tenants, issue each tenant's first admin and its approvers; **no tenant data** |

`docker compose run --rm demo node dist/scripts/demo.js --with-migration` also publishes Northwind contract 2.0.0 (a breaking change), so you can review and approve it on the Contracts page, signed in as the approver. Reset everything with `docker compose down -v`.

A 65-second recorded walkthrough of normal operation and four failure scenarios is in [`docs/demo/clearline-demo.mp4`](docs/demo/clearline-demo.mp4) ([transcript](docs/demo/README.md)).

## Local development (no Docker)

Requires Node.js 22+ and PostgreSQL 16 with a role that can create databases and roles.

```sh
createuser --createrole --login clearline -P      # password: clearline  (or set DATABASE_URL)
createdb -O clearline clearline
npm ci && npm --prefix dashboard ci
npm run migrate && npm run seed
npm run dashboard:build
RUN_WORKER_IN_API=true npm run dev:api            # API + worker + dashboard on :8080
npm run demo                                      # in another terminal
```

Tests create and drop their own databases (`clearline_test`, …). Set `PG_ADMIN_URL` (default `postgres://postgres@localhost:5432/postgres`) to a superuser connection and `PGHOST_URL` (default `postgres://clearline:clearline@localhost:5432`).

## Tests and the required demonstrations

```sh
npm run typecheck
npm run test:unit          # transforms, decimal math, contract validation, migration planning, engine, adapters, reconciliation
npm run test:integration   # HTTP API: health, roles, platform-admin limits, rejection, failure+replay, quarantine, erasure, retention, tokens, audit, scope guard
npm run test:scenarios     # A–J against a real database and worker; writes test-results/evidence.md
npm run dashboard:build && npm run test:e2e   # Chromium: dashboard numbers vs ground truth and SQL
npm run test:mutation      # plant 14 defects in a temp copy; every one must be caught
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
| J Reporting correctness | `j-reporting-correctness.test.ts`, `test/e2e/dashboard.test.ts` | 14 metrics: API = hand-written SQL = ground truth = dashboard; extracts and BI views agree |

The latest recorded results are in [`docs/test-results.md`](docs/test-results.md) and `test-results/`.

## Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/architecture.md) | Components, diagram, module boundaries and dependency direction, batch lifecycle, transaction boundaries |
| [Contracts](docs/contracts.md) | Contract format, supported types/transforms/conditions, processing semantics, compatibility rules, migrations |
| [Data dictionary](docs/data-dictionary.md) | Every platform table, system column and canonical field (generated) |
| [Metric definitions](docs/metrics.md) | Definition, source, filters, aggregation and refresh for every metric (generated) |
| [API reference](docs/api.md) | Every endpoint with roles (generated from the route table); examples in [docs/examples](docs/examples) |
| [Threat model](docs/threat-model.md) | Privacy and tenant isolation: assets, threats, controls, evidence, gaps, HIPAA delta |
| [Runbook](docs/runbook.md) | Failure handling and recovery, backup/restore, retention, erasure |
| [Deployment](docs/deployment.md) | Configuration reference, secrets management, cloud path |
| [Benchmark](docs/benchmark.md) | Measured throughput and latency with environment and method |
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
  control/         tokens and roles, tenants, audit, retention and erasure
  platform/        config, database scopes, migrations, logging, metrics
contracts/         JSON Schema + tenant contracts (northwind v1/v2/v2-unsafe, bluefin v1)
db/migrations/     versioned platform schema
dashboard/         React + Vite operations dashboard
synthetic/         deterministic synthetic data generator and the reference dataset with ground truth
scripts/           seed, demo, benchmark, demo recording, doc generators
test/              unit, integration, scenarios (A–J), e2e
docs/              everything above
```

## Scope and non-goals

No real PHI, no real healthcare integration, no regulatory certification claim, no generalized warehouse, no AI features. It depends on no proprietary project. Production-readiness gaps are listed explicitly in [docs/production-readiness.md](docs/production-readiness.md) and [docs/threat-model.md](docs/threat-model.md).
