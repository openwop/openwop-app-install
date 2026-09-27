/**
 * `KBC-5` (Blocker) + ADR 0643 D6 — the Vendor Directory → KB mirror's lifecycle.
 *
 * `productionKnowledgeService.ts` had ZERO tests (`grep -rln "indexVendor|mgd-production"
 * test/` returned nothing), which is how three independent ways for a DELETED vendor's
 * KB document to survive forever sat in one 100-line file:
 *
 *  (i)   `removeVendor` early-returned on `gateOpen(tenantId)`, so a *retention*
 *        guarantee was conditional on a *feature* switch. The reachable form is not
 *        "the toggle is off" (the DELETE route is itself toggle-gated, so it would
 *        404) — it is the SUBJECT MISMATCH between the two resolutions: the route
 *        resolves with `toggleSubjectOf(req)` = `{tenantId, userId}`, while
 *        `gateOpen` resolves with `{tenantId}` alone. Under a CLOSED BETA
 *        (`status:'beta'` + a `betaCohort` naming the user) the route says enabled
 *        and the indexer says disabled, at the same instant, for the same request.
 *        The vendor row is deleted and its capabilities/region/past-project names and
 *        free-text `notes` stay retrievable by anything bound to `mgd-production-<org>`.
 *  (ii)  `backfillProductionKb` had NO caller, so nothing could ever reconcile the
 *        residue. It is now driven by `POST …/reindex-kb`, matching the `strategy` /
 *        `priority-matrix` siblings, and sweeps BOTH directions.
 *  (iii) `void removeVendor(...)` immediately before `res.status(204).end()`. This host
 *        suspends detached continuations under Cloud Run `cpu-throttling=true`
 *        (`CLAUDE.md:503`, ADR 0556 `:577`, ADR 0585 `:88`), so the 204 claimed a
 *        removal that might never run.
 *
 * The (iii) witness has to DISTINGUISH `await` from `void`, and "check the KB right
 * after the response" cannot: in-process the detached promise settles during the
 * fetch's own I/O wait, so such a test passes either way — vacuous. So the KB write is
 * held open on a deferred and the assertion is on the RESPONSE: an awaited handler
 * cannot have answered yet; a `void`ed one already has.
 *
 * @see docs/adr/0643-kb-reindex-orchestration-write-surface-lifecycle-events.md (D6)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';

/** A latch the mocked KB writes park on. `null` ⇒ pass straight through. */
const latch = vi.hoisted(() => ({ p: null as Promise<void> | null, fail: null as string | null, loseListing: false }));

vi.mock('../src/features/kb/kbService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/features/kb/kbService.js')>();
  return {
    ...actual,
    upsertDocument: async (...args: Parameters<typeof actual.upsertDocument>) => {
      if (latch.p) await latch.p;
      if (latch.fail) throw new Error(latch.fail);
      return actual.upsertDocument(...args);
    },
    deleteDocument: async (...args: Parameters<typeof actual.deleteDocument>) => {
      if (latch.p) await latch.p;
      if (latch.fail) throw new Error(latch.fail);
      return actual.deleteDocument(...args);
    },
  };
});

vi.mock('../src/features/production/productionService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/features/production/productionService.js')>();
  return {
    ...actual,
    // `listForTenantIndexed`'s documented worst case: a MISSING MARKER, so a live row
    // is "simply not enumerated this pass". `getVendor` is a point read on the primary
    // store and is unaffected — which is exactly the asymmetry the sweep must respect.
    listVendors: async (...args: Parameters<typeof actual.listVendors>) =>
      (latch.loseListing ? [] : actual.listVendors(...args)),
  };
});

