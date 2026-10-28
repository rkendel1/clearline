# Deploying to a Hetzner server

One Linux server runs the whole stack with Docker Compose: PostgreSQL (with pgvector), a migration job, the API (which also serves the web app and the assistant), the worker, and Caddy for automatic HTTPS. Everything is served from one origin.

```
internet ──443/80──▶ Caddy ──▶ api (web app, API, assistant) ──▶ PostgreSQL (not published)
                                worker (scheduler, batches) ───▶ PostgreSQL
```

## What you need

- A Hetzner Cloud server (Ubuntu 22.04 or 24.04). **At least 4 GB RAM** (for example CX22/CPX21): the API loads the assistant's embedding model (about 1 GB) and the image build compiles pgvector.
- SSH access as root (or a sudo user) with your key.
- For HTTPS: a domain with an **A record pointing at the server** before the first deploy. Without a domain it serves plain HTTP on the server's IP.

## Deploy (from your machine)

```sh
deploy/hetzner/deploy.sh root@SERVER_IP clearline.example.com     # domain optional
```

It prepares the server on first run (Docker, firewall allowing only 22/80/443, a nightly backup, and `/opt/clearline/.env` with randomly generated secrets), copies the code, builds and starts the stack, and waits for `/readyz`. Run it again for every release; secrets and data are kept.

The migration job refuses to continue if the database login cannot create roles, and says how to fix it. The application logs in as a **non-superuser** (`clearline_app`) so row-level security applies; the administrative `postgres` login is used only for setup and backups.

## First-time steps

```sh
ssh root@SERVER_IP
cd /opt/clearline/src/deploy/hetzner
docker compose --env-file /opt/clearline/.env exec -T api node dist/src/cli.js platform-admin   # prints the first admin token, once
```

Use that token to sign in at your URL and to create your tenant and its first admin and approver tokens (see `docs/api.md`). The demo seed never runs in production.

## Load the synthetic demo data (optional)

Production has no seed and never creates the well-known `cl_dev_*` tokens. To show the demo (two synthetic tenants, their contracts, the reference dataset, saved queries and a scheduled analysis), provision the tenants with **random** tokens and load the data over HTTP:

```sh
cd /opt/clearline/src/deploy/hetzner && DC="docker compose --env-file /opt/clearline/.env"
$DC exec -T -e LOG_LEVEL=error api node dist/scripts/provision-demo.js > /opt/clearline/demo-tokens.json && chmod 600 /opt/clearline/demo-tokens.json
$DC exec -T -e DEMO_TOKENS_JSON="$(cat /opt/clearline/demo-tokens.json)" -e CLEARLINE_URL=http://127.0.0.1:8080 api node dist/scripts/demo.js > /opt/clearline/demo-load.log
```

`demo-tokens.json` holds one token per role for each tenant (admin, approver, steward, operator, reporter); it is the only place they are shown. Provisioning is idempotent and never reissues tokens for an existing tenant. To let anonymous visitors ask the assistant data questions about the demo, set `ASSISTANT_PUBLIC_DATA_TENANT=northwind` in `/opt/clearline/.env` and `up -d` (synthetic data only).

## Settings (`/opt/clearline/.env`)

| Variable | Purpose |
|---|---|
| `SITE_ADDRESS`, `PUBLIC_URL` | Your domain (automatic HTTPS) and the public URL used in links. Change both together |
| `ANTHROPIC_API_KEY`, `NL_SQL_PROVIDER=anthropic` | Optional: model-written assistant answers and natural-language SQL. Without them the offline providers are used |
| `ASSISTANT_PUBLIC_DATA_TENANT` | Leave empty. Only name a tenant holding synthetic data to let anonymous visitors ask data questions |
| `METRICS_TOKEN` | `/metrics` is blocked at the proxy; scrape it from inside the server if you need it |

After editing: `docker compose --env-file /opt/clearline/.env up -d`.

## Operations

- **Logs:** `docker compose --env-file /opt/clearline/.env logs -f api worker`
- **Rebuild the assistant index** after documentation changes: `docker compose --env-file /opt/clearline/.env run --rm index`
- **Backups:** nightly at 03:17 to `/opt/clearline/backups` (database dump plus roles, 14 days). **Copy them off the server** (for example `rsync` to another host or a Hetzner Storage Box); a backup on the same disk is not a backup. Run one now with `deploy/hetzner/backup.sh`.
- **Restore** (to a fresh stack): start `db`, then `gunzip -c roles-*.sql.gz | docker compose exec -T db psql -U postgres` (ignore "already exists"), then `docker compose exec -T db pg_restore -U postgres -d clearline --clean --if-exists < clearline-*.dump`, then start the rest. Practice this once before you rely on it.
- **Update the OS and Docker** regularly; enable Hetzner server backups/snapshots for the whole disk as a second layer.

## Known limits

- One server is a single point of failure: no replica, no automatic failover. Rate limits are in memory (single API process here, so this is fine).
- Test evidence for the application is in `docs/test-results.md`. This deployment recipe was exercised locally (build, migration preflight, index, HTTP through Caddy, backup) but not yet on a real server until you run it.
