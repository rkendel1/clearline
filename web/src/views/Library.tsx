import { useEffect, useMemo, useState } from 'react';
import { enc, request, session, t, qs } from '../lib/api';
import { count, ms, short, when } from '../lib/format';
import { go, href } from '../lib/router';
import { useAction, useLoad } from '../lib/useLoad';
import { Async, Button, Confirm, ErrorBox, Facts, Field, Grid, Json, Note, Page, Section, Signal, Table, Tabs, Tag } from '../ui';
import { defaults, ParamInputs, paramBody } from './Params';
import { ScheduleEditor } from './ScheduleEditor';
import { AnalysisBuilder } from './AnalysisBuilder';

/* eslint-disable @typescript-eslint/no-explicit-any */
const SCOPES = [['all', 'All'], ['mine', 'Mine'], ['shared', 'Shared']];
const SORTS = [['updated', 'Recently updated'], ['recent', 'Recently run'], ['name', 'Name'], ['created', 'Created'], ['last_run', 'Last run']];

export function Library({ id, tab }: { id?: string; tab: string | null }) {
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('all');
  const [sort, setSort] = useState('updated');
  const [fav, setFav] = useState(false);
  const list = useLoad((s) => request<any>('GET', t(`/saved-queries${qs({ q: search, scope, sort, favorite: fav || undefined, limit: 200 })}`), undefined, { signal: s }), [search, scope, sort, fav]);
  return (
    <Page title="Saved queries" sub="Reusable, versioned queries with schedules and analyses. Saving never grants access: each run uses the runner's role." actions={<Button onClick={list.reload}>Refresh</Button>}>
      <div className="split">
        <div className="stack">
          <input value={search} placeholder="Search name, description, tags…" onChange={(e) => setSearch(e.target.value)} aria-label="Search" />
          <div className="row">
            <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope">{SCOPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <label className="row"><input type="checkbox" checked={fav} onChange={(e) => setFav(e.target.checked)} /> ★ only</label>
          </div>
          <Async load={list}>{(d) => (
            <div className="list" role="listbox" aria-label="Saved queries">
              {d.items.length === 0 && <p className="muted pad">No saved queries. Build one in the query workspace and choose “Save as…”.</p>}
              {d.items.map((q: any) => (
                <button key={q.id} className={q.id === id ? 'active' : ''} onClick={() => go('saved', q.id)}>
                  <span className="row"><strong>{q.favorite ? '★ ' : ''}{q.name}</strong>{q.status !== 'active' && <Signal status={q.status} />}{q.needs_revalidation && <Signal status="warn" label="needs revalidation" />}</span>
                  <span className="muted small">{q.owner}{q.mine ? ' (you)' : ''} · v{q.version} · {q.sharing} · {q.active_schedules} schedules · {q.analyses} analyses</span>
                  <span className="muted small">{q.last_run ? <>Last run <Signal status={q.last_run.status} /> {when(q.last_run.at)}</> : 'Never run'}{q.next_run_at ? ` · next ${when(q.next_run_at)}` : ''}</span>
                </button>))}
            </div>)}</Async>
        </div>
        <div>{id === 'new' ? <NewQuery onSaved={(qid) => { list.reload(); go('saved', qid); }} /> : id ? <Detail key={id} id={id} tab={tab} onChanged={list.reload} /> : <Note>Select a saved query to see its versions, schedules and analyses.</Note>}</div>
      </div>
    </Page>
  );
}

