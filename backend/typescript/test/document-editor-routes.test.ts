/**
 * ADR 0334 (DOC-1) — document-editor routes. ROUTE-level over the shared
 * canvas-editor factory bound to `canvas.document`: blank create, the PM-JSON
 * editor-doc validator (malformed content → 422), optimistic-concurrency saves
 * (CAS → 409 on a stale version), cross-tenant IDOR (uniform 404), type pinning
 * (a drawing canvas is a 404 on the document routes), and delete.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';

const BASEPATH = '/v1/host/openwop-app/document-editor';
let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const users = getToggleDefault('users');
  if (users) await saveConfig({ ...users, status: 'on' }, 'test');
  const de = getToggleDefault('document-editor');
  if (de) await saveConfig({ ...de, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  const bin = async (path: string, body: unknown): Promise<{ status: number; contentType: string; text: string }> => {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, contentType: res.headers.get('content-type') ?? '', text: buf.toString('latin1') };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p), bin };
}

let n = 0;
async function orgOwner(): Promise<{ c: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const tenantId = `org:test-doc-ed-${Date.now()}-${n++}`;
  const c = client();
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `doced-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status).toBe(201);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: org.body.orgId, tenantId };
}

const docState = (title: string) => ({ title, content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: title }] }] } });

describe('document-editor routes (canvas.document)', () => {
  it('creates a blank document, gets it, and saves rich content with CAS', async () => {
    const { c, orgId } = await orgOwner();
    const created = await c.post(`${BASEPATH}/orgs/${orgId}/canvases`, { name: 'My Doc' });
    expect(created.status).toBe(201);
    expect(created.body.canvasTypeId).toBe('canvas.document');
    const id = created.body.canvasId;

    const got = await c.get(`${BASEPATH}/orgs/${orgId}/canvases/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.state.content.type).toBe('doc');

    const saved = await c.patch(`${BASEPATH}/orgs/${orgId}/canvases/${id}`, { state: docState('My Doc'), expectedVersion: got.body.version });
    expect(saved.status).toBe(200);
    // A stale expectedVersion → 409 (optimistic concurrency).
    const stale = await c.patch(`${BASEPATH}/orgs/${orgId}/canvases/${id}`, { state: docState('again'), expectedVersion: got.body.version });
    expect(stale.status).toBe(409);
  });

  it('rejects malformed PM-JSON with 422 (validator)', async () => {
    const { c, orgId } = await orgOwner();
    const created = await c.post(`${BASEPATH}/orgs/${orgId}/canvases`, { name: 'Bad' });
    const id = created.body.canvasId;
    const bad = await c.patch(`${BASEPATH}/orgs/${orgId}/canvases/${id}`, { state: { title: 'Bad', content: 'not-a-doc' } });
    expect(bad.status).toBe(422);
  });

  it('does not leak another tenant\'s document (cross-tenant 404)', async () => {
    const a = await orgOwner();
    const created = await a.c.post(`${BASEPATH}/orgs/${a.orgId}/canvases`, { name: 'Private' });
    const id = created.body.canvasId;
    const b = await orgOwner();
    const leak = await b.c.get(`${BASEPATH}/orgs/${b.orgId}/canvases/${id}`);
    expect(leak.status).toBe(404);
  });

  it('type-pins the routes — a drawing canvas is a 404 on the document routes', async () => {
    const { c, orgId, tenantId } = await orgOwner();
    const drawing = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.drawing', name: 'D', initialState: { title: 'D', shapes: [] } });
    const wrong = await c.get(`${BASEPATH}/orgs/${orgId}/canvases/${drawing.canvasId}`);
    expect(wrong.status).toBe(404);
  });

  it('exports the saved document as PDF and Markdown (ADR 0334 4b)', async () => {
    const { c, orgId } = await orgOwner();
    const created = await c.post(`${BASEPATH}/orgs/${orgId}/canvases`, { name: 'Report' });
    const id = created.body.canvasId;
    await c.patch(`${BASEPATH}/orgs/${orgId}/canvases/${id}`, { state: docState('Report'), expectedVersion: created.body.version });

    const pdf = await c.bin(`${BASEPATH}/orgs/${orgId}/canvases/${id}/export`, { format: 'pdf' });
    expect(pdf.status).toBe(200);
    expect(pdf.contentType).toContain('application/pdf');
    expect(pdf.text.startsWith('%PDF')).toBe(true);

    const md = await c.bin(`${BASEPATH}/orgs/${orgId}/canvases/${id}/export`, { format: 'markdown' });
    expect(md.status).toBe(200);
    expect(md.contentType).toContain('text/markdown');
    expect(md.text).toContain('# Report');

    const docx = await c.bin(`${BASEPATH}/orgs/${orgId}/canvases/${id}/export`, { format: 'docx' });
    expect(docx.status).toBe(200);
    expect(docx.contentType).toContain('wordprocessingml');
    expect(docx.text.startsWith('PK')).toBe(true); // .docx is a zip (PK magic)

    const bad = await c.bin(`${BASEPATH}/orgs/${orgId}/canvases/${id}/export`, { format: 'rtf' });
    expect(bad.status).toBe(400);
  });

  it('imports a .docx into HTML (ADR 0334 4b-3)', async () => {
    const { c, orgId } = await orgOwner();
    // Build a real .docx (docx.js — the 4b-2 dep) so we exercise mammoth end-to-end.
    const { Document, Packer, Paragraph, HeadingLevel } = await import('docx');
    const doc = new Document({ sections: [{ children: [
      new Paragraph({ text: 'Imported Title', heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ text: 'A body paragraph.' }),
    ] }] });
    const docxBase64 = (await Packer.toBuffer(doc)).toString('base64');

    const r = await c.post(`${BASEPATH}/orgs/${orgId}/import`, { docxBase64 });
    expect(r.status).toBe(200);
    expect(r.body.html).toContain('Imported Title');
    expect(r.body.html).toContain('A body paragraph.');
    expect(Array.isArray(r.body.warnings)).toBe(true);

    // Missing payload → 400.
    const empty = await c.post(`${BASEPATH}/orgs/${orgId}/import`, {});
    expect(empty.status).toBe(400);

    // Oversized payload → 413 (the import-DoS guard).
    const huge = await c.post(`${BASEPATH}/orgs/${orgId}/import`, { docxBase64: 'A'.repeat(11 * 1024 * 1024) });
    expect(huge.status).toBe(413);
  });

  it('deletes a document (204)', async () => {
    const { c, orgId } = await orgOwner();
    const created = await c.post(`${BASEPATH}/orgs/${orgId}/canvases`, { name: 'Doomed' });
    const del = await c.del(`${BASEPATH}/orgs/${orgId}/canvases/${created.body.canvasId}`);
    expect(del.status).toBe(204);
    expect((await c.get(`${BASEPATH}/orgs/${orgId}/canvases/${created.body.canvasId}`)).status).toBe(404);
  });
});
