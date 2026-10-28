/**
 * ADR 0904 P0 — `GET /host/openwop-app/kb/orgs/:orgId/quality`: which retrieval each
 * collection is ACTUALLY getting (embedder in force and whether it resolves, mode, index
 * freshness). Through the real HTTP boundary, because the risks are door risks:
 *  - it is a LISTING, so a private project's collection must be absent for an org reader
 *    who is not a project member, exactly as from `GET /collections` (CPC-2 was a listing
 *    leaking a collection name). Sabotage: read through an ungated list ⇒ the intruder
 *    leg is red;
 *  - it must not hydrate (a read that embeds would spend): a collection whose config
 *    moved past its vectors stays `stale` across the call, and turns `current` only
 *    after a real search rebuilds it;
 *  - a `provider` collection with no resolvable key reports `available:false` honestly.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';
import { addProjectMember, createProject, setProjectVisibility, projectSubject } from '../src/features/projects/projectsService.js';
import { createCollection, ingestDocument, search, setRetrievalConfig, type CollectionQuality } from '../src/features/kb/kbService.js';

let BASE = '';
let server: http.Server;
let n = 0;

interface Body { user?: { userId: string }; orgId?: string; collections?: CollectionQuality[] }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body | undefined }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    for (const sc of typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : []) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]!; }
    return { status: res.status, body: (await res.json().catch(() => undefined)) as Body | undefined };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b) };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});

describe('ADR 0904 P0 — GET …/kb/orgs/:orgId/quality', () => {
  it('reports the retrieval in force, never hydrates, and hides a private project collection from a non-member', async () => {
    const owner = client();
    const tenantId = `org:kb-quality-${Date.now()}-${n++}`;
    const login = await owner.post('/host/openwop-app/test/login', { email: `member-${n++}@acme.test`, tenantId });
    expect(login.status).toBe(201);
    const member = login.body!.user!.userId;
    const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
    const orgId = org.body!.orgId!;
    const viewer = client();
    const login2 = await viewer.post('/host/openwop-app/test/login', { email: `viewer-${n++}@acme.test`, tenantId });
    const intruder = login2.body!.user!.userId;
    expect((await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Viewer', subject: intruder, roles: ['viewer'] })).status).toBe(201);

    const open = await createCollection(tenantId, orgId, member, { name: 'handbook' });
    await ingestDocument(tenantId, orgId, member, open.collectionId, { title: 'Leave', text: 'Parental leave is sixteen weeks at full pay.' }, {}, PREAUTHORIZED_CALLER);
    const project = await createProject(tenantId, orgId, { name: 'Private project' });
    await addProjectMember(tenantId, project.id, `user:${member}`, 'contributor');
    await setProjectVisibility(tenantId, project.id, 'private');
    const priv = await createCollection(tenantId, orgId, member, { name: 'private corpus' }, { boundSubject: projectSubject(project.id) });
    const byok = await createCollection(tenantId, orgId, member, { name: 'byok corpus' });
    await setRetrievalConfig(tenantId, orgId, byok.collectionId, member, { embedder: 'provider', mode: 'hybrid' }, PREAUTHORIZED_CALLER);

    const path = `/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/quality`;
    const mine = await owner.get(path);
    expect(mine.status).toBe(200);
    const byId = new Map(mine.body!.collections!.map((c) => [c.collectionId, c]));
    expect([...byId.keys()].sort()).toEqual([open.collectionId, priv.collectionId, byok.collectionId].sort());

    const h = byId.get(open.collectionId)!;
    expect(h.embedder).toMatchObject({ mode: 'local', provider: 'local', model: 'local-hash-v1', available: true });
    expect(h.retrievalMode).toBe('hybrid'); // ADR 0904 D5 (P3) — the default for a collection under 5,000 chunks
    expect(h.documentCount).toBe(1);
    // Ingest built the local index, so it serves what the configuration asks for.
    expect(h.indexState).toBe('current');
    // A config change the vectors do not reflect yet ⇒ `stale`, and ASKING must not
    // rebuild it (a hydrate would embed — spend on a provider collection). Only a real
    // search does.
    await setRetrievalConfig(tenantId, orgId, open.collectionId, member, { enrichment: 'heading-path' }, PREAUTHORIZED_CALLER);
    const stateOf = async () => (await owner.get(path)).body!.collections!.find((c) => c.collectionId === open.collectionId)!.indexState;
    expect(await stateOf()).toBe('stale');
    expect(await stateOf()).toBe('stale');
    await search(tenantId, orgId, open.collectionId, 'parental leave', 3, 'dense', PREAUTHORIZED_CALLER);
    expect(await stateOf()).toBe('current');

    // No BYOK key in this tenant ⇒ the provider arm does not resolve, reported honestly.
    const b = byId.get(byok.collectionId)!;
    expect(b.embedder).toMatchObject({ mode: 'provider', available: false });
    expect(b.retrievalMode).toBe('hybrid');
    expect(b.expectedSignature).toBeNull();
    expect(b.indexState).toBe('unbuilt');

    // An org READER who is not a project member: the private collection is absent.
    const theirs = await viewer.get(path);
    expect(theirs.status).toBe(200);
    expect(theirs.body!.collections!.map((c) => c.collectionId).sort()).toEqual([open.collectionId, byok.collectionId].sort());

    // Not in the org at all ⇒ refused at the org scope.
    const stranger = client();
    await stranger.post('/host/openwop-app/test/login', { email: `stranger-${n++}@acme.test`, tenantId });
    expect([403, 404]).toContain((await stranger.get(path)).status);
  }, 60_000);
});
