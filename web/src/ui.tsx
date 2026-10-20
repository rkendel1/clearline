import { type ReactNode, useState } from 'react';
import { ApiError } from './lib/api';
import { cell, tone, words } from './lib/format';
import type { Loaded } from './lib/useLoad';

export function Page({ title, sub, actions, children }: { title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>{title}</h1>{sub && <p className="muted">{sub}</p>}</div>
        {actions && <div className="row">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function Section({ title, hint, children, actions }: { title?: string; hint?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="section">
      {(title || actions) && <div className="section-head"><h2>{title}</h2>{actions && <div className="row">{actions}</div>}</div>}
      {hint && <p className="muted">{hint}</p>}
      {children}
    </section>
  );
}

export function Signal({ status, label }: { status: string | null | undefined; label?: string }) {
  return <span className={`signal ${tone(status)}`}>{label ?? words(status ?? 'unknown')}</span>;
}
export const Tag = ({ children }: { children: ReactNode }) => <span className="tag">{children}</span>;

export function Note({ tone: t = 'idle', children }: { tone?: 'good' | 'warn' | 'bad' | 'idle' | 'info'; children: ReactNode }) {
  return <div className={`note ${t}`} role={t === 'bad' ? 'alert' : 'status'}>{children}</div>;
}

export function ErrorBox({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <Note tone="bad">
      <strong>{error.message}</strong>
      <div className="muted small">{error.code}{error.status ? ` · HTTP ${error.status}` : ''}{error.correlationId ? ` · correlation ${error.correlationId}` : ''}</div>
      {Array.isArray((error.details as { issues?: unknown[] } | undefined)?.issues) && (
        <ul className="small">{((error.details as { issues: { message?: string; code?: string }[] }).issues).map((i, n) => <li key={n}>{i.message ?? i.code}</li>)}</ul>
      )}
    </Note>
  );
}

/** Renders loading / error / content for a useLoad result. */
export function Async<T>({ load, children }: { load: Loaded<T>; children: (d: T) => ReactNode }) {
  if (load.error && !load.data) return <ErrorBox error={load.error} />;
  if (!load.data) return <div className="muted" aria-busy="true">Loading…</div>;
  return <>{load.error && <ErrorBox error={load.error} />}{children(load.data)}</>;
}

export function Button({ children, onClick, primary, danger, disabled, busy, type = 'button', title }: {
  children: ReactNode; onClick?: () => void; primary?: boolean; danger?: boolean; disabled?: boolean; busy?: boolean; type?: 'button' | 'submit'; title?: string;
}) {
  return <button type={type} title={title} className={`btn${primary ? ' primary' : ''}${danger ? ' danger' : ''}`} onClick={onClick} disabled={disabled || busy}>{busy ? '…' : children}</button>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small className="muted">{hint}</small>}</label>;
}

export function Tabs({ tabs, active, onChange }: { tabs: [string, string][]; active: string; onChange: (k: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([k, label]) => <button key={k} role="tab" aria-selected={k === active} className={k === active ? 'active' : ''} onClick={() => onChange(k)}>{label}</button>)}
    </div>
  );
}

export function Facts({ items }: { items: [string, ReactNode][] }) {
  return <dl className="facts">{items.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v ?? '—'}</dd></div>)}</dl>;
}

export interface Col<R> { head: string; cell: (r: R, i: number) => ReactNode; num?: boolean }
// Rows are API JSON of many shapes; callers type cells as needed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = any;
export function Table({ cols, rows, empty = 'Nothing to show.', onRow, rowKey }: { cols: Col<AnyRow>[]; rows: AnyRow[]; empty?: string; onRow?: (r: AnyRow) => void; rowKey?: (r: AnyRow, i: number) => string }) {
  if (!rows.length) return <p className="muted">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{cols.map((c) => <th key={c.head} className={c.num ? 'num' : ''}>{c.head}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey ? rowKey(r, i) : i} className={onRow ? 'click' : ''} onClick={onRow ? () => onRow(r) : undefined}>
              {cols.map((c) => <td key={c.head} className={c.num ? 'num' : ''}>{c.cell(r, i)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A result grid: columns come with types and masking, rows are arrays. Masked columns are marked, never unmasked here. */
export function Grid({ columns, rows }: { columns: { name: string; type?: string; masked?: string | null; sensitive?: boolean }[]; rows: unknown[][] }) {
  if (!rows.length) return <p className="muted">No rows.</p>;
  return (
    <div className="table-wrap grid">
      <table>
        <thead><tr>{columns.map((c) => (
          <th key={c.name} className={c.type === 'integer' || c.type === 'decimal' ? 'num' : ''}>
            {c.name}{c.masked && <span className="mask" title={`Redacted for your role (${c.masked})`}>◐</span>}
            {c.type && <small className="muted"> {c.type}</small>}
          </th>))}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={columns[j]?.type === 'integer' || columns[j]?.type === 'decimal' ? 'num' : ''}>{v === null ? <span className="muted">∅</span> : cell(v)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Json({ value, open = false, label = 'Details' }: { value: unknown; open?: boolean; label?: string }) {
  return <details open={open}><summary>{label}</summary><pre className="code">{JSON.stringify(value, null, 2)}</pre></details>;
}

export function Code({ children }: { children: string }) { return <pre className="code">{children}</pre>; }

/** Confirmation inline (no modal): first click arms, second confirms. */
export function Confirm({ label, onConfirm, danger, disabled, busy }: { label: string; onConfirm: () => void; danger?: boolean; disabled?: boolean; busy?: boolean }) {
  const [armed, setArmed] = useState(false);
  if (!armed) return <Button danger={danger} disabled={disabled} onClick={() => setArmed(true)}>{label}</Button>;
  return <span className="row"><Button danger={danger} busy={busy} onClick={() => { setArmed(false); onConfirm(); }}>Confirm: {label}</Button><Button onClick={() => setArmed(false)}>Cancel</Button></span>;
}

export function Pager({ offset, limit, total, onChange }: { offset: number; limit: number; total: number; onChange: (o: number) => void }) {
  return (
    <div className="row pager">
      <Button disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}>Previous</Button>
      <span className="muted small">{total ? `${offset + 1}–${Math.min(total, offset + limit)} of ${total.toLocaleString()}` : '0'}</span>
      <Button disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next</Button>
    </div>
  );
}

export function Stat({ label, value, sub, status }: { label: string; value: ReactNode; sub?: ReactNode; status?: string }) {
  return <div className={`stat ${status ? tone(status) : ''}`}><div className="stat-label">{label}</div><div className="stat-value">{value}</div>{sub && <div className="muted small">{sub}</div>}</div>;
}
