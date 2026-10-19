# 0008: Tenant isolation in the application and the database

**Context.** Cross-tenant leakage is the most damaging failure for a multi-tenant health data platform. Application checks alone fail open on a single bug.

**Decision.** (1) Every tenant route is authorized against the token's tenant before the handler runs. (2) The authenticated tenant is bound to the request, and `withTenant` refuses any other tenant, so authorization mistakes in a route cannot open another tenant's scope. (3) Every data access runs in a transaction with `app.tenant_id` set, and core tables enforce row-level security keyed on it (or, for BI logins, on their reporting-role mapping). (4) Tenant data lives in per-tenant schemas, and BI roles are granted only their tenant's redacted views.

**Why layer 2 exists.** RLS alone is keyed on the tenant the code *asks for*. During development, a mutation test that deleted the route check showed RLS would have served the requested tenant's rows. Binding the principal's tenant at the request boundary makes the second layer genuinely independent of the first.

**Known gap.** Canonical tables in `t_<tenant>` are not under RLS; the service role can read every tenant schema. Closing it requires per-tenant runtime roles (`SET ROLE` per transaction), which is listed in the threat model and production-readiness report.

**Consequences.** Cross-tenant denial is enforced and audited at two layers for core data and at the SQL layer for BI users (Scenario G).
