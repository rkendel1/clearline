import { useState } from 'react';
import { enc, request, session, t } from '../lib/api';
import { useAction } from '../lib/useLoad';
import { Button, ErrorBox, Field, Json, Note, Section, Signal, Table } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const TYPES: [string, string, string[]][] = [
  ['anomaly', 'Time-series anomalies', ['anomaly.rolling_mad', 'anomaly.seasonal_decomposition']],
  ['forecast', 'Forecast', ['forecast.auto', 'forecast.naive', 'forecast.seasonal_naive', 'forecast.drift', 'forecast.holt_linear']],
  ['outlier', 'Outlier records', ['outlier.robust_distance']],
  ['cluster', 'Segments (k-means)', ['cluster.kmeans']],
];
const NUMERIC = ['integer', 'decimal'];
const TIME = ['date', 'timestamp'];
const GRAINS = ['day', 'week', 'month', 'hour'];
// [key, label, placeholder] per type; empty = server default.
const PARAMS: Record<string, [string, string, string][]> = {
  anomaly: [['period', 'Seasonal period', 'e.g. 7 (weekly in daily data)'], ['window', 'Baseline window', '28, or 8 with a period'], ['threshold', 'Threshold (robust z)', '3.5'], ['min_history', 'Minimum history', 'auto'], ['recent_points', 'Alert on last n points', 'all']],
  forecast: [['period', 'Seasonal period', 'e.g. 7'], ['horizon', 'Horizon', '8'], ['backtest_origins', 'Backtest origins', '8'], ['min_history', 'Minimum history', 'auto'], ['above', 'Alert if forecast above', 'none'], ['below', 'Alert if forecast below', 'none']],
  outlier: [['threshold', 'Threshold', '3.5'], ['min_samples', 'Minimum samples', '30'], ['top_n', 'Top n', '25']],
  cluster: [['k', 'Clusters (k)', '3'], ['seed', 'Seed', '42']],
};

