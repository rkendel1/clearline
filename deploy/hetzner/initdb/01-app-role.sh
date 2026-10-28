#!/bin/sh
# Runs once, on the first start of an empty data directory. The application logs in as a NON-superuser that owns its
# database and may create roles (tenants and the per-role query roles need that). A superuser would bypass row-level
# security, so the application never uses the administrative login.
set -e
psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres <<SQL
CREATE ROLE clearline_app LOGIN PASSWORD '${APP_DB_PASSWORD}' CREATEROLE NOSUPERUSER;
CREATE DATABASE clearline OWNER clearline_app;
SQL
# pgvector is created here, as the administrator, so the application never needs the privilege.
psql -v ON_ERROR_STOP=1 --username postgres --dbname clearline -c 'CREATE EXTENSION IF NOT EXISTS vector'
