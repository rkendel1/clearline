-- Clearline platform schema, migration 0001.
-- Platform-owned tables live in schema "core". Tenant canonical tables are
-- generated from contracts into per-tenant schemas (t_<tenant>) and are NOT
-- created here.

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS reporting;

-- Group role for the application service. Row-level security policies grant
-- tenant-scoped visibility only to members of this role, and only when the
-- transaction has declared its tenant (app.tenant_id) or system scope.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clearline_service') THEN
    CREATE ROLE clearline_service NOLOGIN;
  END IF;
END $$;
GRANT clearline_service TO CURRENT_USER;

CREATE TABLE core.tenants (
  id            text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  retention     jsonb NOT NULL DEFAULT '{}'::jsonb,
  reporting_role text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL
);

-- Maps database login/group roles used by BI tools to exactly one tenant.
CREATE TABLE core.reporting_roles (
  role_name  text PRIMARY KEY,
  tenant_id  text NOT NULL REFERENCES core.tenants(id)
);

-- SECURITY DEFINER (so BI roles need no access to the mapping table); the caller's
-- identity is passed in explicitly because current_user inside is the owner.
CREATE OR REPLACE FUNCTION core.reporting_tenant(who name) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = core, pg_temp AS $$
  -- USAGE (not MEMBER): the service role that created the reporting roles holds
  -- non-inheriting admin membership in them (PG16+), which must not grant visibility.
  -- A role mapped to more than one tenant sees none (fail closed).
  SELECT CASE WHEN pg_has_role(who, 'clearline_service', 'MEMBER') THEN NULL
              WHEN count(*) = 1 THEN min(r.tenant_id) END
  FROM core.reporting_roles r
  WHERE pg_has_role(who, r.role_name, 'USAGE')
$$;

