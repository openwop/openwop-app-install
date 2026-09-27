/**
 * ADR 0256 — safe Markdown → HTML renderer. The security core: escape-first, a
 * fixed safe tag set, scheme-allowlisted hrefs. These tests are the XSS gate.
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdownPreview, renderMarkdownBody } from '../src/features/email/safeMarkdown.js';

describe('ADR 0256 — safe markdown XSS gate', () => {
  it('escapes raw HTML — no unescaped tag ever survives', () => {
    const h = renderMarkdownPreview('<script>alert(1)</script> and <img src=x onerror=alert(2)>');
    expect(h).not.toContain('<script>'); // no raw script tag
    expect(h).not.toContain('<img'); // no raw img tag (preview adds no pixel)
    expect(h).toContain('&lt;script&gt;'); // fully escaped, inert
    expect(h).toContain('&lt;img'); // the onerror= now lives inside inert escaped text
  });

  it('drops non-http(s)/mailto link schemes — never an href, never an anchor', () => {
    const js = renderMarkdownPreview('[click](javascript:alert(1))');
    expect(js).not.toContain('href="javascript:'); // scheme never reaches an href
    expect(js).not.toContain('<a '); // no anchor emitted at all
    expect(js).toContain('[click]'); // falls through to inert escaped text

    const data = renderMarkdownPreview('[x](data:text/html,<script>alert(1)</script>)');
    expect(data).not.toContain('<a ');
    expect(data).not.toContain('href="data:');
    expect(data).not.toContain('<script>');
  });

  it('a quote/bracket in a URL cannot break out of the href attribute', () => {
    // escape-first turns " into &quot; before any anchor is built.
    const h = renderMarkdownPreview('[x](https://e.example/?a="onmouseover="alert(1))');
    expect(h).not.toContain('onmouseover="alert'); // the raw attribute-break is neutralized
    expect(h).not.toContain('"onmouseover'); // no unescaped quote survives in the tag
  });

  it('renders the safe subset: bold, italic, code, headings, lists, links', () => {
    const h = renderMarkdownPreview('# Title\n\nHello **bold** and *italic* and `code`.\n\n- one\n- two\n\n[reserve](https://x.example/r)');
    expect(h).toContain('<h1');
    expect(h).toContain('<strong>bold</strong>');
    expect(h).toContain('<em>italic</em>');
    expect(h).toContain('<code>code</code>');
    expect(h).toContain('<ul');
    expect(h).toContain('<li>one</li>');
    expect(h).toContain('<a href="https://x.example/r" target="_blank" rel="noopener noreferrer">reserve</a>');
  });

  it('autolinks bare host-owned URLs (the unsubscribe/preferences lines) exactly once', () => {
    const h = renderMarkdownPreview('Body.\n\n--\nUnsubscribe: https://app.example/v1/host/openwop-app/public-email/u/TOKEN');
    expect(h).toContain('<a href="https://app.example/v1/host/openwop-app/public-email/u/TOKEN"');
    // exactly one anchor for that URL (no double-wrap from the link/URL alternation).
    expect(h.match(/<a href="https:\/\/app\.example[^"]*TOKEN"/g)?.length).toBe(1);
  });

  it('a markdown link does not get its href re-autolinked (single-pass alternation)', () => {
    const h = renderMarkdownPreview('[go](https://x.example/deep/link)');
    expect(h.match(/<a /g)?.length).toBe(1); // exactly one anchor, not a nested one
  });

  it('emphasis/code inside a URL do not mangle the href (GC-2 — anchors tokenized out first)', () => {
    // a `*for*` in the path must NOT get an <em> spliced into the href.
    const h = renderMarkdownPreview('[sale](https://shop.example/2*for*1) and **bold** after');
    expect(h).toContain('<a href="https://shop.example/2*for*1"'); // href intact
    expect(h).not.toContain('<em>for</em>'); // emphasis did not fire inside the URL
    expect(h).toContain('<strong>bold</strong>'); // emphasis still works outside links
  });

  it('renderMarkdownBody wraps the body + embeds the escaped pixel', () => {
    const doc = renderMarkdownBody('**hi**', 'https://app.example/o/PIX?q=a&b=c');
    expect(doc).toContain('<!doctype html>');
    expect(doc).toContain('<strong>hi</strong>');
    expect(doc).toContain('src="https://app.example/o/PIX?q=a&amp;b=c"'); // pixel URL escaped
  });
});
