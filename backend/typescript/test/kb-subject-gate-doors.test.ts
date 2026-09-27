/**
 * ADR 0643 R3 review — the two Blockers against the KBC-1 subject gate, ported
 * from the reviewer's scratch witnesses as BORN-RED legs on the booted app (the
 * project access resolver is registered at boot, so a subject-bound collection is
 * only really bound here).
 *
 * BLOCKER 1 — `eraseSubjectKb` vs a project/notebook-BOUND collection. KBC-1 made
 * an omitted caller `{ subject: undefined }`, `filterReadable` refused every bound
 * row, and the ADR 0464 eraser SKIPPED the bound corpus and reported
 * `{ documentsDeleted: 0 }` as a complete-looking erasure. `kb-erasure-retention.
 * test.ts` had zero `boundSubject` fixtures, which is why it stayed green. Pinned:
 * the unbound CONTROL (1 deleted) and the BOUND case (1 deleted, the document gone,
 * the `createdBy` attribution scrubbed), on `eraseSubjectKb` AND through the real
 * ADR 0464 fan-out (`eraseSubject`), which must count NO failure. Sabotage: revert
 * the eraser's two `PREAUTHORIZED_CALLER`s ⇒ the bound leg is red at
 * `documentsDeleted`.
 *
 * BLOCKER 2 — `PREAUTHORIZED_CALLER` sat on user-driven BIND/CREATE lanes, so a
 * non-member laundered a bound corpus through them: `getCollection` refused the
 * intruder, the bind did not ask, and the use lanes (pre-authorized BY the
 * binding) then served the private titles and chunk text. Pinned per door, each
 * with a MEMBER positive control so the refusal is proven to be membership-based
 * (the intruder is an org VIEWER: per ADR 0054 D5 `workspace:write` in the org is
 * READ on every project in it, so a writer is not the principal the gate refuses):
 *   - agent-knowledge `bindCollection` (+ the two HTTP reads re-resolve the READER);
 *   - profile-memory `bindCollection`;
 *   - sharing `createLink` (the mint gate);
 *   - comments `createComment` (the target validator);
 *   - knowledge-sync: the runner re-resolves every pass AS THE CONNECTION OWNER
 *     (`kb-lifecycle-silent-lanes.test.ts` carries the runner leg — it needs the
 *     fetch mocks that file already sets up).
 * Sabotage: resolve any one door `PREAUTHORIZED_CALLER` again ⇒ its leg is red.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { getAgentProfile, upsertAgentProfile } from '../src/host/agentProfileService.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import { buildAgentKnowledgeSurface } from '../src/features/agent-knowledge/surface.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { addProjectMember, createProject, setProjectVisibility, projectSubject } from '../src/features/projects/projectsService.js';
import { createCollection, eraseSubjectKb, getCollection, getDocument, ingestDocument, listCollections } from '../src/features/kb/kbService.js';
import { bindCollection as bindToAgent, getAgentKnowledge, retrieveForAgent } from '../src/features/agent-knowledge/service.js';
import { bindCollection as bindToProfile, getProfileKnowledge } from '../src/features/profile-memory/profileKnowledgeService.js';
import { createLink } from '../src/features/sharing/sharingService.js';
import { createComment, listThread, getComment, updateComment, deleteComment, deleteSubjectComments } from '../src/features/comments/commentsService.js';

let BASE = '';
let server: http.Server;
let n = 0;

interface Res<T = Record<string, any>> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res<any>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
}
type Client = ReturnType<typeof client>;

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

/** A tenant with a real org, a PRIVATE project whose only member is `member`, and a
 *  collection BOUND to that project holding one distinctive document. `intruder` is
 *  a second real user of the same tenant + org (workspace:write) who is NOT a
 *  project member — exactly the principal KBC-1 exists to refuse. */