-- Visibility predicate shared by every tenant-scoped core table.
CREATE OR REPLACE FUNCTION core.can_see_tenant(t text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT
    (pg_has_role(current_user, 'clearline_service', 'MEMBER') AND (
        t = nullif(current_setting('app.tenant_id', true), '')
        OR current_setting('app.scope', true) = 'system'))
    OR t = core.reporting_tenant(current_user)
$$;

CREATE TABLE core.api_tokens (
  id          bigserial PRIMARY KEY,
  token_hash  text NOT NULL UNIQUE,
  name        text NOT NULL,
  tenant_id   text REFERENCES core.tenants(id),
  role        text NOT NULL CHECK (role IN ('platform_admin','admin','operator','reporter')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  CHECK ((role = 'platform_admin') = (tenant_id IS NULL))
);

CREATE TABLE core.contract_versions (
  id                bigserial PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES core.tenants(id),
  contract_id       text NOT NULL,
  version           text NOT NULL,
  lifecycle         text NOT NULL CHECK (lifecycle IN ('pending_approval','active','superseded','rejected','rolled_back')),
  document          jsonb NOT NULL,
  document_hash     text NOT NULL,
  transform_version text NOT NULL,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  activated_at      timestamptz,
  UNIQUE (tenant_id, version)
);
CREATE UNIQUE INDEX contract_one_active ON core.contract_versions (tenant_id) WHERE lifecycle = 'active';

CREATE TABLE core.contract_migrations (
  id               bigserial PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES core.tenants(id),
  from_version_id  bigint REFERENCES core.contract_versions(id),
  to_version_id    bigint NOT NULL REFERENCES core.contract_versions(id),
  classification   text NOT NULL CHECK (classification IN ('initial','compatible','requires_approval','rejected')),
  status           text NOT NULL CHECK (status IN ('planned','applied','rejected','failed','rolled_back')),
  plan             jsonb NOT NULL,
  requested_by     text NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  approved_by      text,
  approved_at      timestamptz,
  applied_at       timestamptz,
  rolled_back_at   timestamptz,
  error            text
);

CREATE TABLE core.batches (
  id                    uuid PRIMARY KEY,
  tenant_id             text NOT NULL REFERENCES core.tenants(id),
  source_id             text NOT NULL,
  entity                text NOT NULL,
  contract_version_id   bigint NOT NULL REFERENCES core.contract_versions(id),
  transform_version     text NOT NULL,
  format                text NOT NULL CHECK (format IN ('csv','json')),
  payload_digest        text NOT NULL,
  byte_size             bigint NOT NULL,
  arrival_at            timestamptz NOT NULL DEFAULT now(),
  source_reported_at    timestamptz,
  is_late               boolean NOT NULL DEFAULT false,
  control               jsonb,
  status                text NOT NULL CHECK (status IN ('rejected','queued','processing','completed','completed_with_exceptions','failed')),
  attempt_count         int NOT NULL DEFAULT 0,
  max_attempts          int NOT NULL DEFAULT 3,
  lease_owner           text,
  lease_expires_at      timestamptz,
  received_count        int NOT NULL DEFAULT 0,
  accepted_count        int,
  quarantined_count     int,
  duplicate_count       int,
  late_record_count     int,
  correction_count      int,
  conflict_count        int,
  structural_error_count int,
  business_error_count  int,
  warning_count         int,
  quality_status        text CHECK (quality_status IN ('passed','warning','failed')),
  reconciliation_status text CHECK (reconciliation_status IN ('passed','failed')),
  trust_status          text NOT NULL DEFAULT 'pending' CHECK (trust_status IN ('pending','trusted','untrusted')),
  trust_reasons         jsonb NOT NULL DEFAULT '[]'::jsonb,
  structural_rejection  jsonb,
  started_at            timestamptz,
  completed_at          timestamptz,
  failed_at             timestamptz,
  failure               jsonb,
  submitted_by          text NOT NULL,
  correlation_id        text NOT NULL,
  UNIQUE (tenant_id, source_id, payload_digest)
);
CREATE INDEX batches_queue ON core.batches (status, arrival_at) WHERE status IN ('queued','processing');
CREATE INDEX batches_tenant_time ON core.batches (tenant_id, arrival_at DESC);

CREATE TABLE core.batch_submissions (
  id             bigserial PRIMARY KEY,
  tenant_id      text NOT NULL,
  batch_id       uuid NOT NULL REFERENCES core.batches(id),
  outcome        text NOT NULL CHECK (outcome IN ('accepted','duplicate','rejected')),
  submitted_by   text NOT NULL,
  submitted_at   timestamptz NOT NULL DEFAULT now(),
  correlation_id text NOT NULL
);

CREATE TABLE core.batch_attempts (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  batch_id    uuid NOT NULL REFERENCES core.batches(id),
  attempt     int NOT NULL,
  worker_id   text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  outcome     text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running','succeeded','failed','abandoned','interrupted')),
  error       jsonb,
  UNIQUE (batch_id, attempt)
);

CREATE TABLE core.raw_records (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  batch_id    uuid NOT NULL REFERENCES core.batches(id) ON DELETE CASCADE,
  row_number  int NOT NULL,
  payload     jsonb,                 -- nulled by retention purge / erasure
  row_hash    text NOT NULL,
  parse_error text,                  -- row-level structural problem found by the adapter
  disposition text CHECK (disposition IN ('accepted','accepted_late','quarantined','duplicate')),
  canonical_record_id bigint,        -- the canonical version this row produced (or duplicated)
  purged_at   timestamptz,
  UNIQUE (batch_id, row_number)
);

CREATE TABLE core.quarantine (
  id             bigserial PRIMARY KEY,
  tenant_id      text NOT NULL,
  batch_id       uuid NOT NULL REFERENCES core.batches(id) ON DELETE CASCADE,
  raw_record_id  bigint NOT NULL REFERENCES core.raw_records(id) ON DELETE CASCADE,
  entity         text NOT NULL,
  record_key     text,
  category       text NOT NULL CHECK (category IN ('structural','business_rule','referential','conflict','privacy')),
  errors         jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz,
  resolved_by    text,
  resolution     text
);
CREATE INDEX quarantine_batch ON core.quarantine (batch_id);
CREATE INDEX quarantine_open ON core.quarantine (tenant_id, status);

CREATE TABLE core.quality_results (
  id                  bigserial PRIMARY KEY,
  tenant_id           text NOT NULL,
  batch_id            uuid NOT NULL REFERENCES core.batches(id) ON DELETE CASCADE,
  attempt             int NOT NULL,
  contract_version_id bigint NOT NULL,
  rule_id             text NOT NULL,
  rule_kind           text NOT NULL,
  category            text NOT NULL,
  severity            text NOT NULL CHECK (severity IN ('error','warning','info')),
  evaluated_count     int NOT NULL,
  failed_count        int NOT NULL,
  description         text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quality_results_batch ON core.quality_results (batch_id);

-- One row per (record, rule) failure: "which records were affected".
CREATE TABLE core.quality_findings (
  id             bigserial PRIMARY KEY,
  tenant_id      text NOT NULL,
  batch_id       uuid NOT NULL REFERENCES core.batches(id) ON DELETE CASCADE,
  raw_record_id  bigint NOT NULL REFERENCES core.raw_records(id) ON DELETE CASCADE,
  rule_id        text NOT NULL,
  severity       text NOT NULL,
  category       text NOT NULL,
  field          text,
  message        text NOT NULL
);
CREATE INDEX quality_findings_batch ON core.quality_findings (batch_id, rule_id);
CREATE INDEX quality_findings_raw ON core.quality_findings (raw_record_id);

CREATE TABLE core.reconciliation_results (
  id                  bigserial PRIMARY KEY,
  tenant_id           text NOT NULL,
  batch_id            uuid REFERENCES core.batches(id) ON DELETE CASCADE,
  run_id              text NOT NULL,
  scope               text NOT NULL CHECK (scope IN ('batch','dataset')),
  check_id            text NOT NULL,
  status              text NOT NULL CHECK (status IN ('passed','failed')),
  expected            jsonb,
  actual              jsonb,
  difference          jsonb,
  explanation         text NOT NULL,
  contract_version_id bigint NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recon_batch ON core.reconciliation_results (batch_id);
CREATE INDEX recon_tenant ON core.reconciliation_results (tenant_id, created_at DESC);

CREATE TABLE core.audit_events (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  tenant_id      text,
  actor          text NOT NULL,
  role           text,
  action         text NOT NULL,
  resource       text,
  outcome        text NOT NULL CHECK (outcome IN ('allowed','denied','succeeded','failed')),
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text
);
CREATE INDEX audit_tenant_time ON core.audit_events (tenant_id, at DESC);

CREATE OR REPLACE FUNCTION core.audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.audit_retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP;
END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON core.audit_events
  FOR EACH ROW EXECUTE FUNCTION core.audit_append_only();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON core.audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION core.audit_append_only();

CREATE TABLE core.export_log (
  id                  uuid PRIMARY KEY,
  tenant_id           text NOT NULL,
  extract_id          text NOT NULL,
  contract_version_id bigint NOT NULL,
  requested_by        text NOT NULL,
  role                text NOT NULL,
  params              jsonb NOT NULL,
  as_of               timestamptz NOT NULL,
  row_count           int NOT NULL,
  content_sha256      text NOT NULL,
  record_refs         jsonb NOT NULL,   -- [[entity, record_id], ...] for lineage
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.erasure_log (
  id            bigserial PRIMARY KEY,
  tenant_id     text NOT NULL,
  entity        text NOT NULL,
  key_sha256    text NOT NULL,
  requested_by  text NOT NULL,
  erased_at     timestamptz NOT NULL DEFAULT now(),
  counts        jsonb NOT NULL,
  affected_exports jsonb NOT NULL
);

-- Legitimate post-load removals (subject erasure, retention of superseded versions)
-- recorded per batch so re-verification can tell them apart from drift.
CREATE TABLE core.batch_adjustments (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  batch_id    uuid NOT NULL REFERENCES core.batches(id) ON DELETE CASCADE,
  reason      text NOT NULL,
  rows_removed int NOT NULL,
  sums_removed jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE core.worker_heartbeats (
  worker_id     text PRIMARY KEY,
  hostname      text NOT NULL,
  started_at    timestamptz NOT NULL,
  last_seen     timestamptz NOT NULL,
  current_batch uuid,
  state         text NOT NULL
);

-- Row-level security: defence in depth behind the application's own tenant checks.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_tokens','contract_versions','contract_migrations','batches','batch_submissions',
    'batch_attempts','raw_records','quarantine','quality_results','quality_findings','reconciliation_results',
    'export_log','erasure_log','batch_adjustments'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

CREATE POLICY tenant_isolation ON core.contract_versions USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id));
CREATE POLICY tenant_isolation ON core.contract_migrations USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id));
CREATE POLICY tenant_isolation ON core.batches USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id));
CREATE POLICY tenant_isolation ON core.batch_submissions USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id));
CREATE POLICY tenant_isolation ON core.batch_attempts USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id));
CREATE POLICY tenant_isolation ON core.raw_records USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id));
CREATE POLICY tenant_isolation ON core.quarantine USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id));
CREATE POLICY tenant_isolation ON core.quality_results USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id));
CREATE POLICY tenant_isolation ON core.quality_findings USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id));
CREATE POLICY tenant_isolation ON core.reconciliation_results USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id));
CREATE POLICY tenant_isolation ON core.export_log USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id));
CREATE POLICY tenant_isolation ON core.batch_adjustments USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id));
CREATE POLICY tenant_isolation ON core.erasure_log USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id));
-- Token lookup happens before a tenant is known, so authentication runs in system scope only.
CREATE POLICY system_only ON core.api_tokens USING (current_setting('app.scope', true) = 'system') WITH CHECK (current_setting('app.scope', true) = 'system');

