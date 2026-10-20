import { useState } from 'react';
import { download, request, saveBlob, t, enc, qs } from '../lib/api';
import { useAction, useLoad } from '../lib/useLoad';
import { Async, Button, ErrorBox, Facts, Json, Note, Page, Section, Table } from '../ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function Extracts() {
  const load = useLoad((s) => request<any[]>('GET', t('/extracts'), undefined, { signal: s }), []);
  const [untrusted, setUntrusted] = useState(false);
  const [asOf, setAsOf] = useState('');
  const [meta, setMeta] = useState<Record<string, string> | null>(null);
  const run = useAction(async (id: string) => {
    const r = await download('GET', t(`/extracts/${enc(id)}/csv${qs({ include_untrusted: untrusted, as_of: asOf ? new Date(asOf).toISOString() : undefined })}`));
    saveBlob(r.blob, r.filename);
    const m: Record<string, string> = {}; r.headers.forEach((v, k) => { if (k.startsWith('x-clearline-')) m[k.slice(12)] = v; }); setMeta(m);
  });
  return (
    <Page title="Extracts" sub="Reproducible CSV extracts with explicit schemas. Sensitive fields follow your role's field policy.">
      <Section title="Options">
        <div className="row"><label className="row"><input type="checkbox" checked={untrusted} onChange={(e) => setUntrusted(e.target.checked)} /> Include untrusted data</label>
          <label className="row">As of <input type="datetime-local" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label></div>
      </Section>
      <ErrorBox error={run.error} />
      {meta && <Note tone="good"><Facts items={Object.entries(meta)} /></Note>}
      <Async load={load}>{(rows) => (
        <Section><Table rows={rows} empty="No extracts declared." cols={[
          { head: 'Extract', cell: (x) => <><strong>{x.id ?? x.extract_id}</strong><div className="muted small">{x.description}</div></> },
          { head: 'Columns', cell: (x) => (x.columns ?? []).map((c: any) => c.name ?? c).join(', ') },
          { head: 'Schema', cell: (x) => <Json value={x} label="schema" /> },
          { head: '', cell: (x) => <Button primary busy={run.busy} onClick={() => run.run(x.id ?? x.extract_id)}>Download CSV</Button> }]} /></Section>)}</Async>
    </Page>
  );
}