export function AnalysisBuilder({ d, onSaved }: { d: any; onSaved: () => void }) {
  const schema: any[] = d.current.output_schema ?? [];
  const existing: any[] = d.current.analyses ?? [];
  const [kind, setKind] = useState('anomaly');
  const [algorithm, setAlgorithm] = useState('anomaly.rolling_mad');
  const [grain, setGrain] = useState('day');
  const [timeCol, setTimeCol] = useState(schema.find((c) => TIME.includes(c.type))?.name ?? '');
  const [cols, setCols] = useState<string[]>([]);
  const [idCol, setIdCol] = useState('');
  const [group, setGroup] = useState('');
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [p, setP] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<any>(null);
  const timeLike = kind === 'anomaly' || kind === 'forecast';

  const config = () => {
    const c: any = { type: kind, algorithm, key: key || `${kind}-${existing.length + 1}` };
    if (label) c.label = label;
    if (timeLike) { c.time_column = timeCol; c.grain = grain; if (kind === 'anomaly') c.metrics = cols; else c.metric = cols[0]; }
    else { c.features = cols; c.id_column = idCol || null; if (kind === 'outlier') c.group_by = group || null; }
    for (const [k] of PARAMS[kind]) { const v = p[k]?.trim(); if (v && !['above', 'below'].includes(k)) { const n = Number(v); if (Number.isFinite(n)) c[k] = n; } }
    if (kind === 'forecast') c.thresholds = { above: p.above?.trim() ? Number(p.above) : null, below: p.below?.trim() ? Number(p.below) : null };
    return c;
  };
  const validate = useAction(async () => setCheck(await request('POST', t(`/saved-queries/${enc(d.id)}/analyses/validate`), { config: config() })));
  const add = useAction(async () => {
    const r = await request<any>('POST', t(`/saved-queries/${enc(d.id)}/analyses/validate`), { config: config() });
    setCheck(r);
    if (!r.ok) return;
    await request('POST', t(`/saved-queries/${enc(d.id)}/versions`), { analyses: [...existing, r.config], change_note: `Add analysis ${r.config.key}` });
    onSaved();
  });
  const remove = useAction(async (k: string) => { await request('POST', t(`/saved-queries/${enc(d.id)}/versions`), { analyses: existing.filter((a) => a.key !== k), change_note: `Remove analysis ${k}` }); onSaved(); });
  const toggle = (c: string) => setCols((x) => (kind === 'forecast' ? [c] : x.includes(c) ? x.filter((y) => y !== c) : [...x, c]));
  const canWrite = d.mine && session.can('saved_query:write');
  const numeric = schema.filter((c) => NUMERIC.includes(c.type));

  return (
    <div className="stack">
      <Section title="Configured analyses" hint="Analyses run on the authorized, redacted, bounded result of each run. They never see redacted columns.">
        <ErrorBox error={remove.error} />
        <Table rows={existing} empty="None yet." cols={[{ head: 'Key', cell: (a: any) => <strong>{a.key}</strong> }, { head: 'Type', cell: (a: any) => a.type }, { head: 'Algorithm', cell: (a: any) => a.algorithm },
          { head: 'Config', cell: (a: any) => <Json value={a} label="config" /> }, { head: '', cell: (a: any) => canWrite && <Button busy={remove.busy} onClick={() => remove.run(a.key)}>Remove</Button> }]} />
        {d.needs_revalidation && <Note tone="warn">{d.needs_revalidation}</Note>}
      </Section>
      {!canWrite ? <Note>Only the owner can change a saved query's analyses.</Note> : schema.length === 0 ? <Note tone="warn">Run the query once so its output columns are known, then add analyses.</Note> : (
        <Section title="Add an analysis" hint="Choose columns explicitly. Redacted columns are marked ◐ and the server refuses them as inputs.">
          <div className="form-grid">
            <Field label="Type"><select value={kind} onChange={(e) => { setKind(e.target.value); setAlgorithm(TYPES.find((x) => x[0] === e.target.value)![2][0]); setCols([]); setCheck(null); }}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Algorithm"><select value={algorithm} onChange={(e) => { setAlgorithm(e.target.value); setCheck(null); }}>{TYPES.find((x) => x[0] === kind)![2].map((a) => <option key={a}>{a}</option>)}</select></Field>
            <Field label="Key"><input value={key} placeholder={`${kind}-${existing.length + 1}`} onChange={(e) => setKey(e.target.value)} /></Field>
            <Field label="Label"><input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
            {timeLike && <Field label="Time column"><select value={timeCol} onChange={(e) => setTimeCol(e.target.value)}>{schema.filter((c) => TIME.includes(c.type)).map((c) => <option key={c.name}>{c.name}</option>)}</select></Field>}
            {timeLike && <Field label="Grain"><select value={grain} onChange={(e) => setGrain(e.target.value)}>{GRAINS.map((g) => <option key={g}>{g}</option>)}</select></Field>}
            {!timeLike && <Field label="Record identifier (optional)"><select value={idCol} onChange={(e) => setIdCol(e.target.value)}><option value="">none</option>{schema.map((c) => <option key={c.name} value={c.name}>{c.name}{c.masked ? ' ◐' : ''}</option>)}</select></Field>}
            {kind === 'outlier' && <Field label="Compare within group (optional)"><select value={group} onChange={(e) => setGroup(e.target.value)}><option value="">all records</option>{schema.map((c) => <option key={c.name}>{c.name}</option>)}</select></Field>}
          </div>
          <h3>{kind === 'anomaly' ? 'Metrics (numeric)' : kind === 'forecast' ? 'Metric to forecast (one)' : 'Numeric features'}</h3>
          <div className="row">{numeric.length ? numeric.map((c) => <label key={c.name} className="row"><input type={kind === 'forecast' ? 'radio' : 'checkbox'} name="metric" checked={cols.includes(c.name)} onChange={() => toggle(c.name)} /> {c.name}{(c.masked || c.sensitive) && <span className="mask" title="Redacted or sensitive: not allowed as input">◐</span>}</label>) : <span className="muted">No numeric columns in the output.</span>}</div>
          <div className="form-grid">{PARAMS[kind].map(([k, l, ph]) => <Field key={k} label={l}><input inputMode="decimal" placeholder={ph} value={p[k] ?? ''} onChange={(e) => { setP({ ...p, [k]: e.target.value }); setCheck(null); }} /></Field>)}</div>
          <ErrorBox error={validate.error ?? add.error} />
          <div className="row"><Button busy={validate.busy} onClick={() => validate.run()}>Validate</Button><Button primary busy={add.busy} onClick={() => add.run()}>Add to saved query (new version)</Button></div>
          {check && (check.ok ? <Note tone="good">Valid for the current output. <Json value={check.config} label="Normalized configuration" /></Note> : <Note tone="bad"><strong>Not valid</strong><ul>{check.issues.map((i: any, n: number) => <li key={n}><Signal status="failed" label={i.field || i.code} /> {i.message}</li>)}</ul></Note>)}
        </Section>)}
    </div>
  );
}
