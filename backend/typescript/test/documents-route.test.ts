/**
 * Documents & Templates (ADR 0053) — ROUTE-level harness. Boots the real app and
 * drives the org-scoped, RBAC-gated feature over HTTP: toggle gating, document +
 * version + template CRUD, idempotent version writes, the assemble validate/render
 * floor, cross-tenant IDOR (fail-closed), and the Sharing `document` resolver's
 * approved/final-only visibility.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __putCanvasForTest } from '../src/host/canvasSurface.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'documents', 'sharing']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

let n = 0;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function signup(c: Client, opts: { tenantId?: string } = {}): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('doc'), ...(opts.tenantId ? { tenantId: opts.tenantId } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

async function ownerWithOrg(): Promise<{ owner: Client; orgId: string }> {
  const owner = client();
  await signup(owner, { tenantId: `org:test-${Date.now()}-${n++}` });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
async function ownerWithMember(role: string): Promise<{ owner: Client; member: Client; orgId: string }> {
  const tenantId = `org:test-${Date.now()}-${n++}`;
  const owner = client();
  await signup(owner, { tenantId });
  const member = client();
  const memberUser = await signup(member, { tenantId });
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId;
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject: memberUser.userId, roles: [role] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);
  return { owner, member, orgId };
}
const D = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/documents/orgs/${encodeURIComponent(orgId)}${suffix}`;

describe('documents — toggle gating', () => {
  it('404s when the documents toggle is off', async () => {
    await setToggle('documents', 'off');
    const { owner, orgId } = await ownerWithOrg();
    expect((await owner.get(D(orgId, '/documents'))).status).toBe(404);
    await setToggle('documents', 'on');
  });
});

describe('documents — document + version lifecycle', () => {
  it('creates a document, appends versions (current pointer + idempotency), and lists', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(D(orgId, '/documents'), { title: 'Acme SOW', kind: 'sow' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.documentId;
    expect(created.body.status).toBe('draft');

    const v1 = await owner.post(D(orgId, `/documents/${id}/versions`), { content: '# SOW v1', idempotencyKey: 'k1' });
    expect(v1.status).toBe(201);
    expect(v1.body.version).toBe(1);
    expect(v1.body.versionId).toBe(`${id}:1`);

    // Same idempotency key ⇒ same version (no duplicate).
    const v1again = await owner.post(D(orgId, `/documents/${id}/versions`), { content: 'IGNORED', idempotencyKey: 'k1' });
    expect(v1again.status).toBe(201);
    expect(v1again.body.versionId).toBe(`${id}:1`);
    expect(v1again.body.content).toBe('# SOW v1');

    const v2 = await owner.post(D(orgId, `/documents/${id}/versions`), { content: '# SOW v2' });
    expect(v2.body.version).toBe(2);

    const got = await owner.get(D(orgId, `/documents/${id}`));
    expect(got.body.currentVersionId).toBe(`${id}:2`);
    expect(got.body.currentVersion.content).toBe('# SOW v2');

    const list = await owner.get(D(orgId, '/documents?kind=sow'));
    expect(list.body.documents.length).toBe(1);
  });
});

describe('documents — templates + assemble', () => {
  it('rejects a missing required param and renders when provided', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const t = await owner.post(D(orgId, '/templates'), {
      name: 'SOW template', kind: 'sow',
      promptBody: 'Draft a SOW for {{client}} covering {{scope}}.',
      parameters: { required: ['client', 'scope'], properties: { client: { type: 'string' }, scope: { type: 'string' } } },
      outputSchema: { type: 'object' },
    });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const tid = t.body.templateId;

    const bad = await owner.post(D(orgId, `/templates/${tid}/assemble`), { params: { client: 'Acme' } });
    expect(bad.status).toBe(400);

    const ok = await owner.post(D(orgId, `/templates/${tid}/assemble`), { params: { client: 'Acme', scope: 'a website' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.augmentedPrompt).toBe('Draft a SOW for Acme covering a website.');
    expect(ok.body.outputSchema).toBeTruthy();
  });
});

describe('documents — cross-tenant IDOR (fail-closed)', () => {
  it('a different tenant cannot read another tenant document (uniform 404)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(D(orgId, '/documents'), { title: 'Secret', kind: 'prd' });
    const id = created.body.documentId;
    const stranger = client();
    await signup(stranger, { tenantId: `org:other-${Date.now()}-${n++}` });
    expect((await stranger.get(D(orgId, `/documents/${id}`))).status).toBe(404);
  });
});

describe('documents — sharing resolver is approved/final-only', () => {
  it('refuses to mint a link for a draft, allows it once approved, and resolves the content', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(D(orgId, '/documents'), { title: 'Board agenda', kind: 'board-agenda' });
    const id = created.body.documentId;
    await owner.post(D(orgId, `/documents/${id}/versions`), { content: '# Agenda\n- Item 1' });

    const mintBase = `/v1/host/openwop-app/sharing/orgs/${encodeURIComponent(orgId)}/links`;
    // Draft ⇒ resource not shareable ⇒ mint 404s (no leak).
    const draftMint = await owner.post(mintBase, { resourceType: 'document', resourceId: id });
    expect(draftMint.status).toBe(404);

    // Approve, then mint succeeds and resolves the content.
    await owner.patch(D(orgId, `/documents/${id}`), { status: 'approved' });
    const mint = await owner.post(mintBase, { resourceType: 'document', resourceId: id });
    expect(mint.status, JSON.stringify(mint.body)).toBe(201);
    const token = mint.body.token;

    const pub = client();
    const shared = await pub.get(`/v1/host/openwop-app/shared/${encodeURIComponent(token)}`);
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect(shared.body.resource.content).toContain('# Agenda');

    // Revert to draft ⇒ BOTH the content AND the social card go dark (the card
    // must not keep leaking the title once the document is no longer shareable).
    await owner.patch(D(orgId, `/documents/${id}`), { status: 'draft' });
    expect((await pub.get(`/v1/host/openwop-app/shared/${encodeURIComponent(token)}`)).status).toBe(404);
    expect((await pub.get(`/v1/host/openwop-app/shared/${encodeURIComponent(token)}/card`)).status).toBe(404);
  });
});

describe('documents — approval is privileged (host:members:manage)', () => {
  it('an editor (workspace:write) can edit but NOT approve; an owner can', async () => {
    const { owner, member, orgId } = await ownerWithMember('editor');
    const created = await member.post(D(orgId, '/documents'), { title: 'Proposal', kind: 'rfp' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.documentId;

    // Editor can write content + non-privileged status…
    expect((await member.post(D(orgId, `/documents/${id}/versions`), { content: '# RFP' })).status).toBe(201);
    expect((await member.patch(D(orgId, `/documents/${id}`), { status: 'in-review' })).status).toBe(200);
    // …but cannot promote to a publicly-shareable status.
    expect((await member.patch(D(orgId, `/documents/${id}`), { status: 'approved' })).status).toBe(403);
    expect((await member.patch(D(orgId, `/documents/${id}`), { status: 'final' })).status).toBe(403);
    // The owner (host:members:manage) can.
    expect((await owner.patch(D(orgId, `/documents/${id}`), { status: 'approved' })).status).toBe(200);
  });
});

describe('documents — status state machine', () => {
  it('rejects an invalid status jump (draft → final) with 409', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(D(orgId, '/documents'), { title: 'Brief', kind: 'epic-brief' });
    const id = created.body.documentId;
    // draft → final is not a legal transition (must pass through approved).
    const bad = await owner.patch(D(orgId, `/documents/${id}`), { status: 'final' });
    expect(bad.status, JSON.stringify(bad.body)).toBe(409);
    // draft → approved → final IS legal.
    expect((await owner.patch(D(orgId, `/documents/${id}`), { status: 'approved' })).status).toBe(200);
    expect((await owner.patch(D(orgId, `/documents/${id}`), { status: 'final' })).status).toBe(200);
  });
});

describe('documents — ownerSubject is validated (not an arbitrary tag)', () => {
  it('rejects an ownerSubject referencing a non-existent user (uniform 404)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const r = await owner.post(D(orgId, '/documents'), { title: 'Owned', kind: 'doc', ownerSubject: { kind: 'user', id: 'user:ghost' } });
    expect(r.status, JSON.stringify(r.body)).toBe(404);
  });
});

describe('documents — starter template catalog', () => {
  it('lists built-in starters, instantiates one as an editable template, and assembles it', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const cat = await owner.get(D(orgId, '/templates/catalog'));
    expect(cat.status, JSON.stringify(cat.body)).toBe(200);
    const ids: string[] = cat.body.catalog.map((c: { catalogId: string }) => c.catalogId);
    expect(ids).toEqual(expect.arrayContaining(['seed.sow', 'seed.prd', 'seed.rfp', 'seed.epic-brief', 'seed.board-agenda']));

    // "catalog" is not captured as a template id (route-order check).
    expect((await owner.get(D(orgId, '/templates'))).body.templates.length).toBe(0);

    const made = await owner.post(D(orgId, '/templates/from-catalog/seed.sow'));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.kind).toBe('sow');
    expect((await owner.get(D(orgId, '/templates'))).body.templates.length).toBe(1);

    const asm = await owner.post(D(orgId, `/templates/${made.body.templateId}/assemble`), { params: { client: 'Acme', scope: 'a rebrand' } });
    expect(asm.status, JSON.stringify(asm.body)).toBe(200);
    expect(asm.body.augmentedPrompt).toContain('Acme');

    expect((await owner.post(D(orgId, '/templates/from-catalog/seed.bogus'))).status).toBe(404);
  });
});

describe('documents — materialize from canvas (ADR 0056)', () => {
  it('creates a document from a canvas (idempotent per version); unknown canvas → 404', async () => {
    const tenantId = `org:c2d-${Date.now()}-${n++}`;
    const c = client();
    await signup(c, { tenantId });
    const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    const orgId = org.body.orgId;
    await __putCanvasForTest({ canvasId: 'canvas:t1', tenantId, canvasTypeId: 'canvas.brief', name: 'Q3 Brief', state: { content: '# Brief\n\nGoals and scope.' } });

    const r = await c.post(D(orgId, '/documents/from-canvas'), { canvasId: 'canvas:t1' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.created).toBe(true);
    const docId = r.body.documentId;
    const doc = await c.get(D(orgId, `/documents/${docId}`));
    expect(doc.body.kind).toBe('epic-brief'); // canvas.brief → epic-brief
    expect(doc.body.currentVersion.content).toContain('# Brief');

    // Idempotent: same canvas version → 200, same document, not created.
    const again = await c.post(D(orgId, '/documents/from-canvas'), { canvasId: 'canvas:t1' });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.documentId).toBe(docId);

    // Stale-mapping fix: deleting the materialized doc then re-materializing
    // re-creates a fresh document rather than 404-ing on the dangling mapping.
    expect((await c.del(D(orgId, `/documents/${docId}`))).status).toBe(204);
    const recreated = await c.post(D(orgId, '/documents/from-canvas'), { canvasId: 'canvas:t1' });
    expect(recreated.status, JSON.stringify(recreated.body)).toBe(201);
    expect(recreated.body.created).toBe(true);
    expect(recreated.body.documentId).not.toBe(docId);

    expect((await c.post(D(orgId, '/documents/from-canvas'), { canvasId: 'canvas:nope' })).status).toBe(404);
  });
});

describe('documents — artifact-type binding + discovery + schema serving (ADR 0055)', () => {
  it('lists types, validates the template binding, advertises host.artifactTypes, and serves schemas', async () => {
    const { owner, orgId } = await ownerWithOrg();

    const at = await owner.get(D(orgId, '/artifact-types'));
    expect(at.status, JSON.stringify(at.body)).toBe(200);
    expect(at.body.artifactTypes.map((t: { artifactTypeId: string }) => t.artifactTypeId)).toEqual(expect.arrayContaining(['doc.sow', 'doc.prd']));
    // ADR 0055 Phase 3: the vendored core.openwop.artifact-types pack registers at boot.
    const onePager = at.body.artifactTypes.find((t: { artifactTypeId: string; registrationSource?: string }) => t.artifactTypeId === 'doc.one-pager');
    expect(onePager, 'doc.one-pager from the artifact-type pack').toBeTruthy();
    expect(onePager.registrationSource).toBe('pack');

    // A bound artifactTypeId MUST be registered (no opaque tags).
    expect((await owner.post(D(orgId, '/templates'), { name: 'X', kind: 'sow', promptBody: 'b', artifactTypeId: 'doc.bogus' })).status).toBe(400);
    expect((await owner.post(D(orgId, '/templates'), { name: 'X', kind: 'sow', promptBody: 'b', artifactTypeId: 'doc.sow' })).status).toBe(201);

    // Discovery advertises host.artifactTypes (public).
    const disc = await (await fetch(`${BASE}/.well-known/openwop`)).json();
    expect(JSON.stringify(disc)).toContain('artifactTypes');

    // Schemas served publicly; unknown → 404.
    const sch = await fetch(`${BASE}/schemas/artifacts/doc.sow.schema.json`);
    expect(sch.status).toBe(200);
    const schema = (await sch.json()) as { type?: string };
    expect(schema.type).toBe('object');
    expect((await fetch(`${BASE}/schemas/artifacts/doc.bogus.schema.json`)).status).toBe(404);
  });
});

describe('documents — render to PDF (ADR 0057)', () => {
  it('renders the current version to a PDF Media token; serves it; rejects unsupported formats', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(D(orgId, '/documents'), { title: 'Acme SOW', kind: 'sow' });
    const id = created.body.documentId;
    await owner.post(D(orgId, `/documents/${id}/versions`), { content: '# Statement of Work\n\n- Deliverable 1\n- Deliverable 2\n\n| Item | Cost |\n| --- | --- |\n| Design | $10k |' });

    const r = await owner.post(D(orgId, `/documents/${id}/render`), { format: 'pdf' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(typeof r.body.renderedMediaToken).toBe('string');
    expect(r.body.sizeBytes).toBeGreaterThan(0);
    expect(r.body.url).toContain('/assets/');

    // The version now carries the token.
    const ver = await owner.get(D(orgId, `/documents/${id}`));
    expect(ver.body.currentVersion.renderedMediaToken).toBe(r.body.renderedMediaToken);

    // The Media asset serves real PDF bytes.
    const served = await fetch(`${BASE}${r.body.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type') ?? '').toContain('application/pdf');
    const head = Buffer.from(await served.arrayBuffer()).subarray(0, 5).toString('latin1');
    expect(head).toBe('%PDF-');

    // slides → a PPTX (zip; bytes start with PK); does NOT overwrite the pdf token.
    const sl = await owner.post(D(orgId, `/documents/${id}/render`), { format: 'slides' });
    expect(sl.status, JSON.stringify(sl.body)).toBe(201);
    expect(sl.body.format).toBe('slides');
    const slBytes = await fetch(`${BASE}${sl.body.url}`);
    expect((slBytes.headers.get('content-type') ?? '')).toContain('presentationml');
    expect(Buffer.from(await slBytes.arrayBuffer()).subarray(0, 2).toString('latin1')).toBe('PK');
    expect((await owner.get(D(orgId, `/documents/${id}`))).body.currentVersion.renderedMediaToken).toBe(r.body.renderedMediaToken);

    // sheet → CSV with the table cells.
    const sh = await owner.post(D(orgId, `/documents/${id}/render`), { format: 'sheet' });
    expect(sh.status, JSON.stringify(sh.body)).toBe(201);
    const csv = await (await fetch(`${BASE}${sh.body.url}`)).text();
    expect(csv).toContain('Item');
    expect(csv).toContain('Design');

    // Unsupported format → 400.
    expect((await owner.post(D(orgId, `/documents/${id}/render`), { format: 'docx' })).status).toBe(400);
    // No content → 400.
    const empty = await owner.post(D(orgId, '/documents'), { title: 'Empty', kind: 'doc' });
    expect((await owner.post(D(orgId, `/documents/${empty.body.documentId}/render`), {})).status).toBe(400);
  });
});
