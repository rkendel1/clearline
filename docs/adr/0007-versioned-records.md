# 0007: Versioned canonical records; nothing updates in place

**Context.** Corrections, late data and contract migrations must not silently change the meaning of existing records, and point-in-time results must be reproducible.

**Decision.** Canonical tables are append-only per key: a new version supersedes (`_is_current`), late versions are kept as history (`_is_late`), and migration data operations write new versions tagged `_migration_id` that reference what they superseded. Each version keeps the contract and transform version that produced it. Extracts accept `as_of`.

**Consequences.** Full history and lineage for every key (Scenarios E, H); reproducible extracts by `as_of` + filters (Scenario J); rollback of a migration is a delete of tagged versions. Storage grows with corrections; retention can prune superseded versions after a configurable period (which narrows point-in-time history).
