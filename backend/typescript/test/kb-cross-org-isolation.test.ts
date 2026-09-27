/**
 * KB-1 / KB-4 — the coverage the KB suite has never had.
 *
 * The existing 14 KB suites use a SINGLE `ORG` constant, so nothing in the repo
 * could see a cross-org defect, and no test ever asserted that a deleted document
 * stops being searchable (`removeDocumentRow`'s vector delete was entirely
 * unpinned). Those two blind spots are exactly where the two Blockers lived:
 *
 *   KB-1 — the ingest/create routes narrowed `req.body` with a TypeScript CAST,
 *          which is erased at runtime, so a caller-supplied `collectionId` /
 *          `managed` / `documentId` reached the service; and the vector namespace
 *          was the bare `collectionId` with no org component, so two collections in
 *          one tenant sharing an id shared a vector namespace and a dense search in
 *          org A returned org B's chunk text.
 *   KB-4 — `removeDocumentRow` wiped with `chunkIds(doc)` (the CURRENT chunker)
 *          instead of the `staleWipeIds` union every sibling delete path uses, so a
 *          document deleted after a chunker-version change left an orphan tail
 *          carrying its full text that no later hydrate could reach.
 *
 * Each test below is written to FAIL on the pre-fix code, not merely to pass on the
 * post-fix code.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import {
  collectionNamespace,
  createCollection,
  deleteDocument,
  ingestDocument,
  search,
} from '../src/features/kb/kbService.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'kb']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
function client(): { post: (p: string, b?: unknown) => Promise<Res> } {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { post: (p, b) => call('POST', p, b) };
}

let n = 0;

/** ORG-A's rare token, and ORG-B's. Distinct so a leak is unambiguous. */
const ORG_A_TEXT = 'Alpha org runbook: incident code QQZ-1188 governs the failover drill.';
const ORG_B_TEXT = 'Beta org payroll: severance schedule WWX-7742 for the pending reduction.';

describe('KB-1 — a collection id shared across orgs does not share a vector namespace', () => {
  it('the namespace CARRIES the org (the invariant, stated at the seam)', () => {
    // Asserted directly because everything below depends on it, and because the
    // pre-fix value was the bare collectionId — a one-line regression away.
    const a = collectionNamespace({ collectionId: 'shared', orgId: 'org-a' } as never);
    const b = collectionNamespace({ collectionId: 'shared', orgId: 'org-b' } as never);
    expect(a).not.toBe(b);
    expect(a).toContain('org-a');
    expect(a).not.toBe('shared');
    // A signature-versioned (reindexed) collection keeps the org too.
    expect(collectionNamespace({ collectionId: 'shared', orgId: 'org-a', activeSignature: 'sig1' } as never)).toContain('org-a');
  });

  it('a dense search in org A cannot see org B\'s chunk text', async () => {
    // The attack the assessment traced: the managed-collection id convention is
    // deterministic and in-tree (`mgd-strategy-${orgId}`), so an org-A member who
    // can choose a collection id mints another org's and reads its chunks out of
    // the shared, tenant-only-scoped namespace. Reproduced at the SERVICE level
    // (the route no longer lets an id be chosen at all — asserted separately below),
    // because the namespace must be safe even for the internal managed lane.
    const tenantId = `kbxo-${Date.now()}-${n++}`;
    const SHARED = 'mgd-strategy-victim';

    // Victim org B populates first, so its vectors are already in the (pre-fix)
    // shared namespace when org A hydrates.
    await createCollection(tenantId, 'org-b', 'actor-b', { name: 'B strategy' }, { collectionId: SHARED });
    await ingestDocument(tenantId, 'org-b', 'actor-b', SHARED, { title: 'Payroll', text: ORG_B_TEXT });

    await createCollection(tenantId, 'org-a', 'actor-a', { name: 'A strategy' }, { collectionId: SHARED });
    await ingestDocument(tenantId, 'org-a', 'actor-a', SHARED, { title: 'Runbook', text: ORG_A_TEXT });

    const hits = await search(tenantId, 'org-a', SHARED, 'severance schedule WWX-7742', 10, 'dense');
    // Org A must see only its own corpus. Assert on the CONTENT, not the count:
    // an empty result would also pass a "no org-B hit" count check for the wrong
    // reason, so require org A's own document to still be retrievable.
    expect(hits.some((h) => h.text.includes('WWX-7742')), 'org B chunk text leaked into org A').toBe(false);
    expect(hits.some((h) => h.documentId.length > 0)).toBe(true);
    const own = await search(tenantId, 'org-a', SHARED, 'incident code QQZ-1188', 10, 'dense');
    expect(own.some((h) => h.text.includes('QQZ-1188')), 'org A must still retrieve its OWN document').toBe(true);

    // …and symmetrically, org B's own retrieval survives org A's hydrate.
    const bHits = await search(tenantId, 'org-b', SHARED, 'severance schedule WWX-7742', 10, 'dense');
    expect(bHits.some((h) => h.text.includes('WWX-7742'))).toBe(true);
    expect(bHits.some((h) => h.text.includes('QQZ-1188')), 'org A chunk text leaked into org B').toBe(false);
  });
});

