/**
 * Strategy → KB auto-indexer (ADR 0100 Phase 1) — ROUTE harness. Boots the real
 * app and drives Strategy CRUD + KB reads over HTTP to verify:
 *   - a SHARED (org/workspace) strategy is indexed into the managed 'Strategy KB'
 *     (one doc, keyed by the strategy id) on create + re-indexed on update
 *   - a USER-scoped (private) strategy is NEVER indexed (the RBAC carve-out)
 *   - a scope change org→user and an archive REMOVE the doc
 *   - the managed collection rejects hand-edits via the KB routes (the guard)
 * Indexing is gated on the `strategy` toggle only — the KB is always-on (there is no
 * `kb` toggle any more; strategyKnowledgeService.ts `gatesOpen`).
 *
 * Sabotage witnesses (wave 19, `w19g3-kno-*`): indexing user-scoped or archived
 * strategies, creating the collection unmanaged, skipping the create- or update-path
 * index, and disabling the KB route's managed guard each red the case that names them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('strategy', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);

async function signup(c: Client, tenantId: string): Promise<{ userId: string }> {
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('sk'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}

const S = '/host/openwop-app/strategy';
const freshTenant = (): string => `org:sk-${Date.now()}-${n++}`;
async function ownerWithOrg(): Promise<{ owner: Client; orgId: string }> {
  const owner = client();
  await signup(owner, freshTenant());
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}

/** The managed 'Strategy KB' doc ids for an org (the collection must exist). */
async function kbDocIds(owner: Client, orgId: string): Promise<string[]> {
  const colId = `mgd-strategy-${orgId}`;
  const docs = await owner.get(`/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(colId)}/documents`);
  // No silent `[]`: a 404/403 here would make every `not.toContain` below pass vacuously.
  expect(docs.status, JSON.stringify(docs.body)).toBe(200);
  return (docs.body.documents as Array<{ documentId: string }>).map((d) => d.documentId);
}

describe('ADR 0100 P1 — strategy indexes into the managed Strategy KB', () => {
  it('indexes a shared (org) strategy on create, and the collection is marked managed', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const created = await owner.post(S, { orgId, title: 'North Star', summary: 'Win the market', objectives: [{ title: 'Grow ARR', keyResults: [{ title: 'ARR 10M', target: '10M' }] }] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    expect(await kbDocIds(owner, orgId)).toEqual([created.body.id]);
    const cols = await owner.get(`/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections`);
    const managed = (cols.body.collections as Array<{ collectionId: string; managed?: string; name: string }>).find((c) => c.collectionId === `mgd-strategy-${orgId}`);
    expect(managed?.managed).toBe('strategy');
    expect(managed?.name).toBe('Strategy KB');
  });

  it('does NOT index a user-scoped (private) strategy — the RBAC carve-out', async () => {
    const { owner, orgId } = await ownerWithOrg();
    // Positive control in the SAME org: the collection exists and the shared one IS in it.
    const shared = await owner.post(S, { orgId, title: 'Our shared bet' });
    expect(shared.status).toBe(201);
    const priv = await owner.post(S, { orgId, title: 'My private bet', scope: 'user' });
    expect(priv.status).toBe(201);
    expect(await kbDocIds(owner, orgId)).toEqual([shared.body.id]);
  });

  it('re-indexes on update (single doc, upserted by stable id)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const s = await owner.post(S, { orgId, title: 'V1' });
    await owner.patch(`${S}/${s.body.id}`, { title: 'V2 renamed' });
    expect(await kbDocIds(owner, orgId)).toEqual([s.body.id]); // still one doc, not duplicated
    // …and it carries the NEW content: one doc id alone was also the state with no re-index
    // at all (w19g3-kno-update-not-reindexed stayed green on this case).
    const colId = `mgd-strategy-${orgId}`;
    const doc = await owner.get(`/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(colId)}/documents/${encodeURIComponent(s.body.id)}`);
    expect(doc.status, JSON.stringify(doc.body)).toBe(200);
    expect(doc.body.title).toBe('V2 renamed');
  });

  it('REMOVES the doc when scope changes org→user', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const s = await owner.post(S, { orgId, title: 'Was shared' });
    expect(await kbDocIds(owner, orgId)).toContain(s.body.id);
    const patched = await owner.patch(`${S}/${s.body.id}`, { scope: 'user' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(await kbDocIds(owner, orgId)).not.toContain(s.body.id);
  });

  it('REMOVES the doc on archive', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const s = await owner.post(S, { orgId, title: 'To archive' });
    expect(await kbDocIds(owner, orgId)).toContain(s.body.id);
    const del = await owner.del(`${S}/${s.body.id}`); // shared ⇒ soft-archive
    expect(del.status === 200 || del.status === 204).toBe(true);
    expect(await kbDocIds(owner, orgId)).not.toContain(s.body.id);
  });
});

describe('ADR 0100 P1 — managed collection is read-only via the KB routes', () => {
  it('rejects ingest + delete on the managed Strategy KB (400), keeping it in sync', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await owner.post(S, { orgId, title: 'Seed' }); // creates the managed collection
    const colId = `mgd-strategy-${orgId}`;
    const base = `/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(colId)}`;

    // Assert WHICH 400: the managed guard names the managing feature.
    const ingest = await owner.post(`${base}/documents`, { title: 'manual', text: 'should be rejected' });
    expect(ingest.status).toBe(400);
    expect(JSON.stringify(ingest.body)).toContain('"managed":"strategy"');
    const delCol = await owner.del(base);
    expect(delCol.status).toBe(400);
    expect(JSON.stringify(delCol.body)).toContain('"managed":"strategy"');
  });
});
