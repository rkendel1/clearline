# 0005: Declarative, whitelisted transforms; no tenant code

**Context.** Tenants need source-specific normalisation (date formats, implied decimals, code maps). Running tenant-supplied code or regular expressions would create code-execution, ReDoS and non-determinism risks, and would make lineage unverifiable.

**Decision.** A closed set of transform operators, named formats and condition operators, validated by JSON Schema with `additionalProperties: false` and by semantic checks. Unsupported declarations are rejected with a path and reason. Every canonical row records `engine@<version>+contract@<version>#<hash>`.

**Consequences.** Deterministic, auditable transformations; same input + same contract + same engine produce the same hash. Expressiveness is deliberately limited. New needs are met by adding a reviewed operator (and bumping the engine version), not by escape hatches.
