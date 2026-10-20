import { request, session, t } from '../lib/api';
import { count, ms, num, pct, when } from '../lib/format';
import { href } from '../lib/router';
import { useAction, useLoad } from '../lib/useLoad';
import { Async, Button, ErrorBox, Facts, Note, Page, Section, Signal, Stat, Table } from '../ui';
import { Bars } from '../Chart';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Overview() {
  const ops = useLoad((s) => request<any>('GET', t('/reports/operations'), undefined, { signal: s }), []);
  const biz = useLoad((s) => request<any>('GET', t('/reports/business'), undefined, { signal: s }), []);
  const recon = useAction(async () => { await request('POST', t('/reconciliation/run'), {}); ops.reload(); biz.reload(); });
  return (
    <Page title="Overview" sub={ops.data ? `Tenant ${ops.data.tenant} · contract ${ops.data.contract_version ?? '—'}` : undefined}
      actions={<><Button onClick={() => { ops.reload(); biz.reload(); }}>Refresh</Button>{session.can('batch:replay') && <Button busy={recon.busy} onClick={() => recon.run()}>Run reconciliation</Button>}</>}>
      <ErrorBox error={recon.error} />
      <Async load={ops}>{(o) => (<>
        <Note tone={o.verdict.status === 'healthy' ? 'good' : o.verdict.status === 'failing' ? 'bad' : 'warn'}>
          <strong><Signal status={o.verdict.status} /> {o.verdict.summary}</strong>
          {o.verdict.problems?.length > 0 && <ul>{o.verdict.problems.map((p: string) => <li key={p}>{p}</li>)}</ul>}
        </Note>
        <div className="stats">
          <Stat label="Batches" value={count(o.totals.batches)} sub={`${count(o.totals.in_flight)} in flight`} />
          <Stat label="Succeeded" value={count(o.totals.succeeded)} status={o.totals.succeeded ? 'ok' : undefined} />
          <Stat label="Failed" value={count(o.totals.failed)} status={num(o.totals.failed) ? 'failed' : undefined} />
          <Stat label="Untrusted" value={count(o.totals.untrusted)} status={num(o.totals.untrusted) ? 'warn' : undefined} />
          <Stat label="Rows received" value={count(o.totals.rows_received)} sub={`${count(o.totals.rows_accepted)} accepted`} />
          <Stat label="Quarantined" value={count(o.totals.rows_quarantined)} status={num(o.totals.rows_quarantined) ? 'warn' : undefined} />
          <Stat label="Latency p50 / p95" value={`${ms(num(o.totals.latency_p50_s) !== null ? num(o.totals.latency_p50_s)! * 1000 : null)} / ${ms(num(o.totals.latency_p95_s) !== null ? num(o.totals.latency_p95_s)! * 1000 : null)}`} />
          <Stat label="Queue" value={`${count(o.queue.queued)} / ${count(o.queue.processing)}`} sub="queued / processing" />
        </div>
        <Section title="Daily volume" hint="Rows received and quarantined per day.">
          <Bars data={o.daily.map((d: any) => ({ label: d.day, a: d.rows_received, b: d.rows_quarantined }))} aLabel="Received" bLabel="Quarantined" />
        </Section>
        <Section title="Freshness">
          <Table rows={o.freshness} empty="No sources yet." cols={[
            { head: 'Source', cell: (r: any) => r.source_id }, { head: 'Entity', cell: (r: any) => r.entity },
            { head: 'Last trusted', cell: (r: any) => when(r.last_trusted) }, { head: 'Age (h)', num: true, cell: (r: any) => num(r.age_hours)?.toFixed(1) ?? '—' },
            { head: 'Allowed (h)', num: true, cell: (r: any) => count(r.max_age_hours) }, { head: 'Status', cell: (r: any) => <Signal status={r.status} /> }]} />
        </Section>
        <Section title="Dataset reconciliation" hint={`${count(o.reconciliation.batches_failed)} batch reconciliation checks failing.`}>
          <Table rows={o.reconciliation.latest_dataset_run} empty="No dataset-level run yet." cols={[
            { head: 'Check', cell: (r: any) => r.check_id }, { head: 'Status', cell: (r: any) => <Signal status={r.status} /> }, { head: 'Explanation', cell: (r: any) => r.explanation }]} />
        </Section>
        <Section title="Recent batches">
          <Table rows={o.recent_batches} onRow={(r: any) => { window.location.hash = href('batches', r.id).slice(1); }} cols={[
            { head: 'Batch', cell: (r: any) => <a href={href('batches', r.id)}>{String(r.id).slice(0, 8)}</a> }, { head: 'Source', cell: (r: any) => r.source_id }, { head: 'Entity', cell: (r: any) => r.entity },
            { head: 'Status', cell: (r: any) => <Signal status={r.status} /> }, { head: 'Trust', cell: (r: any) => <Signal status={r.trust_status} /> },
            { head: 'Received', num: true, cell: (r: any) => count(r.received_count) }, { head: 'Quarantined', num: true, cell: (r: any) => count(r.quarantined_count) }, { head: 'Arrived', cell: (r: any) => when(r.arrival_at) }]} />
        </Section>
      </>)}</Async>
      <Async load={biz}>{(b) => (
        <Section title="Business metrics" hint="Contract-declared metrics over trusted data. Values with failing dataset checks are marked.">
          <div className="stats">
            {b.metrics.map((m: any) => (
              <Stat key={m.id} label={m.title} value={m.withheld ? 'withheld' : count(m.value)} status={m.withheld ? 'warn' : m.trusted ? 'ok' : 'warn'}
                sub={m.withheld ?? (num(m.untrusted_records_excluded) ? `${count(m.untrusted_records_excluded)} untrusted records excluded` : m.unit)} />))}
            <Stat label="Exception rate" value={pct(b.exception_rate.rate)} sub={`${count(b.exception_rate.quarantined)} of ${count(b.exception_rate.received)} rows`} />
          </div>
          {b.metrics.filter((m: any) => m.dataset_checks_failing?.length).map((m: any) => <Note key={m.id} tone="warn"><strong>{m.title}</strong>: {m.dataset_checks_failing.map((c: any) => c.explanation).join('; ')}</Note>)}
          <Facts items={[['Contract version', b.contract_version]]} />
        </Section>)}</Async>
    </Page>
  );
}
