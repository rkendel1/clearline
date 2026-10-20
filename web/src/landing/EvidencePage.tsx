import { enc, request } from '../lib/api';
import { useRoute } from '../lib/router';
import { useLoad } from '../lib/useLoad';
import { Async, Facts, Grid, Note, Page, Section } from '../ui';

interface Evidence {
  id: string; tool: string; title: string; computed_at: string; source: string; trust_scope: string; execution_id?: string; sql_sha256?: string; sql?: string; policy_epoch?: number; contract_version?: string;
  measure?: { id: string; title: string; definition: string; unit: string; entity: string; aggregation: string }; window?: { from: string; to: string }; compare?: { a: { from: string; to: string }; b: { from: string; to: string } }; grouping?: string[];
  columns: { name: string; type?: string }[]; rows: unknown[][]; row_count: number; truncated: boolean; qualifications: string[]; limitations: string[];
}

/** The recorded computation behind a data answer: what was asked, how it is defined, the exact window, the result and its limits. */
export function EvidencePage() {
  const id = useRoute().query.get('id') ?? '';
  const load = useLoad((s) => request<Evidence>('GET', `/api/public/assistant/evidence?id=${enc(id)}`, undefined, { signal: s }), [id]);
  return (
    <div className="landing"><Page title="Answer evidence" sub={<><button className="linklike" onClick={() => window.history.back()}>← Back</button> · The recorded computation behind an assistant answer</>}>
      <Async load={load}>{(e) => (<>
        <Section title={e.title}>
          <Note tone="idle">This is the result as it was computed at {new Date(e.computed_at).toLocaleString()}. If the underlying data has changed since, asking again computes a new result; this record is never updated.</Note>
          <Facts items={[
            ['Computed', new Date(e.computed_at).toLocaleString()], ['Operation', e.tool.replace(/_/g, ' ')], ['Metric', e.measure ? `${e.measure.title} (${e.measure.id})` : '—'], ['Definition', e.measure?.definition ?? '—'],
            ['Aggregation', e.measure?.aggregation ?? '—'], ['Window', e.window ? `${e.window.from} to ${e.window.to}` : e.compare ? `${e.compare.b.from} to ${e.compare.b.to} versus ${e.compare.a.from} to ${e.compare.a.to}` : '—'],
            ['Grouping', e.grouping?.length ? e.grouping.join(', ') : 'none'], ['Data scope', e.trust_scope], ['Contract version', e.contract_version ?? '—'],
            ['Execution', e.execution_id ?? '—'], ['SQL digest', e.sql_sha256 ? e.sql_sha256.slice(0, 16) : '—'], ['Policy epoch', e.policy_epoch !== undefined ? String(e.policy_epoch) : '—']]} />
        </Section>
        <Section title="Result"><Grid columns={e.columns} rows={e.rows} />{e.truncated && <p className="muted small">Truncated.</p>}</Section>
        {e.qualifications.length > 0 && <Section title="Qualifications"><ul>{e.qualifications.map((q) => <li key={q}>{q}</li>)}</ul></Section>}
        <Section title="Limitations"><ul>{e.limitations.map((q) => <li key={q}>{q}</li>)}</ul></Section>
        {e.sql && <Section title="Query"><pre className="code">{e.sql}</pre><p className="muted small">Generated from validated arguments, then validated again for the asking role and run read-only. It was not written by a language model.</p></Section>}
      </>)}</Async>
    </Page></div>
  );
}
