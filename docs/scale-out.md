# Scale-out design

The first release is a modular monolith on PostgreSQL: the database is the queue, the store and the reporting engine. That is the right default while one database server can hold the data and absorb the write rate, because every added system brings its own failure modes, on-call burden and consistency boundary. This document sets out what to add, **when the evidence says so**, and what each addition costs.

## Where the current design runs out

Measured (see [benchmark.md](benchmark.md)): about 8,000–9,300 canonical rows per second per worker on a 2-vCPU VM with PostgreSQL on the same host, linear in batch size up to 100,000 rows. With four workers, intake from a single sequential client was the bottleneck.

Expected limits, in the order they are likely to bite:

1. **Single-batch transaction size.** A batch is one transaction. Very large files (well beyond the measured 100k rows; the configured cap is 500k) mean long transactions, large WAL bursts and long row locks. *First response:* cap batch size and ask sources to split files (already enforced by `MAX_ROWS_PER_BATCH`). Then process large files as sub-batches with a parent reconciliation record.
2. **Write throughput of one primary.** Many workers contend on one primary's WAL and I/O. *First response:* bigger instance, faster storage, tuned `max_wal_size`/checkpoints, `COPY` instead of multi-row `INSERT`.
3. **Analytical reads competing with ingestion.** Dashboards and extracts run on the same primary. *First response:* read replica for reporting and extracts (lineage needs the primary only for just-committed data).
4. **Per-entity serialization.** Batches for the same tenant entity are serialized by an advisory lock (correctness of corrections and supersession). One very hot entity cannot use more than one worker. *First response:* partition keys into shards with independent locks. This is a real design change to correction semantics, so it needs its own ADR.

## Components and the trigger for each

| Add | Justified when | What it buys | Operational cost it introduces |
|---|---|---|---|
| **Message queue** (SQS, Pub/Sub, RabbitMQ) in place of `SELECT … FOR UPDATE SKIP LOCKED` | Claim latency or lock churn on `core.batches` is measurable at the worker count needed; or batches must fan out to consumers other than the processor; or intake must be decoupled from the database during outages | Independent scaling of intake and processing; buffering when the database is degraded | A second source of truth for "what is pending": queue/DB reconciliation, dead-letter handling, at-least-once **plus** outbox pattern to avoid lost or phantom messages; another system to secure, monitor and pay for |
| **Object storage** for raw payloads (S3/GCS) instead of `core.raw_records.payload` | Raw payload volume dominates database size or backup time | Cheaper retention, lifecycle policies, smaller backups | Two places to erase a subject; consistency between object and row; encryption key management for the bucket |
| **Distributed processing engine** (Spark, Flink, Beam) | Single files routinely exceed what one worker transforms within the latency target **after** sub-batching; or cross-batch transformations (joins across large histories) become required | Parallelism within a batch; large joins | Cluster operations or managed-service cost; a second implementation of transformation semantics that must stay **bit-for-bit identical** to the contract engine (or replace it); much harder per-record lineage and debugging; jobs measured in minutes instead of seconds |
| **Warehouse / lakehouse** (BigQuery, Snowflake, Redshift, Delta/Iceberg) for serving | Reporting queries over full history slow down ingestion even with a replica; data volume outgrows one Postgres; many BI consumers need governed SQL access | Elastic analytical compute; columnar storage; separation of serving from processing | A replication pipeline with its own freshness and reconciliation (it becomes a *source* that must be reconciled against Postgres); duplicated access controls and masking policies, so RLS and redaction must be re-implemented and re-tested there; cost governance |
| **Workflow orchestrator** (Airflow, Dagster, Temporal) | Processing becomes a multi-step DAG across systems (land → transform → publish to warehouse → notify), with cross-step retries, backfills and schedules that a single worker transaction no longer covers | Visible DAGs, backfills, schedule management | A scheduler and metadata DB to run; split between orchestrator state and platform state (batch status must remain the source of truth for trust); more places for partial failure, so "completed" vs "trusted" must be enforced across steps |
| **Horizontal API scale** | CPU-bound on request handling (CSV parsing in intake is the hot path) | Throughput of submissions | None material: the API is stateless; add instances behind the load balancer |
| **More worker processes** | Queue age (`clearline_oldest_queued_seconds`) grows while the database still has headroom | Parallel batches across entities/tenants | Database connections (`DB_POOL_SIZE` × processes); contention if work is concentrated on one entity |
| **Kubernetes** | Many services and environments to operate uniformly, autoscaling on custom metrics, platform team in place | Uniform deployment, autoscaling | Cluster lifecycle, networking and policy, upgrades. Not justified for two stateless services and a managed database. |

## What must not change when scaling

Any of the above must preserve these invariants, each covered by an automated scenario today:

- One trusted outcome per batch, decided only after reconciliation (Scenarios A, I).
- No partial effects from failed or interrupted processing (F).
- No duplicate business effects from redelivery (C).
- Deterministic, contract-versioned transformation with per-record lineage (A, B, E, H).
- Tenant isolation and redaction in every serving store (G). **A warehouse copy is a new place this must be proven.**
- Dashboard numbers equal independently computed numbers (J).

Keep the scenario suite as the acceptance gate for any architectural change: if a new component cannot pass A–J, it is not ready.

## Recommended order

1. Larger instance + `COPY` + read replica for reporting (cheap, no new semantics).
2. Sub-batching for very large files, with parent-level reconciliation.
3. Object storage for raw payloads.
4. Warehouse for serving, fed by change data capture and reconciled back to Postgres.
5. A queue or orchestrator only when 1–4 leave a measured bottleneck in claiming or multi-system coordination.
