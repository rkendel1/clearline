import { useState } from 'react';
import { request, session, t } from '../lib/api';
import { when } from '../lib/format';
import { useAction, useLoad } from '../lib/useLoad';
import { Async, Button, ErrorBox, Field, Note, Section } from '../ui';
import { defaults, ParamInputs, paramBody } from './Params';

/* eslint-disable @typescript-eslint/no-explicit-any */
const FREQ = ['once', 'hourly', 'daily', 'weekly', 'monthly'];
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
// Mirrors the server's DELEGABLE_ROLES for display only; the server decides.
const DELEGABLE: Record<string, string[]> = { admin: ['reporter', 'operator', 'steward', 'admin'], steward: ['reporter', 'steward'], operator: ['reporter', 'operator'], reporter: ['reporter'] };

export function ScheduleEditor({ d, onCreated }: { d: any; onCreated: () => void }) {
  const dests = useLoad((s) => request<any>('GET', t('/analytics/destinations'), undefined, { signal: s }), []);
  const roles = DELEGABLE[session.me?.role ?? ''] ?? [];
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [f, setF] = useState({ name: '', frequency: 'daily', interval: '1', at: '08:00', month_day: '1', start_local: `${new Date().toISOString().slice(0, 10)}T08:00`, until_local: '', timezone: tz, run_as_role: roles[0] ?? 'reporter' });
  const [days, setDays] = useState<string[]>(['MO']);
  const [chosen, setChosen] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>(defaults(d.current.parameters ?? []));
  const [preview, setPreview] = useState<any>(null);
  const set = (k: string, v: string) => { setF((x) => ({ ...x, [k]: v })); setPreview(null); };
  const recurrence = () => {
    const r: any = { frequency: f.frequency, interval: Math.max(1, Number(f.interval) || 1) };
    if (f.frequency !== 'hourly' && f.frequency !== 'once') r.at = f.at;
    if (f.frequency === 'weekly') r.weekdays = days;
    if (f.frequency === 'monthly') r.month_day = Number(f.month_day) || 1;
    return r;
  };
  const prev = useAction(async () => setPreview(await request('POST', t('/analytics/schedules/preview'), { recurrence: recurrence(), start_local: f.start_local, timezone: f.timezone, until_local: f.until_local || null, count: 5 })));
  const create = useAction(async () => {
    await request('POST', t('/analytics/schedules'), { query_id: d.id, name: f.name || undefined, recurrence: recurrence(), start_local: f.start_local, timezone: f.timezone, until_local: f.until_local || null,
      run_as_role: f.run_as_role, destination_ids: chosen, parameters: paramBody(d.current.parameters ?? [], values) });
    setPreview(null); onCreated();
  });
  return (
    <Section title="New schedule" hint="The schedule runs as you, with the role you choose, and uses that role's current access each time.">
      <div className="form-grid">
        <Field label="Name"><input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Repeats"><select value={f.frequency} onChange={(e) => set('frequency', e.target.value)}>{FREQ.map((x) => <option key={x}>{x}</option>)}</select></Field>
        {f.frequency !== 'once' && <Field label="Every (interval)"><input inputMode="numeric" value={f.interval} onChange={(e) => set('interval', e.target.value)} /></Field>}
        {f.frequency !== 'once' && f.frequency !== 'hourly' && <Field label="At (local time)"><input type="time" value={f.at} onChange={(e) => set('at', e.target.value)} /></Field>}
        {f.frequency === 'monthly' && <Field label="Day of month"><input inputMode="numeric" value={f.month_day} onChange={(e) => set('month_day', e.target.value)} /></Field>}
        <Field label="Start (local)"><input type="datetime-local" value={f.start_local} onChange={(e) => set('start_local', e.target.value)} /></Field>
        <Field label="Until (local, optional)"><input type="datetime-local" value={f.until_local} onChange={(e) => set('until_local', e.target.value)} /></Field>
        <Field label="Time zone (IANA)"><input value={f.timezone} onChange={(e) => set('timezone', e.target.value)} /></Field>
        <Field label="Runs as role"><select value={f.run_as_role} onChange={(e) => set('run_as_role', e.target.value)}>{roles.map((r) => <option key={r} value={r}>{session.me?.actor} as {r}</option>)}</select></Field>
      </div>
      {f.frequency === 'weekly' && <div className="row" role="group" aria-label="Weekdays">{WEEKDAYS.map((w) => <label key={w} className="row"><input type="checkbox" checked={days.includes(w)} onChange={(e) => { setDays((x) => (e.target.checked ? [...x, w] : x.filter((y) => y !== w))); setPreview(null); }} /> {w}</label>)}</div>}
      <ParamInputs decls={d.current.parameters ?? []} values={values} onChange={setValues} />
      <h3>Deliver to</h3>
      <Async load={dests}>{(x) => x.items.length ? <div className="row">{x.items.filter((i: any) => i.enabled).map((i: any) => <label key={i.id} className="row"><input type="checkbox" checked={chosen.includes(i.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, i.id] : c.filter((y) => y !== i.id)))} /> {i.name} <span className="muted small">({i.kind})</span></label>)}</div> : <p className="muted">No destinations. Results are kept in run history.</p>}</Async>
      <ErrorBox error={prev.error ?? create.error} />
      <div className="row"><Button busy={prev.busy} onClick={() => prev.run()}>Preview occurrences</Button><Button primary busy={create.busy} disabled={f.frequency === 'weekly' && !days.length} onClick={() => create.run()}>Create schedule</Button></div>
      {preview && <Note tone="info"><strong>{preview.description}</strong>{preview.rrule && <div className="mono small">{preview.rrule}</div>}<ol>{preview.next.map((n: string) => <li key={n}>{when(n)} <span className="muted small">({n})</span></li>)}</ol><p className="small muted">Daylight-saving changes are applied by the server; occurrences shown are exact UTC instants.</p></Note>}
    </Section>
  );
}