-- Read-only reporting views. Views run with the owner's privileges, but the RLS
-- policy above evaluates core.reporting_tenant() for the *session* user, so a
-- BI role mapped to tenant A only ever sees tenant A rows.
CREATE VIEW reporting.batch_overview AS
SELECT b.tenant_id, b.id AS batch_id, b.source_id, b.entity, cv.version AS contract_version, b.transform_version,
       b.arrival_at, b.source_reported_at, b.is_late, b.status AS pipeline_status, b.attempt_count,
       b.received_count, b.accepted_count, b.quarantined_count, b.duplicate_count, b.late_record_count,
       b.correction_count, b.conflict_count, b.quality_status, b.reconciliation_status, b.trust_status,
       b.started_at, b.completed_at,
       EXTRACT(EPOCH FROM (b.completed_at - b.arrival_at)) AS end_to_end_seconds
FROM core.batches b JOIN core.contract_versions cv ON cv.id = b.contract_version_id;

CREATE VIEW reporting.quality_overview AS
SELECT q.tenant_id, q.batch_id, b.source_id, q.rule_id, q.rule_kind, q.category, q.severity,
       q.evaluated_count, q.failed_count, cv.version AS contract_version, q.attempt, q.created_at
FROM core.quality_results q
JOIN core.batches b ON b.id = q.batch_id
JOIN core.contract_versions cv ON cv.id = q.contract_version_id;

CREATE VIEW reporting.reconciliation_overview AS
SELECT r.tenant_id, r.batch_id, r.scope, r.check_id, r.status, r.expected, r.actual, r.difference,
       r.explanation, r.run_id, r.created_at
FROM core.reconciliation_results r;

CREATE VIEW reporting.exceptions AS
SELECT q.tenant_id, q.batch_id, b.source_id, q.entity, q.record_key, q.category, q.status,
       r.row_number AS source_row, q.errors, q.created_at
FROM core.quarantine q JOIN core.batches b ON b.id = q.batch_id JOIN core.raw_records r ON r.id = q.raw_record_id;
