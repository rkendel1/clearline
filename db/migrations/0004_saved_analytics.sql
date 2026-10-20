-- Clearline platform schema, migration 0004: saved analytics. Saved, versioned
-- queries; durable schedules and runs; ML analysis runs and insights; delivery
-- destinations, deliveries and their attempts; in-app notifications; expiring
-- CSV exports. See docs/saved-analytics.md.
--
-- Conventions as before: every table is tenant-scoped with row-level security,
-- histories are append-only, and nothing here is an authorization grant: every
-- execution and delivery re-checks identity and the current field policy.

-- 1. Saved queries. Metadata lives on the query; SQL, parameters, the expected
--    output schema and the analysis configuration live on immutable versions.
CREATE TABLE core.saved_queries (
  id               uuid PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES core.tenants(id),
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description      text,
  purpose          text,
  category         text,
  business_owner   text,
  tags             text[] NOT NULL DEFAULT '{}',
  owner_actor      text NOT NULL,
  owner_role       text NOT NULL,
  sharing          text NOT NULL DEFAULT 'private' CHECK (sharing IN ('private','tenant')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','archived')),
  current_version  int NOT NULL,
  duplicated_from  uuid REFERENCES core.saved_queries(id),
  needs_revalidation text,              -- set when an execution saw an output schema different from the saved one
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by       text NOT NULL
);
CREATE UNIQUE INDEX saved_queries_name ON core.saved_queries (tenant_id, lower(name)) WHERE status <> 'archived';
CREATE INDEX saved_queries_tenant ON core.saved_queries (tenant_id, updated_at DESC);

CREATE TABLE core.saved_query_versions (
  tenant_id          text NOT NULL REFERENCES core.tenants(id),
  query_id           uuid NOT NULL REFERENCES core.saved_queries(id),
  version            int NOT NULL CHECK (version >= 1),
  sql                text NOT NULL,
  sql_sha256         text NOT NULL,
  question           text,
  source_proposal_id uuid REFERENCES core.query_proposals(id),
  parameters         jsonb NOT NULL DEFAULT '[]'::jsonb,
  output_schema      jsonb,             -- [{name, type, masked, sensitive}] observed when the version was saved
  analyses           jsonb NOT NULL DEFAULT '[]'::jsonb,
  change_note        text,
  created_by         text NOT NULL,
  created_role       text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (query_id, version)
);
CREATE TRIGGER saved_query_versions_append_only BEFORE UPDATE OR DELETE ON core.saved_query_versions
  FOR EACH ROW EXECUTE FUNCTION core.audit_append_only();

CREATE TABLE core.saved_query_favorites (
  tenant_id  text NOT NULL REFERENCES core.tenants(id),
  query_id   uuid NOT NULL REFERENCES core.saved_queries(id),
  actor      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (query_id, actor)
);

-- 2. Delivery destinations (tenant-wide, managed by delivery:manage). Secrets are
--    never stored: a webhook names an environment-provided secret by reference.
CREATE TABLE core.delivery_destinations (
  id           uuid PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES core.tenants(id),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  kind         text NOT NULL CHECK (kind IN ('in_app','email','webhook','export')),
  config       jsonb NOT NULL,
  content      text NOT NULL DEFAULT 'summary' CHECK (content IN ('summary','summary_with_csv')),
  notify_on    text NOT NULL DEFAULT 'always' CHECK (notify_on IN ('always','success','failure','anomaly')),
  enabled      boolean NOT NULL DEFAULT true,
  max_attempts int NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  version      int NOT NULL DEFAULT 1,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by   text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX delivery_destinations_name ON core.delivery_destinations (tenant_id, lower(name));

-- 3. Schedules. Recurrence is an RFC 5545 RRULE subset evaluated in an IANA time
--    zone from a local wall-clock start (src/analytics/recurrence.ts); NULL rrule
--    means "once at start_local". The schedule runs AS an explicit identity: an
--    existing API token name plus a role that token may delegate, both re-checked
--    on every run.
CREATE TABLE core.schedules (
  id              uuid PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES core.tenants(id),
  query_id        uuid NOT NULL REFERENCES core.saved_queries(id),
  name            text NOT NULL,
  pinned_version  int,                  -- NULL: run the saved query's current version
  rrule           text,
  start_local     text NOT NULL CHECK (start_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  timezone        text NOT NULL,
  until_local     text CHECK (until_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  parameters      jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_as_actor    text NOT NULL,
  run_as_role     text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled','completed')),
  next_run_at     timestamptz,
  last_run_id     uuid,
  attention       text,                 -- why the last run could not proceed (e.g. the identity lost access)
  max_attempts    int NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  destination_ids uuid[] NOT NULL DEFAULT '{}',
  version         int NOT NULL DEFAULT 1,
  created_by      text NOT NULL,
  created_role    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by      text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX schedules_due ON core.schedules (next_run_at) WHERE status = 'active';
CREATE INDEX schedules_query ON core.schedules (query_id);

-- 4. Runs: one per schedule occurrence (idempotent: UNIQUE (schedule_id, occurrence_at))
--    or manual request. Query, analysis and delivery outcomes are recorded separately so
--    a successful query followed by a failed delivery is never reported as delivered.
CREATE TABLE core.analytics_runs (
  id               uuid PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES core.tenants(id),
  query_id         uuid NOT NULL REFERENCES core.saved_queries(id),
  query_version    int NOT NULL,
  schedule_id      uuid REFERENCES core.schedules(id),
  occurrence_at    timestamptz,
  trigger          text NOT NULL CHECK (trigger IN ('schedule','manual')),
  requested_by     text NOT NULL,
  run_as_actor     text NOT NULL,
  run_as_role      text NOT NULL,
  parameters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  destination_ids  uuid[] NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','delivering','succeeded','failed','denied','cancelled')),
  query_status     text NOT NULL DEFAULT 'pending' CHECK (query_status IN ('pending','succeeded','failed','denied','timed_out','skipped')),
  analysis_status  text NOT NULL DEFAULT 'pending' CHECK (analysis_status IN ('pending','succeeded','partial','failed','skipped','not_configured')),
  delivery_status  text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','delivered','partial','failed','blocked','none')),
  failure_class    text CHECK (failure_class IN ('authorization','validation','query','timeout','resource_limit','result_persistence','analysis','delivery','interrupted','internal')),
  error_code       text,
  error_message    text,
  attempt          int NOT NULL DEFAULT 0,
  max_attempts     int NOT NULL DEFAULT 3,
  next_attempt_at  timestamptz,
  lease_owner      text,
  lease_expires_at timestamptz,
  execution_id     uuid,
  result_meta      jsonb,
  timings          jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_epoch     bigint,
  missed_occurrences int NOT NULL DEFAULT 0,
  correlation_id   text,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at       timestamptz,
  finished_at      timestamptz,
  UNIQUE (schedule_id, occurrence_at)
);
CREATE INDEX analytics_runs_claim ON core.analytics_runs (next_attempt_at) WHERE status = 'queued';
CREATE INDEX analytics_runs_query ON core.analytics_runs (query_id, created_at DESC);
CREATE INDEX analytics_runs_tenant ON core.analytics_runs (tenant_id, created_at DESC);

-- Executions of saved queries are recorded alongside workspace executions.
ALTER TABLE core.query_executions ALTER COLUMN proposal_id DROP NOT NULL;
ALTER TABLE core.query_executions ADD COLUMN saved_query_id uuid REFERENCES core.saved_queries(id);
ALTER TABLE core.query_executions ADD COLUMN saved_query_version int;
ALTER TABLE core.query_executions ADD COLUMN run_id uuid REFERENCES core.analytics_runs(id);
ALTER TABLE core.query_executions ADD CONSTRAINT query_executions_origin CHECK (proposal_id IS NOT NULL OR saved_query_id IS NOT NULL);

-- Bounded result snapshot of a run (already redacted for the run identity), kept
-- only so analyses and delivery retries do not re-run the query. Purged at expires_at.
CREATE TABLE core.run_results (
  run_id     uuid PRIMARY KEY REFERENCES core.analytics_runs(id),
  tenant_id  text NOT NULL REFERENCES core.tenants(id),
  columns    jsonb NOT NULL,
  rows       jsonb NOT NULL,
  row_count  int NOT NULL,
  truncated  boolean NOT NULL,
  bytes      int NOT NULL,
  sha256     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);

-- 5. ML analyses and insights. Results are bounded summaries, never the input dataset.
CREATE TABLE core.analysis_runs (
  id                uuid PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES core.tenants(id),
  run_id            uuid NOT NULL REFERENCES core.analytics_runs(id),
  query_id          uuid NOT NULL REFERENCES core.saved_queries(id),
  query_version     int NOT NULL,
  analysis_key      text NOT NULL,
  analysis_type     text NOT NULL CHECK (analysis_type IN ('anomaly','forecast','outlier','cluster')),
  algorithm         text NOT NULL,
  algorithm_version text NOT NULL,
  config            jsonb NOT NULL,
  status            text NOT NULL CHECK (status IN ('succeeded','insufficient_data','unsupported_input','invalid_configuration','algorithm_failure','cancelled','stale_schema')),
  message           text,
  result            jsonb,
  quality           jsonb,
  input_rows        int,
  timings           jsonb NOT NULL DEFAULT '{}'::jsonb,
  review            jsonb,              -- user-reviewed names for clusters (until then they are unnamed)
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, analysis_key)
);
CREATE INDEX analysis_runs_query ON core.analysis_runs (query_id, created_at DESC);

CREATE TABLE core.insights (
  id              uuid PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES core.tenants(id),
  run_id          uuid NOT NULL REFERENCES core.analytics_runs(id),
  analysis_run_id uuid REFERENCES core.analysis_runs(id),
  query_id        uuid NOT NULL REFERENCES core.saved_queries(id),
  kind            text NOT NULL CHECK (kind IN ('anomaly','forecast','outlier','segment','status')),
  severity        text NOT NULL CHECK (severity IN ('info','low','medium','high')),
  metric          text,
  title           text NOT NULL,
  body            text NOT NULL,        -- generated from computed values by a template; authoritative
  narrative       jsonb,                -- optional model-written summary, accepted only if grounded in the evidence
  evidence        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX insights_run ON core.insights (run_id);
CREATE INDEX insights_query ON core.insights (query_id, created_at DESC);

-- 6. Deliveries: exactly one row per (run, destination); attempts are append-only.
CREATE TABLE core.deliveries (
  id                  uuid PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES core.tenants(id),
  run_id              uuid NOT NULL REFERENCES core.analytics_runs(id),
  destination_id      uuid NOT NULL REFERENCES core.delivery_destinations(id),
  destination_version int NOT NULL,
  kind                text NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','delivered','retrying','failed','blocked','skipped')),
  attempts            int NOT NULL DEFAULT 0,
  max_attempts        int NOT NULL,
  next_attempt_at     timestamptz,
  lease_owner         text,
  lease_expires_at    timestamptz,
  last_error_code     text,
  last_error          text,
  delivered_at        timestamptz,
  payload_sha256      text,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, destination_id)
);
CREATE INDEX deliveries_claim ON core.deliveries (next_attempt_at) WHERE status IN ('pending','retrying');

CREATE TABLE core.delivery_attempts (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES core.tenants(id),
  delivery_id uuid NOT NULL REFERENCES core.deliveries(id),
  attempt     int NOT NULL,
  outcome     text NOT NULL CHECK (outcome IN ('delivered','transient_failure','permanent_failure','blocked')),
  status_code int,
  error_code  text,
  error       text,
  duration_ms int,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (delivery_id, attempt)
);
CREATE TRIGGER delivery_attempts_append_only BEFORE UPDATE OR DELETE ON core.delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION core.audit_append_only();

-- 7. In-app notifications (per recipient token name) and expiring exports.
CREATE TABLE core.notifications (
  id             uuid PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES core.tenants(id),
  recipient      text NOT NULL,
  run_id         uuid REFERENCES core.analytics_runs(id),
  delivery_id    uuid REFERENCES core.deliveries(id),
  query_id       uuid REFERENCES core.saved_queries(id),
  kind           text NOT NULL CHECK (kind IN ('run_succeeded','anomaly','forecast','threshold','query_failed','analysis_failed','delivery_failed','authorization','test')),
  severity       text NOT NULL CHECK (severity IN ('info','low','medium','high')),
  title          text NOT NULL,
  body           text NOT NULL,
  links          jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (delivery_id, recipient)
);
CREATE INDEX notifications_recipient ON core.notifications (tenant_id, recipient, created_at DESC);

CREATE TABLE core.exports (
  id               uuid PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES core.tenants(id),
  run_id           uuid NOT NULL REFERENCES core.analytics_runs(id),
  delivery_id      uuid REFERENCES core.deliveries(id),
  query_id         uuid NOT NULL REFERENCES core.saved_queries(id),
  role             text NOT NULL,       -- the redaction the content was produced under (the run identity's role)
  file_name        text NOT NULL,
  content          bytea,               -- NULL after expiry
  bytes            int NOT NULL,
  row_count        int NOT NULL,
  truncated        boolean NOT NULL,
  sha256           text NOT NULL,
  redacted_columns jsonb NOT NULL,
  downloads        int NOT NULL DEFAULT 0,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['saved_queries','saved_query_versions','saved_query_favorites','delivery_destinations','schedules','analytics_runs',
                           'run_results','analysis_runs','insights','deliveries','delivery_attempts','notifications','exports'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON core.%I USING (core.can_see_tenant(tenant_id)) WITH CHECK (core.can_see_tenant(tenant_id))', t);
  END LOOP;
END $$;
