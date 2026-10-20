import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, request, session } from '../lib/api';
import { destHref, loadContent, type Content, type Dest } from '../lib/content';
import { useRoute } from '../lib/router';
import { Link } from './Link';
import { RichText } from './Markdown';
import { type AssistantContext, onOpenAssistant } from './assistantBus';

interface Citation { n: number; id: string; title: string; heading: string; dest: Dest; score: number }
interface Action { label: string; dest: Dest }
interface Turn { role: 'user' | 'assistant'; text: string; mode?: string; category?: string; citations?: Citation[]; actions?: Action[]; notice?: string; evidence?: { retrieved: number; used: number; embedder?: string; model?: string; corpus_version?: string } }
interface Status { retrieval: { available: boolean; chunk_count?: number; embedder?: string; model?: string }; generator: { mode: 'model' | 'extractive'; model?: string } }

const SUGGESTED = [
  'Explain the architecture from ingestion to reporting.',
  'Why use a vector database?',
  'How does Clearline establish that a report is correct?',
  'What happens when a scheduled run fails?',
  'Which ML capabilities are implemented?',
  'What are the main architecture tradeoffs?',
  'Show me an example of anomaly detection.',
  'What would need to change to support a larger healthcare platform?',
];
const MODE_LABEL: Record<string, string> = { model: 'Written by a language model from the cited sources', extractive: 'Excerpts from the cited sources (no language model)', declined: 'Not answered', unavailable: 'Unavailable' };

/** Persistent assistant: a launcher and a side panel available on every screen. History lives for the browser session only; nothing is stored on the server. */
export function Assistant({ view }: { view?: string }) {
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [extra, setExtra] = useState<AssistantContext>({});
  const [names, setNames] = useState<Content | null>(null);
  useEffect(() => { loadContent().then(setNames, () => {}); }, []);
  const end = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const q = route.query;
  const context: AssistantContext = {
    component: extra.component ?? q.get('component') ?? undefined,
    capability: extra.capability ?? q.get('capability') ?? undefined,
    decision: extra.decision ?? q.get('decision') ?? undefined,
    view: view ?? extra.view,
  };
  const ctxLabel = context.component ? `Component: ${names?.components.find((x) => x.id === context.component)?.name ?? context.component}`
    : context.capability ? `Capability: ${names?.capabilities.find((x) => x.id === context.capability)?.name ?? context.capability}`
    : context.decision ? `Decision: ${names?.decisions.find((x) => x.id === context.decision)?.title ?? context.decision}`
    : view !== undefined ? `Screen: ${view || 'overview'}` : null;

  useEffect(() => onOpenAssistant((r) => { setOpen(true); setExtra(r.context); if (r.question) send(r.question, r.context); }), []);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open && !status) request<Status>('GET', '/api/public/assistant/status').then(setStatus, () => setStatus(null)); }, [open, status]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns, busy]);
  useEffect(() => { if (open) field.current?.focus(); }, [open]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, []);

  async function send(text: string, ctx: AssistantContext = context) {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    const history = turns.slice(-6).map((t) => ({ role: t.role, text: t.text.slice(0, 2000) }));
    setTurns((t) => [...t, { role: 'user', text: message }]);
    setBusy(true);
    try {
      const r = await request<Omit<Turn, 'role' | 'text'> & { answer: string }>('POST', '/api/public/assistant/ask', { message, history, context: { ...ctx, page: session.token ? 'app' : 'landing' } });
      setTurns((t) => [...t, { role: 'assistant', text: r.answer, mode: r.mode, category: r.category, citations: r.citations, actions: r.actions, notice: r.notice, evidence: r.evidence }]);
    } catch (e) {
      const err = e as ApiError;
      setTurns((t) => [...t, { role: 'assistant', mode: 'unavailable', text: err.code === 'rate_limited' ? err.message : err.status === 0 ? 'I cannot reach the Clearline server right now.' : `The assistant could not answer (${err.code}).` }]);
    } finally { setBusy(false); }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void send(input); };

  if (!open) return <button className="ask-launch btn primary" onClick={() => setOpen(true)} aria-haspopup="dialog">Ask Clearline</button>;
  return (
    <aside className="ask" role="dialog" aria-label="Ask Clearline">
      <header className="ask-head"><strong>Ask Clearline</strong><span className="grow" /><button className="btn" onClick={() => setTurns([])} disabled={!turns.length}>Clear</button><button className="btn" onClick={() => setOpen(false)} aria-label="Close assistant">Close</button></header>
      <div className="ask-body" aria-live="polite">
        {!turns.length && (
          <div className="ask-intro">
            <p>I can explain Clearline's architecture, design decisions, data flows, security controls and demonstration scenarios. Ask me why a decision was made, how a metric is defined, or what happens when a workflow fails.</p>
            <p className="muted small">I answer from approved documentation and cite it. I cannot yet answer questions about current values in the demo data: those need validated data tools, which are planned. Use the query workspace for them.</p>
            {status && !status.retrieval.available && <p className="note warn small">Document search is not available on this server yet, so I cannot answer reliably.</p>}
            {status && status.generator.mode === 'extractive' && <p className="muted small">No language model is configured here: answers will be excerpts from the sources.</p>}
            <div className="suggest">{SUGGESTED.map((s) => <button key={s} className="chip" onClick={() => send(s)}>{s}</button>)}</div>
          </div>)}
        {turns.map((t, i) => (
          <div key={i} className={`turn ${t.role}`}>
            {t.role === 'user' ? <p>{t.text}</p> : (
              <>
                <RichText text={t.text} onCite={(n) => document.getElementById(`cite-${i}-${n}`)?.focus()} />
                {t.mode && <p className={`mode small ${t.mode}`}>{MODE_LABEL[t.mode] ?? t.mode}</p>}
                {t.notice && <p className="note idle small">{t.notice}</p>}
                {t.citations && t.citations.length > 0 && (
                  <details open><summary className="small">Sources ({t.citations.length})</summary>
                    <ol className="cites">{t.citations.map((c) => { const h = destHref(c.dest); return <li key={c.n}>{h ? <Link to={h} className="small" onClick={() => setOpen(false)}><span id={`cite-${i}-${c.n}`} tabIndex={-1}>[{c.n}] {c.title}</span></Link> : <span className="small">[{c.n}] {c.title}</span>}<span className="muted small"> · {c.heading}</span></li>; })}</ol></details>)}
                {t.actions && t.actions.length > 0 && <div className="row actions">{t.actions.map((a, k) => { const h = destHref(a.dest); return h ? <Link key={k} to={h} className="chip" onClick={() => setOpen(false)}>{a.label}</Link> : null; })}</div>}
              </>)}
          </div>))}
        {busy && <div className="turn assistant muted" aria-busy="true">Searching the documentation…</div>}
        <div ref={end} />
      </div>
      <form className="ask-form" onSubmit={submit}>
        {ctxLabel && <p className="muted small ctx">Context: {ctxLabel}</p>}
        <div className="row">
          <textarea ref={field} rows={2} maxLength={1000} value={input} placeholder="Ask about the architecture, a decision, or a capability…" aria-label="Your question"
            onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }} />
          <button className="btn primary" type="submit" disabled={busy || !input.trim()}>Ask</button>
        </div>
      </form>
    </aside>
  );
}