function NewQuery({ onSaved }: { onSaved: (id: string) => void }) {
  const proposalId = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('proposal');
  const [f, setF] = useState({ name: '', description: '', purpose: '', category: '', tags: '', sharing: 'private', sql: '' });
  const prop = useLoad((s) => (proposalId ? request<any>('GET', t(`/queries/proposals/${enc(proposalId)}`), undefined, { signal: s }) : Promise.resolve(null)), [proposalId]);
  const [params, setParams] = useState('[]');
  const save = useAction(async () => {
    let parameters: unknown; try { parameters = JSON.parse(params || '[]'); } catch { throw new Error('Parameters must be a JSON array.'); }
    const body: any = { name: f.name, description: f.description || undefined, purpose: f.purpose || undefined, category: f.category || undefined, tags: f.tags.split(',').map((x) => x.trim()).filter(Boolean), sharing: f.sharing, parameters };
    if (proposalId) body.proposal_id = proposalId; else body.sql = f.sql;
    const r = await request<any>('POST', t('/saved-queries'), body); onSaved(r.id);
  });
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <Section title="Save a query" hint={proposalId ? 'From the validated proposal in the workspace. Use :name placeholders in SQL for parameters, and declare them below.' : 'Write SQL, or open the workspace and choose “Save as…”.'}>
      {prop.data && <pre className="code">{prop.data.validated_sql ?? prop.data.proposed_sql}</pre>}
      {!proposalId && <textarea className="sql" rows={6} value={f.sql} onChange={(e) => set('sql', e.target.value)} placeholder="SELECT …" aria-label="SQL" />}
      <div className="form-grid">
        <Field label="Name *"><input value={f.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Category"><input value={f.category} onChange={(e) => set('category', e.target.value)} /></Field>
        <Field label="Tags" hint="comma-separated"><input value={f.tags} onChange={(e) => set('tags', e.target.value)} /></Field>
        <Field label="Sharing"><select value={f.sharing} onChange={(e) => set('sharing', e.target.value)}><option value="private">private</option>{session.can('saved_query:share') && <option value="tenant">tenant</option>}</select></Field>
      </div>
      <Field label="Description"><input value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
      <Field label="Purpose"><input value={f.purpose} onChange={(e) => set('purpose', e.target.value)} /></Field>
      <Field label="Parameters (JSON)" hint='e.g. [{"name":"status","type":"string","default":"PAID"}]'><textarea className="sql" rows={3} value={params} onChange={(e) => setParams(e.target.value)} /></Field>
      <ErrorBox error={save.error} />
      <div><Button primary busy={save.busy} disabled={!f.name.trim() || (!proposalId && !f.sql.trim())} onClick={() => save.run()}>Save</Button></div>
    </Section>
  );
}

