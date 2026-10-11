/**
 * Priority Matrix → KB auto-indexer (ADR 0100 Phase 2) — ROUTE harness. Drives
 * list + idea CRUD over HTTP and reads the managed 'Priority Matrix KB' to verify:
 *   - a workspace/org list is indexed (pm-list doc); its ideas are indexed
 *     (pm-idea docs) on submit, and re-indexed (not duplicated) on score/move
 *   - a PROJECT-scoped list + its ideas are NOT indexed (the RBAC carve-out)
 *   - deleteList evicts the list doc + every idea doc (the only idea-removal path)
 *
 * What turns it red (w15 probes): a wrong list/idea doc id or a skipped idea upsert;
 * the collection losing its `managed` stamp; the kanban card-delete hook unregistered or
 * not evicting; the board claim returning null or the kanban route ignoring it;
 * `isShared` letting a project-scoped list through (the ADR 0100 visibility invariant);
 * dropping the `## Scores` block; `reindexListIdeas` not running on a criteria change;
 * `removeList` skipping the list doc or the idea docs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import type { Criterion } from '../src/features/priority-matrix/types.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  for (const id of ['priority-matrix', 'kb', 'projects']) await enableToggle(id);
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);
interface KbCollection { collectionId: string; managed?: string }
const L = '/host/openwop-app/priority-matrix/lists';

async function ownerWithOrg(): Promise<{ owner: Client; orgId: string }> {
  const owner = client();
  const r = await owner.post('/host/openwop-app/test/login', { email: uniqEmail('pmk'), tenantId: `org:pmk-${Date.now()}-${n++}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}

/** Doc ids in the managed Priority Matrix KB for an org (empty if absent). */
async function kbDocIds(owner: Client, orgId: string): Promise<string[]> {
  const colId = `mgd-priority-matrix-${orgId}`;
  const docs = await owner.get(`/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(colId)}/documents`);
  // Only a MISSING collection is a legitimate empty. Any other non-200 used to read as
  // "no docs", which satisfied every `not.toContain` below on a failed read.
  if (docs.status === 404) return [];
  expect(docs.status, JSON.stringify(docs.body)).toBe(200);
  return (docs.body.documents as Array<{ documentId: string }>).map((d) => d.documentId);
}

