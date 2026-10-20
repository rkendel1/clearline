import { useEffect, useState } from 'react';
import { request, session } from './api';

// Mirrors src/assistant/content.ts. Served by GET /api/public/content (no account needed).
export interface Ref { label: string; path: string }
export interface Component { id: string; name: string; layer: string; status: 'implemented' | 'partial' | 'planned'; layout: { x: number; y: number; w: number; h: number }; summary: string;
  responsibility: string; inputs: string[]; outputs: string[]; dependencies: string[]; data: string; security: string; failure_modes: string[]; why: string; decisions: string[]; refs: Ref[] }
export interface Edge { from: string; to: string; kind: 'sync' | 'async' | 'retrieval' | 'planned'; label: string }
export interface Boundary { id: string; label: string; x: number; y: number; w: number; h: number; enforced_by: string }
export interface Capability { id: string; name: string; status: string; actors: string[]; description: string; business_value: string; use_case: string; scenarios: string[];
  evidence: { type: string; path: string }[]; docs: string[]; demo: { view: string; label: string }; limitations: string[]; verification: { doc: string; commit?: string; note: string } }
export interface Decision { id: string; letter: string; title: string; tags: string[]; rationale_note: string; context: string; decision: string; alternatives: string[]; advantages: string[]; costs: string[];
  risks: string[]; revisit_when: string; implementation_evidence: string[]; refs: Ref[]; components: string[] }
export interface Actor { id: string; name: string; goal: string; questions: string[]; areas: string[]; components: string[]; decisions: string[] }
export interface Content { components: Component[]; diagram: { edges: Edge[]; boundaries: Boundary[] }; capabilities: Capability[]; status_labels: string[]; decisions: Decision[]; decision_tags: [string, string][];
  actors: Actor[]; site: { problems: { title: string; body: string }[]; limitations: string[]; scenarios: [string, string, string][]; recorded_commit: string } }

let cached: Promise<Content> | undefined;
export const loadContent = () => (cached ??= request<Content>('GET', '/api/public/content').catch((e) => { cached = undefined; throw e; }));

export function useContent() {
  const [c, setC] = useState<Content | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { loadContent().then(setC, (e) => setError(e.message)); }, []);
  return { content: c, error };
}

// ---- destinations: every link the assistant or a citation can produce maps through this fixed table.
export type Dest = { kind: 'component' | 'decision' | 'capability' | 'actor'; id: string } | { kind: 'section'; id: string } | { kind: 'source'; path: string } | { kind: 'evidence'; id: string } | { kind: 'demo'; view: string } | { kind: 'signin' };
const SECTIONS = ['why', 'architecture', 'capabilities', 'actors', 'decisions', 'scenarios', 'limits'];
const DEMO_VIEWS = ['', 'batches', 'exceptions', 'records', 'lineage', 'extracts', 'query', 'history', 'saved', 'runs', 'notifications', 'destinations', 'contracts', 'metrics', 'fields', 'audit'];

export function destHref(d: Dest): string | null {
  const base = session.token ? '#/about' : '#/';
  switch (d.kind) {
    case 'component': return `${base}?s=architecture&component=${encodeURIComponent(d.id)}`;
    case 'decision': return `${base}?s=decisions&decision=${encodeURIComponent(d.id)}`;
    case 'capability': return `${base}?s=capabilities&capability=${encodeURIComponent(d.id)}`;
    case 'actor': return `${base}?s=actors&actor=${encodeURIComponent(d.id)}`;
    case 'section': return SECTIONS.includes(d.id) ? `${base}?s=${d.id}` : null;
    case 'source': return /^(README\.md|docs\/[A-Za-z0-9_./-]+\.md)$/.test(d.path) && !d.path.includes('..') ? `#/source?path=${encodeURIComponent(d.path)}` : null;
    case 'evidence': return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.id) ? `#/evidence?id=${d.id}` : null;
    case 'demo': return session.token && DEMO_VIEWS.includes(d.view) ? `#/${d.view}` : '#/signin';
    case 'signin': return session.token ? '#/' : '#/signin';
    default: return null;     // a destination kind this table does not know is never linked
  }
}
