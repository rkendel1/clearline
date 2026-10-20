import { useEffect, useState } from 'react';

// Hash routes (#/runs/abc?x=1) keep the server free of client-route knowledge and survive reloads of the shell.
export function parse(hash: string): { path: string[]; query: URLSearchParams } {
  const [p, q] = hash.replace(/^#\/?/, '').split('?');
  return { path: p.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q ?? '') };
}

export function useRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => { const f = () => setHash(window.location.hash); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return parse(hash);
}

export const href = (...parts: (string | number)[]) => `#/${parts.map((p) => encodeURIComponent(String(p))).join('/')}`;
export const go = (...parts: (string | number)[]) => { window.location.hash = href(...parts); };