describe('ADR 0100 P2 — priority matrix indexes lists + ideas', () => {
  it('indexes a workspace list and its ideas; re-indexes (not duplicates) on score', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Launch priorities' })).body;
    expect(await kbDocIds(owner, orgId)).toEqual([`pm-list:${list.id}`]);

    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Ship onboarding', description: 'Reduce time-to-value' })).body;
    expect(await kbDocIds(owner, orgId)).toEqual(expect.arrayContaining([`pm-list:${list.id}`, `pm-idea:${idea.id}`]));

    await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: { 'strategic-alignment': 9, roi: 8, urgency: 7, 'compliance-risk': 5, cost: 3 } });
    const ids = await kbDocIds(owner, orgId);
    expect(ids.filter((d) => d === `pm-idea:${idea.id}`)).toHaveLength(1); // upserted, not duplicated

    const cols = await owner.get(`/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections`);
    expect((cols.body.collections as KbCollection[]).find((c) => c.collectionId === `mgd-priority-matrix-${orgId}`)?.managed).toBe('priority-matrix');
  });

  it('ADR 0667 D5(a) — deleting the CARD through kanban\'s own door EVICTS the idea doc', async () => {
    // The harm this closes: `DELETE …/kanban/cards/:cardId` ran no priority-matrix
    // cascade, and `indexIdea` (the eviction) has no caller outside the feature — so a
    // deleted idea kept being RETRIEVED from the org's managed PM collection, which is
    // shareable to advisory boards.
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Launch priorities' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Ship onboarding' })).body;
    await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: { 'strategic-alignment': 9, roi: 8, urgency: 7, 'compliance-risk': 5, cost: 3 } });
    expect(await kbDocIds(owner, orgId), 'precondition: the idea is indexed').toContain(`pm-idea:${idea.id}`);

    // Delete via KANBAN, not via the priority-matrix door.
    const del = await owner.del(`/host/openwop-app/kanban/cards/${encodeURIComponent(idea.id)}`);
    expect(del.status).toBe(204);

    expect(await kbDocIds(owner, orgId), 'the deleted idea must not still be retrievable').not.toContain(`pm-idea:${idea.id}`);
    expect(await kbDocIds(owner, orgId), 'and the list doc is untouched').toContain(`pm-list:${list.id}`);
  });

  it('ADR 0667 D5(b) — deleting the BOARD under a priority list is refused (409), not silently emptying it', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Launch priorities' })).body;
    const res = await owner.del(`/host/openwop-app/kanban/boards/${encodeURIComponent(list.boardId)}`);
    expect(res.status, 'the kanban route needs only workspace:write; the list needs more').toBe(409);
    expect(JSON.stringify(res.body)).toContain('priority-matrix');
    // And the list still works — the refusal protected it rather than stranding it.
    expect((await owner.get(`${L}/${encodeURIComponent(list.id)}`)).status).toBe(200);
  });

  it('does NOT index a PROJECT-scoped list or its ideas — the RBAC carve-out', async () => {
    const { owner, orgId } = await ownerWithOrg();
    // A shared list in the same org first, so the managed collection EXISTS and the
    // negative assertions below are made against a real 200 read (positive control).
    const shared = (await owner.post(L, { orgId, name: 'Org priorities' })).body;
    const proj = (await owner.post('/host/openwop-app/projects', { orgId, name: 'Secret project' })).body;
    const list = (await owner.post(L, { orgId, name: 'Project priorities', projectId: proj.id })).body;
    const idea = (await owner.post(`${L}/${encodeURIComponent(list.id)}/ideas`, { title: 'Private idea' })).body;

    const ids = await kbDocIds(owner, orgId);
    expect(ids, 'positive control: the shared list IS indexed').toContain(`pm-list:${shared.id}`);
    expect(ids).not.toContain(`pm-list:${list.id}`);
    expect(ids).not.toContain(`pm-idea:${idea.id}`);
  });

  it('idea doc carries the score; a criteria-weight change re-indexes it (single doc, refreshed)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Scored list' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Scored idea' })).body;
    await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: { 'strategic-alignment': 9, roi: 8, urgency: 7, 'compliance-risk': 5, cost: 3 } });

    const colId = `mgd-priority-matrix-${orgId}`;
    const docPath = `/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(colId)}/documents/${encodeURIComponent(`pm-idea:${idea.id}`)}`;
    const doc = (await owner.get(docPath)).body;
    expect(doc.text).toContain('## Scores');
    expect(doc.text).toContain('Strategic alignment: 9/10');

    // Re-weight criteria → recompute + re-index; the idea doc stays single + present.
    const priorityLine = (text: string): string | undefined => /Priority: [0-9.]+/.exec(text)?.[0];
    const before = priorityLine(doc.text);
    expect(before, 'precondition: the doc carries a priority').toBeTruthy();
    const cs = { ...list.criteriaSet, criteria: (list.criteriaSet.criteria as Criterion[]).map((c) => ({ ...c, weight: c.id === 'roi' ? 10 : c.weight })) };
    expect((await owner.patch(base, { criteriaSet: cs })).status).toBe(200);
    expect((await kbDocIds(owner, orgId)).filter((d) => d === `pm-idea:${idea.id}`)).toHaveLength(1);
    // REFRESHED, not merely present: the doc's priority is the re-ranked value.
    const now = (await owner.get(`${base}/ideas`)).body.ideas[0].computedPriority as number;
    const after = priorityLine((await owner.get(docPath)).body.text);
    expect(after).not.toBe(before);
    expect(after).toBe(`Priority: ${now.toFixed(2)}`);
  });

  it('deleteList evicts the list doc and all idea docs', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Temp list' })).body;
    const idea = (await owner.post(`${L}/${encodeURIComponent(list.id)}/ideas`, { title: 'Temp idea' })).body;
    expect(await kbDocIds(owner, orgId)).toEqual(expect.arrayContaining([`pm-list:${list.id}`, `pm-idea:${idea.id}`]));

    expect((await owner.del(`${L}/${encodeURIComponent(list.id)}`)).status).toBe(204);
    const ids = await kbDocIds(owner, orgId);
    expect(ids).not.toContain(`pm-list:${list.id}`);
    expect(ids).not.toContain(`pm-idea:${idea.id}`);
  });
});
