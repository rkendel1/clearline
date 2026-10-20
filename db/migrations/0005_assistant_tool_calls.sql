-- Evidence for the assistant's data answers: one row per tool invocation, so an answer can point at the exact
-- computation behind it. Holds aggregates only (never raw records). Not tenant-RLS data: access is decided in the
-- application (public rows are readable by their unguessable id; others only by the actor that made them).
CREATE SCHEMA IF NOT EXISTS assistant;
CREATE TABLE IF NOT EXISTS assistant.tool_calls (
  id           uuid PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  audience     text NOT NULL CHECK (audience IN ('public', 'authenticated')),
  tenant_id    text,
  actor        text NOT NULL,
  tool         text NOT NULL,
  args         jsonb NOT NULL,
  execution_id text,
  evidence     jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_created_idx ON assistant.tool_calls (created_at);
