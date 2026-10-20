import { useEffect, useState } from 'react';
import { download, enc, request, saveBlob, session, t } from '../lib/api';
import { count, ms, num, short, when } from '../lib/format';
import { go, href } from '../lib/router';
import { useAction, useLoad } from '../lib/useLoad';
import { SeriesChart, type Pt } from '../Chart';
import { Async, Button, ErrorBox, Facts, Field, Grid, Json, Note, Page, Section, Signal, Table, Tag } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const ACTIVE = ['queued', 'running', 'delivering'];

export function Run({ id }: { id: string }) {
  const load = useLoad((s) => request<any>('GET', t(`/analytics/runs/${enc(id)}`), undefined, { signal: s }), [id]);
  const [offset, setOffset] = useState(0);
  const ready = !!load.data && load.data.access.data && !!load.data.run.result;
  const page = useLoad((s) => (ready ? request<any>('GET', t(`/analytics/runs/${enc(id)}/result?offset=${offset}&limit=200`), undefined, { signal: s }) : Promise.resolve(null)), [id, offset, ready]);
  // Poll while the run is active (the scheduler executes it in the worker).
  const active = load.data ? ACTIVE.includes(load.data.run.status) : false;
  useEffect(() => { if (!active) return; const h = setInterval(load.reload, 2000); return () => clearInterval(h); }, [active]);  // eslint-disable-line react-hooks/exhaustive-deps
  const rerun = useAction(async () => { const r = await request<any>('POST', t(`/analytics/runs/${enc(id)}/rerun`), {}); go('runs', r.run_id); });
  const cancel = useAction(async () => { await request('POST', t(`/analytics/runs/${enc(id)}/cancel`), {}); load.reload(); });
  const retry = useAction(async () => { await request('POST', t(`/analytics/runs/${enc(id)}/retry-deliveries`), {}); load.reload(); });
  const d = load.data;
  return (
    <Page title={d ? `Run of “${d.query.name}”` : 'Run'} sub={<><a href="#/runs">← Run history</a>{d && <> · {d.run.trigger} run {short(d.run.id)} · version {d.run.query_version} · ran as {d.run.run_as.actor} ({d.run.run_as.role}) · {when(d.run.created_at)}</>}</>}
      actions={d && <>
        <a className="btn" href={href('saved', d.query.id)}>Open saved query</a>
        {d.run.status === 'queued' && session.can('analysis:run') && <Button busy={cancel.busy} onClick={() => cancel.run()}>Cancel</Button>}
        <Button disabled={!session.can('analysis:run')} busy={rerun.busy} onClick={() => rerun.run()}>Rerun</Button>
        <Button primary onClick={load.reload}>Refresh</Button></>}>
      <ErrorBox error={rerun.error ?? cancel.error ?? retry.error} />
      <Async load={load}>{(x) => (<>
        <div className="row" aria-live="polite"><strong>Outcome</strong><Signal status={x.run.status} /><span className="muted">query</span><Signal status={x.run.query_status} /><span className="muted">analyses</span><Signal status={x.run.analysis_status} /><span className="muted">delivery</span><Signal status={x.run.delivery_status} />{active && <span className="muted small">updating…</span>}</div>
        {x.run.error_message && <Note tone="bad"><strong>{x.run.error_message}</strong> <span className="mono">{x.run.error_code}</span>{x.run.failure_class && <> · {x.run.failure_class}</>}</Note>}
        {!x.access.data && <Note tone="warn">Result data is withheld: {x.access.reason ?? 'your access has narrowed since this run'}.</Note>}
        {x.access.remasked_columns?.length > 0 && <Note tone="warn">Re-masked for your role now: {x.access.remasked_columns.join(', ')}.</Note>}
        <Section title="Timings and parameters"><Facts items={[['Attempt', `${x.run.attempt} of ${x.run.max_attempts}`], ['Started', when(x.run.started_at)], ['Finished', when(x.run.finished_at)],
          ['Rows', x.run.result ? `${count(x.run.result.row_count)}${x.run.result.truncated ? ' (truncated)' : ''}` : '—'], ['Scheduled for', when(x.run.occurrence_at)], ['Missed occurrences', String(x.run.missed_occurrences ?? 0)]]} />
          <Json value={{ timings: x.run.timings, parameters: x.run.parameters }} label="Phase timings & parameters" /></Section>
        {(x.insights.length > 0 || x.insights_withheld > 0) && <Section title="Insights" hint="Computed by the listed methods from this run's authorized result. Statistical findings, not explanations of their causes.">
          {x.insights_withheld > 0 && <Note tone="warn">{x.insights_withheld} insights are withheld: they depend on columns redacted for your role.</Note>}
          {x.insights.map((i: any) => <Note key={i.id} tone={i.severity === 'high' ? 'bad' : i.severity === 'medium' ? 'warn' : 'idle'}><strong><Signal status={i.severity} /> {i.title}</strong><div>{i.body}</div>{i.narrative?.text && <div className="muted small">{i.narrative.text} <Tag>{i.narrative.provider}</Tag></div>}</Note>)}</Section>}
        {x.analyses.map((a: any) => <Analysis key={a.id} a={a} onReviewed={load.reload} />)}
        <Section title="Deliveries" actions={x.deliveries.some((v: any) => ['failed', 'blocked', 'retrying'].includes(v.status)) && session.can('schedule:manage') && <Button busy={retry.busy} onClick={() => retry.run()}>Retry failed</Button>}>
          <Table rows={x.deliveries} empty="No deliveries for this run." cols={[{ head: 'Destination', cell: (v: any) => v.destination }, { head: 'Kind', cell: (v: any) => v.kind }, { head: 'Status', cell: (v: any) => <Signal status={v.status} /> },
            { head: 'Attempts', cell: (v: any) => `${v.attempts}/${v.max_attempts}` }, { head: 'Delivered', cell: (v: any) => when(v.delivered_at) }, { head: 'Last error', cell: (v: any) => v.last_error ?? '' }]} />
          {x.exports?.length > 0 && <Table rows={x.exports} cols={[{ head: 'Export', cell: (e: any) => e.id }, { head: 'Expires', cell: (e: any) => when(e.expires_at) }, { head: '', cell: (e: any) => <a href="#" onClick={async (ev) => { ev.preventDefault(); const r = await download('GET', t(`/analytics/exports/${enc(e.id)}/download`)); saveBlob(r.blob, r.filename); }}>Download CSV</a> }]} />}
        </Section>
        <Section title="Result" hint={page.data ? `${count(page.data.row_count)} rows${page.data.truncated ? ', truncated' : ''} (the run's bounded snapshot, as your role may see it now).` : undefined}>
          <Async load={page}>{(p) => p ? <><Grid columns={p.columns} rows={p.rows} />
            <div className="row pager"><Button disabled={offset <= 0} onClick={() => setOffset(Math.max(0, offset - 200))}>Previous</Button><span className="muted small">{p.offset + 1}–{Math.min(p.row_count, p.offset + p.rows.length)} of {count(p.row_count)}</span><Button disabled={offset + 200 >= p.row_count} onClick={() => setOffset(offset + 200)}>Next</Button></div></> : <p className="muted">No result available.</p>}</Async>
        </Section>
      </>)}</Async>
    </Page>
  );
}

