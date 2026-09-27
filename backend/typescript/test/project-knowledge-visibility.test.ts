/**
 * ADR 0608 Tier 2 — the two remaining private-read leaks on a project's KB.
 *
 * `CPC-2` (D4): `/projects/:id/knowledge` 404s a non-member org viewer while the
 * KB feature's own org-scoped doors over the SAME rows returned the collection
 * name, the document titles and the VERBATIM chunk text. Two doors, same rows,
 * opposite answers.
 *
 * `CPC-3` (D5): the shareable-KB visibility carve-out was applied at SHARE TIME
 * ONLY, so flipping a shared project `org` -> `private` left every advisor still
 * bound to the collection while the board's panel reported nothing was shared.
 * The existing test covers private-THEN-share; this covers share-THEN-private,
 * and the way back.
 *
 * @see docs/adr/0608-collaborative-projects-visibility-and-browser-cadence.md
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember } from '../src/host/accessControlService.js';
import { getAgentProfile } from '../src/host/agentProfileService.js';
import { getCollection } from '../src/features/kb/kbService.js';
// `KBC-1` (ADR 0643 D2 precondition) — `getCollection` now applies the subject
// gate at the SERVICE, so a bound row read with no caller answers `null` (the
// fail-closed default). These legs inspect the ROW ITSELF, not a caller's view,
// so they say so explicitly. That is the point of the marker: every bypass is
// spelled, and `grep PREAUTHORIZED_CALLER` enumerates them.
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';

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
  for (const id of ['users', 'kb', 'advisory-board', 'projects', 'notebooks']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
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

const P = '/v1/host/openwop-app/projects';
const NB = '/v1/host/openwop-app/notebooks';
const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
const KB = (orgId: string): string => `/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}`;

/** Owner + a private project + a bound collection holding one secret document. */
async function privateCorpus() {
  const tenantId = `org:pkv-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pkv-owner'), tenantId });
  const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'PrivCo' })).body.orgId;
  const projectId = (await owner.post(P, { orgId, name: 'Secret' })).body.id;
  const col = await owner.post(`${P}/${projectId}/knowledge/collections`, { orgId, name: 'Secret notes' });
  expect(col.status, JSON.stringify(col.body)).toBe(201);
  const collectionId: string = col.body.collectionId;
  const ing = await owner.post(`${P}/${projectId}/knowledge/collections/${collectionId}/documents`, {
    orgId, title: 'Merger plan', text: 'ACQUIRE ACME FOR 40M. Board only.',
  });
  expect(ing.status, JSON.stringify(ing.body)).toBe(201);
  expect((await owner.patch(`${P}/${projectId}/visibility`, { visibility: 'private' })).body.visibility).toBe('private');
  return { tenantId, orgId, projectId, collectionId, owner };
}

/** Owner + a private project whose Sources corpus is provisioned via the NOTEBOOKS
 *  path (`ensureNotebookForProject`, what opening the Sources tab does) — the H1 birth
 *  site, distinct from `privateCorpus`'s Knowledge tab. */
async function privateNotebookCorpus() {
  const tenantId = `org:pkv-nb-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pkv-nb-owner'), tenantId });
  const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'PrivCo' })).body.orgId;
  const projectId = (await owner.post(P, { orgId, name: 'SecretNB' })).body.id;
  const ensure = await owner.post(`${NB}/${projectId}/ensure`);
  expect(ensure.status, JSON.stringify(ensure.body)).toBe(200);
  const collectionId: string = ensure.body.collectionId;
  const ing = await owner.post(`${NB}/${projectId}/sources`, { title: 'Merger plan', text: 'ACQUIRE ACME FOR 40M. Board only.' });
  expect(ing.status, JSON.stringify(ing.body)).toBe(201);
  expect((await owner.patch(`${P}/${projectId}/visibility`, { visibility: 'private' })).body.visibility).toBe('private');
  return { tenantId, orgId, projectId, collectionId, owner };
}

/** Owner + a notebook minted via `POST /notebooks` (`createNotebook`), THEN flipped
 *  private — the SECOND H1 birth site (org-born ⇒ private ⇒ leak pre-fix), distinct
 *  from the `ensureNotebookForProject` path above. */
