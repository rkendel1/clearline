import { request, t } from '../lib/api';
import { useLoad } from '../lib/useLoad';
import { Async, Page, Section, Table } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Metrics() {
  const load = useLoad((s) => request<any>('GET', t('/metrics/definitions'), undefined, { signal: s }), []);
  const cols = [{ head: 'Metric', cell: (m: any) => <><strong>{m.title ?? m.id}</strong><div className="muted small mono">{m.id}</div></> }, { head: 'Definition', cell: (m: any) => m.description ?? m.definition ?? '' },
    { head: 'Unit', cell: (m: any) => m.unit ?? '' }, { head: 'Source', cell: (m: any) => m.source ?? '' }, { head: 'Trust scope', cell: (m: any) => m.trust_scope ?? '' }];
  return (
    <Page title="Metric definitions" sub="Every reported number, how it is defined and which data it counts.">
      <Async load={load}>{(d) => (<>
        <Section title={`Declared by contract ${d.contract_version ?? ''}`}><Table rows={d.declared ?? []} cols={cols} empty="None declared." /></Section>
        <Section title="Platform-defined"><Table rows={d.platform ?? []} cols={cols} empty="None." /></Section>
      </>)}</Async>
    </Page>
  );
}
