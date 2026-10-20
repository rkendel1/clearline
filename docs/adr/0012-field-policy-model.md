# 0012: Field access and sensitivity are separate policy dimensions, enforced by one server-side resolver

**Context.** The platform redacted contract-classified PII/PHI unless a role held `record:read_sensitive`, with the rule repeated in records, lineage, extracts and the exception report. The query workspace needs finer control: whether a role may discover a field, use it in queries, or see its values, and whether a field is sensitive and how it is redacted.

**Decision.** Two dimensions per field (and per table): *role access* (`hidden < discover < filter < full`) and *sensitivity* (redaction style plus the roles that may see original values). Effective access is role access, then sensitivity, so marking a field sensitive can only lower what anyone receives. Defaults are derived from the contract classification and reproduce the previous rule exactly. Policies are rows in `core.field_policies` with an append-only version history; stewards (new role, `policy:manage`) may only tighten, widening requires `policy:grant` (administrators). One resolver (`FieldViewer`) is used by every read surface, and every change regenerates the database views and grants in the same transaction.

**Reasons.** Discovery, query use and value visibility are genuinely different permissions (a role may join on a member key it may not read). Separating authorization from redaction keeps "make it sensitive" safe to delegate. A single resolver removes the repeated rule that would otherwise drift between surfaces, and database grants mean hidden fields are not readable by query roles at all.

**Costs.** Policies are per tenant and per field; there is no policy language (conditions, attribute-based rules) and no per-user exceptions. Declared business metrics over a field a role may not see in full are withheld rather than recomputed.

**Revisit when** tenants need row-level conditions (e.g. a role limited to one plan) or purpose-based access; that would extend the same resolver and the query role's row-level security.
