# Operations runbook

For each failure: how you notice it, what it means, and what to do. Commands assume the Compose stack (`docker compose …`). For a bare-metal install, substitute `node dist/src/cli.js` and your process manager. The tenant `northwind` and operator token are examples.

```sh
API=http://localhost:8080; T=cl_dev_northwind_operator; H="Authorization: Bearer $T"
```

## First look

| Question | Where |
|---|---|
| Is the API up / ready? | `curl $API/healthz` (process), `curl $API/readyz` (database + migrations; 503 with the failing check otherwise) |
| Is anything stuck? | Native client → Overview → "Ran versus trusted" and queue line; `/metrics`: `clearline_backlog_batches`, `clearline_oldest_queued_seconds`, `clearline_workers_live` |
| Is data stale? | Native client → Overview → Freshness by source; `clearline_data_freshness_seconds` |
| What happened to batch X? | Native client → batch detail, or `curl -H "$H" $API/api/v1/tenants/northwind/batches/X` (attempts, failure, reconciliation, quality) |
| Logs for one request or run | All logs are JSON lines carrying `correlation_id`, `batch_id`, `attempt`, `worker_id`: `docker compose logs api worker \| grep <id>` |

Suggested alerts: `clearline_workers_live == 0` for 2 min; `clearline_oldest_queued_seconds > 600`; any `clearline_batches{status="failed"}` increase; `clearline_batches{trust="untrusted"}` increase; freshness above the contract limit; `/readyz` non-200.

## Failure: batch status `failed`

**Means:** a processing attempt raised an error (not an interruption). The transaction rolled back, so the batch has **no** canonical rows, quality results or reconciliation. It is `untrusted` and listed under Exceptions → Batches needing review.

1. Read `failure` and `attempts[].error` on the batch detail. Search logs by `batch_id`.
2. Fix the cause: database capacity, timeouts (`BATCH_TIMEOUT_MS`, `STATEMENT_TIMEOUT_MS`), or a defect.
3. Replay: native client "Replay batch", or `curl -X POST -H "$H" $API/api/v1/tenants/northwind/batches/X/replay`. Replay re-queues the same staged rows. It is safe because failed attempts left no effects. *(Tested: integration test "a failed batch … replays safely".)*

## Failure: worker crashed or host died mid-batch

**Means:** the batch shows `processing` with an expired lease, and its attempt is `running`. Nothing it wrote is visible, because the transaction never committed.

**Recovery is automatic.** Any worker re-queues expired leases (every 5 s, and before `drain`). The interrupted attempt is marked `interrupted`, `batch.recover` is audited, and the next attempt processes from scratch. After `MAX_ATTEMPTS` interruptions the batch is marked `failed` (`max_attempts_exceeded`); investigate, then replay. *(Tested: Scenario F1, SIGKILL mid-write.)*

To speed up recovery, restart a worker; to make it more conservative, raise `WORKER_LEASE_SECONDS`. A live worker holds a row lock for its whole transaction, so lease recovery can never steal a batch that is still being processed.

## Planned restart or deploy

`docker compose stop worker` (or SIGTERM): the worker stops claiming and gives the in-flight batch `SHUTDOWN_GRACE_MS` to finish. Past that it aborts the transaction, re-queues the batch (attempt marked `interrupted`) and exits 0. The API stops accepting connections and finishes in-flight requests. *(Tested: Scenario F2 and the Compose shutdown check.)* Set the orchestrator's stop timeout above `SHUTDOWN_GRACE_MS` (Compose: `stop_grace_period: 30s`).

## Batch completed but `untrusted`

**Means:** the data loaded but must not be relied on. Trusted metrics and default extracts exclude it, and metrics show `trusted=false` with the excluded count. `trust_reasons` says why:

| Reason | Action |
|---|---|
| `reconciliation failed: source_control_count` / `source_control_sum:*` | The sender's totals disagree with what arrived; the explanation states the exact row/amount difference. Ask the source for the corrected, **complete** file and submit it. Rows already held only by the untrusted batch are re-established by the new trusted batch, not ignored as duplicates. *(Tested: Scenario I.)* The original batch stays untrusted as a record of what happened. |
| `reject rate X% exceeds threshold` | Too many rows quarantined. Read Exceptions → Quarantined records (each has its rule, field and source row); fix at source and resubmit corrected rows. |
| `post-load drift detected` | Rows in the target no longer match what the batch loaded: something changed data outside the platform. See *Drift* below. |

## Drift detected (rows changed outside the platform)

**Notice:** `batch.drift_detected` audit event; failed `reverify:*` checks in the batch's reconciliation; the batch flips to untrusted. Re-verification compares, per batch, row counts and control-total fields, including migration-created versions (`reverify:migration_*`). Edits to other fields of a row are not detected. Triggered by `POST /api/v1/tenants/:tenant/reconciliation/run` (schedule it, e.g. hourly).

