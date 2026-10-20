import type { ReactNode } from 'react';

// A deliberately tiny renderer for assistant text: paragraphs, bullet lists, **bold**, `code` and [n] citation
// markers. It builds React elements only (never HTML strings), so model output cannot inject markup or links.
export function RichText({ text, onCite }: { text: string; onCite?: (n: number) => void }) {
  const inline = (s: string): ReactNode[] => {
    const out: ReactNode[] = [];
    const re = /(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g;
    let last = 0, m: RegExpExecArray | null, k = 0;
    while ((m = re.exec(s))) {
      if (m.index > last) out.push(s.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('**')) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
      else if (t.startsWith('`')) out.push(<code key={k++} className="mono">{t.slice(1, -1)}</code>);
      else { const n = Number(t.slice(1, -1)); out.push(<button key={k++} className="cite" onClick={() => onCite?.(n)} aria-label={`Source ${n}`}>{n}</button>); }
      last = m.index + t.length;
    }
    if (last < s.length) out.push(s.slice(last));
    return out;
  };
  const blocks = text.split(/\n{2,}/);
  return (
    <>{blocks.map((b, i) => {
      const lines = b.split('\n');
      if (lines.every((l) => /^\s*[-*] /.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*] /, ''))}</li>)}</ul>;
      return <p key={i}>{lines.map((l, j) => <span key={j}>{j > 0 && <br />}{inline(l.replace(/^#{1,4} /, ''))}</span>)}</p>;
    })}</>
  );
}
