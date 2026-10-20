import { useState } from 'react';
import { request, session, t, qs } from '../lib/api';
import { count, ms, when } from '../lib/format';
import { useLoad } from '../lib/useLoad';
import { Async, Button, Page, Section, Signal, Table, Tag } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function History() {
  const [all, setAll] = useState(false);
  const load = useLoad((s) => request<any>('GET', t(`/queries/history${qs({ all: all || undefined, limit: 100 })}`), undefined, { signal: s }), [all]);
  return (
    <Page title="Query history" sub="Questions and SQL proposed, validated and run. History is re-evaluated against your current access." actions={<>
      {session.can('query:history_all') && <label className="row"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Whole tenant</label>}
      <Button onClick={load.reload}>Refresh</Button></>}>
      <Async load={load}>{(h) => (
        <Section><Table rows={h.items} empty="Nothing yet." cols={[
          { head: 'When', cell: (i) => when(i.created_at) }, { head: 'By', cell: (i) => `${i.actor} (${i.role})` }, { head: 'Question / SQL', cell: (i) => i.withheld ? <span className="muted">withheld: your access has narrowed</span> : <><div>{i.question}</div><div className="mono small muted">{(i.validated_sql ?? i.proposed_sql ?? '').slice(0, 160)}</div></> },
          { head: 'Status', cell: (i) => <><Signal status={i.status} />{i.stale_policy && <> <Tag>policy changed</Tag></>}</> },
          { head: 'Runs', cell: (i) => (i.executions ?? []).map((e: any) => <div key={e.id} className="small"><Signal status={e.status} /> {e.mode} · {count(e.row_count)} rows · {ms(e.duration_ms)}</div>) },
          { head: '', cell: (i) => !i.withheld && (i.validated_sql || i.proposed_sql) && <a href={`#/query?proposal=${i.id}`}>Open in workspace</a> }]} /></Section>)}</Async>
    </Page>
  );
}
