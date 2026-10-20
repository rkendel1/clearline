// Central, validated configuration. Every tunable limit is here so operators
// can see and change them without reading code.

function int(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Config ${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

function str(name: string, def?: string): string {
  const v = process.env[name] ?? def;
  if (v === undefined) throw new Error(`Missing required config ${name}`);
  return v;
}

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  env: 'development' | 'test' | 'production';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  maxUploadBytes: number;
  maxRowsPerBatch: number;
  dbPoolSize: number;
  statementTimeoutMs: number;
  batchTimeoutMs: number;
  leaseSeconds: number;
  workerPollMs: number;
  maxAttempts: number;
  shutdownGraceMs: number;
  runWorkerInApi: boolean;
  faultInjection: string;   // test-only fault hooks, ignored in production
  // Analytical query workspace (docs/query-workspace.md)
  nlSqlProvider: 'deterministic' | 'anthropic' | 'none';
  nlSqlModel: string;
  nlSqlTimeoutMs: number;
  queryTimeoutMs: number;          // statement_timeout for analytical queries
  queryMaxRows: number;            // rows returned by a run
  queryPreviewRows: number;        // rows returned by a preview
  queryMaxResultBytes: number;     // serialized result size cap
  queryMaxCost: number;            // planner cost above which a query is refused before running
  queryMaxConcurrentPerTenant: number;
  queryMaxConcurrent: number;
  queryDatabaseUrl: string;        // login used ONLY for analytical queries (no privileges of its own)
  queryLoginRole: string;
  // Saved analytics: scheduler, runs, analyses, delivery (docs/saved-analytics.md)
  schedulerEnabled: boolean;       // run the scheduler loop in worker processes
  schedulerTickMs: number;
  schedulerMaxConcurrent: number;  // runs executing at once per worker process
  schedulerMaxPerTenant: number;   // runs executing at once per tenant, across all workers
  runLeaseSeconds: number;
  runRetryBaseMs: number;          // exponential backoff base for transient run failures
  runRetryMaxMs: number;
  runResultRetentionHours: number; // bounded result snapshots used by analyses and delivery retries
  analysisMaxRows: number;
  analysisMaxFeatures: number;
  analysisMaxPoints: number;
  analysisMaxHorizon: number;
  analysisTimeoutMs: number;
  analysisMaxMemoryMb: number;
  deliveryConcurrency: number;
  deliveryTimeoutMs: number;
  deliveryLeaseSeconds: number;
  deliveryRetryBaseMs: number;
  deliveryRetryMaxMs: number;
  deliveryMaxRows: number;         // rows a webhook payload may carry when a destination includes rows
  deliveryMaxBytes: number;        // payload / attachment size cap
  exportExpiryHours: number;
  webhookAllowPrivate: boolean;    // test/dev only: allow loopback/private webhook targets and plain http
  emailProvider: 'none' | 'smtp' | 'file' | 'test';
  smtpUrl: string;
  emailFrom: string;
  emailOutboxDir: string;
  emailAllowedDomains: string[];   // empty = any domain
  publicUrl: string;               // base URL used in links inside deliveries
}

function oneOf<T extends string>(name: string, allowed: readonly T[], def: T): T {
  const v = (process.env[name] ?? def) as T;
  if (!allowed.includes(v)) throw new Error(`Config ${name} must be one of ${allowed.join(', ')}, got "${v}"`);
  return v;
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  const env = str('NODE_ENV', 'development') as Config['env'];
  // A silent localhost default in production only shows up later as ECONNREFUSED; say what is missing instead.
  if (env === 'production' && !process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in production (on Fly: fly postgres attach <db-app> --app <app>, or fly secrets set DATABASE_URL=...)');
  const cfg: Config = {
    databaseUrl: str('DATABASE_URL', 'postgres://clearline:clearline@localhost:5432/clearline'),
    port: int('PORT', 8080),
    host: str('HOST', '0.0.0.0'),
    env,
    logLevel: str('LOG_LEVEL', env === 'test' ? 'warn' : 'info') as Config['logLevel'],
    maxUploadBytes: int('MAX_UPLOAD_BYTES', 50 * 1024 * 1024),
    maxRowsPerBatch: int('MAX_ROWS_PER_BATCH', 500_000),
    dbPoolSize: int('DB_POOL_SIZE', 10),
    statementTimeoutMs: int('STATEMENT_TIMEOUT_MS', 60_000),
    batchTimeoutMs: int('BATCH_TIMEOUT_MS', 10 * 60_000),
    leaseSeconds: int('WORKER_LEASE_SECONDS', 120),
    workerPollMs: int('WORKER_POLL_MS', 500),
    maxAttempts: int('MAX_ATTEMPTS', 3),
    shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 20_000),
    runWorkerInApi: str('RUN_WORKER_IN_API', 'false') === 'true',
    faultInjection: env === 'production' ? '' : str('CLEARLINE_FAULT_INJECTION', ''),
    nlSqlProvider: oneOf('NL_SQL_PROVIDER', ['deterministic', 'anthropic', 'none'] as const, 'deterministic'),
    nlSqlModel: str('NL_SQL_MODEL', 'claude-opus-5-5'),
    nlSqlTimeoutMs: int('NL_SQL_TIMEOUT_MS', 60_000),
    queryTimeoutMs: int('QUERY_TIMEOUT_MS', 10_000),
    queryMaxRows: int('QUERY_MAX_ROWS', 5_000),
    queryPreviewRows: int('QUERY_PREVIEW_ROWS', 20),
    queryMaxResultBytes: int('QUERY_MAX_RESULT_BYTES', 8 * 1024 * 1024),
    queryMaxCost: int('QUERY_MAX_COST', 5_000_000),
    queryMaxConcurrentPerTenant: int('QUERY_MAX_CONCURRENT_PER_TENANT', 2),
    queryMaxConcurrent: int('QUERY_MAX_CONCURRENT', 4),
    queryDatabaseUrl: '',
    queryLoginRole: '',
    schedulerEnabled: str('SCHEDULER_ENABLED', 'true') === 'true',
    schedulerTickMs: int('SCHEDULER_TICK_MS', 1_000),
    schedulerMaxConcurrent: int('SCHEDULER_MAX_CONCURRENT', 2),
    schedulerMaxPerTenant: int('SCHEDULER_MAX_PER_TENANT', 2),
    runLeaseSeconds: int('RUN_LEASE_SECONDS', 300),
    runRetryBaseMs: int('RUN_RETRY_BASE_MS', 30_000),
    runRetryMaxMs: int('RUN_RETRY_MAX_MS', 60 * 60_000),
    runResultRetentionHours: int('RUN_RESULT_RETENTION_HOURS', 168),
    analysisMaxRows: int('ANALYSIS_MAX_ROWS', 5_000),
    analysisMaxFeatures: int('ANALYSIS_MAX_FEATURES', 20),
    analysisMaxPoints: int('ANALYSIS_MAX_POINTS', 5_000),
    analysisMaxHorizon: int('ANALYSIS_MAX_HORIZON', 104),
    analysisTimeoutMs: int('ANALYSIS_TIMEOUT_MS', 10_000),
    analysisMaxMemoryMb: int('ANALYSIS_MAX_MEMORY_MB', 256),
    deliveryConcurrency: int('DELIVERY_CONCURRENCY', 4),
    deliveryTimeoutMs: int('DELIVERY_TIMEOUT_MS', 10_000),
    deliveryLeaseSeconds: int('DELIVERY_LEASE_SECONDS', 120),
    deliveryRetryBaseMs: int('DELIVERY_RETRY_BASE_MS', 30_000),
    deliveryRetryMaxMs: int('DELIVERY_RETRY_MAX_MS', 60 * 60_000),
    deliveryMaxRows: int('DELIVERY_MAX_ROWS', 100),
    deliveryMaxBytes: int('DELIVERY_MAX_BYTES', 1024 * 1024),
    exportExpiryHours: int('EXPORT_EXPIRY_HOURS', 72),
    webhookAllowPrivate: env !== 'production' && str('WEBHOOK_ALLOW_PRIVATE', 'false') === 'true',
    emailProvider: oneOf('EMAIL_PROVIDER', ['none', 'smtp', 'file', 'test'] as const, 'none'),
    smtpUrl: str('SMTP_URL', ''),
    emailFrom: str('EMAIL_FROM', 'clearline@localhost'),
    emailOutboxDir: str('EMAIL_OUTBOX_DIR', 'var/outbox'),
    emailAllowedDomains: str('EMAIL_ALLOWED_DOMAINS', '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    publicUrl: str('PUBLIC_URL', 'http://localhost:8080').replace(/\/$/, ''),
  };
  if (env === 'production' && process.env.WEBHOOK_ALLOW_PRIVATE === 'true') throw new Error('WEBHOOK_ALLOW_PRIVATE is not permitted in production');
  if (cfg.emailProvider === 'smtp' && !cfg.smtpUrl) throw new Error('EMAIL_PROVIDER=smtp requires SMTP_URL');
  // Analytical queries connect as a separate login that owns no privileges (so RESET ROLE leaves
  // it with nothing). Production must configure it explicitly; elsewhere it is derived from
  // DATABASE_URL with a local-only password, and the application provisions the role.
  const explicit = process.env.QUERY_DATABASE_URL;
  if (explicit) cfg.queryDatabaseUrl = explicit;
  else {
    if (env === 'production' && !process.env.QUERY_DB_PASSWORD) throw new Error('QUERY_DATABASE_URL or QUERY_DB_PASSWORD is required in production');
    const u = new URL(cfg.databaseUrl);
    u.username = 'clearline_query';
    u.password = process.env.QUERY_DB_PASSWORD ?? 'clearline-query-local-only';
    cfg.queryDatabaseUrl = u.toString();
  }
  cfg.queryLoginRole = decodeURIComponent(new URL(cfg.queryDatabaseUrl).username);
  // On the service login, RESET ROLE inside a query would regain the service's privileges.
  if (cfg.queryLoginRole === decodeURIComponent(new URL(cfg.databaseUrl).username)) throw new Error('QUERY_DATABASE_URL must use a login other than the service login (DATABASE_URL)');
  cached = cfg;
  return cfg;
}

export function resetConfigForTests(): void { cached = undefined; }
