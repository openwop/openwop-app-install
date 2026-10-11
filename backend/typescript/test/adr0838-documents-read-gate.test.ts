/**
 * ADR 0838 D3 / D5 — ONE document read gate on every exit, write tier on the
 * run surface's writers, and the checked `documents.revise` tool.
 *
 * `DOCWF2-9` — `openwop:documents.get` checked only org `workspace:read`, while the
 * HTTP GET door also asks the ADR 0610 D3′ project seam. An org VIEWER who is not a
 * member of a private project (the caller `levelFor` walks to `'none'`) got the full
 * body through the chat. The run surface's `getDocument`/`listDocuments` had the
 * same gap for a run acting for that viewer.
 *
 * `DOCWF2-3` — the surface registered no `orgPolicy`, so the ADR 0832 floor asked
 * read tier of every writer.
 *
 * Sabotage-witnessed (grade-tests w14): dropping the read gate from documents.get,
 * the run surface's reads, or the CRM e-sign exit; dropping the writers' method
 * scopes or a method from the partition; a lax stale-base check; no revise
 * idempotency key; dropping revise's write-tier check; ignoring the pinned e-sign
 * version; and both source ratchets (an ungated version reader, a second raw writer)
 * each turn a case red.
 *
 * Honest ceiling: revise's `canReadDocument` clause is a double guard no fixture can
 * isolate — every `workspace:write` holder resolves `write` on every project
 * (`projectsService.levelFor`), and user-owned documents have no subject resolver, so
 * a caller who passes the write tier always passes the read gate.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember } from '../src/host/accessControlService.js';
import { buildFeatureSurfaces } from '../src/host/featureSurfaces.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { DOCUMENTS_GET_TOOL_ID, DOCUMENTS_REVISE_TOOL_ID } from '../src/features/documents/agentTools.js';
import {
  buildDocumentsSurface, DOCUMENTS_SURFACE_READS, DOCUMENTS_SURFACE_WRITERS,
} from '../src/features/documents/surface.js';
import { getDocument, listVersions, addVersion } from '../src/features/documents/documentsService.js';
import { renderTarget } from '../src/features/crm/signTargets.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env.OPENWOP_DEMO_MODE;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'projects', 'documents']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: Record<string, unknown> | undefined }
/** A string field of a JSON body (fails loudly when the fixture call did not return it). */
function field(r: Res, ...path: string[]): string {
  let v: unknown = r.body;
  for (const k of path) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  if (typeof v !== 'string') throw new Error(`fixture: ${path.join('.')} missing in ${r.status} ${JSON.stringify(r.body)}`);
  return v;
}
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const json: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: json && typeof json === 'object' ? (json as Record<string, unknown>) : undefined };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b) };
}
const uniq = (who: string) => `${who}-${Date.now()}-${n++}@acme.test`;
const DOC = (orgId: string) => `/host/openwop-app/documents/orgs/${encodeURIComponent(orgId)}/documents`;
const SECRET = 'BOARD-ONLY: acquire Globex for 42M';

