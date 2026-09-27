/**
 * ADR 0350 Phase 3 — `markdownToHtml` (the server half of promote-to-rich). Its
 * output is fed to the client's `generateJSON(html, documentExtensions())`; the
 * `html: false` markdown-it config is the FIRST line of the two-layer XSS defense
 * (raw HTML never passes through as live markup — it's escaped to text).
 */
import { describe, it, expect } from 'vitest';
import { markdownToHtml } from '../src/features/documents/render.js';

describe('markdownToHtml', () => {
  it('renders GFM markdown (headings, emphasis, links, tables) to HTML', () => {
    const html = markdownToHtml('# Title\n\nA **para** with a [link](https://x.dev).\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>para</strong>');
    expect(html).toContain('<a href="https://x.dev">');
    expect(html).toContain('<table>');
  });

  it('does NOT emit raw HTML as live markup (html:false — escaped, not passed through)', () => {
    const html = markdownToHtml('ok <script>alert(1)</script> and <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script'); // escaped to &lt;script…
    expect(html).not.toContain('<img');
    expect(html).toContain('ok'); // surrounding text still renders
  });

  it('handles empty / undefined content', () => {
    expect(markdownToHtml('').trim()).toBe('');
  });
});