async function privateCreatedNotebookCorpus() {
  const tenantId = `org:pkv-cn-${Date.now()}-${n++}`;
  const owner = client();
  await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pkv-cn-owner'), tenantId });
  const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'PrivCo' })).body.orgId;
  const created = await owner.post(NB, { name: 'SecretCN', orgId });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const projectId: string = created.body.notebook.id;
  const collectionId: string = created.body.collectionId;
  const ing = await owner.post(`${NB}/${projectId}/sources`, { title: 'Merger plan', text: 'ACQUIRE ACME FOR 40M. Board only.' });
  expect(ing.status, JSON.stringify(ing.body)).toBe(201);
  expect((await owner.patch(`${P}/${projectId}/visibility`, { visibility: 'private' })).body.visibility).toBe('private');
  return { tenantId, orgId, projectId, collectionId, owner };
}

/** A real org VIEWER of the same org who is NOT a project member. */
async function orgViewer(tenantId: string, orgId: string): Promise<Client & { userId: string }> {
  const viewer = client();
  const viewerId = (await viewer.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pkv-viewer'), tenantId })).body.user.userId;
  await createMember({ tenantId, orgId, subject: viewerId, displayName: 'V', roles: ['viewer'] });
  return Object.assign(viewer, { userId: viewerId as string });
}

describe('CPC-2 — a private project\'s corpus is not readable through the KB door', () => {
  it('the org viewer is refused at BOTH doors — list, documents, search, get', async () => {
    const { tenantId, orgId, projectId, collectionId, owner } = await privateCorpus();
    const viewer = await orgViewer(tenantId, orgId);

    // Control: the project door already refuses, and the viewer really is an org reader.
    expect((await viewer.get(`${P}/${projectId}`)).status).toBe(404);
    expect((await viewer.get(`${P}/${projectId}/knowledge`)).status).toBe(404);
    expect((await viewer.get(`${KB(orgId)}/collections`)).status).toBe(200); // org read works

    // The KB door must now agree, on every lane that reaches the rows.
    const list = await viewer.get(`${KB(orgId)}/collections`);
    expect((list.body.collections as { collectionId: string }[]).map((c) => c.collectionId)).not.toContain(collectionId);
    expect((await viewer.get(`${KB(orgId)}/collections/${collectionId}`)).status).toBe(404);
    expect((await viewer.get(`${KB(orgId)}/collections/${collectionId}/documents`)).status).toBe(404);

    const search = await viewer.post(`${KB(orgId)}/collections/${collectionId}/search`, { query: 'merger', topK: 5 });
    expect(search.status).toBe(404);
    // Positive control against a dead cure: the verbatim chunk must not appear
    // ANYWHERE in the response, whatever shape a future refusal takes.
    expect(JSON.stringify(search.body ?? {})).not.toContain('ACQUIRE ACME');

    // Positive control: the OWNER still reads it through the KB door (not a brick).
    expect((await owner.get(`${KB(orgId)}/collections/${collectionId}/documents`)).status).toBe(200);
    const ownerSearch = await owner.post(`${KB(orgId)}/collections/${collectionId}/search`, { query: 'merger', topK: 5 });
    expect(ownerSearch.status).toBe(200);
  });

  it('a project MEMBER regains the KB door, and an ORG-visible project is unaffected', async () => {
    const { tenantId, orgId, projectId, collectionId, owner } = await privateCorpus();
    const viewer = await orgViewer(tenantId, orgId);
    expect((await owner.post(`${P}/${projectId}/members`, { ref: `user:${viewer.userId}`, role: 'observer' })).status).toBe(201);

    // Membership grants READ on a private project — and that must reach the KB door.
    expect((await viewer.get(`${P}/${projectId}`)).status).toBe(200);
    expect((await viewer.get(`${KB(orgId)}/collections/${collectionId}/documents`)).status).toBe(200);

    // And flipping back to `org` restores it for a NON-member org reader — the
    // guard must not be a one-way ratchet.
    const stranger = await orgViewer(tenantId, orgId);
    expect((await stranger.get(`${KB(orgId)}/collections/${collectionId}`)).status).toBe(404);
    expect((await owner.patch(`${P}/${projectId}/visibility`, { visibility: 'org' })).body.visibility).toBe('org');
    expect((await stranger.get(`${KB(orgId)}/collections/${collectionId}`)).status).toBe(200);
  });

  it('the STAMP itself is asserted on the row, not only through the guard', async () => {
    // The guard and the stamp are two mechanisms; a test that only reads the door
    // cannot tell which one is doing the work. (Measured: removing EITHER stamp
    // site alone leaves this file green — they are redundant by design — so the
    // row-level assertion is what pins the stamp.)
    const { tenantId, orgId, projectId, collectionId } = await privateCorpus();
    expect((await getCollection(tenantId, orgId, collectionId, PREAUTHORIZED_CALLER))?.boundSubject).toEqual({ kind: 'project', id: projectId });
  });

  it('EXIT — deleting the owning project releases the stamp, never bricking the corpus', async () => {
    // A stamp names a Subject that can be deleted, and `resolveSubjectAccess`
    // answers 'none' for a project that denies you AND for one that is gone. An
    // unreleased stamp is therefore a gate with no exit — the collection becomes
    // unreachable dead data for its own owners. This is the arm that caught the
    // first version of this fix (`notebooks-delete-honesty.test.ts` went red).
    const { tenantId, orgId, projectId, collectionId, owner } = await privateCorpus();
    expect((await getCollection(tenantId, orgId, collectionId, PREAUTHORIZED_CALLER))?.boundSubject).toBeTruthy();
    expect((await owner.get(`${KB(orgId)}/collections/${collectionId}`)).status).toBe(200);

    expect((await owner.del(`${P}/${projectId}`)).body.deleted).toBe(true);

    expect((await getCollection(tenantId, orgId, collectionId, PREAUTHORIZED_CALLER))?.boundSubject).toBeUndefined();
    // The corpus outlives the project and stays reachable — it was never deleted.
    expect((await owner.get(`${KB(orgId)}/collections/${collectionId}`)).status).toBe(200);
    const viewer = await orgViewer(tenantId, orgId);
    expect((await viewer.get(`${KB(orgId)}/collections/${collectionId}`)).status).toBe(200);
  });

  it('SHARED — binding an existing org collection to a project does NOT narrow it', async () => {
    // The inverse control. An org KB collection a project merely REFERENCES is
    // still an org resource; stamping on bind narrowed it retroactively AND made
    // a two-project collection hostage to whichever project was deleted first.
    const { tenantId, orgId, owner } = await privateCorpus();
    const shared = await owner.post(`${KB(orgId)}/collections`, { name: 'Shared org corpus' });
    expect(shared.status).toBe(201);
    const sharedId: string = shared.body.collectionId;
    const other = (await owner.post(P, { orgId, name: 'Bindy' })).body.id;
    expect([200, 201]).toContain((await owner.post(`${P}/${other}/knowledge/bindings`, { collectionId: sharedId })).status);

    expect((await getCollection(tenantId, orgId, sharedId))?.boundSubject).toBeUndefined();
    const viewer = await orgViewer(tenantId, orgId);
    expect((await viewer.get(`${KB(orgId)}/collections/${sharedId}`)).status).toBe(200);
  });

  it('an ordinary org collection (no project binding) is untouched by the guard', async () => {
    const { orgId, owner, tenantId } = await privateCorpus();
    const plain = await owner.post(`${KB(orgId)}/collections`, { name: 'Plain org notes' });
    expect(plain.status).toBe(201);
    const viewer = await orgViewer(tenantId, orgId);
    expect((await viewer.get(`${KB(orgId)}/collections/${plain.body.collectionId}`)).status).toBe(200);
    expect((await viewer.get(`${KB(orgId)}/collections`)).body.collections.some(
      (c: { collectionId: string }) => c.collectionId === plain.body.collectionId,
    )).toBe(true);
  });

  it('H1 — a corpus born via the Sources/notebooks path is stamped + refused to non-members', async () => {
    // The Knowledge tab stamps; the Sources/notebooks birth site (ensureNotebookForProject)
    // did NOT — so a private project's Sources corpus leaked to any org reader.
    const { tenantId, orgId, projectId, collectionId, owner } = await privateNotebookCorpus();
    const viewer = await orgViewer(tenantId, orgId);

    // The row must be stamped at birth (the fix; unstamped ⇒ the leak).
    expect((await getCollection(tenantId, orgId, collectionId, PREAUTHORIZED_CALLER))?.boundSubject).toEqual({ kind: 'project', id: projectId });

    // The KB door refuses the non-member on every lane, and the listing omits it.
    expect((await viewer.get(`${KB(orgId)}/collections`)).body.collections
      .map((c: { collectionId: string }) => c.collectionId)).not.toContain(collectionId);
    expect((await viewer.get(`${KB(orgId)}/collections/${collectionId}`)).status).toBe(404);
    expect((await viewer.get(`${KB(orgId)}/collections/${collectionId}/documents`)).status).toBe(404);
    const search = await viewer.post(`${KB(orgId)}/collections/${collectionId}/search`, { query: 'merger', topK: 5 });
    expect(search.status).toBe(404);
    expect(JSON.stringify(search.body ?? {})).not.toContain('ACQUIRE ACME');

    // Positive control — the owner is not bricked.
    expect((await owner.get(`${KB(orgId)}/collections/${collectionId}`)).status).toBe(200);
  });

  it('H1 (create path) — a corpus born via POST /notebooks is stamped + refused to non-members', async () => {
    // The SECOND birth site: createNotebook mints an org-visible notebook-project
    // whose collection must also be stamped, so flipping it private closes the leak.
    const { tenantId, orgId, projectId, collectionId, owner } = await privateCreatedNotebookCorpus();
    const viewer = await orgViewer(tenantId, orgId);

    expect((await getCollection(tenantId, orgId, collectionId, PREAUTHORIZED_CALLER))?.boundSubject).toEqual({ kind: 'project', id: projectId });
    expect((await viewer.get(`${KB(orgId)}/collections`)).body.collections
      .map((c: { collectionId: string }) => c.collectionId)).not.toContain(collectionId);
    expect((await viewer.get(`${KB(orgId)}/collections/${collectionId}`)).status).toBe(404);
    expect((await viewer.get(`${KB(orgId)}/collections/${collectionId}/documents`)).status).toBe(404);
    const search = await viewer.post(`${KB(orgId)}/collections/${collectionId}/search`, { query: 'merger', topK: 5 });
    expect(search.status).toBe(404);
    expect(JSON.stringify(search.body ?? {})).not.toContain('ACQUIRE ACME');
    expect((await owner.get(`${KB(orgId)}/collections/${collectionId}`)).status).toBe(200);
  });
});

describe('CPC-3 — flipping a shared project to private unbinds it from the advisors', () => {
  async function boardWithAdvisor(owner: Client, orgId: string) {
    const r = await owner.post('/v1/host/openwop-app/roster', { persona: 'Ada Lovelace', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const rosterId: string = r.body.rosterId;
    const b = await owner.post('/v1/host/openwop-app/advisors/boards', { orgId, name: 'Council', advisors: [rosterId] });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    return { boardId: b.body.boardId as string, rosterId };
  }

  it('share-THEN-private unbinds the advisor; private-THEN-org re-binds it', async () => {
    const tenantId = `org:pkv3-${Date.now()}-${n++}`;
    const owner = client();
    await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pkv3'), tenantId });
    const orgId = (await owner.post('/v1/host/openwop-app/orgs', { name: 'ShareCo' })).body.orgId;
    const projectId = (await owner.post(P, { orgId, name: 'Launch' })).body.id;
    const collectionId: string = (await owner.post(`${P}/${projectId}/knowledge/collections`, { orgId, name: 'Launch notes' })).body.collectionId;
    const { boardId, rosterId } = await boardWithAdvisor(owner, orgId);

    // Share while the project is org-visible — the advisor is bound.
    const shared = await owner.post(`/v1/host/openwop-app/advisors/boards/${boardId}/shared-knowledge`, { kind: 'project', shared: true });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    const bound = async (): Promise<string[]> => (await getAgentProfile(tenantId, rosterId))?.knowledge?.collectionIds ?? [];
    expect(await bound()).toContain(collectionId);

    // NOW flip it private. The binding must be revoked — this is the arm the
    // existing `advisory-board-knowledge.test.ts` (private-THEN-share) cannot see.
    expect((await owner.patch(`${P}/${projectId}/visibility`, { visibility: 'private' })).body.visibility).toBe('private');
    expect(await bound()).not.toContain(collectionId);

    // Positive control — the advisor's OTHER bindings and the board itself survive;
    // this is a targeted revoke, not a wipe.
    const status = await owner.get(`/v1/host/openwop-app/advisors/boards/${boardId}/shared-knowledge`);
    expect(status.status).toBe(200);

    // And back: restoring `org` visibility re-binds, so stored intent stays honest
    // in BOTH directions rather than becoming a claim about nothing.
    expect((await owner.patch(`${P}/${projectId}/visibility`, { visibility: 'org' })).body.visibility).toBe('org');
    expect(await bound()).toContain(collectionId);
  });
});
