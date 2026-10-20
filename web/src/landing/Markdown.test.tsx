import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RichText } from './Markdown';

// Assistant text comes from a model and from retrieved documents: it is untrusted. The renderer builds React
// elements only, so nothing in it can become markup, a link or an event handler.
describe('RichText', () => {
  const html = (t: string) => renderToStaticMarkup(<RichText text={t} />);
  it('escapes markup instead of rendering it', () => {
    const out = html('<img src=x onerror="alert(1)"> <script>alert(2)</script> <a href="javascript:alert(3)">x</a>');
    expect(out).not.toMatch(/<img|<script|<a[ >]/i);
    expect(out).toContain('&lt;img');
    expect(out).toContain('&lt;script&gt;');
  });
  it('never creates links, even from markdown link syntax or bare URLs', () => {
    const out = html('[click](https://evil.example) https://evil.example/login [1]');
    expect(out).not.toMatch(/<a[ >]/i);
    expect(out).not.toMatch(/href=/i);
  });
  it('renders bold, code, lists and citation markers as plain elements', () => {
    const out = html('**Bold** and `code` [2]\n\n- one\n- two');
    expect(out).toContain('<strong>Bold</strong>');
    expect(out).toContain('<code class="mono">code</code>');
    expect(out).toContain('<button class="cite"');
    expect(out).toContain('<li>one</li>');
  });
  it('carries no event-handler attributes or inline styles (the page policy forbids them)', () => {
    expect(html('x [1] **y** `z` - a')).not.toMatch(/\son[a-z]+=|style=/i);
  });
});
