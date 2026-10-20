# Saved analytics: saved queries, schedules, analyses and delivery

Clearline turns a validated query into a **saved, versioned analytical asset** that can run on a schedule, apply deterministic statistical analyses to its result, and deliver results and insights to people and systems. Everything here reuses the query workspace's authority: the validator, the field policy, the query login with `SET LOCAL ROLE`, the audit trail and RLS. Nothing in this subsystem grants access. Saving a query, scheduling it and delivering its result are all re-checked against the **current** policy every time they happen.

```
 saved query (versions) ──> schedule (RRULE + time zone, run-as identity)
                                │  scheduler (worker process, durable, leased)
                                v
      run: identity check -> re-validate -> query (bound parameters) -> bounded snapshot
                                -> analyses (deterministic) -> insights (templated, evidence)
                                -> deliveries (in-app | email | webhook | export), each re-authorized
```

Code: `src/analytics/` (saved queries, schedules, recurrence, runner, scheduler, runs), `src/analysis/` (algorithms, insights, optional narrator), `src/delivery/` (destinations, adapters, SSRF guard, inbox, exports). Schema: `db/migrations/0004_saved_analytics.sql`. Decision records: [ADR 0014](adr/0014-saved-analytics-authority.md) (saving is not a grant), [ADR 0015](adr/0015-durable-scheduler.md) (durable scheduling in PostgreSQL), [ADR 0016](adr/0016-deterministic-analysis.md) (deterministic analysis first).

## 1. Saved queries

A saved query has a stable identity and metadata (name, description, business purpose, category, tags, business owner, sharing, status, favorites), and an append-only list of **versions**. A version holds the SQL, the original natural-language request and source proposal (when it came from one), typed **parameter declarations**, the **output schema** observed for the saver's role, and the **analysis configurations**. Versions cannot be updated or deleted (a database trigger refuses it); every run records the version it used.

| Operation | API | Rule |
|---|---|---|
| Create from a proposal or SQL | `POST /saved-queries` | the SQL is validated for the creator's role; a proposal must be the creator's own and executable |
| Edit metadata | `POST /saved-queries/:id` | owner or `saved_query:admin`; sharing needs `saved_query:share` |
| New version | `POST /saved-queries/:id/versions` | re-validated; unchanged content is refused (`no_change`); analyses whose columns no longer match are kept but flagged `needs_revalidation` |
| Duplicate | `POST /saved-queries/:id/duplicate` | copy is private to the duplicator, version 1 |
| Disable / archive / restore | `POST /saved-queries/:id/status` | disabling or archiving pauses its schedules with an attention notice |
| Favorite | `POST /saved-queries/:id/favorite` | per token |
| Run synchronously (preview/run) | `POST /saved-queries/:id/execute` | `analysis:run`; same path as the workspace |
| Queue a run (analyses + deliveries) | `POST /saved-queries/:id/runs` | the scheduler executes it |

**Visibility.** A private query is visible to its owner (and to `saved_query:admin`, for governance); a query shared with the tenant is listed for everyone in the tenant. Visible is not usable: when a viewer's role may not run the SQL (for example it filters on a field hidden from them), the SQL and validation messages are withheld and execution is refused with `query_not_permitted` — exactly what the workspace does for the same SQL.

**Parameters** are referenced as `:name` and declared with a type (`text`, `integer`, `decimal`, `boolean`, `date`, `timestamp`), optional label, default, `min`/`max`, `allowed` values and `required`. Date defaults may be relative: `{ "relative_days": -7 }`, `{ "relative_months": -1, "start_of": "month" }`, resolved in the schedule's time zone at the occurrence time. The validator turns each reference into a typed bind parameter (`CAST($n AS date)` after deparse); values are always bound, never spliced into text. Undeclared, unused and positional (`$1`) parameters are rejected.

## 2. Schedules

A schedule binds a saved query (current version, or a pinned version), parameter values, destinations and an **execution identity** to a recurrence.

**Recurrence format.** The stored form is an RFC 5545 `RRULE` subset plus a wall-clock start, optional wall-clock end and an IANA time zone:

