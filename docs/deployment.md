# Deployment and configuration

## Local (reproducible)

```sh
docker compose up -d            # db → migrate → seed (demo tenants) → api + worker
docker compose run --rm demo    # load the reference dataset, print results vs ground truth
open http://localhost:8080      # dashboard
docker compose down -v          # remove everything
```

The image is built from `Dockerfile` (multi-stage: compile backend and dashboard, then a production-only runtime running as the unprivileged `node` user). One image serves every role through its command: API (`node dist/src/main.js`), worker (`node dist/src/worker-main.js`), migrations (`node dist/src/cli.js migrate`), retention (`node dist/src/cli.js retention <tenant>`), demo seed (`node dist/scripts/seed.js`, which refuses `NODE_ENV=production`).

Behind a TLS-inspecting corporate proxy, pass its CA to the build without baking it into the image: `docker build --secret id=extra_ca,src=ca.pem .`. Base images can be redirected to a mirror with `NODE_IMAGE=…` and `POSTGRES_IMAGE=…`.

## Configuration reference

All settings are environment variables, validated at startup (`src/platform/config.ts`). Invalid values stop the process with a message.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://clearline:clearline@localhost:5432/clearline` | **Secret.** Connection string |
| `NODE_ENV` | `development` | `production` disables fault injection, forces distinct-approver checks, blocks the demo seed |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | API listener |
| `LOG_LEVEL` | `info` (`warn` in test) | `debug` \| `info` \| `warn` \| `error` |
| `DB_POOL_SIZE` | `10` | Connections per process |
| `STATEMENT_TIMEOUT_MS` | `60000` | Per-statement database timeout |
| `BATCH_TIMEOUT_MS` | `600000` | Maximum processing time per batch attempt (also the HTTP request timeout) |
| `MAX_UPLOAD_BYTES` | `52428800` | Request body limit |
| `MAX_ROWS_PER_BATCH` | `500000` | Rows per submission |
| `WORKER_LEASE_SECONDS` | `120` | Lease before an abandoned batch is recovered |
| `WORKER_POLL_MS` | `500` | Idle poll interval |
| `MAX_ATTEMPTS` | `3` | Interrupted attempts before a batch is marked failed |
| `SHUTDOWN_GRACE_MS` | `20000` | Time an in-flight batch gets on SIGTERM before it is aborted and re-queued |
| `RUN_WORKER_IN_API` | `false` | Run a worker inside the API process (single-container installs) |
| `MIGRATE_ON_START` | `false` | Apply migrations when the API starts (prefer a separate migrate job) |
| `DASHBOARD_DIR` | `dashboard/dist` | Static dashboard build served at `/` |
| `METRICS_TOKEN` | unset | **Secret.** If set, `/metrics` requires `Authorization: Bearer <token>` |
| `ALLOW_SELF_APPROVAL` | `false` | Outside production only: allow a requester to approve their own breaking migration |
| `CLEARLINE_FAULT_INJECTION` | unset | Test-only (`crash_after_rows=N`, `fail_source=<id>`); ignored in production |

Compose sets explicit CPU and memory limits per service (`deploy.resources.limits`) and a 30-second stop grace period.

## Secrets management

- The repository contains **only** local demo credentials: Compose's `clearline-local-only` password and the seeded `cl_dev_*` tokens. They are listed in `.gitleaks.toml` so the CI secret scan still fails on anything else.
- In any shared environment, inject `DATABASE_URL` and `METRICS_TOKEN` from the platform's secret store (AWS Secrets Manager / SSM, GCP Secret Manager, Azure Key Vault, Kubernetes Secrets with external-secrets, or Vault) as environment variables at runtime. Never bake them into images or Compose files.
- API tokens are generated server-side (`cl_` + 192 random bits), returned **once**, stored as SHA-256, and revocable (`POST /api/v1/tenants/:tenant/tokens/:name/revoke`). The first tenant-admin token is issued by a platform-admin token. Create that one out of band (the seed script shows how) and store it in the secret store.
- Rotate database credentials by adding the new role/password, rolling the services, then removing the old one. Rotate tokens by issuing a new one under a new name, switching clients, and revoking the old one.

## Path to a cloud deployment

The first release needs no Kubernetes. A conventional managed deployment:

| Concern | Recommended mapping |
|---|---|
| Database | Managed PostgreSQL 16 (RDS / Cloud SQL / Azure Flexible Server) with PITR, encrypted storage, private networking only |
| API | 2+ container instances (ECS Fargate / Cloud Run / App Service) behind a TLS load balancer. Health check `/healthz`; readiness gate `/readyz` |
| Worker | Separate service, 1+ instances, no inbound traffic; stop timeout > `SHUTDOWN_GRACE_MS` |
| Migrations | One-off task (`node dist/src/cli.js migrate`) run by the deploy pipeline before rolling the services; `/readyz` refuses traffic while migrations are pending |
| Retention / reconciliation re-verify | Scheduled tasks (EventBridge / Cloud Scheduler) calling the CLI or the API with an admin token |
| Secrets | Platform secret store → environment variables |
| Logs | stdout JSON → CloudWatch / Cloud Logging / your SIEM; index `correlation_id`, `batch_id` |
| Metrics | Scrape `/metrics` (Prometheus / managed Prometheus / OpenTelemetry collector) with `METRICS_TOKEN` |
| Images | Build in CI, push to a private registry, deploy by digest |

The Compose file is the executable specification of the topology: one database, a migration job, N stateless API instances, M workers. Moving to the table above changes where each runs, not what runs.

## Database privileges

The bootstrap role needs `CREATEROLE`, because creating a tenant creates its reporting role. For production, split it into an owner/migration role (DDL, role creation) and a runtime role (DML only, member of `clearline_service`). That split is listed under gaps in [threat-model.md](threat-model.md) and [production-readiness.md](production-readiness.md).