1. Treat it as a security/integrity incident. The re-verification explanation gives the row and amount difference. The audit trail shows every platform-made change; the change you are looking at was **not** made through the platform.
2. Restore the affected rows from backup (below) into a scratch database and copy them back, or restore the database to a point in time. Resubmitting the original file will **not** repair it: identical bytes are an exact duplicate with no effect.
3. Re-run reconciliation (`POST …/reconciliation/run`). If every re-verification check passes again, drift was the only reason for distrust, and the batch's own load-time reconciliation had passed, trust is restored automatically and audited as `batch.trust_restored`. A batch that failed its own load-time checks is never re-trusted this way. *(Tested: Scenario I.)*

## Quarantined records

Exceptions → Quarantined records lists each row with its source row number and every reason. Records are never auto-admitted. Fix at the source and resubmit; then mark the item resolved with a note (operators and admins), which is audited. Resolved items are deleted after `quarantine_days`.

## Orphaned references (dataset check `orphans:*` failing)

Records referencing a record that has not arrived, e.g. claims for members not yet in the eligibility feed. Usually late reference data: the check clears once the referenced records arrive (*tested: Scenario I*). If it persists, ask the source for the missing reference records.

## Batch failed with `ContractSupersededError`

The batch was queued when a breaking contract migration was applied, so it was not processed under the superseded contract. It has no effects. Check that the source's file still matches the new contract, then replay it: replay re-pins it to the active contract.

## Contract migration awaiting approval or failed

A breaking contract stays `pending_approval` and blocks further publishes (409). Review the plan (Contracts page or `GET …/migrations`). An **approver** (token issued by the platform administrator) approves with the target version typed in, or rejects it. If an approved migration fails, the transaction rolls back, the migration is `failed`, the version `rejected`, and the previous version stays active. Rollback (`POST …/migrations/:id/rollback`) is allowed only before any batch uses the new version; after that, publish a corrected new version.

## Database unavailable

`/readyz` returns 503 with `database: <error>`. Workers log `worker loop error` and back off, intake returns 500 with a correlation id, and no partial writes are possible. Once the database is back, everything resumes on its own: queued batches are claimed and expired leases recovered.

## Backup and restore

*Procedure tested in this repository's development session against the Compose stack: restored counts and paid totals matched the source database exactly.*

```sh
# 1. Roles live outside the database dump (reporting roles, clearline_service): back them up once per change.
docker compose exec -T db pg_dumpall -U clearline --roles-only > roles.sql
# 2. Logical backup (consistent snapshot; safe while running)
docker compose exec -T db pg_dump -U clearline -d clearline -Fc > clearline-$(date +%F).dump
# 3. Restore into a NEW database and verify before switching
docker compose exec -T db psql -U clearline -d postgres -c "CREATE DATABASE clearline_restore OWNER clearline"
docker compose exec -T db pg_restore -U clearline -d clearline_restore --no-owner < clearline-YYYY-MM-DD.dump
docker compose exec -T db psql -U clearline -d clearline_restore -c "SELECT count(*) FROM core.batches"
# 4. Point DATABASE_URL at the restored database (or rename databases while the app is stopped), then:
curl -X POST -H "Authorization: Bearer <admin token>" $API/api/v1/tenants/<tenant>/reconciliation/run   # re-verify every batch against the restored data
```

On a new cluster, apply `roles.sql` before `pg_restore`. For production, use continuous archiving / point-in-time recovery (managed Postgres PITR or pgBackRest) rather than nightly dumps, encrypt backups, and set their retention consistently with tenant erasure obligations (erased subjects persist in backups until they expire). Restore drills belong on a schedule; this repository proves the procedure, not the drill cadence.

## Retention

Run per tenant on a schedule: `docker compose exec api node dist/src/cli.js retention northwind`, or `POST …/retention/run` (admin). It nulls raw payloads older than `raw_payload_days` (row hashes and numbers remain), deletes resolved quarantine older than `quarantine_days`, optionally deletes superseded versions, and deletes audit events older than `audit_days`. Audited as `retention.run`.

## Subject erasure