async function boundFixture(): Promise<{ tenantId: string; orgId: string; collectionId: string; member: string; intruder: string; projectId: string; ownerClient: Client; intruderClient: Client }> {
  const owner = client();
  const tenantId = `org:kb-doors-${Date.now()}-${n++}`;
  const login = await owner.post('/v1/host/openwop-app/test/login', { email: `member-${n++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const member = login.body.user.userId as string;
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId as string;
  const other = client();
  const login2 = await other.post('/v1/host/openwop-app/test/login', { email: `intruder-${n++}@acme.test`, tenantId });
  expect(login2.status).toBe(201);
  const intruder = login2.body.user.userId as string;
  // A VIEWER, deliberately: ADR 0054 D5 makes WRITE org-scoped authority ("membership
  // never grants write" — and `workspace:write` in the org READS every project in it,
  // private ones included). Only READ has the membership dimension the gate enforces,
  // so the principal KBC-1 refuses is an org reader who is not a project member.
  const add = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'Intruder', subject: intruder, roles: ['viewer'] });
  expect(add.status, JSON.stringify(add.body)).toBe(201);

  const project = await createProject(tenantId, orgId, { name: 'Private project' });
  await addProjectMember(tenantId, project.id, `user:${member}`, 'contributor');
  await setProjectVisibility(tenantId, project.id, 'private');
  const col = await createCollection(tenantId, orgId, member, { name: 'private project corpus' }, { boundSubject: projectSubject(project.id) });
  await ingestDocument(tenantId, orgId, member, col.collectionId, { title: 'Secret roadmap', text: 'The acme merger closes in Q4 and the codename is bluebird.' }, {}, PREAUTHORIZED_CALLER);
  // The gate itself holds for the intruder and opens for the member — the premise.
  expect(await getCollection(tenantId, orgId, col.collectionId, { subject: intruder })).toBeNull();
  expect(await getCollection(tenantId, orgId, col.collectionId, { subject: member })).not.toBeNull();
  return { tenantId, orgId, collectionId: col.collectionId, member, intruder, projectId: project.id, ownerClient: owner, intruderClient: other };
}

const PROFILE_BODY = { roleKey: 'kb-agent', autonomy: { specLevel: 'recommend' }, capabilities: ['knowledge'] };

describe('BLOCKER 1 — the ADR 0464 eraser reaches a BOUND collection', () => {
  it('control: an UNBOUND collection is erased (documentsDeleted 1)', async () => {
    const tenantId = `org:kb-erase-ctl-${Date.now()}-${n++}`;
    const col = await createCollection(tenantId, 'org1', 'victim', { name: 'plain' });
    await ingestDocument(tenantId, 'org1', 'victim', col.collectionId, { title: 'profile', text: 'hello world text' }, { documentId: 'profile:victim' }, PREAUTHORIZED_CALLER);
    const r = await eraseSubjectKb(tenantId, 'victim');
    expect(r.documentsDeleted).toBe(1);
    expect(r.attributionsAnonymized).toBeGreaterThanOrEqual(1);
  });

  it('a project-BOUND collection: the subject-keyed document is deleted and the attribution scrubbed (this was 0 / survived / still the victim)', async () => {
    const { tenantId, orgId, collectionId, member } = await boundFixture();
    await ingestDocument(tenantId, orgId, member, collectionId, { title: 'profile', text: 'the member dossier' }, { documentId: `profile:${member}` }, PREAUTHORIZED_CALLER);
    expect(await getDocument(tenantId, orgId, collectionId, `profile:${member}`, PREAUTHORIZED_CALLER), 'non-vacuity').not.toBeNull();

    const r = await eraseSubjectKb(tenantId, member);
    expect(r.documentsDeleted, 'the eraser must REACH the bound corpus — a skipped collection reported as success is the ADR 0464 failure its docblock forbids').toBe(1);
    expect(await getDocument(tenantId, orgId, collectionId, `profile:${member}`, PREAUTHORIZED_CALLER)).toBeNull();
    const c = await getCollection(tenantId, orgId, collectionId, PREAUTHORIZED_CALLER);
    expect(c!.createdBy, 'the collection attribution inside the bound corpus is scrubbed too').not.toBe(member);
    expect(r.attributionsAnonymized).toBeGreaterThanOrEqual(1);
  });

  it('through the real ADR 0464 fan-out (`eraseSubject`): NO eraser failure, and the bound corpus no longer holds the subject', async () => {
    const { tenantId, orgId, collectionId, member } = await boundFixture();
    await ingestDocument(tenantId, orgId, member, collectionId, { title: 'profile', text: 'the member dossier' }, { documentId: `profile:${member}` }, PREAUTHORIZED_CALLER);
    const result = await eraseSubject(tenantId, member);
    expect(result.failed, `erasers failed: ${JSON.stringify(result.failedFeatures)}`).toBe(0);
    expect(await getDocument(tenantId, orgId, collectionId, `profile:${member}`, PREAUTHORIZED_CALLER)).toBeNull();
    expect((await listCollections(tenantId, orgId, PREAUTHORIZED_CALLER)).find((c) => c.collectionId === collectionId)!.createdBy).not.toBe(member);
  });
});

describe('BLOCKER 2 — the doors that turn a user-supplied collectionId into a grant resolve the REAL principal', () => {
  it('agent-knowledge: the intruder cannot bind a bound corpus (404); the member can; the HTTP reads re-resolve the READER', async () => {
    const { tenantId, collectionId, member, intruder } = await boundFixture();
    const agentId = `agent-doors-${n++}`;
    await upsertAgentProfile(tenantId, agentId, { roleKey: 'kb-agent', autonomy: { level: 'review', specLevel: 'recommend' }, capabilities: ['knowledge'] } as never);

    await expect(bindToAgent(tenantId, agentId, collectionId, { subject: intruder }), 'the bind door must not ask less than the read door').rejects.toMatchObject({ httpStatus: 404 });
    const afterRefusal = await getAgentKnowledge(tenantId, agentId, PREAUTHORIZED_CALLER);
    expect(afterRefusal.collections, 'a refused bind must leave NO grant behind').toEqual([]);

    // Positive control — the refusal is membership-based, not "binding is broken".
    await bindToAgent(tenantId, agentId, collectionId, { subject: member });
    const memberView = await getAgentKnowledge(tenantId, agentId, { subject: member });
    expect(memberView.collections.flatMap((c) => c.documents.map((d) => d.title))).toEqual(['Secret roadmap']);
    const memberRetrieve = await retrieveForAgent(tenantId, agentId, 'acme merger codename', { subject: member });
    expect(memberRetrieve.hasResults).toBe(true);

    // The same binding, read by a NON-member over HTTP-shaped reads: nothing.
    const intruderView = await getAgentKnowledge(tenantId, agentId, { subject: intruder });
    expect(intruderView.collections, 'a bound corpus the reader may not read is not projected (no titles, no counts)').toEqual([]);
    const intruderRetrieve = await retrieveForAgent(tenantId, agentId, 'acme merger codename', { subject: intruder });
    expect(intruderRetrieve.chunks, 'no chunk text either').toEqual([]);
    // …and the intruder's read did not PRUNE the member's binding (existence ≠ visibility).
    expect((await getAgentKnowledge(tenantId, agentId, { subject: member })).collections).toHaveLength(1);
  });

  it('profile-memory: the intruder cannot bind a bound corpus to their own profile (404); the member can, and reads it as themselves', async () => {
    const { tenantId, collectionId, member, intruder } = await boundFixture();
    await expect(bindToProfile(tenantId, intruder, collectionId)).rejects.toMatchObject({ httpStatus: 404 });
    expect((await getProfileKnowledge(tenantId, intruder)).collections).toEqual([]);
    await bindToProfile(tenantId, member, collectionId);
    const view = await getProfileKnowledge(tenantId, member);
    expect(view.collections.map((c) => c.collectionId)).toEqual([collectionId]);
    expect(view.collections[0]!.documents.map((d) => d.title)).toEqual(['Secret roadmap']);
  });

  it('sharing: the intruder cannot MINT a public link to a bound corpus (404); the member can', async () => {
    const { tenantId, orgId, collectionId, member, intruder } = await boundFixture();
    await expect(createLink(tenantId, orgId, intruder, { resourceType: 'kb_collection', resourceId: collectionId })).rejects.toMatchObject({ httpStatus: 404 });
    const link = await createLink(tenantId, orgId, member, { resourceType: 'kb_collection', resourceId: collectionId });
    expect(link.token).toBeTruthy();
  });

  it('comments: the intruder cannot open a thread on a bound corpus (404 — no name in a thread title); the member can', async () => {
    const { tenantId, orgId, collectionId, member, intruder } = await boundFixture();
    await expect(createComment({ tenantId, orgId, resourceType: 'kb_collection', resourceId: collectionId, body: 'probe', authorId: intruder , caller: { subject: intruder }})).rejects.toMatchObject({ httpStatus: 404 });
    const { notify } = await createComment({ tenantId, orgId, resourceType: 'kb_collection', resourceId: collectionId, body: 'hello', authorId: member , caller: { subject: member }});
    expect(notify.resourceTitle).toBe('private project corpus');
  });

  /**
   * ADR 0659 D1 — the READ half of the same gate. Born red on `d7bdabf9f`: every leg
   * below returned the member's thread to the intruder, because `listThread` /
   * `getComment` took no caller at all and never resolved the target. The write leg
   * above was closed by ADR 0643 R3 and passed throughout — which is exactly why the
   * read half survived: a gate on the CREATION lane is not a gate on the USE lane.
   */
  it('comments READ: the intruder cannot list, edit or delete a bound corpus\'s thread; the member can', async () => {
    const { tenantId, orgId, collectionId, member, intruder } = await boundFixture();
    const { comment } = await createComment({
      tenantId, orgId, resourceType: 'kb_collection', resourceId: collectionId,
      body: 'a private review note', authorId: member, caller: { subject: member },
    });

    // --- too open: the intruder sees nothing, through every by-id lane too.
    expect(await listThread(tenantId, orgId, 'kb_collection', collectionId, { subject: intruder })).toBeNull();
    expect(await getComment(tenantId, orgId, comment.commentId, { subject: intruder })).toBeNull();
    expect(await updateComment(tenantId, orgId, comment.commentId, intruder, { status: 'resolved' }, { subject: intruder })).toBeNull();
    expect(await deleteComment(tenantId, orgId, comment.commentId, { userId: intruder, isAdmin: false }, { subject: intruder })).toBe(false);

    // No oracle: a comment the intruder cannot see and a comment that does not exist
    // answer IDENTICALLY. Before D1's ordering rule, `updateComment` threw 403 here
    // ("exists, not yours") and a ghost id returned null — a usable existence probe.
    expect(await getComment(tenantId, orgId, 'cmt:does-not-exist', { subject: intruder })).toBeNull();
    expect(await updateComment(tenantId, orgId, 'cmt:does-not-exist', intruder, { status: 'resolved' }, { subject: intruder })).toBeNull();

    // --- too closed (the CMWF-2 direction): the bound MEMBER still works.
    expect((await listThread(tenantId, orgId, 'kb_collection', collectionId, { subject: member }))?.length).toBe(1);
    expect(await getComment(tenantId, orgId, comment.commentId, { subject: member })).not.toBeNull();

    // --- moderation: an org admin who is NOT a project member keeps the delete.
    expect(await deleteComment(tenantId, orgId, comment.commentId, { userId: 'someone-else', isAdmin: true }, PREAUTHORIZED_CALLER)).toBe(true);
  });

  /**
   * ADR 0659 D1, the too-CLOSED direction that `CMWF-2` names: a workflow run acts with
   * its INITIATOR's visibility and is ATTRIBUTED to the agent. Born red — `createComment`
   * used to hand the subject gate `authorId`, so `agent:<runId>` (never a bound member)
   * was refused on every bound corpus and the run was told `not_found`, which was false.
   */
  it('comments: an agent-authored comment on a bound corpus succeeds for a bound initiator and is attributed to the agent', async () => {
    const { tenantId, orgId, collectionId, member, intruder } = await boundFixture();
    const agent = 'agent:run-0659';

    const { comment } = await createComment({
      tenantId, orgId, resourceType: 'kb_collection', resourceId: collectionId,
      body: 'agent review', authorId: agent, caller: { subject: member }, onBehalfOf: member,
    });
    expect(comment.authorId, 'provenance stays the agent').toBe(agent);
    expect(comment.onBehalfOf, 'and the principal it acted for is recorded (D10)').toBe(member);

    // The same run started by a NON-member is still refused — the caller decides.
    await expect(createComment({
      tenantId, orgId, resourceType: 'kb_collection', resourceId: collectionId,
      body: 'agent review', authorId: agent, caller: { subject: intruder }, onBehalfOf: intruder,
    })).rejects.toMatchObject({ httpStatus: 404 });

    // …and so is a run with no acting user at all (a schedule / inbound webhook).
    await expect(createComment({
      tenantId, orgId, resourceType: 'kb_collection', resourceId: collectionId,
      body: 'agent review', authorId: agent, caller: { subject: undefined },
    })).rejects.toMatchObject({ httpStatus: 404 });

    // D10 — the initiator's erasure reaches the agent-authored row.
    expect(await deleteSubjectComments(tenantId, member)).toBe(1);
  });
});

describe('ADR 0643 R4 review — the SEVENTH bind door and the two missed reads', () => {
  it('Blocker 1: PUT /agents/:id/profile with knowledge.collectionIds is REFUSED (400); the run/chat lane then serves nothing; a PUT without it keeps the curator\'s binding', async () => {
    const { tenantId, collectionId, member, intruder, intruderClient, ownerClient } = await boundFixture();
    const roster = await createRosterEntry({ tenantId, persona: 'Door probe', agentRef: { agentId: 'agent:door-probe' }, roleKey: 'kb-agent' });
    const agentId = roster.rosterId;
    await upsertAgentProfile(tenantId, agentId, { roleKey: 'kb-agent', autonomy: { level: 'review', specLevel: 'recommend' }, capabilities: ['knowledge'] } as never);
    // The intruder is a tenant member (an org VIEWER) — exactly what `requireOwnedAgent`
    // alone admitted. The write would have bypassed `bindCollection`'s principal check
    // AND `BINDING_CAP`, and the run lane reads the binding pre-authorized.
    const put = await intruderClient.put(`/v1/host/openwop-app/agents/${encodeURIComponent(agentId)}/profile`, { ...PROFILE_BODY, knowledge: { collectionIds: [collectionId] } });
    expect(put.status, JSON.stringify(put.body)).toBe(400);
    expect(put.body?.details?.field ?? put.body?.error?.details?.field).toBe('knowledge.collectionIds');
    expect((await getAgentProfile(tenantId, agentId))?.knowledge?.collectionIds ?? [], 'no grant landed').toEqual([]);
    // The use lanes that a laundered binding would have fed: nothing.
    const run = await retrieveForAgent(tenantId, agentId, 'acme merger codename');
    expect(run.chunks).toEqual([]);
    const surface = buildAgentKnowledgeSurface({ tenantId, runId: 'run:door-probe' } as BundleScope);
    const out = await surface.retrieve!({ agentId, query: 'acme merger codename' }) as { hasResults: boolean };
    expect(out.hasResults).toBe(false);

    // Corollary — the curator's binding SURVIVES an ordinary profile save that carries
    // `knowledge` without `collectionIds` (that save used to wipe the array).
    await bindToAgent(tenantId, agentId, collectionId, { subject: member });
    const save = await ownerClient.put(`/v1/host/openwop-app/agents/${encodeURIComponent(agentId)}/profile`, { ...PROFILE_BODY, knowledge: { memoryWritable: true } });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect((await getAgentProfile(tenantId, agentId))?.knowledge?.collectionIds).toEqual([collectionId]);
    expect((await getAgentProfile(tenantId, agentId))?.knowledge?.memoryWritable).toBe(true);
    void intruder;
  });

  it('Blocker 2: PUT …/memory-writable and POST …/notes re-resolve the READER — a writer in org A who is a viewer in org B sees none of org B\'s private titles', async () => {
    const { tenantId, collectionId, member, intruder, intruderClient, ownerClient } = await boundFixture();
    // The intruder is an EDITOR in a second org A ⇒ tenant-level `workspace:write` (the
    // union across orgs), which is all these two routes gate on; in org B (the project's)
    // they are a viewer. This two-org shape is also what exposed the routes' local
    // `requireTenantScope` as a FIRST-MATCH rather than a union (fixed in the same fold):
    // the leg was ~50% 403 before, deterministically 200 now.
    const orgA = await ownerClient.post('/v1/host/openwop-app/orgs', { name: 'Other Org' });
    expect(orgA.status, JSON.stringify(orgA.body)).toBe(201);
    const addA = await ownerClient.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgA.body.orgId as string)}/members`, { displayName: 'Intruder', subject: intruder, roles: ['editor'] });
    expect(addA.status, JSON.stringify(addA.body)).toBe(201);
    const roster = await createRosterEntry({ tenantId, persona: 'Read probe', agentRef: { agentId: 'agent:read-probe' }, roleKey: 'kb-agent' });
    const agentId = roster.rosterId;
    await upsertAgentProfile(tenantId, agentId, { roleKey: 'kb-agent', autonomy: { level: 'review', specLevel: 'recommend' }, capabilities: ['knowledge'] } as never);
    await bindToAgent(tenantId, agentId, collectionId, { subject: member });
    expect((await getAgentKnowledge(tenantId, agentId, { subject: member })).collections.flatMap((c) => c.documents.map((d) => d.title)), 'non-vacuity: the member sees the title').toEqual(['Secret roadmap']);

    const mw = await intruderClient.put(`/v1/host/openwop-app/agents/${encodeURIComponent(agentId)}/knowledge/memory-writable`, { writable: true });
    expect(mw.status, JSON.stringify(mw.body)).toBe(200);
    expect(JSON.stringify(mw.body), 'the response body must not carry a corpus the caller cannot read').not.toContain('Secret roadmap');
    expect(mw.body.collections).toEqual([]);
    const note = await intruderClient.post(`/v1/host/openwop-app/agents/${encodeURIComponent(agentId)}/knowledge/notes`, { content: 'probe note' });
    // A 403 from the agent-policy gate is acceptable (the note lane is policy-gated); a
    // 201 must not leak. Either way the body carries no private title.
    expect([201, 403]).toContain(note.status);
    expect(JSON.stringify(note.body ?? {})).not.toContain('Secret roadmap');
    // …and neither read PRUNED the member's binding.
    expect((await getAgentProfile(tenantId, agentId))?.knowledge?.collectionIds).toEqual([collectionId]);
  });
});