function Detail({ id, tab: tabParam, onChanged }: { id: string; tab: string | null; onChanged: () => void }) {
  const load = useLoad((s) => request<any>('GET', t(`/saved-queries/${enc(id)}`), undefined, { signal: s }), [id]);
  const [tab, setTab] = useState(tabParam ?? 'overview');
  const q = load.data;
  const decls = useMemo(() => q?.current?.parameters ?? [], [q]);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => { if (q) setValues(defaults(decls)); }, [q?.id, q?.version]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [preview, setPreview] = useState<any>(null);
  const [queued, setQueued] = useState<any>(null);
  const refresh = () => { load.reload(); onChanged(); };
  const previewA = useAction(async () => setPreview(await request('POST', t(`/saved-queries/${enc(id)}/execute`), { parameters: paramBody(decls, values), mode: 'preview' })));
  const runA = useAction(async () => setQueued(await request('POST', t(`/saved-queries/${enc(id)}/runs`), { parameters: paramBody(decls, values) })));
  const favA = useAction(async () => { await request('POST', t(`/saved-queries/${enc(id)}/favorite`), { favorite: !q.favorite }); refresh(); });
  const dupA = useAction(async () => { const r = await request<any>('POST', t(`/saved-queries/${enc(id)}/duplicate`), {}); onChanged(); go('saved', r.id); });
  const statusA = useAction(async (status: string) => { await request('POST', t(`/saved-queries/${enc(id)}/status`), { status }); refresh(); });
  return (
    <Async load={load}>{(d) => (
      <div className="stack">
        <Section title={d.name} actions={<>
          <Signal status={d.status} />{d.needs_revalidation && <Signal status="warn" label="needs revalidation" />}
          <Button busy={favA.busy} onClick={() => favA.run()}>{d.favorite ? '★ Unfavorite' : '☆ Favorite'}</Button>
          {session.can('saved_query:write') && <Button busy={dupA.busy} onClick={() => dupA.run()}>Duplicate</Button>}
          {d.mine && d.status !== 'archived' && session.can('saved_query:write') && <Confirm label="Archive" danger onConfirm={() => statusA.run('archived')} />}
        </>}>
          <p className="muted">{d.description}</p>
          <ErrorBox error={favA.error ?? dupA.error ?? statusA.error} />
          {d.withheld && <Note tone="warn">The SQL is withheld: your role may not use all of its columns now.</Note>}
          {d.issues?.length > 0 && <Note tone="warn"><ul>{d.issues.map((i: any, n: number) => <li key={n}>{i.message}</li>)}</ul></Note>}
          <Facts items={[['Owner', `${d.owner} (${d.owner_role})`], ['Sharing', d.sharing], ['Version', `v${d.version}`], ['Category', d.category], ['Tags', d.tags.join(', ')], ['Business owner', d.business_owner], ['Updated', when(d.updated_at)], ['Purpose', d.purpose]]} />
        </Section>
        <Section title="Run">
          <ParamInputs decls={decls} values={values} onChange={setValues} />
          <div className="row">
            <Button busy={previewA.busy} disabled={!d.executable_now || !session.can('query:run')} onClick={() => previewA.run()}>Preview rows</Button>
            <Button primary busy={runA.busy} disabled={!d.executable_now || !session.can('analysis:run')} onClick={() => runA.run()} title="Queues a full run: query, analyses and deliveries">Run now (with analyses)</Button>
          </div>
          <ErrorBox error={previewA.error ?? runA.error} />
          {queued && <Note tone="good">Run queued. <a href={href('runs', queued.run_id)}>Open run {short(queued.run_id)}</a></Note>}
          {preview && (preview.error ? <Note tone="bad">{preview.error.message}</Note> : <><p className="muted small">{count(preview.row_count)} rows{preview.truncated ? ' (truncated)' : ''} · {ms(preview.duration_ms)} · v{preview.version}</p><Grid columns={preview.columns} rows={preview.rows} /></>)}
        </Section>
        <Tabs active={tab} onChange={setTab} tabs={[['overview', 'Runs'], ['sql', 'SQL & versions'], ['schedules', `Schedules (${d.schedules.length})`], ['analyses', `Analyses (${d.current.analyses.length})`]]} />
        {tab === 'overview' && <Section><Table rows={d.recent_runs} empty="No runs yet." cols={[
          { head: 'Run', cell: (r: any) => <a href={href('runs', r.id)}>{short(r.id)}</a> }, { head: 'Trigger', cell: (r: any) => r.trigger }, { head: 'Status', cell: (r: any) => <Signal status={r.status} /> }, { head: 'v', num: true, cell: (r: any) => r.query_version },
          { head: 'Rows', num: true, cell: (r: any) => count(r.row_count) }, { head: 'Created', cell: (r: any) => when(r.created_at) }]} />
          {d.latest_analyses.length > 0 && <Table rows={d.latest_analyses} cols={[{ head: 'Latest analysis', cell: (a: any) => a.analysis_key }, { head: 'Type', cell: (a: any) => a.analysis_type }, { head: 'Status', cell: (a: any) => <Signal status={a.status} /> }, { head: 'Message', cell: (a: any) => a.message ?? '' }, { head: 'Run', cell: (a: any) => <a href={href('runs', a.run_id)}>{short(a.run_id)}</a> }]} />}</Section>}
        {tab === 'sql' && <Versions d={d} onSaved={refresh} />}
        {tab === 'schedules' && <Schedules d={d} onChanged={refresh} />}
        {tab === 'analyses' && <AnalysisBuilder d={d} onSaved={refresh} />}
      </div>)}</Async>
  );
}

