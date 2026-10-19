# 0004: Contracts generate typed per-tenant tables

**Context.** Tenants define different canonical models. Options: a generic EAV/JSONB store interpreted at read time, or real typed tables generated from the contract.

**Decision.** Each entity becomes a typed table in schema `t_<tenant>` with system columns for lineage and versioning, plus generated `current_*` and redacted `rpt_*` views. DDL is derived deterministically from validated declarations and limited to additive or widening operations.

**Consequences.** Database types enforce the contract; numeric sums are exact; BI tools see normal tables and views; per-tenant schemas give a natural isolation and grant boundary. Contract changes require planned migrations (Scenario H), which is the point: storage cannot silently drift from meaning. Column drops are never automated, so removed fields leave unused columns behind.