function series(a: any): { title: string; points: Pt[] }[] {
  if (a.status !== 'succeeded' || a.withheld) return [];
  if (a.type === 'anomaly') return (a.result.metrics ?? []).map((m: any) => {
    const marks = new Map<string, string>((m.anomalies ?? []).map((x: any) => [x.t, x.severity]));
    return { title: `${m.metric}: observed (line), expected range (band), anomalies (dots)`, points: (m.points ?? []).map((p: any) => ({ label: p.t, observed: num(p.observed), lower: num(p.lower), upper: num(p.upper), expected: num(p.expected), marker: marks.has(p.t) ? (marks.get(p.t) === 'high' ? 'high' : 'other') : null })) };
  });
  if (a.type === 'forecast') {
    const pts: Pt[] = (a.result.history ?? []).map((h: any) => ({ label: h.t, observed: num(h.value) }));
    if (pts.length) pts[pts.length - 1].forecast = pts[pts.length - 1].observed;
    pts.push(...(a.result.forecast ?? []).map((f: any) => ({ label: f.t, forecast: num(f.value), lower: num(f.lower), upper: num(f.upper) })));
    return [{ title: `${a.config.metric}: history and forecast (interval band)`, points: pts }];
  }
  return [];
}

function Analysis({ a, onReviewed }: { a: any; onReviewed: () => void }) {
  const clusters: any[] = a.type === 'cluster' ? a.result?.clusters ?? [] : [];
  const reviewed: Record<string, string> = a.review?.names ?? {};
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(clusters.map((c) => [String(c.cluster), reviewed[String(c.cluster)] ?? ''])));
  const save = useAction(async () => { await request('POST', t(`/analytics/analyses/${enc(a.id)}/review`), { cluster_names: Object.fromEntries(Object.entries(names).filter(([, v]) => v.trim())) }); onReviewed(); });
  const r = a.result ?? {};
  const feats: string[] = r.features ?? [];
  return (
    <Section title={a.config?.label ?? a.key} actions={<><Tag>{a.algorithm} v{a.algorithm_version}</Tag><Signal status={a.status} /></>}
      hint={`${a.input_rows ?? 0} input rows · prepare ${ms(a.timings?.prepare_ms)} · algorithm ${ms(a.timings?.algorithm_ms)}`}>
      {a.message && <Note tone={a.status === 'succeeded' ? 'idle' : 'warn'}>{a.message}</Note>}
      {a.withheld && <Note tone="warn">Result withheld: it was computed over a column that is redacted for your role now.</Note>}
      {series(a).map((s, i) => <SeriesChart key={i} {...s} />)}
      {a.type === 'forecast' && a.status === 'succeeded' && r.backtest && <p className="muted small">Method {r.method} · backtest over {r.backtest.origins} rolling origins: MAE {String(r.backtest.mae)}, RMSE {String(r.backtest.rmse)}, MAPE {String(r.backtest.mape ?? '—')}, MASE {String(r.backtest.mase ?? '—')} · interval {String(r.interval ?? '')} (coverage on the backtest {String(r.backtest.interval_coverage ?? '—')})</p>}
      {a.type === 'outlier' && a.status === 'succeeded' && <><Table rows={(r.records ?? []).slice(0, 15)} cols={[
        { head: 'Rank', num: true, cell: (x: any) => x.rank }, { head: 'Record', cell: (x: any) => x.id ?? `row ${x.row}` }, { head: 'Compared within', cell: (x: any) => x.group ?? 'all' }, { head: 'Score', num: true, cell: (x: any) => String(x.score) },
        { head: '', cell: (x: any) => x.flagged && <Signal status="warn" label="unusual" /> }, { head: 'Main contributions', cell: (x: any) => (x.contributions ?? []).slice(0, 2).map((c: any) => `${c.feature} ${Math.round(c.share * 100)}%`).join(', ') }]} />
        <p className="muted small">{String(r.flagged)} of {String(r.scored)} records reach the threshold. Unusual relative to comparable records is not the same as wrong.</p></>}
      {a.type === 'cluster' && a.status === 'succeeded' && <>
        <Table rows={clusters} cols={[{ head: 'Cluster', cell: (c: any) => reviewed[String(c.cluster)] ? `${reviewed[String(c.cluster)]} (reviewed)` : c.label }, { head: 'Size', num: true, cell: (c: any) => c.size }, ...feats.map((f) => ({ head: f, num: true, cell: (c: any) => String(c.centroid?.[f] ?? '') }))]} />
        <p className="muted small">Mean silhouette {String(r.silhouette)} (1 = well separated). {r.scaling?.method} scaling. Statistical groupings: review and name them before treating them as business segments.</p>
        {session.can('analysis:run') && <div className="row">{clusters.map((c) => <Field key={c.cluster} label={`Name for cluster ${c.cluster}`}><input value={names[String(c.cluster)] ?? ''} onChange={(e) => setNames({ ...names, [String(c.cluster)]: e.target.value })} /></Field>)}<Button busy={save.busy} onClick={() => save.run()}>Save names</Button></div>}
        <ErrorBox error={save.error} /></>}
      {Array.isArray(r.limitations) && r.limitations.map((l: string, i: number) => <p key={i} className="muted small">Limitation: {l}</p>)}
      {a.quality && Object.keys(a.quality).length > 0 && <Json value={a.quality} label="Quality / evaluation metrics" />}
    </Section>
  );
}