function Versions({ d, onSaved }: { d: any; onSaved: () => void }) {
  const [sql, setSql] = useState(d.current.sql ?? '');
  const [params, setParams] = useState(JSON.stringify(d.current.parameters ?? [], null, 2));
  const [note, setNote] = useState('');
  const [shown, setShown] = useState<any>(null);
  const save = useAction(async () => {
    let parameters: unknown; try { parameters = JSON.parse(params || '[]'); } catch { throw new Error('Parameters must be a JSON array.'); }
    await request('POST', t(`/saved-queries/${enc(d.id)}/versions`), { sql, parameters, change_note: note || undefined }); setNote(''); onSaved();
  });
  const showV = useAction(async (v: number) => setShown(await request('GET', t(`/saved-queries/${enc(d.id)}/versions/${v}`))));
  const canWrite = d.mine && session.can('saved_query:write') && d.current.sql !== null;
  return (
    <Section title={`Current: version ${d.current.version}`} hint="Versions are immutable. Saving changes creates a new version; analyses that no longer fit the output are flagged for revalidation.">
      {d.current.sql === null ? <Note tone="warn">SQL withheld.</Note> : <>
        <textarea className="sql" rows={8} value={sql} onChange={(e) => setSql(e.target.value)} readOnly={!canWrite} aria-label="SQL" />
        <Field label="Parameter declarations (JSON)"><textarea className="sql" rows={5} value={params} onChange={(e) => setParams(e.target.value)} readOnly={!canWrite} /></Field>
        {canWrite && <><Field label="Change note"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field><ErrorBox error={save.error} /><div><Button primary busy={save.busy} onClick={() => save.run()}>Save new version</Button></div></>}
      </>}
      <h3>Output columns</h3>
      <Table rows={d.current.output_schema ?? []} empty="Not yet observed (run it once)." cols={[{ head: 'Column', cell: (c: any) => c.name }, { head: 'Type', cell: (c: any) => c.type }, { head: 'Redaction', cell: (c: any) => (c.masked ? <Signal status="masked" label={c.masked} /> : '') }]} />
      <h3>History</h3>
      <Table rows={d.versions} cols={[{ head: 'v', num: true, cell: (v: any) => v.version }, { head: 'Note', cell: (v: any) => v.change_note ?? '' }, { head: 'By', cell: (v: any) => v.created_by }, { head: 'When', cell: (v: any) => when(v.created_at) }, { head: 'Analyses', num: true, cell: (v: any) => v.analyses },
        { head: '', cell: (v: any) => <Button busy={showV.busy} onClick={() => showV.run(v.version)}>View</Button> }]} />
      <ErrorBox error={showV.error} />
      {shown && <Json open value={shown} label={`Version ${shown.version}`} />}
    </Section>
  );
}

function Schedules({ d, onChanged }: { d: any; onChanged: () => void }) {
  const act = useAction(async (sid: string, action: string) => { await request('POST', t(`/analytics/schedules/${sid}/${action}`), {}); onChanged(); });
  const canManage = session.can('schedule:manage');
  return (
    <div className="stack">
      <Section title="Schedules">
        <ErrorBox error={act.error} />
        <Table rows={d.schedules} empty="No schedules." cols={[
          { head: 'Name', cell: (s: any) => <><strong>{s.name}</strong><div className="muted small">{s.description}</div></> }, { head: 'State', cell: (s: any) => <><Signal status={s.status} />{s.attention && <> <Signal status="warn" label="needs attention" /></>}</> },
          { head: 'Next run', cell: (s: any) => when(s.next_run_at) }, { head: 'Zone', cell: (s: any) => s.timezone }, { head: 'Runs as', cell: (s: any) => `${s.run_as_actor} (${s.run_as_role})` },
          { head: '', cell: (s: any) => canManage && s.status !== 'cancelled' && (
            <span className="row"><Button busy={act.busy} onClick={() => act.run(s.id, 'run')}>Run now</Button>
              {s.status === 'active' && <Button busy={act.busy} onClick={() => act.run(s.id, 'pause')}>Pause</Button>}
              {s.status === 'paused' && <Button busy={act.busy} onClick={() => act.run(s.id, 'resume')}>Resume</Button>}
              <Confirm danger label="Cancel" onConfirm={() => act.run(s.id, 'cancel')} /></span>) }]} />
        {d.schedules.some((s: any) => s.attention) && <Note tone="warn">{d.schedules.filter((s: any) => s.attention).map((s: any) => `${s.name}: ${s.attention}`).join(' · ')}</Note>}
      </Section>
      {canManage ? <ScheduleEditor d={d} onCreated={onChanged} /> : <Note>Your role can view schedules but not manage them.</Note>}
    </div>
  );
}
