# 0015: Durable scheduling in PostgreSQL, executed by the worker

**Context.** Schedules must fire whether or not any client is open, survive restarts, never run the same occurrence twice, and stay bounded when many fall due at once. The platform already uses PostgreSQL as its durable work queue (ADR 0002) and runs a worker process.

**Decision.** Schedules, occurrences, runs, deliveries and attempts are rows. The worker's scheduler materializes due occurrences under `FOR UPDATE SKIP LOCKED` and `UNIQUE (schedule_id, occurrence_at)`, claims runs and deliveries with leases (renewed between phases), recovers expired leases, and limits concurrency per process and per tenant (the latter counted under an advisory lock, so it holds across workers). Recurrence is stored as an RFC 5545 RRULE subset with a wall-clock start and an IANA time zone, with explicit DST rules. Missed occurrences are coalesced: only the latest runs. Phases (query, analysis, delivery) are recorded separately; deliveries retry independently of the query.

**Reasons.** No new infrastructure (no cron daemon, broker or in-memory timer that loses state on restart); every guarantee is a database constraint or a lock that tests can exercise; several workers can run safely. Recording phases separately lets a failed delivery be retried without re-running the query and keeps the run's status honest.

**Costs.** Scheduling resolution is the tick interval (`SCHEDULER_TICK_MS`, 1 s); throughput is bounded by PostgreSQL round trips (the benchmark measures about 14 runs/s per scheduler process for small runs on the test machine); long-running analyses hold a worker slot.

**Revisit when** the number of schedules or the run rate outgrows a single database, or sub-second precision is required.
