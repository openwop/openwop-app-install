/**
 * ADR 1055 — the document editor's server lanes (feature loop round 2, row 87).
 *
 *  - D1: the `canvas.document` validator is closed-world. TipTap opens a whole
 *    stored document as BLANK when one node or mark in it is outside the
 *    editor's schema, or when a text node is empty, so each of those is refused
 *    on every lane. RED on `13fb94b5d`: the validator accepted all three shapes,
 *    and the from-artifact seed ran no validator for this type at all (5 of 7
 *    cases red there; the two controls passed).
 *
 *  - D3: the DOCX import inflated an upload with no budget. MEASURED on
 *    `13fb94b5d`: a 98 KB file inflated to a 42 MB part and came back as 41 MB
 *    of HTML (the import answered 200). The shared counted budget now stops it,
 *    including a zip whose directory lies about its sizes, which the slides
 *    importer's old pre-check let through to a full inflate.
 *
 *  - D4: "Improve with AI" drove the markdown Documents author, whose tools
 *    save documents in that store. The Writing Assistant replaces it. An empty
 *    manifest allowlist is not enough on its own: the ADR 0315 default-on
 *    baseline (which includes `documents.draft`) is unioned into every agent's
 *    tools. The core `text-only` capability turns it off; the agent's own pack
 *    activates it by default (`x-openwop-app.agentCapabilities`), so every entry
 *    point and every workspace gets it with no write, and no agent is named in
 *    the resolver. RED on `13fb94b5d`: the pack did not exist, and an empty
 *    allowlist was offered all 9 baseline tools.
 *
 * Each refusal sits beside a control that must still succeed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { persistRunArtifact } from '../src/host/runArtifactStore.js';
import { registerArtifactType } from '../src/host/artifactTypes.js';
import { validateDocumentDoc } from '../src/features/document-editor/validateDocumentDoc.js';
import { isDocumentHrefAllowed } from '../src/features/document-editor/documentSchemaNames.js';
import JSZip from 'jszip';
import { openZipWithinBudget, ZipBudgetError } from '../src/host/zipBudget.js';
import { readFileSync, readdirSync } from 'node:fs';
import { DEFAULT_ON_AGENT_TOOL_IDS, TEXT_ONLY_CAPABILITY, agentOffersToolBaseline, effectiveToolAllowlist } from '../src/host/agentToolAllowlistService.js';
import { activateAgentCapability, getAgentProfile } from '../src/host/agentProfileService.js';
import { hostCapabilitiesOf, loadAgentsFromManifest } from '../src/packs/agentLoader.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { turnToolAllowlist } from '../src/host/conversationToolLoop.js';
import { documentEditorFeature } from '../src/features/document-editor/feature.js';
import { PACK_PINS } from '../src/features/packPins.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('document-editor');
  if (!d) throw new Error('document-editor toggle default missing');
  await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface ErrBody { error: string; message: string }
interface LoginBody { user: { userId: string } }
interface OrgBody { orgId: string }
interface CanvasBody { canvasId: string; canvasTypeId: string }
function client(): { post: <T>(p: string, b?: unknown) => Promise<Res<T>>; raw: (p: string, b?: unknown) => Promise<Response> } {
  let cookie = '';
  const raw = async (path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return res;
  };
  return {
    raw,
    post: async <T>(path: string, body?: unknown): Promise<Res<T>> => {
      const res = await raw(path, body);
      const text = await res.text();
      const parsed: T = JSON.parse(text || 'null'); // every JSON route here answers JSON
      return { status: res.status, body: parsed };
    },
  };
}

const H = '/host/openwop-app';
const DE = (orgId: string) => `${H}/document-editor/orgs/${encodeURIComponent(orgId)}`;
const para = (text: string, marks?: unknown[]) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });
const docOf = (...content: unknown[]) => ({ title: 'T', content: { type: 'doc', content } });

/** The three shapes that blank the editor (measured on `13fb94b5d`, FE
 *  `documentSchema.test.ts`), each beside a paragraph that must survive. */