const { createApp } = await import('../src/index.js');
const { saveConfig } = await import('../src/host/featureToggles/service.js');
const { getToggleDefault } = await import('../src/host/featureToggles/registry.js');
const { getDocument, listDocuments, getCollection } = await import('../src/features/kb/kbService.js');
const { deleteVendor, getVendor } = await import('../src/features/production/productionService.js');
const { createMember } = await import('../src/host/accessControlService.js');

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
  const u = getToggleDefault('users');
  if (u) await saveConfig({ ...u, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => { latch.p = null; latch.fail = null; latch.loseListing = false; });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown, method?: string) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b, m) => call(m ?? 'POST', p, b), del: (p) => call('DELETE', p) };
}

const P = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/production/orgs/${encodeURIComponent(orgId)}${suffix}`;
const COLLECTION = (orgId: string): string => `mgd-production-${orgId}`;
const DOC_ID = (vendorId: string): string => `vendor:${vendorId}`;
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;

const setProduction = async (patch: Record<string, unknown>): Promise<void> => {
  const def = getToggleDefault('production');
  if (def) await saveConfig({ ...def, ...patch }, 'test');
};

async function workspace(): Promise<{ owner: Client; orgId: string; tenantId: string; userId: string }> {
  const tenantId = `org:kbc5-${Date.now()}-${n++}`;
  const owner = client();
  const userId = (await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('own'), tenantId })).body.user.userId;
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId, userId };
}

/** A logged-in user with the `profiles` toggle on — for the two profiles D6 sites. */
async function profilesUser(): Promise<{ c: Client; tenantId: string; userId: string }> {
  const def = getToggleDefault('profiles');
  if (def) await saveConfig({ ...def, status: 'on' }, 'test');
  const tenantId = `org:kbc5p-${Date.now()}-${n++}`;
  const c = client();
  const userId = (await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('prof'), tenantId })).body.user.userId;
  return { c, tenantId, userId };
}

/** Create a vendor through the route with the toggle fully ON ⇒ it IS mirrored. */
async function indexedVendor(w: Awaited<ReturnType<typeof workspace>>, name = 'Bright Studio'): Promise<string> {
  await setProduction({ status: 'on' });
  const created = await w.owner.post(P(w.orgId, '/vendors'), {
    type: 'agency', name, region: 'EU', notes: 'BOARD-ONLY: pays kickbacks',
    capabilities: [{ name: 'Brand design', category: 'design' }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const vendorId: string = created.body.vendorId;
  expect(await getDocument(w.tenantId, w.orgId, COLLECTION(w.orgId), DOC_ID(vendorId)), 'the vendor must actually be mirrored first').toBeTruthy();
  return vendorId;
}

describe('KBC-5(i) — vendor removal is NOT gated on the production toggle', () => {
  it('a closed beta opens the DELETE route while gateOpen(tenantId) says off — the doc must still go (born-red)', async () => {
    const w = await workspace();
    const vendorId = await indexedVendor(w);

    // The divergence, in one line: the route resolves `{tenantId, userId}` and the
    // user IS in the cohort; `gateOpen` resolves `{tenantId}` and the tenant is not.
    await setProduction({ status: 'beta', betaCohort: [w.userId] });
    expect((await w.owner.get(P(w.orgId, '/vendors'))).status, 'precondition: the route is OPEN for this user').toBe(200);

    expect((await w.owner.del(P(w.orgId, `/vendors/${vendorId}`))).status).toBe(204);

    // Before the fix this document survived — capability list, region and the
    // free-text notes — retrievable by any agent bound to the managed collection.
    const stranded = await getDocument(w.tenantId, w.orgId, COLLECTION(w.orgId), DOC_ID(vendorId));
    expect(stranded, 'a deleted vendor must not keep a KB document').toBeNull();
    await setProduction({ status: 'on', betaCohort: [] });
  });

  it('deleting a never-indexed vendor is a clean no-op (idempotent, not an error)', async () => {
    const w = await workspace();
    await setProduction({ status: 'on' });
    // No collection exists yet for a brand-new org until the first index.
    const created = await w.owner.post(P(w.orgId, '/vendors'), { name: 'Ghost' });
    const vendorId: string = created.body.vendorId;
    expect((await w.owner.del(P(w.orgId, `/vendors/${vendorId}`))).status).toBe(204);
    expect((await w.owner.del(P(w.orgId, `/vendors/${vendorId}`))).status, 'second delete 404s on the vendor row, not on the KB').toBe(404);
  });
});

describe('KBC-5(ii) — backfillProductionKb is reachable, and reconciles both directions', () => {
  it('indexes vendors that predate the toggle flip', async () => {
    const w = await workspace();
    // Created while the indexer's gate is CLOSED (closed beta again) ⇒ never mirrored.
    await setProduction({ status: 'beta', betaCohort: [w.userId] });
    const created = await w.owner.post(P(w.orgId, '/vendors'), { name: 'Predates', type: 'agency' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const vendorId: string = created.body.vendorId;
    expect(await getCollection(w.tenantId, w.orgId, COLLECTION(w.orgId))).toBeNull();

    await setProduction({ status: 'on', betaCohort: [] });
    const swept = await w.owner.post(P(w.orgId, '/reindex-kb'));
    expect(swept.status, JSON.stringify(swept.body)).toBe(200);
    expect(swept.body).toMatchObject({ vendors: 1, removedOrphans: 0, complete: true });
    expect(await getDocument(w.tenantId, w.orgId, COLLECTION(w.orgId), DOC_ID(vendorId))).toBeTruthy();
  });

  it('removes an ORPHAN — a KB doc whose vendor is gone (the residue of (i) and (iii))', async () => {
    const w = await workspace();
    const vendorId = await indexedVendor(w, 'Orphan Maker');

    // Drop the vendor ROW only, bypassing the route's KB cleanup — exactly the state
    // a gated removal or a dropped continuation used to leave behind.
    expect(await deleteVendor(w.tenantId, w.orgId, vendorId)).toBe(true);
    expect(await getDocument(w.tenantId, w.orgId, COLLECTION(w.orgId), DOC_ID(vendorId)), 'the orphan exists before the sweep').toBeTruthy();

    const swept = await w.owner.post(P(w.orgId, '/reindex-kb'));
    expect(swept.status, JSON.stringify(swept.body)).toBe(200);
    expect(swept.body).toMatchObject({ vendors: 0, removedOrphans: 1, complete: true });
    expect(await getDocument(w.tenantId, w.orgId, COLLECTION(w.orgId), DOC_ID(vendorId))).toBeNull();
    expect(await listDocuments(w.tenantId, w.orgId, COLLECTION(w.orgId))).toHaveLength(0);
  });

  it('carries the sibling reindex-kb gate: toggle + workspace:write in the path org', async () => {
    const w = await workspace();
    await setProduction({ status: 'on' });

    const viewerC = client();
    const viewerId = (await viewerC.post('/v1/host/openwop-app/test/login', { email: uniqEmail('view'), tenantId: w.tenantId })).body.user.userId;
    await createMember({ tenantId: w.tenantId, orgId: w.orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
    expect((await viewerC.post(P(w.orgId, '/reindex-kb'))).status, 'a viewer cannot drive the sweep').toBe(403);

    await setProduction({ status: 'off' });
    expect((await w.owner.post(P(w.orgId, '/reindex-kb'))).status, 'toggle off ⇒ the surface does not exist').toBe(404);
    await setProduction({ status: 'on' });
  });
});

describe('ADR 0643 D6 — the derived-index write is AWAITED, not detached', () => {
  /** Hold the KB write open, then assert the response has NOT been produced yet. */
  async function assertHandlerBlocksOnKb(fire: () => Promise<Res>): Promise<Res> {
    let release!: () => void;
    latch.p = new Promise<void>((r) => { release = r; });
    let answered = false;
    const inflight = fire().then((r) => { answered = true; return r; });
    // Generous: the handler only has to reach the held KB call, which is a handful
    // of in-memory awaits away. A `void`ed write answers in well under this.
    await new Promise((r) => setTimeout(r, 250));
    expect(answered, 'the response was produced while the KB write was still pending — the write is DETACHED').toBe(false);
    release();
    latch.p = null;
    return inflight;
  }

  it('DELETE /vendors/:id blocks on the KB removal (KBC-5(iii) — the lane a dropped continuation strands)', async () => {
    const w = await workspace();
    const vendorId = await indexedVendor(w, 'Awaited Delete');
    const res = await assertHandlerBlocksOnKb(() => w.owner.del(P(w.orgId, `/vendors/${vendorId}`)));
    expect(res.status).toBe(204);
    expect(await getDocument(w.tenantId, w.orgId, COLLECTION(w.orgId), DOC_ID(vendorId))).toBeNull();
  });

  it('POST /vendors blocks on the KB index', async () => {
    const w = await workspace();
    await setProduction({ status: 'on' });
    // Pre-create the managed collection so the held call is the vendor upsert itself.
    await indexedVendor(w, 'Seed');
    const res = await assertHandlerBlocksOnKb(() => w.owner.post(P(w.orgId, '/vendors'), { name: 'Awaited Create', type: 'agency' }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await getDocument(w.tenantId, w.orgId, COLLECTION(w.orgId), DOC_ID(res.body.vendorId))).toBeTruthy();
  });

  it("the ADR's measured claim: awaiting cannot fail the mutation — a KB throw is swallowed inside", async () => {
    // This is the whole safety argument for D6. If it were false, awaiting would
    // turn a best-effort mirror into a 500 on vendor CRUD.
    const w = await workspace();
    await setProduction({ status: 'on' });
    latch.fail = 'kb exploded (simulating the assertNoLiveReindex 409 and every other KB failure)';
    const created = await w.owner.post(P(w.orgId, '/vendors'), { name: 'Survives KB failure', type: 'agency' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const vendorId: string = created.body.vendorId;
    expect((await w.owner.del(P(w.orgId, `/vendors/${vendorId}`))).status, 'the DELETE lane too').toBe(204);
    latch.fail = null;
  });
});

describe('the sweep decides DELETE from a non-lossy read, and never reports a partial pass as clean', () => {
  it('a LIVE vendor missing from the lossy listing is NOT destroyed (born-red against the Set-based oracle)', async () => {
    // The review's objection, made into a witness. `listVendors` rides
    // `vendors.listForTenantIndexed`, documented as "the worst case is a missing
    // marker … retention is delayed, not lost" (`hostExtPersistence.ts:261-266`) —
    // a guarantee written for a RETENTION consumer. Building `liveDocIds` from it
    // inverted the polarity: a miss made a LIVE vendor look orphaned and DESTROYED
    // its doc, and re-running could not heal it because the same missing marker
    // also excludes that vendor from the index half. The fix is a point `get`.
    const w = await workspace();
    const vendorId = await indexedVendor(w, 'Invisible But Alive');

    latch.loseListing = true; // the marker is gone; the ROW is not
    const swept = await w.owner.post(P(w.orgId, '/reindex-kb'));
    expect(swept.status, JSON.stringify(swept.body)).toBe(200);
    expect(swept.body.removedOrphans, 'a live vendor must never be swept').toBe(0);
    latch.loseListing = false;

    expect(
      await getDocument(w.tenantId, w.orgId, COLLECTION(w.orgId), DOC_ID(vendorId)),
      'the live vendor still has its KB document',
    ).toBeTruthy();
    // …and the vendor really was invisible to the listing, so the test is not vacuous.
    expect(await getVendor(w.tenantId, w.orgId, vendorId), 'the point read still sees it').toBeTruthy();
  });

  it('a sweep cut short reports complete:false rather than a clean count (born-red)', async () => {
    // `assertNoLiveReindex` 409s every document mutation while a reindex is running
    // for the collection — the very condition ADR 0643 D1 exists for. Before this,
    // the whole body sat in one try/catch, so the throw was swallowed and the route
    // answered 200 with partial counts that the docblock called a drift signal.
    const w = await workspace();
    const vendorId = await indexedVendor(w, 'Sweepable');
    expect(await deleteVendor(w.tenantId, w.orgId, vendorId)).toBe(true); // make a real orphan

    latch.fail = 'a reindex is in progress for this collection';
    const swept = await w.owner.post(P(w.orgId, '/reindex-kb'));
    expect(swept.status, JSON.stringify(swept.body)).toBe(200);
    expect(swept.body.complete, 'a partial pass must NOT claim completeness').toBe(false);
    expect(swept.body.failures).toBeGreaterThan(0);
    expect(swept.body.removedOrphans, 'and it must not claim it removed what it could not').toBe(0);
    latch.fail = null;

    // The orphan is still there — "did not finish looking", not "nothing to fix".
    expect(await getDocument(w.tenantId, w.orgId, COLLECTION(w.orgId), DOC_ID(vendorId))).toBeTruthy();
    // A clean re-run heals it AND says so.
    const retry = await w.owner.post(P(w.orgId, '/reindex-kb'));
    expect(retry.body).toMatchObject({ removedOrphans: 1, failures: 0, complete: true });
  });
});

/**
 * D6 COVERAGE — the review's last point: the latch witness originally pinned only 2 of
 * the 6 converted sites (vendor POST + vendor DELETE). "The other four are also awaited"
 * was an unwitnessed claim, and an unwitnessed claim is exactly what D6 is about. All
 * six are now pinned by the same discriminating mechanism, so a future `void` at ANY of
 * them turns a test red rather than passing on the strength of a comment.
 */
describe('ADR 0643 D6 — the remaining four converted sites are awaited too (6/6)', () => {
  async function blocksOnKb(fire: () => Promise<Res>): Promise<Res> {
    let release!: () => void;
    latch.p = new Promise<void>((r) => { release = r; });
    let answered = false;
    const inflight = fire().then((r) => { answered = true; return r; });
    await new Promise((r) => setTimeout(r, 250));
    expect(answered, 'the response was produced while the KB write was still pending — DETACHED').toBe(false);
    release();
    latch.p = null;
    return inflight;
  }

  it('production PATCH /vendors/:id blocks on the KB re-sync', async () => {
    const w = await workspace();
    const vendorId = await indexedVendor(w, 'Patchable');
    const res = await blocksOnKb(() => w.owner.post(P(w.orgId, `/vendors/${vendorId}`), undefined, 'PATCH'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('production PUT /vendors/:id/portfolio blocks on the KB re-sync', async () => {
    const w = await workspace();
    const vendorId = await indexedVendor(w, 'Portfolio Holder');
    const res = await blocksOnKb(() => w.owner.post(P(w.orgId, `/vendors/${vendorId}/portfolio`), { tokens: ['media:abc'] }, 'PUT'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('profiles PATCH /me blocks on the team-portfolio KB index', async () => {
    const w = await profilesUser();
    const res = await blocksOnKb(() => w.c.post('/v1/host/openwop-app/profiles/me', { jobTitle: 'Gaffer' }, 'PATCH'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('profiles PUT /me/skills blocks on the team-portfolio KB index', async () => {
    const w = await profilesUser();
    // A profile with signal, so `indexProfile` upserts rather than taking the remove branch.
    expect((await w.c.post('/v1/host/openwop-app/profiles/me', { jobTitle: 'Gaffer' }, 'PATCH')).status).toBe(200);
    const res = await blocksOnKb(() => w.c.post('/v1/host/openwop-app/profiles/me/skills', { skills: [{ name: 'Lighting', proficiency: 4 }] }, 'PUT'));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