async function fixture() {
  const tenantId = `org:a0838rg-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = field(await owner.post('/host/openwop-app/test/login', { email: uniq('own'), tenantId }), 'user', 'userId');
  const orgId = field(await owner.post('/host/openwop-app/orgs', { name: 'PrivCo' }), 'orgId');
  const projectId = field(await owner.post('/host/openwop-app/projects', { orgId, name: 'Secret' }), 'id');
  const doc = await owner.post(DOC(orgId), { title: 'Merger plan', kind: 'note', format: 'markdown', ownerSubject: { kind: 'project', id: projectId } });
  expect(doc.status, JSON.stringify(doc.body)).toBe(201);
  const documentId = field(doc, 'documentId');
  expect((await owner.post(`${DOC(orgId)}/${documentId}/versions`, { content: SECRET })).status).toBe(201);
  expect((await owner.patch(`/host/openwop-app/projects/${projectId}/visibility`, { visibility: 'private' })).status).toBe(200);
  const viewer = client();
  const viewerId = field(await viewer.post('/host/openwop-app/test/login', { email: uniq('view'), tenantId }), 'user', 'userId');
  await createMember({ tenantId, orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
  const editor = client();
  const editorId = field(await editor.post('/host/openwop-app/test/login', { email: uniq('edit'), tenantId }), 'user', 'userId');
  await createMember({ tenantId, orgId, subject: editorId, displayName: 'E', roles: ['editor'] });
  return { tenantId, orgId, projectId, documentId, owner, ownerId, viewer, viewerId, editorId };
}

describe('ADR 0838 D3 — the chat read tool asks the same gate as the HTTP door', () => {
  it('an org viewer outside a private project gets not_found from documents.get, as from GET', async () => {
    const f = await fixture();
    // Control: the HTTP door already refuses this caller.
    expect((await f.viewer.get(`${DOC(f.orgId)}/${f.documentId}`)).status).toBe(404);
    const provider = createAgentToolProvider({ tenantId: f.tenantId, runId: 'run-rg-1', actingUserId: f.viewerId });
    const out = await provider.executeTool({ name: DOCUMENTS_GET_TOOL_ID, input: { documentId: f.documentId } });
    expect(out.content).not.toContain(SECRET);
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content).error).toBe('not_found');
  });

  it('positive control: the owner reads it, and the result carries the version to base an edit on', async () => {
    const f = await fixture();
    const provider = createAgentToolProvider({ tenantId: f.tenantId, runId: 'run-rg-2', actingUserId: f.ownerId });
    const out = await provider.executeTool({ name: DOCUMENTS_GET_TOOL_ID, input: { documentId: f.documentId } });
    const body = JSON.parse(out.content);
    expect(body.content).toBe(SECRET);
    expect(body.currentVersionId).toBe(`${f.documentId}:1`);
    expect(body.version).toBe(1);
  });
});

describe('ADR 0838 D3 — the run surface reads through the same gate', () => {
  it('a run acting for the viewer cannot read or list the private project document', async () => {
    const f = await fixture();
    const s = buildFeatureSurfaces({ tenantId: f.tenantId, runId: 'run-rg-3', actingUserId: f.viewerId }).documents!;
    expect((await s.getDocument!({ orgId: f.orgId, documentId: f.documentId }) as { document: unknown }).document).toBeNull();
    const listed = await s.listDocuments!({ orgId: f.orgId }) as { documents: { documentId: string }[] };
    expect(listed.documents.map((d) => d.documentId)).not.toContain(f.documentId);
  });

  it('positive control: a run acting for the owner reads it', async () => {
    const f = await fixture();
    const s = buildFeatureSurfaces({ tenantId: f.tenantId, runId: 'run-rg-4', actingUserId: f.ownerId }).documents!;
    expect((await s.getDocument!({ orgId: f.orgId, documentId: f.documentId }) as { document: { documentId: string } | null }).document?.documentId).toBe(f.documentId);
  });
});

describe('ADR 0838 D3 — surface writers ask write tier (DOCWF2-3)', () => {
  it('the method partition is closed-world', () => {
    const methods = Object.keys(buildDocumentsSurface({ tenantId: 't-part' })).sort();
    const classified = [...DOCUMENTS_SURFACE_READS, ...DOCUMENTS_SURFACE_WRITERS];
    expect(new Set(classified).size, 'a method is in both sets').toBe(classified.length);
    expect([...classified].sort()).toEqual(methods);
  });

  it('a run acting for an org viewer cannot create or version a document', async () => {
    const f = await fixture();
    const s = buildFeatureSurfaces({ tenantId: f.tenantId, runId: 'run-rg-5', actingUserId: f.viewerId }).documents!;
    await expect(s.createDocument!({ orgId: f.orgId, title: 'x', kind: 'doc' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(s.createDraftDocument!({ orgId: f.orgId, title: 'x', content: 'y' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(s.addVersion!({ orgId: f.orgId, documentId: f.documentId, content: 'z' })).rejects.toMatchObject({ code: 'forbidden_scope' });
    await expect(s.render!({ orgId: f.orgId, documentId: f.documentId })).rejects.toMatchObject({ code: 'forbidden_scope' });
  });

  it('positive control: a run acting for an org editor can', async () => {
    const f = await fixture();
    const s = buildFeatureSurfaces({ tenantId: f.tenantId, runId: 'run-rg-6', actingUserId: f.editorId }).documents!;
    const out = await s.createDocument!({ orgId: f.orgId, title: 'ok', kind: 'doc' }) as { document: { documentId: string } };
    expect(out.document.documentId).toBeTruthy();
  });
});

describe('ADR 0838 D5 — documents.revise is a checked edit', () => {
  const revise = (tenantId: string, actingUserId: string, input: Record<string, unknown>, runId = `run-rv-${n++}`) =>
    createAgentToolProvider({ tenantId, runId, actingUserId }).executeTool({ name: DOCUMENTS_REVISE_TOOL_ID, input });

  it('revises from the version it read; a stale base is a typed refusal naming the current version', async () => {
    const f = await fixture();
    const base = `${f.documentId}:1`;
    const ok = await revise(f.tenantId, f.ownerId, { documentId: f.documentId, baseVersionId: base, content: 'tightened' });
    expect(ok.isError, ok.content).toBeFalsy();
    expect(JSON.parse(ok.content).version).toBe(2);
    const stale = await revise(f.tenantId, f.ownerId, { documentId: f.documentId, baseVersionId: base, content: 'clobber' });
    expect(stale.isError).toBe(true);
    const err = JSON.parse(stale.content);
    expect(err.error).toBe('stale_base');
    expect(err.currentVersionId).toBe(`${f.documentId}:2`);
    expect((await listVersions(f.tenantId, f.orgId, f.documentId)).length).toBe(2);
  });

  it('an exact retry in the same run returns the version it already wrote', async () => {
    const f = await fixture();
    const input = { documentId: f.documentId, baseVersionId: `${f.documentId}:1`, content: 'once' };
    const a = await revise(f.tenantId, f.ownerId, input, 'run-rv-retry');
    const b = await revise(f.tenantId, f.ownerId, input, 'run-rv-retry');
    expect(JSON.parse(a.content).versionId).toBe(JSON.parse(b.content).versionId);
    expect((await listVersions(f.tenantId, f.orgId, f.documentId)).length).toBe(2);
  });

  it('refuses a viewer (no write) and a non-member (no read) with not_found', async () => {
    const f = await fixture();
    const out = await revise(f.tenantId, f.viewerId, { documentId: f.documentId, baseVersionId: `${f.documentId}:1`, content: 'x' });
    expect(JSON.parse(out.content).error).toBe('not_found');
    expect((await getDocument(f.tenantId, f.orgId, f.documentId))?.currentVersionId).toBe(`${f.documentId}:1`);

    // An ORG-scoped document (no ownerSubject) the viewer CAN read: only the write tier
    // can refuse here, so this isolates revise's `workspace:write` check.
    const orgDoc = await f.owner.post(DOC(f.orgId), { title: 'Org memo', kind: 'note', format: 'markdown' });
    expect(orgDoc.status, JSON.stringify(orgDoc.body)).toBe(201);
    const orgDocId = field(orgDoc, 'documentId');
    expect((await f.owner.post(`${DOC(f.orgId)}/${orgDocId}/versions`, { content: 'org text' })).status).toBe(201);
    expect((await f.viewer.get(`${DOC(f.orgId)}/${orgDocId}`)).status).toBe(200); // control: readable
    const byViewer = await revise(f.tenantId, f.viewerId, { documentId: orgDocId, baseVersionId: `${orgDocId}:1`, content: 'viewer edit' });
    expect(byViewer.isError).toBe(true);
    expect(JSON.parse(byViewer.content).error).toBe('not_found');

    // A member with no role (no read, no write) is refused the same way.
    const nobodyId = `u-nobody-${n++}`;
    await createMember({ tenantId: f.tenantId, orgId: f.orgId, subject: nobodyId, displayName: 'N', roles: [] });
    const byNobody = await revise(f.tenantId, nobodyId, { documentId: orgDocId, baseVersionId: `${orgDocId}:1`, content: 'nobody edit' });
    expect(JSON.parse(byNobody.content).error).toBe('not_found');
    expect((await listVersions(f.tenantId, f.orgId, orgDocId)).map((v) => v.content)).toEqual(['org text']);
  });
});

describe('ADR 0838 D3 — ratchet: every module that reads document versions imports the one gate', () => {
  // grade-code H1 — scanning only features/documents/** missed the CRM e-sign
  // exit; the population is every module that imports the documents service.
  // A module that reads version CONTENT must call the gate, or be named here
  // with the reason it is not an exit.
  const NOT_AN_EXIT: Record<string, string> = {
    'features/documents/erasure.ts': 'anonymises ids in place; returns nothing',
    'features/documents/seedTemplates.ts': 'starter catalog only',
    'features/sharing/sharingService.ts': 'serves publicDocumentView (the pinned approved version) to the public lane; the MINT calls canReadDocument',
    'features/podcasts/podcastsService.ts': 'DOC2CD-4 — filed: public transcript serves the newest version (pre-existing, owned by podcasts)',
  };
  it('no module reading document versions skips canReadDocument', () => {
    const root = join(__dirname, '..', 'src');
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [join(d, e.name)] : []));
    const offenders = walk(root).filter((f) => {
      const rel = f.slice(root.length + 1);
      if (rel === 'features/documents/documentsService.ts' || NOT_AN_EXIT[rel]) return false;
      const src = readFileSync(f, 'utf8');
      if (!/documentsService\.js/.test(src)) return false;
      return /\bgetVersion\b/.test(src) && !/\bcanReadDocument\b/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it('no second writer of documents:doc rows outside the service CAS helper', () => {
    const dir = join(__dirname, '..', 'src', 'features', 'documents');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      if (f === 'documentsService.ts') {
        // The only raw puts: the insert-only CAS in createDocument and the test seam.
        expect(src.match(/\bdocs\.put\(/g)?.length ?? 0, f).toBe(1);
      } else {
        expect(/\bdocs\.(put|compareAndSwap)\(/.test(src), f).toBe(false);
      }
    }
  });
});

describe('ADR 0838 D3 — the CRM e-sign document target is an exit too (grade-code H1)', () => {
  it('a requester who cannot read the document cannot send it to a signer; the owner can, and the request pins the version', async () => {
    const f = await fixture();
    await expect(renderTarget(f.tenantId, f.orgId, { kind: 'document', id: f.documentId }, { reader: f.viewerId }))
      .rejects.toMatchObject({ httpStatus: 404 });
    const asOwner = await renderTarget(f.tenantId, f.orgId, { kind: 'document', id: f.documentId }, { reader: f.ownerId });
    expect(asOwner.markdown).toBe(SECRET);
    expect(asOwner.versionId).toBe(`${f.documentId}:1`);
    // Text saved after the request never reaches the signer page.
    await addVersion(f.tenantId, f.orgId, f.documentId, { content: 'saved later, never approved', producedBy: { kind: 'user', id: f.ownerId } });
    const later = await renderTarget(f.tenantId, f.orgId, { kind: 'document', id: f.documentId, versionId: asOwner.versionId! });
    expect(later.markdown).toBe(SECRET);
    expect(later.canonical).toBe(asOwner.canonical);
  });
});
