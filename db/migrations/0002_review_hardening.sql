-- Clearline platform schema, migration 0002: hardening from independent review.

-- 1. Token provenance: who issued each token. Used to stop an administrator from
--    approving their own breaking migration with a token they (transitively) minted.
ALTER TABLE core.api_tokens ADD COLUMN issued_by_token_id bigint REFERENCES core.api_tokens(id);
ALTER TABLE core.api_tokens ADD COLUMN issued_by text;

-- 2. The audit trail enforces its own retention floor. Deletion is possible only
--    inside a retention run AND only for rows older than the tenant's audit_days
--    (default 2555). UPDATE and TRUNCATE are always rejected. (A table owner or
--    superuser can still disable triggers: see docs/threat-model.md.)
CREATE OR REPLACE FUNCTION core.audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE keep_days int;
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.audit_retention_purge', true) = 'on' THEN
    SELECT coalesce((retention->>'audit_days')::int, 2555) INTO keep_days FROM core.tenants WHERE id = OLD.tenant_id;
    IF OLD.at < now() - make_interval(days => coalesce(keep_days, 2555)) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'audit event % is younger than the retention period and cannot be deleted', OLD.id;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP;
END $$;

-- 3. Record versions created (and removed) by contract migrations per batch, so
--    post-load re-verification also covers migration-created current rows.
ALTER TABLE core.batch_adjustments ADD COLUMN migration_rows_added int NOT NULL DEFAULT 0;
ALTER TABLE core.batch_adjustments ADD COLUMN migration_rows_removed int NOT NULL DEFAULT 0;

-- 4. An identical record re-delivered in a later batch must be able to create a
--    new version when the earlier one came from an untrusted batch, so the
--    (key, hash) index on tenant tables is no longer unique.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, indexname, indexdef FROM pg_indexes
            WHERE schemaname LIKE 't\_%' AND indexname LIKE '%\_key\_hash' AND indexdef LIKE 'CREATE UNIQUE INDEX%' LOOP
    EXECUTE format('DROP INDEX %I.%I', r.schemaname, r.indexname);
    EXECUTE replace(r.indexdef, 'CREATE UNIQUE INDEX', 'CREATE INDEX');
  END LOOP;
END $$;

-- 5. Separation of duties: an 'approver' role that can only decide contract migrations.
ALTER TABLE core.api_tokens DROP CONSTRAINT IF EXISTS api_tokens_role_check;
ALTER TABLE core.api_tokens ADD CONSTRAINT api_tokens_role_check CHECK (role IN ('platform_admin','admin','approver','operator','reporter'));