describe('KB-1 — the routes PICK the caller-settable fields (a cast is not validation)', () => {
  async function ownerOrg(): Promise<{ c: ReturnType<typeof client>; orgId: string }> {
    const tenantId = `org:kbxo-${Date.now()}-${n++}`;
    const c = client();
    const login = await c.post('/v1/host/openwop-app/test/login', { email: `kbxo-${Date.now()}-${n++}@acme.test`, tenantId });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    return { c, orgId: org.body.orgId };
  }

  it('a caller-supplied collectionId + managed flag are NOT honored', async () => {
    const { c, orgId } = await ownerOrg();
    const created = await c.post(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections`, {
      name: 'Innocent', collectionId: 'mgd-strategy-someoneelse', managed: 'strategy',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.collectionId, 'the caller must never choose the id').not.toBe('mgd-strategy-someoneelse');
    expect(created.body.managed, 'the caller must never mark a collection auto-managed').toBeUndefined();
  });

  it('a caller-supplied documentId is NOT honored (the clobber vector)', async () => {
    const { c, orgId } = await ownerOrg();
    const col = await c.post(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections`, { name: 'Docs' });
    const base = `/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(col.body.collectionId)}/documents`;
    const first = await c.post(base, { title: 'One', text: ORG_A_TEXT, documentId: 'pinned-id' });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.documentId).not.toBe('pinned-id');
  });
});

describe('KB-1 — a stable id may not SILENTLY replace an existing document', () => {
  it('a second ingest under the same documentId is refused (409), not swallowed', async () => {
    const tenantId = `kbxo-clobber-${Date.now()}-${n++}`;
    const col = await createCollection(tenantId, 'org-a', 'actor', { name: 'Docs' });
    await ingestDocument(tenantId, 'org-a', 'actor', col.collectionId, { title: 'One', text: ORG_A_TEXT }, { documentId: 'stable-1' });
    await expect(
      ingestDocument(tenantId, 'org-a', 'actor', col.collectionId, { title: 'Two', text: ORG_B_TEXT }, { documentId: 'stable-1' }),
      'the old shape replaced the row, double-counted documentCount, and orphaned the prior chunk tail',
    ).rejects.toMatchObject({ code: 'conflict', httpStatus: 409 });
  });
});

describe('KB-4 — a deleted document stops being searchable, tail included', () => {
  it('search after delete finds nothing (the pin the suite never had)', async () => {
    const tenantId = `kbxo-del-${Date.now()}-${n++}`;
    const col = await createCollection(tenantId, 'org-a', 'actor', { name: 'Docs' });
    const doc = await ingestDocument(tenantId, 'org-a', 'actor', col.collectionId, { title: 'Runbook', text: ORG_A_TEXT });

    const before = await search(tenantId, 'org-a', col.collectionId, 'incident code QQZ-1188', 10, 'dense');
    expect(before.some((h) => h.text.includes('QQZ-1188')), 'non-vacuity: it must be findable first').toBe(true);

    await deleteDocument(tenantId, 'org-a', col.collectionId, doc.documentId);
    const after = await search(tenantId, 'org-a', col.collectionId, 'incident code QQZ-1188', 10, 'dense');
    expect(after.some((h) => h.text.includes('QQZ-1188'))).toBe(false);
  });

  it('a v1-chunker TAIL is wiped too (the orphan no later hydrate could reach)', async () => {
    // Reconstruct the real shape: a document whose DURABLE `chunkCount` is larger
    // than what the current chunker produces (what a v1→v2 chunker change leaves),
    // with the extra vectors actually present in the namespace. The pre-fix wipe
    // used `chunkIds(doc)` — the CURRENT count — so ids [newCount..oldCount) stayed,
    // carrying the deleted document's text forever on a persisted backend.
    const tenantId = `kbxo-tail-${Date.now()}-${n++}`;
    const col = await createCollection(tenantId, 'org-a', 'actor', { name: 'Docs' });
    const doc = await ingestDocument(tenantId, 'org-a', 'actor', col.collectionId, { title: 'Runbook', text: ORG_A_TEXT });
    const liveCount = doc.chunkCount;

    // Inflate the durable chunkCount and plant the v1 tail vector.
    const storage = hostExtStorage();
    const key = `hostext:kb:document:${tenantId}:org-a:${doc.documentId}`;
    const rowRaw = await storage.kvGet(key);
    expect(rowRaw, 'the durable document row must exist for this simulation to mean anything').toBeTruthy();
    const row = JSON.parse(rowRaw!) as { chunkCount: number };
    row.chunkCount = liveCount + 1;
    await storage.kvSet(key, JSON.stringify(row));

    const ns = collectionNamespace({ collectionId: col.collectionId, orgId: 'org-a' } as never);
    const vector = buildHostSurfaceBundle({ tenantId }).db.vector;
    const tailId = `${doc.documentId}:${liveCount}`;
    await vector.upsert({ namespace: ns, items: [{ id: tailId, vector: new Array(256).fill(0.01), metadata: { documentId: doc.documentId, chunkIndex: liveCount, title: 'Runbook', text: ORG_A_TEXT, contentTrust: 'trusted', headingPath: [] } }] });

    await deleteDocument(tenantId, 'org-a', col.collectionId, doc.documentId);

    // Probe the STORE, not the search: after a delete the collection is empty, so a
    // search would return [] whether or not the tail survived — a green that proves
    // nothing. Ask the namespace directly whether the row is gone.
    const remaining = await vector.query({ namespace: ns, vector: new Array(256).fill(0.01), topK: 50 });
    const ids = (remaining.matches as Array<{ id: string }>).map((m) => m.id);
    expect(ids, 'the v1 tail must be reclaimed by the staleWipeIds union').not.toContain(tailId);
  });
});
