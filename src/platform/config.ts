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
  dashboardDir: string;
  faultInjection: string;   // test-only fault hooks, ignored in production
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
    dashboardDir: str('DASHBOARD_DIR', 'dashboard/dist'),
    faultInjection: env === 'production' ? '' : str('CLEARLINE_FAULT_INJECTION', ''),
  };
  cached = cfg;
  return cfg;
}

export function resetConfigForTests(): void { cached = undefined; }
