import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';

export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try { setData(await api<T>(path)); setError(null); }
    catch (e) { setError(e as ApiError); }
    finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, reload: load };
}

/* Status vocabulary. Two independent signals per batch:
   "ran"     = did processing commit? (pipeline status)
   "trusted" = did it pass reconciliation and quality thresholds? (trust status)
   Each status carries an icon and a word; colour never carries meaning alone. */
type Tone = 'good' | 'warn' | 'bad' | 'idle';
const ICON: Record<Tone, string> = { good: '✓', warn: '!', bad: '✕', idle: '…' };

export function Signal({ tone, label, title }: { tone: Tone; label: string; title?: string }) {
  return <span className={`signal signal-${tone}`} title={title}><span className="signal-icon" aria-hidden="true">{ICON[tone]}</span>{label}</span>;
}

export function PipelineSignal({ status }: { status: string }) {
  const map: Record<string, [Tone, string]> = {
    completed: ['good', 'Ran'], completed_with_exceptions: ['warn', 'Ran with exceptions'], failed: ['bad', 'Failed'],
    rejected: ['bad', 'Rejected'], queued: ['idle', 'Queued'], processing: ['idle', 'Processing'],
  };
  const [tone, label] = map[status] ?? ['idle', status];
  return <Signal tone={tone} label={label} title={`Pipeline status: ${status}`} />;
}

export function TrustSignal({ status, reasons }: { status: string; reasons?: string[] }) {
  const map: Record<string, [Tone, string]> = { trusted: ['good', 'Trusted'], untrusted: ['bad', 'Not trusted'], pending: ['idle', 'Pending'] };
  const [tone, label] = map[status] ?? ['idle', status];
  return <Signal tone={tone} label={label} title={reasons?.length ? reasons.join('\n') : `Trust status: ${status}`} />;
}

export function CheckSignal({ status }: { status: string }) {
  return status === 'passed' ? <Signal tone="good" label="Passed" /> : status === 'failed' ? <Signal tone="bad" label="Failed" /> : status === 'warning' ? <Signal tone="warn" label="Warning" /> : <Signal tone="idle" label={status} />;
}

export function Section({ title, description, actions, children, id }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="section" id={id} aria-labelledby={id ? `${id}-h` : undefined}>
      <header className="section-head">
        <div>
          <h2 id={id ? `${id}-h` : undefined}>{title}</h2>
          {description && <p className="section-desc">{description}</p>}
        </div>
        {actions && <div className="section-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function ErrorNote({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const hint = error.status === 403 ? 'Your token’s role does not allow this view.' : error.status === 401 ? 'Sign in again with a valid token.' : error.correlationId ? `Quote correlation id ${error.correlationId} when reporting this.` : '';
  return <p className="note note-bad" role="alert">{error.message}. {hint}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  if (typeof value !== 'object') return <>{String(value)}</>;
  return <>{Object.entries(value as Record<string, unknown>).map(([k, v]) => <span key={k} className="kv"><span className="muted">{k.replace(/_/g, ' ')}</span> {typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>)}</>;
}