| Frequency | Example input (`recurrence`) | Stored `rrule` |
|---|---|---|
| once | `{ "frequency": "once" }` (runs at `start_local`) | `null` |
| hourly | `{ "frequency": "hourly", "interval": 4 }` (every 4 hours from `start_local`) | `FREQ=HOURLY;INTERVAL=4` |
| daily | `{ "frequency": "daily", "at": "06:00" }` | `FREQ=DAILY;BYHOUR=6;BYMINUTE=0` |
| weekly | `{ "frequency": "weekly", "weekdays": ["MO","TH"], "at": "09:30" }` | `FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=9;BYMINUTE=30` |
| monthly | `{ "frequency": "monthly", "month_day": -1, "at": "18:00" }` (last day) | `FREQ=MONTHLY;BYMONTHDAY=-1;BYHOUR=18;BYMINUTE=0` |

An `rrule` string may be given instead of `recurrence`. `POST /analytics/schedules/preview` returns the description and the next occurrences without saving.

**Daylight saving time** (explicit and tested): a local time that does not exist (spring-forward gap) runs at the same wall-clock time shifted forward by the gap, i.e. using the offset in effect before the transition (02:30 → 03:30); a local time that occurs twice (fall-back overlap) runs once, at the first occurrence; hourly schedules count elapsed hours, so a day may have 23 or 25 runs. A daily 06:00 America/New_York schedule runs at 10:00 UTC before 1 November 2026 and 11:00 UTC after.