/**
 * ADR 0664 D6 — the FIFTH HTTP door.
 *
 * ADR 0643 R3 left `PREAUTHORIZED_CALLER` on lanes where no principal exists, and
 * re-resolves the reader "wherever a principal exists". Four `agent-knowledge/routes.ts`
 * reads do that. `routes/agents.ts:327` — agent dispatch — also HAS a principal
 * (`req.userId`, used for the borrowed-recall gate 17 lines below) and passed none, on a
 * different router, which is how the count in `surface.ts`'s docblock stayed at "four".
 *
 * Born red: before D6 the intruder's dispatch composed the bound corpus verbatim.
 */
describe('ADR 0664 D6 — the agent-dispatch lane re-resolves the reader', () => {
  it('a non-member gets NO chunks from a bound corpus; the bound member still does', async () => {
    const { tenantId, collectionId, member, intruder } = await boundFixture();
    const roster = await createRosterEntry({ tenantId, persona: 'Dispatch probe', agentRef: { agentId: 'agent:dispatch-probe' }, roleKey: 'kb-agent' });
    const agentId = roster.rosterId;
    await upsertAgentProfile(tenantId, agentId, { roleKey: 'kb-agent', autonomy: { level: 'review', specLevel: 'recommend' }, capabilities: ['knowledge'] } as never);
    await bindToAgent(tenantId, agentId, collectionId, { subject: member });

    const { resolveAgentKnowledgeRetrieve } = await import('../src/host/agentKnowledgeComposition.js');
    const { createAgentMemoryPort } = await import('../src/host/agentMemoryAdapter.js');
    const memory = createAgentMemoryPort(tenantId);

    // Non-vacuity FIRST: the bound member really does retrieve the corpus, so a later
    // empty result means "refused", not "nothing was ever there".
    const asMember = await resolveAgentKnowledgeRetrieve(tenantId, agentId, memory, undefined, { subject: member });
    const memberChunks = asMember ? await asMember('roadmap') : [];
    expect(memberChunks.length, 'non-vacuity: the bound member retrieves').toBeGreaterThan(0);
    expect(JSON.stringify(memberChunks)).toContain('bluebird');

    // The door itself.
    const asIntruder = await resolveAgentKnowledgeRetrieve(tenantId, agentId, memory, undefined, { subject: intruder });
    const intruderChunks = asIntruder ? await asIntruder('roadmap') : [];
    expect(JSON.stringify(intruderChunks), 'a non-member must not receive the private corpus').not.toContain('bluebird');
  });

  it('STRUCTURAL — the dispatch route passes a caller (the behavioural leg cannot see a regression at the call site)', () => {
    // The leg above proves the MECHANISM honours a caller. It cannot notice if
    // `routes/agents.ts` stops passing one — which is exactly the defect D6 fixed. This
    // pins the call site, the way the repo pins other cross-file obligations.
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes', 'agents.ts'), 'utf8');
    const call = /resolveAgentKnowledgeRetrieve\(([\s\S]*?)\);/.exec(src);
    expect(call, 'the dispatch route must still call resolveAgentKnowledgeRetrieve').toBeTruthy();
    expect(call![1], 'ADR 0664 D6 — the reader is re-resolved on this lane').toContain('req.userId');
  });
});
