import { describe, expect, it } from 'vitest';
import { destHref } from './content';

// Every link the assistant or a citation can produce goes through this table. Anything that is not a known
// destination kind, or has a malformed id or path, must produce no link at all.
describe('destHref', () => {
  it('maps known destinations to in-app hash routes', () => {
    expect(destHref({ kind: 'component', id: 'api' })).toBe('#/?s=architecture&component=api');
    expect(destHref({ kind: 'decision', id: 'D-postgres' })).toBe('#/?s=decisions&decision=D-postgres');
    expect(destHref({ kind: 'section', id: 'limits' })).toBe('#/?s=limits');
    expect(destHref({ kind: 'source', path: 'docs/adr/0002-postgres-as-queue.md' })).toBe('#/source?path=docs%2Fadr%2F0002-postgres-as-queue.md');
    expect(destHref({ kind: 'evidence', id: '11111111-2222-3333-4444-555555555555' })).toBe('#/evidence?id=11111111-2222-3333-4444-555555555555');
    expect(destHref({ kind: 'signin' })).toBe('#/signin');
  });
  it('refuses unknown sections, malformed ids, traversal and every URL-like input', () => {
    const bad: unknown[] = [
      { kind: 'section', id: 'admin' }, { kind: 'evidence', id: 'not-a-uuid' }, { kind: 'evidence', id: '../../x' },
      { kind: 'source', path: '../.env' }, { kind: 'source', path: 'docs/../../secret.md' }, { kind: 'source', path: 'https://evil.example/a.md' }, { kind: 'source', path: 'src/main.ts' },
      { kind: 'url', href: 'https://evil.example' }, { kind: 'javascript', href: 'javascript:alert(1)' }, {},
    ];
    for (const d of bad) expect(destHref(d as never), JSON.stringify(d)).toBeNull();
  });
  it('sends demo links to sign-in unless a session exists, and never to an unknown view', () => {
    expect(destHref({ kind: 'demo', view: 'query' })).toBe('#/signin');
    expect(destHref({ kind: 'demo', view: 'javascript:alert(1)' })).toBe('#/signin');
  });
});
