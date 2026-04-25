import { describe, expect, it } from 'vitest';
import { escape, html, renderToString, Html } from '@/shared/html.js';

describe('escape', () => {
  it('encodes the five HTML-special characters', () => {
    expect(escape('<')).toBe('&lt;');
    expect(escape('>')).toBe('&gt;');
    expect(escape('&')).toBe('&amp;');
    expect(escape('"')).toBe('&quot;');
    expect(escape("'")).toBe('&#39;');
  });

  it('handles a mixed string in one pass', () => {
    expect(escape('<a href="x">&y</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;y&lt;/a&gt;');
  });

  it('coerces non-strings via String()', () => {
    expect(escape(42)).toBe('42');
    expect(escape(true)).toBe('true');
  });

  it('treats null and undefined as empty strings', () => {
    expect(escape(null)).toBe('');
    expect(escape(undefined)).toBe('');
  });

  it('passes unicode through unchanged', () => {
    expect(escape('café — 日本語')).toBe('café — 日本語');
  });
});

describe('html tagged template', () => {
  it('returns an Html instance with the assembled string', () => {
    const out = html`<p>hello</p>`;
    expect(out).toBeInstanceOf(Html);
    expect(renderToString(out)).toBe('<p>hello</p>');
  });

  it('escapes interpolated user strings', () => {
    const name = '<script>alert(1)</script>';
    const out = html`<p>${name}</p>`;
    expect(renderToString(out)).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('does not double-escape nested Html values', () => {
    const inner = html`<em>${'<b>x</b>'}</em>`;
    const outer = html`<p>${inner}</p>`;
    expect(renderToString(outer)).toBe('<p><em>&lt;b&gt;x&lt;/b&gt;</em></p>');
  });

  it('flattens arrays of Html values', () => {
    const items = ['a', 'b', 'c'].map((c) => html`<li>${c}</li>`);
    // prettier-ignore
    const out = html`<ul>${items}</ul>`;
    expect(renderToString(out)).toBe('<ul><li>a</li><li>b</li><li>c</li></ul>');
  });

  it('renders null, undefined, and false as empty', () => {
    const out = html`<p>${null}${undefined}${false}done</p>`;
    expect(renderToString(out)).toBe('<p>done</p>');
  });

  it('escapes interpolation inside attribute contexts', () => {
    const danger = '" onclick="alert(1)';
    const out = html`<a href="${danger}">x</a>`;
    expect(renderToString(out)).toBe('<a href="&quot; onclick=&quot;alert(1)">x</a>');
  });
});