**Lifecycle:** `pause`, `resume` (the next occurrence is recomputed from now; missed ones are not replayed), `cancel` (terminal), `run` (an immediate manual run under the schedule's identity and destinations), and `POST /analytics/schedules/:id` to change recurrence, parameters, destinations, pinned version or role. A concurrent edit is refused (`version_conflict`). Changing a schedule **re-binds it to the editor's identity** (the person now responsible for it), and the role it runs as must be one the editor may delegate. Each schedule shows `next_run_at`, its last run and an `attention` message when it needs a person (identity revoked, query disabled, repeated failures).

**Execution identity.** A schedule runs as an explicit identity: an active API token (`run_as_actor`, the creator) and a role (`run_as_role`) that the creator's role may delegate — admin to any data role, steward to steward or reporter, operator to operator or reporter, reporter to reporter. A schedule never inherits a higher role from whoever edits or triggers it, and an administrator pressing *Run now* does not make the run an administrator's. Before every run the identity is re-checked: the token must still be active and its role must still be delegable; otherwise the run is `denied` (`identity_revoked`, `role_not_delegable`), nothing is queried and the schedule gets an attention notice.

## 3. Durable scheduler and runs

There is no scheduler in the client and none held in memory: state lives in PostgreSQL and the scheduler runs in the **worker** process (`SCHEDULER_ENABLED`, on by default; the API runs it only with `RUN_WORKER_IN_API=true`). Each tick:

1. **Materialize** due occurrences: due schedules are locked with `FOR UPDATE SKIP LOCKED`; a run is inserted per occurrence under `UNIQUE (schedule_id, occurrence_at)`, so two schedulers cannot create the same occurrence twice. If several occurrences were missed (worker down), only the latest runs and the others are counted in `missed_occurrences` — no burst of stale catch-up runs.
2. **Recover** runs and deliveries whose lease expired (worker crash): a run returns to the queue for another attempt (`error_code = interrupted`; after `max_attempts` it fails with `failure_class = interrupted`), a delivery returns to `retrying`; the interrupted claim counts as an attempt and each recovery is audited (`run.recover`, `delivery.recover`).
3. **Claim** queued runs: at most `SCHEDULER_MAX_CONCURRENT` per process and `SCHEDULER_MAX_PER_TENANT` per tenant across all workers (counted under a per-tenant advisory lock). A run is executed under a lease (`RUN_LEASE_SECONDS`) that is renewed between phases; a worker that lost its lease stops without writing.
4. **Deliver** pending deliveries (`DELIVERY_CONCURRENCY`), each under its own lease.
5. **Purge** expired result snapshots (`RUN_RESULT_RETENTION_HOURS`) and expired exports.

**Run record.** Every run stores: saved query and version, schedule and occurrence, trigger (`schedule`, `manual`, `rerun`), requested by, run-as actor and role, parameters, attempt and max attempts, status, the phase outcomes `query_status`, `analysis_status`, `delivery_status`, the `failure_class` (`authorization`, `validation`, `query`, `timeout`, `resource_limit`, `result_persistence`, `analysis`, `delivery`, `interrupted`, `internal`) with error code and message, timings per phase (queue wait, identity, query, snapshot, analyses, delivery), the execution id (links to `query_executions`), the result metadata (columns, row count, truncation, bytes, schema change), and the correlation id that links every audit event of the run.

**Retries.** Transient query failures (timeouts, connection loss, concurrency limit) are retried with exponential backoff (`RUN_RETRY_BASE_MS` doubling to `RUN_RETRY_MAX_MS`, up to the schedule's `max_attempts`); a 429 from the concurrency limit is requeued without consuming an attempt. Authorization and validation failures are never retried. Each analysis has its own outcome; `analysis_status` is `succeeded`, `partial` (some analyses did not succeed, e.g. `insufficient_data`), `failed` (every analysis failed) or `not_configured`, and analyses never cause the query to be re-run. A run is `succeeded` only when the query succeeded, the analyses did not all fail, and **every** delivery was delivered; it is `delivering` while deliveries are pending, and otherwise `failed` with `failure_class` `analysis` or `delivery` (`delivery_status` `partial`, `failed` or `blocked`). A failed delivery is never reported as delivered.

**Manual recovery.** `POST /analytics/runs/:id/retry-deliveries` re-sends failed or blocked deliveries from the stored snapshot **without re-running the query** (and re-authorizes them first); `POST /analytics/runs/:id/rerun` queues a fresh run; `POST /analytics/runs/:id/cancel` cancels a queued run.

**Result snapshots.** The run's result is kept as a bounded snapshot (`core.run_results`) of what the run identity's role may see (masked fields already redacted by the database), so analyses, deliveries and later viewing do not re-query. Snapshots expire. When someone views a run, values are re-masked for the **viewer's** current role, and the result and dependent insights are withheld when the viewer could not run the query now.

**Schema drift.** The output schema of each run is compared with the version's saved schema. A change is recorded on the run (`schema_changed`) and analyses whose required columns changed type, disappeared or became redacted end as `stale_schema` instead of computing on the wrong data.

## 4. Analyses

The analysis pipeline is separate from query execution: it receives only the run's authorized snapshot, is deterministic, and runs offline. Configurations are validated (`POST /saved-queries/:id/analyses/validate`) against the version's output schema: masked or sensitive columns are refused as inputs, numeric features must be numeric, a time column must be a date or timestamp.

| Algorithm (all v1.0.0) | Method |
|---|---|
| `anomaly.rolling_mad` | For each point, a baseline from **earlier points only** (no look-ahead): the median of the previous `window` same-phase observations when a seasonal `period` is set (e.g. 7 for daily data), otherwise of the previous `window` observations. Scale: a pooled leave-one-out MAD of residuals over `window × period` points (×1.4826), with a multiplicative mode chosen automatically for series whose spread grows with level. A point is anomalous when its robust z-score exceeds `threshold` (default 3.5); severity from the z-score. |
| `anomaly.seasonal_decomposition` | Trend by centred moving **median** (robust to the spike itself), seasonal component as the per-phase median of the detrended series, anomalies where the residual's robust z-score exceeds the threshold. |
| `forecast.naive`, `forecast.seasonal_naive`, `forecast.drift`, `forecast.holt_linear` | Baselines: last value; same phase last season; linear drift; Holt's linear trend with α and β chosen on a fixed grid (0.1–0.9) by in-sample one-step squared error of the training data only. |
| `forecast.auto` | Runs a **rolling-origin backtest** (`backtest_origins`, default 8) for each candidate and picks the lowest MAE; reports MAE, RMSE, MAPE and MASE. Prediction intervals are empirical quantiles of the absolute backtest errors per horizon step (at least 5 origins required), and the achieved coverage on the backtest is reported next to the nominal level. |
| `outlier.robust_distance` | Per feature, a median/MAD robust z-score within an optional `group_by` (e.g. procedure); the record's score is the RMS of feature scores; each flagged record carries the per-feature contributions. |
| `cluster.kmeans` | Features standardized; seeded k-means++ initialization (`seed`, deterministic PRNG), `n_init` restarts, canonical row order, clusters relabelled by size; silhouette on a deterministic sample of at most 2,000 rows; per-cluster centroids and sizes. Clusters stay **unnamed** until a person names them (`POST /analytics/analyses/:id/review`). |

Every outcome has a status: `succeeded`, `insufficient_data` (e.g. fewer than `min_history` points), `unsupported_input` (truncated result, too many rows or points, memory estimate above the limit, duplicate periods), `invalid_configuration`, `algorithm_failure`, `cancelled`, `stale_schema` — never a silent partial result. Missing periods are handled explicitly (`missing`: `skip`, `zero` or `interpolate`) and counted. Each result carries its limitations (for example: a rolling baseline flags a level shift once and then adopts it; intervals are empirical and their coverage is not independently validated).

**Forecast evaluation methodology.** Accuracy is only claimed as measured: for each candidate method the series is cut at the last `backtest_origins` origins, the method is fitted on the data before each origin and scored on the next `horizon` points; MAE, RMSE, MAPE (when no actual is zero) and MASE (scaled by the in-sample one-step naive error before the first origin) are computed over all origins. `forecast.auto` selects by MAE and reports all metrics for the chosen method. Scenario S2 checks this on held-out weeks the forecast never saw: the reported backtest errors are compared with the errors actually observed on the held-out data.

**Limits.** `ANALYSIS_MAX_ROWS` (5,000), `ANALYSIS_MAX_POINTS` (5,000), `ANALYSIS_MAX_FEATURES` (20), `ANALYSIS_MAX_HORIZON` (104), `ANALYSIS_MAX_MEMORY_MB` (256, an up-front estimate), `ANALYSIS_TIMEOUT_MS` (10,000: checked between k-means iterations; a result produced after the limit by any algorithm is discarded as `algorithm_failure`). A truncated query result is never analysed.

### Insights

Insights are generated from computed values by templates — each one states the observed value, the expected value or range, the score and threshold, the method and version, and that a statistical deviation does not establish a cause. Each insight stores its **evidence** (the numbers it quotes). No number in an insight is produced by a model.

**Optional model-assisted mode** (`ANALYSIS_NARRATOR=anthropic`, off by default; `ANTHROPIC_API_KEY`, `ANALYSIS_NARRATOR_MODEL`): a model may write a short plain-language summary of an insight. It receives only the insight's evidence (never rows), and its text is accepted only if a grounding check passes: every number in it must appear in the evidence, and it must not assert causes, misconduct or certainty. Rejected text is recorded with the reason; the templated insight is always shown. The core demo and every test run without a model.

## 5. Delivery

Destinations (`delivery:manage`) are tenant-level and versioned; a schedule references up to 10. Each has a kind, a `notify_on` rule (`always`, `success`, `failure`, `anomaly`), content (`summary` or `summary_with_csv`), `max_attempts` and an enable switch. There is **one delivery per run and destination** (`UNIQUE (run_id, destination_id)`), and every attempt is appended to `delivery_attempts` (status code, error, duration, payload hash).

Before anything derived from data is sent, the delivery is **re-authorized**: the run identity must still be active, the SQL must still validate for its role, and the redaction of every output column must be unchanged since the snapshot. Otherwise the delivery is `blocked` (and data-free status notices may still go out). `POST /analytics/destinations/:id/test` sends a test message with no query data and reports exactly what happened.

| Kind | What is sent | Security |
|---|---|---|
| `in_app` | A notification per recipient (`$owner` or token names) with kind (`run_succeeded`, `anomaly`, `forecast`, `threshold`, `query_failed`, `analysis_failed`, `delivery_failed`, `authorization`), severity, summary and links | Recipients who could not run the query now get a status-only notice; listing is scoped to the recipient's token |
| `email` | Summary text; optionally the CSV (bounded, redacted) | Provider is configuration, never credentials in the database: `EMAIL_PROVIDER` = `none` (default), `smtp` (`SMTP_URL`: STARTTLS required, `smtps://` implicit TLS, `?tls=none` refused in production), `file` (writes `.eml` files to `EMAIL_OUTBOX_DIR`, for local demos), `test`. `EMAIL_FROM`, `EMAIL_ALLOWED_DOMAINS`. Header injection (CR/LF) refused; SMTP dot-stuffing |
| `webhook` | JSON `clearline.analytics.delivery/v1`: event (`run.succeeded`, `run.anomaly`, `run.failed`, `run.denied`), run, query, insights, links; rows only with `include_rows` (≤ `DELIVERY_MAX_ROWS`, ≤ `DELIVERY_MAX_BYTES`) | HTTPS only. Every resolved address is checked and the connection is pinned to it (no DNS rebinding); private, loopback, link-local, CGNAT, ULA, multicast, documentation and IPv4-mapped/NAT64 forms refused; redirects not followed; `DELIVERY_TIMEOUT_MS`. Signed: `Clearline-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`; `Clearline-Delivery` is stable across retries (for receiver de-duplication). Secrets are server environment references: `WEBHOOK_SECRET_<REF>` (signing), optional `WEBHOOK_AUTH_<REF>` (Authorization header); the API shows only whether they are configured |
| `export` | A CSV of the snapshot, downloadable until `EXPORT_EXPIRY_HOURS` | Download (`GET /analytics/exports/:id/download`) is re-authorized for the **downloader's** role (re-masked or refused) and audited |

Transient failures (timeouts, 5xx, 429, SMTP 4xx) are retried with exponential backoff (`DELIVERY_RETRY_BASE_MS` to `DELIVERY_RETRY_MAX_MS`) up to `max_attempts`; permanent failures (4xx, invalid recipient, missing secret, blocked address) stop at once.

## 6. Native client

The desktop client has five views for this subsystem (see [ADR 0013](adr/0013-native-client.md) for the architecture):

- **Saved queries** (library): search, scope (all, mine, shared, favorites, archived), sort (recently changed, recently used, name, last run); details with purpose, original request, output schema, recent runs; *Run now*, *Preview* with parameter inputs, favorite, duplicate, archive; the **SQL and versions** tab (edit SQL and parameter declarations, save a new version, version history); the **Schedules** tab (schedules with recurrence, next run, identity, actions, and the **schedule editor**: frequency, interval, local time, weekdays, month day, start/end, time zone, run-as role limited to delegable roles, destinations, server preview of the next occurrences); the **Analyses** tab (**analysis builder**: type, algorithm, time column, grain, metrics or features restricted to permitted numeric columns, parameters, server-side validation, add/remove as a new version).
- **Run** view: outcome per phase, timings, insights (first three, expandable), each analysis with its charts (series with expected band and anomaly markers; history and forecast with interval band), method, backtest metrics, limitations; cluster naming; deliveries with retry; the result snapshot in the grid. It polls while a run is active.
- **Run history**, **Notifications** (unread badge in the navigation; opening one opens its run) and **Delivery** (destinations, test delivery, enable/disable).

Saving from the query workspace (*Save as…* on a validated proposal) opens the new query in the library. All requests run off the UI thread.

## 7. Audit, metrics and operations

Audit events (values are never written — ids, hashes, counts, column names and codes only): `saved_query.create|version|update|share|duplicate|enable|disable|archive`, `schedule.create|update|pause|resume|cancel|run_now`, `schedule.occurrence`, `run.request|finish|denied|retry_scheduled|recover|rerun|cancel`, `analysis.run`, `analysis.review`, `delivery.attempt|retry|recover`, `destination.create|update|test`, `export.download`, plus the query workspace's `query.execution.*` events for each run. Favorites and read markers are per-token preferences and are not audited. All events of a run share its correlation id (`GET /audit?correlation_id=…`).

Metrics: `clearline_analytics_runs_total{status,trigger}`, `clearline_analytics_run_seconds`, `clearline_analytics_runs_active`, `clearline_analytics_oldest_due_seconds` (scheduler lag), `clearline_deliveries{status}`, `clearline_delivery_attempts_total{kind,outcome}`, `clearline_schedules_needing_attention`. Alerting suggestions and procedures are in the [runbook](runbook.md#saved-analytics).

## 8. Known limitations

- Recurrence supports the RRULE subset above (no `BYSETPOS`, `COUNT` or multiple times per day other than hourly).
- Analyses run inside the worker process (bounded by the caps above), not in a separate sandbox; a pathological input is limited by row and point caps, the memory estimate and the run lease rather than by process isolation.
- Email uses a minimal built-in SMTP client (no DKIM signing, no OAuth SMTP); webhook receivers must verify signatures themselves.
- The model-assisted narrator has been exercised with a stub provider in tests; a live provider call was not run in this repository's CI.
- Exports and snapshots are stored in PostgreSQL (bounded by the limits), not in object storage.
