-- Clearline platform schema, migration 0003: field-level policy, sensitivity and
-- redaction, and the natural-language query workspace (proposals, executions).

-- 1. Data steward role: classifies fields and tightens redaction; sees no original
--    sensitive values unless a policy explicitly grants it.
ALTER TABLE core.api_tokens DROP CONSTRAINT IF EXISTS api_tokens_role_check;
ALTER TABLE core.api_tokens ADD CONSTRAINT api_tokens_role_check
  CHECK (role IN ('platform_admin','admin','approver','steward','operator','reporter'));

-- 2. Field policies. A row exists only when someone configured the field; absent a
--    row, the policy is derived from the contract's sensitivity classification
--    (src/policy/fields.ts). field = '*' carries table-level role access.
CREATE TABLE core.field_policies (
  tenant_id    text NOT NULL REFERENCES core.tenants(id),
  entity       text NOT NULL,
  field        text NOT NULL,
  sensitive    boolean NOT NULL,
  redaction    text NOT NULL CHECK (redaction IN ('full','last4','first_initial','year_only')),
  reason       text,
  unmask_roles text[] NOT NULL DEFAULT '{}',
  role_access  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- role -> hidden | discover | filter | full
  version      int NOT NULL,
  updated_by   text NOT NULL,
  updated_role text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, entity, field),
  CHECK (field = '*' OR NOT sensitive OR coalesce(length(trim(reason)), 0) > 0)
);

-- Every change, append-only: the version history of each field's policy.
CREATE TABLE core.field_policy_versions (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES core.tenants(id),
  entity       text NOT NULL,
  field        text NOT NULL,
  version      int NOT NULL,
  policy       jsonb NOT NULL,
  previous     jsonb NOT NULL,
  change_kind  text NOT NULL CHECK (change_kind IN ('tighten','loosen','mixed','none')),
  changed_by   text NOT NULL,
  changed_role text NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  correlation_id text,
  UNIQUE (tenant_id, entity, field, version)
);
CREATE TRIGGER field_policy_versions_append_only BEFORE UPDATE OR DELETE ON core.field_policy_versions
  FOR EACH ROW EXECUTE FUNCTION core.audit_append_only();

-- 3. Query proposals: what was asked, what the provider proposed, what the server
--    validated (and the exact rewritten SQL it would run). Model output is stored
--    as an untrusted proposal; validated_sql is produced by the server.
CREATE TABLE core.query_proposals (
  id                   uuid PRIMARY KEY,
  tenant_id            text NOT NULL REFERENCES core.tenants(id),
  actor                text NOT NULL,
  role                 text NOT NULL,
  source               text NOT NULL CHECK (source IN ('generated','edited','manual')),
  parent_id            uuid REFERENCES core.query_proposals(id),
  question             text,
  provider             text,
  model                text,
  proposed_sql         text,
  explanation          text,
  status               text NOT NULL CHECK (status IN ('valid','rejected','generation_failed')),
  validation           jsonb NOT NULL,
  validated_sql        text,
  validated_sql_sha256 text,
  estimate             jsonb,
  policy_epoch         bigint NOT NULL,
  correlation_id       text,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX query_proposals_tenant_time ON core.query_proposals (tenant_id, created_at DESC);

-- Executions record outcomes and result METADATA only; result rows are never stored.
CREATE TABLE core.query_executions (
  id                  uuid PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES core.tenants(id),
  proposal_id         uuid NOT NULL REFERENCES core.query_proposals(id),
  actor               text NOT NULL,
  role                text NOT NULL,
  mode                text NOT NULL CHECK (mode IN ('preview','run','export')),
  executed_sql        text NOT NULL,
  executed_sql_sha256 text NOT NULL,
  status              text NOT NULL CHECK (status IN ('running','succeeded','failed','timed_out','cancelled')),
  row_count           int,
  truncated           boolean,
  duration_ms         int,
  columns             jsonb,
  masked_columns      jsonb,
  error_code          text,
  policy_epoch        bigint NOT NULL,
  correlation_id      text,
  started_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at         timestamptz
);
CREATE INDEX query_executions_proposal ON core.query_executions (proposal_id, started_at DESC);
CREATE INDEX query_executions_tenant_time ON core.query_executions (tenant_id, started_at DESC);

-- Which contract version and policy epoch each tenant's query surface (schema q_<tenant>,
-- its views and per-role column grants) was last generated for.
CREATE TABLE core.query_surfaces (
  tenant_id           text PRIMARY KEY REFERENCES core.tenants(id),
  contract_version_id bigint NOT NULL,
  policy_epoch        bigint NOT NULL,
  generated_at        timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['field_policies','field_policy_versions','query_proposals','query_executions','query_surfaces'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON core.%I USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id))', t);
  END LOOP;
END $$;

-- 4. Redaction inside the database: query results for masked fields are computed
--    here, so original values never leave PostgreSQL for those viewers. The
--    TypeScript twin (src/policy/mask.ts) is checked against this function in tests.
CREATE OR REPLACE FUNCTION core.mask_value(v text, style text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
  SELECT CASE
    WHEN v IS NULL THEN NULL
    WHEN style = 'last4' THEN
      CASE WHEN length(regexp_replace(v, '[^A-Za-z0-9]', '', 'g')) <= 4 THEN regexp_replace(v, '[A-Za-z0-9]', '*', 'g')
           ELSE (SELECT string_agg(CASE WHEN ch ~ '[A-Za-z0-9]' AND rn_from_end > 4 THEN '*' ELSE ch END, '' ORDER BY i)
                   FROM (SELECT i, ch, sum(CASE WHEN ch ~ '[A-Za-z0-9]' THEN 1 ELSE 0 END) OVER (ORDER BY i DESC) AS rn_from_end
                           FROM (SELECT i, substr(v, i, 1) AS ch FROM generate_series(1, length(v)) AS i) chars) ranked) END
    WHEN style = 'first_initial' THEN left(v, 1) || '***'
    WHEN style = 'year_only' THEN CASE WHEN v ~ '^\d{4}' THEN left(v, 4) || '-**-**' ELSE '[redacted]' END
    ELSE '[redacted]'
  END
$$;