`POST /api/v1/tenants/:tenant/subjects/:entity/:key/erase` (admin). The response lists prior exports that contained the subject; follow up with their recipients. Dependent records (e.g. that member's claims) are retained and become orphaned references; erase them separately if required.

## Saved analytics

Schedules run in the **worker** (`SCHEDULER_ENABLED=true`, the default); the desktop client plays no part. Details: [saved-analytics.md](saved-analytics.md).

```sh
A=cl_dev_northwind_admin; HA="Authorization: Bearer $A"
curl -H "$HA" "$API/api/v1/tenants/northwind/analytics/runs?status=failed&limit=20"     # recent failures
curl -H "$HA" "$API/api/v1/tenants/northwind/analytics/runs/<run_id>"                   # phases, timings, deliveries, attempts
curl -H "$HA" "$API/api/v1/tenants/northwind/audit?correlation_id=<run_id>"             # every event of that run
```

Suggested alerts: `clearline_analytics_oldest_due_seconds > 300` (scheduler not keeping up or not running); `clearline_schedules_needing_attention > 0`; `clearline_deliveries{status="failed"}` or `{status="blocked"}` increasing; `clearline_analytics_runs_total{status="failed"}` rate.

| Symptom | Meaning | Action |
|---|---|---|
| Runs stay `queued`, oldest-due grows | No scheduler is running, or it is saturated (`SCHEDULER_MAX_CONCURRENT`, `SCHEDULER_MAX_PER_TENANT`) | Check `docker compose ps worker` and worker logs for `scheduler started`; raise limits only with database headroom |
| Run `denied`, `identity_revoked` / `role_not_delegable`; schedule shows attention | The execution identity lost its token or may no longer delegate the role | Someone with `schedule:manage` edits the schedule (re-binding it to their identity) or cancels it. Do not reissue a token just to revive a schedule |
| Run `failed`, `failure_class=validation` or `authorization` | The SQL is no longer permitted for the run role (policy tightened, field hidden) | Intended. Review with the query owner; save a new version that complies |
| Run `failed`, `failure_class=delivery`, `delivery_status=partial/failed` | The query and analyses succeeded; one or more destinations did not | Inspect the delivery's `last_error_code`; fix the destination (URL, secret `WEBHOOK_SECRET_<REF>`, SMTP); then `POST …/runs/<id>/retry-deliveries` (no re-query) |
| Delivery `blocked`, `access_changed` | Redaction or permissions changed after the query ran | Intended: nothing was sent. Rerun the query if the new policy should apply (`POST …/runs/<id>/rerun`) |
| Delivery `result_expired` | The snapshot passed `RUN_RESULT_RETENTION_HOURS` | Rerun the query |
| Analysis `stale_schema` / `needs_revalidation` | The query's output changed type or columns | Open the saved query → Analyses; revalidate and save a new version |
| Worker crashed mid-run | Leases expire (`RUN_LEASE_SECONDS`, `DELIVERY_LEASE_SECONDS`), then the next tick re-queues (audited `run.recover`, `delivery.recover`) | Nothing to do; check `missed_occurrences` on the next run if the outage spanned scheduled times (only the latest occurrence runs) |

Email: `EMAIL_PROVIDER=none` (default) makes email deliveries fail permanently with `email_not_configured`; configure `smtp` with `SMTP_URL` (STARTTLS or `smtps://`) and `EMAIL_FROM`. Webhooks to private addresses are refused unless `WEBHOOK_ALLOW_PRIVATE=true`, which is rejected at startup in production.

## Assistant (public walkthrough and data answers)

- **Build or refresh the index** after changing documents or `content/`: `docker compose run --rm index` (or `npm run assistant:index`). It is incremental: unchanged chunks are not re-embedded, changed ones are replaced, chunks whose source is gone are removed. `GET /api/public/assistant/status` shows the embedder, model, chunk count and corpus version.
- **Change the embedding model**: set `EMBEDDING_PROVIDER`, then `npm run assistant:index -- --rebuild`. Without `--rebuild` the indexer refuses (`model_mismatch`); vectors from different models are never mixed.
- **Anonymous data answers**: enabled only by `ASSISTANT_PUBLIC_DATA_TENANT` (compose sets it to the synthetic demo tenant). Unset it anywhere real data could exist.
- **Model**: `ANTHROPIC_API_KEY` in `.env.local` enables model-written answers; absent, answers are labelled excerpts and data answers are unaffected (their figures never come from a model).

What a visitor sees when something fails (the assistant never substitutes a guess):

| Situation | Behaviour | Where to look |
|---|---|---|
| Index not built, pgvector missing or the embedding model mismatches | "I cannot search the architecture documents at the moment, so I will not answer from memory"; signed-in users also see the reason | `clearline_assistant_errors_total{subsystem="index_*"}`, status endpoint |
| No relevant documents (best similarity below `ASSISTANT_MIN_SCORE`) | Declines and lists what it can answer | `clearline_assistant_requests_total{mode="declined"}` |
| Model provider unavailable or does not cite sources | Excerpts from the sources, with a notice | `clearline_assistant_errors_total{subsystem="model"}` |
| Data tool rejected the arguments or the role may not see the data | "I could not complete that calculation: ... I will not estimate or guess a figure." | `clearline_assistant_tool_calls_total{outcome=...}`, audit action `assistant.tool` |
| Data query timed out or failed | The same, with no figure | audit action `query.execution.*`, `clearline_assistant_tool_seconds` |
| Rate limited | HTTP 429 with `Retry-After` | `clearline_assistant_rate_limited_total` |
| Anonymous data not enabled | "not enabled for anonymous visitors" | `/api/public/assistant/status` `data_tools.public_enabled` |

## Reset a local environment

`docker compose down -v && docker compose up -d && docker compose run --rm demo`. This deletes all data, including the volume.