const BLANKING: Record<string, Record<string, unknown>> = {
  'unknown node': docOf(para('keep me'), { type: 'notARealNode' }),
  'empty text node': docOf(para('keep me'), { type: 'paragraph', content: [{ type: 'text', text: '' }] }),
  'unknown mark': docOf(para('keep me'), para('x', [{ type: 'glitter' }])),
};

async function fixture() {
  const tenantId = `org:de1055-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post<LoginBody>(`${H}/test/login`, { email: `de1055-${n++}@acme.test`, tenantId });
  const orgId = (await owner.post<OrgBody>(`${H}/orgs`, { name: 'Acme' })).body.orgId;
  return { tenantId, owner, orgId };
}

async function emit(tenantId: string, payload: unknown): Promise<string> {
  const runId = `run-1055-${Date.now()}-${n++}`;
  await persistRunArtifact({ tenantId, runId, nodeId: 'write', role: 'deliverable', now: new Date().toISOString(), output: { artifact: { artifactTypeId: 'canvas.document', payload, title: 'Doc' } } });
  return `${runId}:write`;
}

describe('ADR 1055 D1 — the document validator is closed-world', () => {
  it.each(Object.entries(BLANKING))('refuses a document with an %s, naming that node', (_label, state) => {
    const errors = validateDocumentDoc(state).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toMatch(/^content\.content\[1\]/);
  });

  it('accepts every node and mark the editor can open (control)', () => {
    const state = docOf(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] },
      para('styled', [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }, { type: 'strike' }, { type: 'code' }]),
      para('linked', [{ type: 'link', attrs: { href: 'https://example.com', target: '_blank', rel: null, class: null } }]),
      para('suggested', [{ type: 'insertion', attrs: { author: 'ai' } }, { type: 'comment', attrs: { threadId: 't1' } }]),
      { type: 'bulletList', content: [{ type: 'listItem', content: [para('item')] }] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [para('h')] }, { type: 'tableCell', content: [para('c')] }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] },
      { type: 'mathBlock', attrs: { latex: 'x^2' } },
      { type: 'image', attrs: { src: '/media/a.png', alt: 'a' } },
      { type: 'horizontalRule' },
    );
    expect(validateDocumentDoc(state).errors).toEqual([]);
  });

  // DE87CD-3/4 — a nested `doc` crashes the view; text directly in a block
  // container, or a block inside a textblock, opens as an invalid document.
  it('refuses a node in a place the editor cannot hold it', () => {
    const at = (state: Record<string, unknown>) => validateDocumentDoc(state).errors.map((e) => e.message);
    expect(at(docOf({ type: 'blockquote', content: [{ type: 'doc', content: [para('x')] }] }))).toEqual(['"doc" may only be the root node']);
    expect(at(docOf({ type: 'text', text: 'loose' }))).toEqual(['"text" must sit inside a paragraph, heading or code block']);
    expect(at(docOf({ type: 'paragraph', content: [{ type: 'table' }] }))).toEqual(['"paragraph" may only hold text']);
    expect(at(docOf({ type: 'bulletList', content: [{ type: 'listItem', content: [para('nested ok')] }] }))).toEqual([]);
  });

  it('refuses a malformed mark and a link the editor would not follow', () => {
    expect(validateDocumentDoc(docOf(para('x', ['bold']))).errors[0]!.message).toMatch(/object with a string type/);
    expect(validateDocumentDoc(docOf(para('x', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]))).errors[0]!.path).toBe('content.content[0].content[0].marks[0].attrs.href');
  });

  it('isDocumentHrefAllowed reads the scheme the way a browser does', () => {
    expect(['https://a.b', 'http://a', 'mailto:a@b.c', 'tel:+1', '/rel', '#top', 'page.html', 'MAILTO:x'].every(isDocumentHrefAllowed)).toBe(true);
    expect(['javascript:alert(1)', 'java\tscript:x', ' javascript:x', 'JaVaScRiPt:x', 'data:text/html,x', 'vbscript:x', '', 'javascript&#58;alert(1)', 'javascript&colon;x', 'javascript%3Ax', 'java\\script:x'].some(isDocumentHrefAllowed)).toBe(false);
    // A query or fragment may still carry `&` and `%` (control).
    expect(['https://a.b/?q=1&r=%20', '/docs?a=1&b=2', '#a%20b'].every(isDocumentHrefAllowed)).toBe(true);
  });
});

describe('ADR 1055 D1 — the from-artifact seed runs the closed validator', () => {
  // No `canvas.document` artifact type is registered on this host today, so a
  // run artifact never carries the type and this door 404s. The test registers
  // one (open schema, as a pack could) to prove the door holds once one exists:
  // on `13fb94b5d` it then seeded the blanking document (201).
  beforeAll(() => {
    registerArtifactType({ artifactTypeId: 'canvas.document', title: 'Document', schema: { type: 'object' }, export: [], registrationSource: 'pack' });
  });

  it('refuses a run artifact the editor would open blank, and seeds a valid one', async () => {
    const f = await fixture();
    const bad = await f.owner.post<ErrBody>(`${DE(f.orgId)}/canvases/from-artifact`, { artifactKey: await emit(f.tenantId, BLANKING['unknown node']) });
    expect(bad.status, JSON.stringify(bad.body)).toBe(422);
    expect(bad.body.message).toMatch(/unsupported node type "notARealNode"/);
    const good = await f.owner.post<CanvasBody>(`${DE(f.orgId)}/canvases/from-artifact`, { artifactKey: await emit(f.tenantId, docOf(para('keep me'))) });
    expect(good.status, JSON.stringify(good.body)).toBe(201);
    expect(good.body.canvasTypeId).toBe('canvas.document');
  });
});

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
/** A minimal real .docx whose body is `paragraphs` copies of `text`. */
async function docx(text: string, paragraphs: number, opts: { image?: boolean; mainPart?: string; extra?: Record<string, string> } = {}): Promise<Buffer> {
  const zip = new JSZip();
  const p = `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const img = opts.image ? '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' : '';
  const main = opts.mainPart ?? 'word/document.xml';
  zip.file(main, `<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>${p.repeat(paragraphs)}${img}</w:body></w:document>`);
  for (const [name, body] of Object.entries(opts.extra ?? {})) zip.file(name, body);
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`);
  if (opts.image) {
    zip.file('word/_rels/document.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/a.png"/></Relationships>');
    zip.file('word/media/a.png', Buffer.alloc(64, 1));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

/** Rewrite the declared uncompressed size of the entry `name` (its local header
 *  and its central-directory record) to `n` bytes: a zip that lies about how
 *  big a part is. Every other entry stays honest. */
function lieAboutSize(buf: Buffer, name: string, n: number): Buffer {
  const out = Buffer.from(buf);
  for (let i = 0; i + 46 <= out.length; i++) {
    const sig = out.readUInt32LE(i);
    if (sig === 0x04034b50 && out.toString('latin1', i + 30, i + 30 + out.readUInt16LE(i + 26)) === name) out.writeUInt32LE(n, i + 22);
    else if (sig === 0x02014b50 && out.toString('latin1', i + 46, i + 46 + out.readUInt16LE(i + 28)) === name) out.writeUInt32LE(n, i + 24);
  }
  return out;
}

describe('ADR 1055 D3 — the DOCX import inflates only within a budget', () => {
  // ~12 MB of document.xml (past the 8 MB part cap) in well under 200 KB on
  // the wire.
  const BOMB_PARAS = 12_000;
  const BIG = 'A'.repeat(1024);

  it('refuses a zip bomb with 413, and imports a real document (control)', async () => {
    const f = await fixture();
    const bomb = await docx(BIG, BOMB_PARAS);
    expect(bomb.length).toBeLessThan(200 * 1024);
    const bad = await f.owner.post<ErrBody & { details?: { reason?: string } }>(`${DE(f.orgId)}/import`, { docxBase64: bomb.toString('base64') });
    expect(bad.status, JSON.stringify(bad.body)).toBe(413);
    expect(bad.body.details?.reason).toBe('entry_too_large'); // the budget, not the HTML cap
    expect(bad.body.message).toMatch(/expands past the import limit/);
    const good = await f.owner.post<{ html: string; warnings: string[] }>(`${DE(f.orgId)}/import`, { docxBase64: (await docx('Hello world', 3)).toString('base64') });
    expect(good.status, JSON.stringify(good.body)).toBe(200);
    expect(good.body.html).toContain('<p>Hello world</p>');
  });

  it('refuses a bomb whose zip directory lies about its sizes', async () => {
    const f = await fixture();
    const liar = lieAboutSize(await docx(BIG, BOMB_PARAS), 'word/document.xml', 1000);
    const bad = await f.owner.post<ErrBody & { details?: { reason?: string } }>(`${DE(f.orgId)}/import`, { docxBase64: liar.toString('base64') });
    expect(bad.status, JSON.stringify(bad.body)).toBe(413);
    expect(bad.body.details?.reason).toBe('entry_too_large');
  });

  // DE87CD-1/19 — mammoth reads parts whatever their names: it always reads
  // `mammoth/style-map`, and takes the main part's path from `_rels/.rels`. An
  // extension filter (`.xml`/`.rels` only) left both outside the budget.
  it('counts a part with no .xml name: an inflating mammoth/style-map', async () => {
    const f = await fixture();
    const bomb = await docx('Hello', 1, { extra: { 'mammoth/style-map': 'p => p\n'.repeat(1_500_000) } });
    const bad = await f.owner.post<ErrBody & { details?: { reason?: string } }>(`${DE(f.orgId)}/import`, { docxBase64: bomb.toString('base64') });
    expect(bad.status, JSON.stringify(bad.body).slice(0, 300)).toBe(413);
    expect(bad.body.details?.reason).toBe('entry_too_large');
  });

  it('counts a main part that _rels/.rels names without an .xml extension', async () => {
    const f = await fixture();
    const bomb = await docx(BIG, BOMB_PARAS, { mainPart: 'word/document.bin' });
    const bad = await f.owner.post<ErrBody & { details?: { reason?: string } }>(`${DE(f.orgId)}/import`, { docxBase64: bomb.toString('base64') });
    expect(bad.status, JSON.stringify(bad.body).slice(0, 300)).toBe(413);
    expect(bad.body.details?.reason).toBe('entry_too_large'); // the budget, before mammoth ran
  });

  it('drops images at the source and says so', async () => {
    const f = await fixture();
    const res = await f.owner.post<{ html: string; warnings: string[] }>(`${DE(f.orgId)}/import`, { docxBase64: (await docx('With a picture', 1, { image: true })).toString('base64') });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.html).not.toMatch(/<img|data:/);
    expect(res.body.warnings).toContain('1 image(s) were not imported. Insert them from the media library.');
  });

  it('the shared budget stops a lying entry mid-inflate, not after it', async () => {
    const liar = lieAboutSize(await docx(BIG, BOMB_PARAS), 'word/document.xml', 1000);
    const archive = await openZipWithinBudget(liar, { maxEntryBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 });
    const err = await archive.measure('word/document.xml').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ZipBudgetError);
    expect((err as ZipBudgetError).code).toBe('entry_too_large');
    // It stopped part-way, never the whole ~12 MB part (the overshoot is at most
    // one inflate step: JSZip feeds the inflater 16 KiB of COMPRESSED input at a
    // time), and it STAYS stopped: the worker is paused, not left inflating in
    // the background after the refusal (DE87CD-2/5).
    const atRefusal = archive.inflated;
    expect(atRefusal).toBeGreaterThan(1024 * 1024);
    expect(atRefusal).toBeLessThan(BIG.length * BOMB_PARAS);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(archive.inflated).toBe(atRefusal);
  });
});

describe('ADR 1055 D4 — the Writing Assistant is offered no tools, by its own pack\'s default capability', () => {
  const PACK_DIR = new URL('../../../packs/vendor.openwop-app.document-editor.agents/', import.meta.url);
  const pack = JSON.parse(readFileSync(new URL('pack.json', PACK_DIR), 'utf8')) as { name: string; version: string; agents: { agentId: string; toolAllowlist: string[] }[] };

  it('ships as a required, pinned pack whose one agent lists no tools', () => {
    expect(pack.agents).toHaveLength(1);
    expect(pack.agents[0]!.toolAllowlist).toEqual([]);
    expect(documentEditorFeature.requiredPacks).toContain(pack.name);
    expect(new Map(Object.entries(PACK_PINS)).get(pack.name)).toBe(pack.version);
  });

  it('through the REAL loader, the agent carries text-only and a chat turn compiles NO tools, in any workspace, with no write', async () => {
    const [writer] = loadAgentsFromManifest(fileURLToPath(PACK_DIR));
    expect(writer?.agentId).toBe(pack.agents[0]!.agentId);
    expect(writer?.hostCapabilities).toEqual([TEXT_ONLY_CAPABILITY]);
    const f = await fixture();
    expect(await getAgentProfile(f.tenantId, writer!.agentId)).toBeNull(); // nothing was provisioned
    expect(turnToolAllowlist(writer!.toolAllowlist, undefined, undefined, await agentOffersToolBaseline(f.tenantId, writer!))).toEqual([]);
  });

  it('an agent without the capability keeps the baseline, and a tenant profile can activate it too (control)', async () => {
    const f = await fixture();
    const other = { agentId: 'vendor.openwop-app.documents.agents.document-author' };
    expect(turnToolAllowlist([], undefined, undefined, await agentOffersToolBaseline(f.tenantId, other))).toEqual([...DEFAULT_ON_AGENT_TOOL_IDS]);
    expect(DEFAULT_ON_AGENT_TOOL_IDS).toContain('openwop:documents.draft');
    await activateAgentCapability(f.tenantId, other.agentId, TEXT_ONLY_CAPABILITY, { roleKey: 'probe', autonomy: { specLevel: 'recommend' } });
    expect(await agentOffersToolBaseline(f.tenantId, other)).toBe(false);
    expect(await agentOffersToolBaseline((await fixture()).tenantId, other)).toBe(true); // per tenant
  });

  it('a pack may declare only take-away capabilities, and only for its OWN agents', () => {
    const ext = { agentCapabilities: { 'p.agents.a': ['text-only', 'assistant'], 'other.pack.agent': ['text-only'] } };
    expect(hostCapabilitiesOf(ext, 'p.agents.a', 'p.agents')).toEqual({ hostCapabilities: ['text-only'] });
    // The loader asks per agent of THIS manifest, so a key naming another
    // pack's agent is never looked up for it; an unlisted agent gets nothing.
    expect(hostCapabilitiesOf(ext, 'p.agents.b', 'p.agents')).toEqual({});
    expect(hostCapabilitiesOf({ agentCapabilities: { 'p.agents.a': ['assistant'] } }, 'p.agents.a', 'p.agents')).toEqual({});
  });

  it('an operator override still replaces the tools of a text-only agent (ADR 0104 stays authoritative)', () => {
    expect(effectiveToolAllowlist([], ['openwop:kanban.add-todo'], false)).toEqual(['openwop:kanban.add-todo']);
  });

  // The resolver is only as good as its callers (DE87CD-6/18). The flag is a
  // REQUIRED parameter, so tsc refuses a call without one; this finds every
  // call site in src by scanning, and refuses one that does not ask the profile.
  it('every src caller of the offering resolver derives the flag from agentOffersToolBaseline', () => {
    const SRC = fileURLToPath(new URL('../src/', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); } else if (e.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(SRC);
    const callers = files.filter((p) => /(?<!function )\b(effectiveToolAllowlist|turnToolAllowlist)\(/.test(readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '')));
    expect(callers.length).toBeGreaterThanOrEqual(5);
    for (const p of callers) {
      if (p.endsWith('agentToolAllowlistService.ts')) continue; // the definition
      const src = readFileSync(p, 'utf8');
      expect(src, p).toMatch(/agentOffersToolBaseline\(/);
      expect(src, p).not.toMatch(/(effectiveToolAllowlist|turnToolAllowlist)\([^;]*,\s*true\)/);
    }
  });
});

describe('ADR 1055 D7 — the .docx export carries only links the editor would follow', () => {
  it('drops a javascript: hyperlink, keeps an https one', async () => {
    const { pmToDocx } = await import('../src/features/document-editor/pmToDocx.js');
    const content = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'bad', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'good', marks: [{ type: 'link', attrs: { href: 'https://example.com/ok' } }] }] },
    ] };
    const zip = await JSZip.loadAsync(await pmToDocx(content, { title: 'T' }));
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    const body = await zip.file('word/document.xml')!.async('string');
    expect(rels).toContain('https://example.com/ok');
    expect(rels + body).not.toMatch(/javascript:/i);
    expect(body).toContain('bad'); // the text survives as plain text
  });
});

describe('DE87CD-13 — a line break inside applied text survives every export', () => {
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First line.\n\nSecond line.' }] }] };

  it('becomes Markdown hard breaks, and a code block stays verbatim', async () => {
    const { pmToMarkdown } = await import('../src/features/document-editor/pmToMarkdown.js');
    expect(pmToMarkdown(content)).toBe('First line.  \n  \nSecond line.\n');
    expect(pmToMarkdown({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'a\n**b**' }] }] })).toBe('```\na\n**b**\n```\n');
  });

  it('becomes docx breaks', async () => {
    const { pmToDocx } = await import('../src/features/document-editor/pmToDocx.js');
    const body = await (await JSZip.loadAsync(await pmToDocx(content, { title: 'T' }))).file('word/document.xml')!.async('string');
    expect(body.match(/<w:br\/>/g)?.length).toBe(2);
    expect(body).toContain('Second line.');
  });
});


// DE87CD-15 — the HOME-vs-ACTIVE tenant trap. In a real shared `ws:` workspace
// the caller's home tenant (`user:<hash>`) is not the workspace's, and canvases
// live under the workspace's. RED on `13fb94b5d`: the export loaded the canvas
// under `user.tenantId` and answered 404 to the member who had just created it.
describe('DE87CD-15 — the export works inside a real shared workspace', () => {
  it('a member exports a document they created in a ws: workspace', async () => {
    const c = client();
    expect((await c.post(`${H}/test/login`, { email: `de1055-ws-${Date.now()}-${n++}@acme.test` })).status).toBe(201);
    const ws = await c.post<{ workspaceId: string }>(`${H}/workspaces`, { name: `WS ${n++}` });
    expect(ws.body.workspaceId).toMatch(/^ws:/);
    expect((await c.post<{ active: string }>(`${H}/workspaces/${encodeURIComponent(ws.body.workspaceId)}/switch`)).body.active).toBe(ws.body.workspaceId);
    const org = await c.post<{ org?: { orgId: string }; orgId?: string }>(`${H}/orgs`, { name: 'Acme' });
    const orgId = org.body.org?.orgId ?? org.body.orgId ?? '';
    const created = await c.post<CanvasBody>(`${DE(orgId)}/canvases`, { name: 'Shared doc' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const res = await fetchExport(c, orgId, created.body.canvasId);
    expect(res.status, res.text.slice(0, 200)).toBe(200);
    expect(res.contentType).toMatch(/text\/markdown/);
  });
});

/** The export answers a file, not JSON, so it gets its own small reader. */
async function fetchExport(c: ReturnType<typeof client>, orgId: string, canvasId: string): Promise<{ status: number; text: string; contentType: string }> {
  const res = await c.raw(`${DE(orgId)}/canvases/${encodeURIComponent(canvasId)}/export`, { format: 'markdown' });
  return { status: res.status, text: await res.text(), contentType: res.headers.get('content-type') ?? '' };
}
