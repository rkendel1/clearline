// Append-only audit trail. Events are written in their own transaction so a
// denial or failure is recorded even when the triggering work rolls back.
// Details must never include raw record values.

import { getPool, type Tx } from '../platform/db.js';
import { log } from '../platform/logger.js';

export interface AuditEvent {
  tenantId: string | null;
  actor: string;
  role?: string | null;
  action: string;
  resource?: string | null;
  outcome: 'allowed' | 'denied' | 'succeeded' | 'failed';
  details?: Record<string, unknown>;
  correlationId?: string | null;
}

const SQL = `INSERT INTO core.audit_events (tenant_id, actor, role, action, resource, outcome, details, correlation_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;

const params = (e: AuditEvent) => [e.tenantId, e.actor, e.role ?? null, e.action, e.resource ?? null, e.outcome, JSON.stringify(e.details ?? {}), e.correlationId ?? null];

export async function audit(e: AuditEvent): Promise<void> {
  try {
    await getPool().query(SQL, params(e));
  } catch (err) {
    // Audit failure is an operational incident; surface loudly but never log payloads.
    log.error('audit write failed', { action: e.action, tenant: e.tenantId, error: err as Error });
    throw err;
  }
}

/** Audit inside an existing transaction (commits or rolls back with the work it describes). */
export async function auditTx(tx: Tx, e: AuditEvent): Promise<void> {
  await tx.query(SQL, params(e));
}
