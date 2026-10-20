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
  };
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
