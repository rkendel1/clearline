import { useState } from 'react';
import { request, t, qs } from '../lib/api';
import { count, ms, short, when } from '../lib/format';
import { go, href } from '../lib/router';
import { useLoad } from '../lib/useLoad';
import { Async, Button, Page, Section, Signal, Table } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
const FILTERS = ['', 'queued', 'running', 'delivering', 'succeeded', 'failed', 'cancelled'];
export function Runs() {
  const [status, setStatus] = useState('');
  const load = useLoad((s) => request<any>('GET', t(`/analytics/runs${qs({ status, limit: 100 })}`), undefined, { signal: s }), [status]);
  return (
    <Page title="Run history" sub="Scheduled and manual runs of saved queries." actions={<>
      <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">{FILTERS.map((f) => <option key={f} value={f}>{f || 'All statuses'}</option>)}</select><Button onClick={load.reload}>Refresh</Button></>}>
      <Async load={load}>{(d) => (
        <Section><Table rows={d.items} empty="No runs." onRow={(r) => go('runs', r.id)} cols={[
          { head: 'Run', cell: (r) => <a href={href('runs', r.id)}>{short(r.id)}</a> }, { head: 'Query', cell: (r) => <a href={href('saved', r.query_id)}>{r.query_name}</a> }, { head: 'v', num: true, cell: (r) => r.query_version },
          { head: 'Trigger', cell: (r) => r.trigger }, { head: 'Status', cell: (r) => <Signal status={r.status} /> },
          { head: 'Query / analyses / delivery', cell: (r) => <span className="row"><Signal status={r.query_status} /><Signal status={r.analysis_status} /><Signal status={r.delivery_status} /></span> },
          { head: 'Rows', num: true, cell: (r) => count(r.result?.row_count) }, { head: 'Took', num: true, cell: (r) => ms(r.timings?.total_ms ?? r.timings?.query_ms) }, { head: 'Created', cell: (r) => when(r.created_at) }]} /></Section>)}</Async>
    </Page>
  );
}
