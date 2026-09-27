/**
 * ADR 0400 — documents export parity. P1 DOCX: the markdown-token → `docx`
 * walker's fidelity (per the ADR fidelity matrix — headings, inline marks,
 * lists, tables, code, blockquote, footnotes, images, hr), the tenant-checked
 * image resolver posture (host assets embed; external URLs degrade to linked
 * text, never fetched), the scratch-TTL storage split (no library row, no
 * renderedMediaToken stamp), and the widened route.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import JSZip from 'jszip';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { renderMarkdownToDocx, probeImageDims } from '../src/features/documents/render.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'documents', 'media']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

const D = (orgId: string, s = ''): string => `/v1/host/openwop-app/documents/orgs/${encodeURIComponent(orgId)}${s}`;
const M = (orgId: string, s = ''): string => `/v1/host/openwop-app/media/orgs/${encodeURIComponent(orgId)}${s}`;

// A valid 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function ownerWithOrg() {
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `dx-${Date.now()}-${Math.floor(Math.random() * 1e6)}@t.test`, tenantId: `org:dx-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
  expect(r.status).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: org.body.orgId as string };
}

const RICH_MD = `# Title One

Intro with **bold**, *italic*, ~~gone~~, \`inline()\`, and a [link](https://example.com).

## Section

1. first
2. second

- bullet a
- bullet b

> A quoted thought.

\`\`\`ts
const x = 1;
\`\`\`

| Col A | Col B |
| --- | --- |
| a1 | b1 |

A claim.[^1]

---

The end.

[^1]: The footnote body.
`;

async function docxXml(buf: Buffer, path = 'word/document.xml'): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const f = zip.file(path);
  return f ? f.async('string') : '';
}

describe('renderMarkdownToDocx (ADR 0400 P1)', () => {
  it('covers the fidelity matrix: headings, real runs, lists, tables, code, quote, hr, footnotes', async () => {
    const buf = await renderMarkdownToDocx(RICH_MD, { title: 'Fidelity' });
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK'); // OOXML zip
    const xml = await docxXml(buf);
    expect(xml).toContain('Heading1');
    expect(xml).toContain('Heading2');
    expect(xml).toContain('<w:b/>'); // real bold run
    expect(xml).toContain('<w:i/>'); // real italic run
    expect(xml).toContain('<w:strike/>');
    expect(xml).toContain('Courier New'); // inline + block code
    expect(xml).toContain('<w:tbl>'); // real table
    expect(xml).toContain('a1');
    expect(xml).toContain('<w:numPr>'); // real list numbering
    expect(xml).toContain('A quoted thought.');
    expect(xml).toContain('<w:footnoteReference'); // real footnote ref
    const foot = await docxXml(buf, 'word/footnotes.xml');
    expect(foot).toContain('The footnote body.');
    // Hyperlink rides a relationship, not raw text.
    const rels = await docxXml(buf, 'word/_rels/document.xml.rels');
    expect(rels).toContain('https://example.com');
  });

  it('embeds a resolver-supplied host image and degrades an external URL to linked text', async () => {
    const png = Buffer.from(PNG, 'base64');
    const buf = await renderMarkdownToDocx('![host pic](/v1/host/openwop-app/assets/tok123)\n\n![ext pic](https://cdn.example.com/x.png)\n', {
      resolveImage: async (src) => (src.includes('tok123') ? { data: png, kind: 'png', width: 1, height: 1 } : null),
    });
    const zip = await JSZip.loadAsync(buf);
    const media = Object.keys(zip.files).filter((f) => f.startsWith('word/media/') && !f.endsWith('/'));
    expect(media.length).toBe(1); // host image embedded; external NOT fetched
    const xml = await docxXml(buf);
    expect(xml).toContain('[ext pic]'); // degraded placeholder text
  });

  it('probeImageDims reads png/gif/jpeg headers', () => {
    expect(probeImageDims(Buffer.from(PNG, 'base64'))).toEqual({ kind: 'png', width: 1, height: 1 });
    const gif = Buffer.from('GIF89a', 'latin1');
    const gifFull = Buffer.concat([gif, Buffer.from([0x02, 0x00, 0x03, 0x00, 0, 0, 0, 0])]);
    expect(probeImageDims(gifFull)).toEqual({ kind: 'gif', width: 2, height: 3 });
    expect(probeImageDims(Buffer.from('not an image'))).toBeNull();
  });

  it('math degrades to TeX-as-text (never dropped silently)', async () => {
    const xml = await docxXml(await renderMarkdownToDocx('The energy is $E = mc^2$ here.\n'));
    expect(xml).toContain('E = mc^2');
  });
});

describe('documents render route — docx (ADR 0400 P1)', () => {
  it('renders docx as scratch-TTL media WITHOUT stamping the version pointer or a library row', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(D(orgId, '/documents'), { title: 'Export Me', kind: 'sow' });
    const id = created.body.documentId;
    await c.post(D(orgId, `/documents/${id}/versions`), { content: RICH_MD });

    const r = await c.post(D(orgId, `/documents/${id}/render`), { format: 'docx' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.format).toBe('docx');
    expect(r.body.sizeBytes).toBeGreaterThan(1000);

    // Serves real OOXML bytes with the wordprocessingml content type.
    const served = await fetch(`${BASE}${r.body.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type') ?? '').toContain('wordprocessingml');
    const bytes = Buffer.from(await served.arrayBuffer());
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    // The version pointer still belongs to PDF only.
    const after = await c.get(D(orgId, `/documents/${id}`));
    expect(after.body.currentVersion.renderedMediaToken).not.toBe(r.body.renderedMediaToken);

    // No durable library row for the scratch export (PDF renders do create one).
    const assets = await c.get(M(orgId, '/assets'));
    const names = ((assets.body?.assets ?? []) as Array<{ name: string }>).map((a) => a.name);
    expect(names.some((n) => n.endsWith('.docx'))).toBe(false);
  });

  it('still rejects an unknown format', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(D(orgId, '/documents'), { title: 'X', kind: 'sow' });
    await c.post(D(orgId, `/documents/${created.body.documentId}/versions`), { content: '# T' });
    const r = await c.post(D(orgId, `/documents/${created.body.documentId}/render`), { format: 'wpd' });
    expect(r.status).toBe(400);
  });
});

describe('renderMarkdownToEpub (ADR 0400 P2)', () => {
  it('produces a structurally valid EPUB3: STORED mimetype first, container, OPF, nav, chapters', async () => {
    const { renderMarkdownToEpub } = await import('../src/features/documents/render.js');
    const buf = await renderMarkdownToEpub(RICH_MD, { title: 'My Book', identifier: 'urn:x:1', modifiedAt: '2026-07-17T00:00:00Z' });
    // mimetype must be the FIRST local file entry and uncompressed.
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(buf.subarray(30, 38).toString('latin1')).toBe('mimetype');
    expect(buf.readUInt16LE(8)).toBe(0); // compression method 0 = STORED
    const zip = await JSZip.loadAsync(buf);
    expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
    const container = await zip.file('META-INF/container.xml')!.async('string');
    expect(container).toContain('EPUB/content.opf');
    const opf = await zip.file('EPUB/content.opf')!.async('string');
    expect(opf).toContain('<dc:title>My Book</dc:title>');
    expect(opf).toContain('urn:x:1');
    expect(opf).toContain('dcterms:modified');
    expect(opf).toContain('properties="nav"');
    // Two chapters: "Title One" (h1) and "Section" (h2).
    const nav = await zip.file('EPUB/nav.xhtml')!.async('string');
    expect(nav).toContain('Title One');
    expect(nav).toContain('Section');
    const ch1 = await zip.file('EPUB/chapter1.xhtml')!.async('string');
    expect(ch1).toContain('<strong>bold</strong>');
    const ch2 = await zip.file('EPUB/chapter2.xhtml')!.async('string');
    expect(ch2).toContain('<table>');
  });

  // EPUB-DET-1 — NOTE this "deterministic" claim is WEAKER than its name. Both
  // generations happen back-to-back, so they almost always land in the same
  // second, and JSZip's per-entry `new Date()` stamp cannot differ. MEASURED
  // 2026-09-01: deleting BOTH `pinZipTimestamps` calls leaves this GREEN.
  // The property is really asserted in `documents-export-determinism.test.ts`,
  // which moves the clock a day between the two calls. Kept as-is (it covers
  // CONTENT stability, which is worth having) rather than renamed, so the gap
  // between a test's name and its reach stays on the record.
  it('is deterministic per version (same inputs ⇒ identical bytes) and embeds host images only', async () => {
    const { renderMarkdownToEpub } = await import('../src/features/documents/render.js');
    const png = Buffer.from(PNG, 'base64');
    const opts = {
      title: 'D', identifier: 'urn:x:2', modifiedAt: '2026-07-17T00:00:00Z',
      resolveImage: async (src: string) => (src.includes('tok9') ? { data: png, kind: 'png' as const, width: 1, height: 1 } : null),
    };
    const mdSrc = '# C\n\n![in](/v1/host/openwop-app/assets/tok9)\n\n![out](https://ex.com/a.png)\n';
    const a = await renderMarkdownToEpub(mdSrc, opts);
    const b = await renderMarkdownToEpub(mdSrc, opts);
    expect(Buffer.compare(a, b)).toBe(0);
    const zip = await JSZip.loadAsync(a);
    expect(zip.file('EPUB/images/img1.png')).toBeTruthy();
    const ch = await zip.file('EPUB/chapter1.xhtml')!.async('string');
    expect(ch).toContain('src="images/img1.png"');
    expect(ch).toContain('[out]'); // external degraded to a link, not fetched
  });

  it('fence-aware chapter split never breaks inside a code fence', async () => {
    const { splitMarkdownChapters } = await import('../src/features/documents/render.js');
    const chapters = splitMarkdownChapters('# A\n\n```\n# not a heading\n```\n\n## B\n\ntext');
    expect(chapters.map((c) => c.title)).toEqual(['A', 'B']);
    expect(chapters[0]!.markdown).toContain('# not a heading');
  });
});

describe('documents render route — epub (ADR 0400 P2)', () => {
  it('renders epub as scratch media with the epub content type', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(D(orgId, '/documents'), { title: 'Book', kind: 'doc' });
    await c.post(D(orgId, `/documents/${created.body.documentId}/versions`), { content: RICH_MD });
    const r = await c.post(D(orgId, `/documents/${created.body.documentId}/render`), { format: 'epub' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const served = await fetch(`${BASE}${r.body.url}`);
    expect(served.headers.get('content-type') ?? '').toContain('application/epub+zip');
  });
});

describe('renderMarkdownToOdt (ADR 0400 P3)', () => {
  it('produces a structurally valid ODT: STORED mimetype first, manifest, styled content', async () => {
    const { renderMarkdownToOdt } = await import('../src/features/documents/render.js');
    const buf = await renderMarkdownToOdt(RICH_MD, { title: 'Odt Doc' });
    expect(buf.subarray(30, 38).toString('latin1')).toBe('mimetype');
    expect(buf.readUInt16LE(8)).toBe(0); // STORED
    const zip = await JSZip.loadAsync(buf);
    expect(await zip.file('mimetype')!.async('string')).toBe('application/vnd.oasis.opendocument.text');
    const content = await zip.file('content.xml')!.async('string');
    expect(content).toContain('text:outline-level="1"');
    expect(content).toContain('text:style-name="OwpBold"');
    expect(content).toContain('<table:table>');
    expect(content).toContain('text:style-name="OwpCodeBlock"');
    expect(content).toContain('<text:list ');
    expect(content).toContain('text:note-class="footnote"');
    expect(content).toContain('The footnote body.');
    expect(content).not.toContain('__OWP_FOOTNOTE_');
    const manifest = await zip.file('META-INF/manifest.xml')!.async('string');
    expect(manifest).toContain('content.xml');
    const meta = await zip.file('meta.xml')!.async('string');
    expect(meta).toContain('Odt Doc');
  });

  it('embeds host images with sizing and degrades external URLs', async () => {
    const { renderMarkdownToOdt } = await import('../src/features/documents/render.js');
    const png = Buffer.from(PNG, 'base64');
    const buf = await renderMarkdownToOdt('![in](/v1/host/openwop-app/assets/tokZ)\n\n![out](https://x.com/y.png)\n', {
      resolveImage: async (src) => (src.includes('tokZ') ? { data: png, kind: 'png', width: 96, height: 48 } : null),
    });
    const zip = await JSZip.loadAsync(buf);
    expect(zip.file('Pictures/img1.png')).toBeTruthy();
    const content = await zip.file('content.xml')!.async('string');
    expect(content).toContain('draw:image');
    expect(content).toContain('svg:width="2.540cm"');
    expect(content).toContain('[out]');
  });
});

describe('documents render route — odt (ADR 0400 P3)', () => {
  it('renders odt as scratch media with the opendocument content type', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(D(orgId, '/documents'), { title: 'OD', kind: 'doc' });
    await c.post(D(orgId, `/documents/${created.body.documentId}/versions`), { content: RICH_MD });
    const r = await c.post(D(orgId, `/documents/${created.body.documentId}/render`), { format: 'odt' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const served = await fetch(`${BASE}${r.body.url}`);
    expect(served.headers.get('content-type') ?? '').toContain('opendocument.text');
  });
});

describe('renderMarkdownToLatex (ADR 0400 P4)', () => {
  it('emits a standalone .tex with faithful structure and PRESERVED math', async () => {
    const { renderMarkdownToLatex } = await import('../src/features/documents/render.js');
    const tex = await renderMarkdownToLatex(RICH_MD, { title: 'Paper & Co' });
    expect(tex).toContain('\\documentclass[11pt]{article}');
    expect(tex).toContain('\\begin{document}');
    expect(tex).toContain('\\title{Paper \\& Co}'); // & escaped in body text
    expect(tex).toContain('\\section{'); // h1
    expect(tex).toContain('\\subsection{'); // h2
    expect(tex).toContain('\\textbf{'); // bold
    expect(tex).toContain('\\textit{'); // italic
    expect(tex).toContain('\\sout{'); // strike (ulem)
    expect(tex).toContain('\\begin{itemize}');
    expect(tex).toContain('\\begin{enumerate}');
    expect(tex).toContain('\\begin{verbatim}'); // code fence
    expect(tex).toContain('\\begin{tabular}');
    expect(tex).toContain('\\href{');
    expect(tex).toContain('\\footnote{The footnote body.}'); // spliced
    expect(tex).toContain('\\end{document}');
  });

  it('passes inline $…$ math through VERBATIM (the one faithful-math export)', async () => {
    const { renderMarkdownToLatex } = await import('../src/features/documents/render.js');
    const tex = await renderMarkdownToLatex('The energy is $E = mc^2$ and $a_{n}$ terms.\n');
    expect(tex).toContain('$E = mc^2$'); // untouched — ^ and _ NOT escaped inside math
    expect(tex).toContain('$a_{n}$');
  });

  it('escapes LaTeX specials in body text but not $-delimited math', async () => {
    const { renderMarkdownToLatex } = await import('../src/features/documents/render.js');
    const tex = await renderMarkdownToLatex('100% of a_b costs #5 & more; keep $x_1$ intact.\n');
    expect(tex).toContain('100\\% of a\\_b costs \\#5 \\& more');
    expect(tex).toContain('$x_1$');
  });
});

describe('documents render route — latex (ADR 0400 P4)', () => {
  it('renders latex as scratch media with the x-tex content type', async () => {
    const { c, orgId } = await ownerWithOrg();
    const created = await c.post(D(orgId, '/documents'), { title: 'TeX doc', kind: 'doc' });
    await c.post(D(orgId, `/documents/${created.body.documentId}/versions`), { content: '# Title\n\nWith $E=mc^2$.' });
    const r = await c.post(D(orgId, `/documents/${created.body.documentId}/render`), { format: 'latex' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const served = await fetch(`${BASE}${r.body.url}`);
    expect(served.headers.get('content-type') ?? '').toContain('application/x-tex');
    expect(await served.text()).toContain('\\documentclass');
  });
});

describe('EPUB MathML (ADR 0400 — temml)', () => {
  it('converts $$…$$ to MathML and flags the chapter with the mathml property', async () => {
    const { renderMarkdownToEpub } = await import('../src/features/documents/render.js');
    const buf = await renderMarkdownToEpub('# Physics\n\nThe identity $$E = mc^2$$ is famous.\n', { title: 'M', modifiedAt: '2026-07-17T00:00:00Z' });
    const zip = await JSZip.loadAsync(buf);
    const ch = await zip.file('EPUB/chapter1.xhtml')!.async('string');
    expect(ch).toContain('<math'); // real MathML, not literal $$
    expect(ch).toContain('http://www.w3.org/1998/Math/MathML');
    expect(ch).not.toContain('$$E = mc^2$$');
    const opf = await zip.file('EPUB/content.opf')!.async('string');
    expect(opf).toMatch(/<item id="ch1"[^>]*properties="mathml"/);
  });

  // EPUB-DET-1 — NOTE this "deterministic" claim is WEAKER than its name. Both
  // generations happen back-to-back, so they almost always land in the same
  // second, and JSZip's per-entry `new Date()` stamp cannot differ. MEASURED
  // 2026-09-01: deleting BOTH `pinZipTimestamps` calls leaves this GREEN.
  // The property is really asserted in `documents-export-determinism.test.ts`,
  // which moves the clock a day between the two calls. Kept as-is (it covers
  // CONTENT stability, which is worth having) rather than renamed, so the gap
  // between a test's name and its reach stays on the record.
  it('is deterministic (same version ⇒ identical bytes) with math present', async () => {
    const { renderMarkdownToEpub } = await import('../src/features/documents/render.js');
    const md = '# T\n\n$$\\frac{a}{b}$$ and $$x_n$$.\n';
    const opts = { title: 'D', identifier: 'urn:x:9', modifiedAt: '2026-07-17T00:00:00Z' };
    const a = await renderMarkdownToEpub(md, opts);
    const b = await renderMarkdownToEpub(md, opts);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('single-$ money is NOT math, and a malformed formula falls back to literal text', async () => {
    const { renderMarkdownToEpub } = await import('../src/features/documents/render.js');
    const zip = await JSZip.loadAsync(await renderMarkdownToEpub('Costs $5 and $10 total. Broken $$\\frac{$$ here.\n', { modifiedAt: '2026-07-17T00:00:00Z' }));
    const ch = await zip.file('EPUB/chapter1.xhtml')!.async('string');
    expect(ch).toContain('$5 and $10'); // money untouched — single $ is never math
    expect(ch).not.toContain('<math'); // no valid formula in this doc
  });

  it('leaves $$ inside a code span/fence untouched (no math in code)', async () => {
    const { renderMarkdownToEpub } = await import('../src/features/documents/render.js');
    const zip = await JSZip.loadAsync(await renderMarkdownToEpub('Inline `$$x$$` and\n\n```\n$$y$$\n```\n', { modifiedAt: '2026-07-17T00:00:00Z' }));
    const ch = await zip.file('EPUB/chapter1.xhtml')!.async('string');
    expect(ch).not.toContain('<math');
    expect(ch).toContain('$$x$$');
    expect(ch).toContain('$$y$$');
  });
});
