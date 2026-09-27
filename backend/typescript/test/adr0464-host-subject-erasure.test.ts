/**
 * ADR 0464 Phase 2 — host-store subject erasure.
 *
 * Every host-owned durable store that records a subject identifier now has a
 * registered `SubjectEraser`. This proves the per-store taxonomy for each:
 *   - a subject's OWN data (memory, knowledge, chat read-state/feedback/
 *     reactions, runner residue, twin grants) is DELETED;
 *   - a structurally-needed row (kanban cards, canvas versions/ownership,
 *     scheduled jobs, ACL memberships/orgs, conversations) is ANONYMIZED in
 *     place (ids → sentinel, subject free-text redacted), never deleted;
 * with the two-subjects + other-tenant isolation invariant and idempotency for
 * each. The final block proves the host fan-out wiring (`eraseSubject`).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseSubject, registerSubjectEraser, registerSubjectKeyResolver, __resetSubjectErasers, __resetSubjectKeyResolvers } from '../src/host/subjectErasure.js';
import { ERASED, ERASED_USER_REF } from '../src/host/subjectErasureRedaction.js';
import { registerHostSubjectErasers } from '../src/host/hostSubjectErasers.js';

import * as kanban from '../src/host/kanbanService.js';
import * as canvas from '../src/host/canvasSurface.js';
import * as sched from '../src/host/schedulingService.js';
import * as twin from '../src/host/twinService.js';
import * as acl from '../src/host/accessControlService.js';
import * as convo from '../src/host/conversationStore.js';
import * as readState from '../src/host/conversationReadState.js';
import * as feedback from '../src/host/messageFeedbackStore.js';
import * as reactions from '../src/host/messageReactionsStore.js';
import * as sknow from '../src/host/subjectKnowledge.js';
import * as smem from '../src/host/subjectMemory.js';
import * as runner from '../src/host/selfHostedRunner.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import { getAgentProfile, setAgentTwin, eraseSubjectAgentTwinLinks, __resetAgentProfileStore } from '../src/host/agentProfileService.js';
import { personSubject } from '../src/host/subject.js';

const T = 'tenant-A';
const T2 = 'tenant-B';
const A = 'user:alice'; // the DSAR key form (subject scope)
const A_RAW = 'alice';
const B = 'user:bob';
const B_RAW = 'bob';

let storage: Storage;

beforeEach(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0464-')) });
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await kanban.__resetKanbanStore();
  await acl.__resetAccessStores();
  await sched.resetScheduling();
  await __resetAgentProfileStore();
  // ADR 0734: the runner-erasure cases call registerRunner(); without this the
  // "is idempotent" case inherits the previous case's registration map.
  runner._resetRunnerRegistryForTest();
});

describe('ADR 0464 — kanban card erasure (anonymize the subject\'s cards)', () => {
  it('redacts only the subject\'s authored/assigned cards; others untouched', async () => {
    const board = await kanban.createBoard({ tenantId: T, name: 'Board' });
    const otherBoard = await kanban.createBoard({ tenantId: T2, name: 'Other' });
    const mine = await kanban.createCard({ boardId: board.id, columnId: 'todo', title: 'Ship the thing', description: 'private note', assigneeId: A_RAW, createdBy: A_RAW, assignmentReason: 'because Alice', blockerNote: 'waiting on x' });
    const theirs = await kanban.createCard({ boardId: board.id, columnId: 'todo', title: 'Bob task', assigneeId: B_RAW, createdBy: B_RAW });
    const otherTenant = await kanban.createCard({ boardId: otherBoard.id, columnId: 'todo', title: 'T2 alice', assigneeId: A_RAW });

    await kanban.eraseSubjectKanban(T, A);

    const erased = await kanban.getCard(mine.id);
    expect(erased?.title).toBe(ERASED);
    expect(erased?.description).toBe(ERASED);
    expect(erased?.assigneeId).toBe(ERASED);
    expect(erased?.createdBy).toBe(ERASED);
    expect(erased?.assignmentReason).toBe(ERASED);
    expect(erased?.blockerNote).toBe(ERASED);

    const untouched = await kanban.getCard(theirs.id);
    expect(untouched?.title).toBe('Bob task');
    expect(untouched?.assigneeId).toBe(B_RAW);

    const t2 = await kanban.getCard(otherTenant.id);
    expect(t2?.title).toBe('T2 alice'); // other tenant intact
  });

  it('anonymizes a board the subject owns (never deletes it); other boards intact', async () => {
    const mineUser = await kanban.createBoard({ tenantId: T, name: 'Alice board', ownerUserId: A_RAW });
    const mineSubj = await kanban.createBoard({ tenantId: T, name: 'Alice subj board', ownerSubject: personSubject(A_RAW) });
    const theirs = await kanban.createBoard({ tenantId: T, name: 'Bob board', ownerUserId: B_RAW });

    await kanban.eraseSubjectKanban(T, A);

    const bu = await kanban.getBoard(mineUser.id);
    expect(bu).not.toBeNull(); // never deleted
    expect(bu?.ownerUserId).toBe(ERASED);
    const bs = await kanban.getBoard(mineSubj.id);
    expect(bs?.ownerSubject).toEqual({ kind: 'user', id: ERASED });
    expect((await kanban.getBoard(theirs.id))?.ownerUserId).toBe(B_RAW);
  });

  it('is idempotent and no-ops on falsy input', async () => {
    const board = await kanban.createBoard({ tenantId: T, name: 'Board' });
    const c = await kanban.createCard({ boardId: board.id, columnId: 'todo', title: 'x', assigneeId: A_RAW });
    await kanban.eraseSubjectKanban(T, A);
    await kanban.eraseSubjectKanban(T, A);
    expect((await kanban.getCard(c.id))?.assigneeId).toBe(ERASED);
    await kanban.eraseSubjectKanban(T, '');
    expect((await kanban.getCard(board.id))?.title).toBeUndefined();
  });
});

describe('ADR 0464 — canvas erasure (anonymize capturedBy + ownerSubject)', () => {
  it('anonymizes the subject\'s capturedBy + ownership; others intact', async () => {
    await canvas.__putCanvasForTest({ canvasId: 'cv-a', tenantId: T, canvasTypeId: 'doc', state: {} });
    await canvas.snapshotCanvas({ tenantId: T, canvasId: 'cv-a', state: { v: 1 }, version: 1 }, A_RAW, { force: true });
    await canvas.__putCanvasForTest({ canvasId: 'cv-b', tenantId: T, canvasTypeId: 'doc', state: {} });
    await canvas.snapshotCanvas({ tenantId: T, canvasId: 'cv-b', state: { v: 1 }, version: 1 }, B_RAW, { force: true });
    await canvas.__putCanvasForTest({ canvasId: 'cv-t2', tenantId: T2, canvasTypeId: 'doc', state: {} });
    await canvas.snapshotCanvas({ tenantId: T2, canvasId: 'cv-t2', state: { v: 1 }, version: 1 }, A_RAW, { force: true });
    const owned = await canvas.createCanvasForTenant(T, { canvasTypeId: 'doc', ownerSubject: personSubject(A_RAW) });

    await canvas.eraseSubjectCanvas(T, A);

    expect((await canvas.listCanvasVersions(T, 'cv-a'))[0]!.capturedBy).toBe(ERASED);
    expect((await canvas.listCanvasVersions(T, 'cv-b'))[0]!.capturedBy).toBe(B_RAW);
    expect((await canvas.listCanvasVersions(T2, 'cv-t2'))[0]!.capturedBy).toBe(A_RAW); // other tenant
    const c = await canvas.getCanvasForTenant(T, owned.canvasId);
    expect(c?.ownerSubject).toEqual({ kind: 'user', id: ERASED });
  });

  it('is idempotent', async () => {
    await canvas.__putCanvasForTest({ canvasId: 'cv-a', tenantId: T, canvasTypeId: 'doc', state: {} });
    await canvas.snapshotCanvas({ tenantId: T, canvasId: 'cv-a', state: { v: 1 }, version: 1 }, A_RAW, { force: true });
    await canvas.eraseSubjectCanvas(T, A);
    await canvas.eraseSubjectCanvas(T, A);
    expect((await canvas.listCanvasVersions(T, 'cv-a'))[0]!.capturedBy).toBe(ERASED);
  });
});

describe('ADR 0464 — scheduler erasure (disable + anonymize owner)', () => {
  it('disables + anonymizes the subject\'s jobs; others keep firing', async () => {
    await sched.registerJob({ jobId: 'j-a', tenantId: T, cronExpr: '* * * * *', ownerUserId: A_RAW, workflowId: 'wf' });
    await sched.registerJob({ jobId: 'j-a2', tenantId: T, cronExpr: '* * * * *', ownerSubject: personSubject(A_RAW) });
    await sched.registerJob({ jobId: 'j-b', tenantId: T, cronExpr: '* * * * *', ownerUserId: B_RAW });
    await sched.registerJob({ jobId: 'j-t2', tenantId: T2, cronExpr: '* * * * *', ownerUserId: A_RAW });

    await sched.eraseSubjectSchedules(T, A);

    const ja = await sched.getJob('j-a');
    expect(ja?.enabled).toBe(false);
    expect(ja?.ownerUserId).toBe(ERASED);
    const ja2 = await sched.getJob('j-a2');
    expect(ja2?.enabled).toBe(false);
    expect(ja2?.ownerSubject).toEqual({ kind: 'user', id: ERASED });
    expect((await sched.getJob('j-b'))?.enabled).toBe(true);
    expect((await sched.getJob('j-b'))?.ownerUserId).toBe(B_RAW);
    expect((await sched.getJob('j-t2'))?.enabled).toBe(true); // other tenant
  });

  // SCC-4 — feature tools (scheduled-agent-chats followup/recurring) also stamp the raw
  // user id into `metadata.actingUserId`; the owner scrub alone left it behind post-DSAR.
  it('scrubs metadata.actingUserId for the erased subject, preserving other metadata + other subjects', async () => {
    await sched.registerJob({ jobId: 'j-meta-a', tenantId: T, cronExpr: '* * * * *', workflowId: 'wf',
      ownerSubject: personSubject(A_RAW), metadata: { tool: 'followup', actingUserId: A_RAW, sourceRunId: 'run-1' } });
    await sched.registerJob({ jobId: 'j-meta-b', tenantId: T, cronExpr: '* * * * *', workflowId: 'wf',
      ownerSubject: personSubject(B_RAW), metadata: { tool: 'followup', actingUserId: B_RAW } });

    await sched.eraseSubjectSchedules(T, A);

    const a = await sched.getJob('j-meta-a');
    expect(a?.enabled).toBe(false);
    expect(a?.ownerSubject).toEqual({ kind: 'user', id: ERASED });
    expect((a?.metadata as Record<string, unknown>)?.actingUserId).toBe(ERASED); // the raw id is gone
    expect((a?.metadata as Record<string, unknown>)?.tool).toBe('followup');     // non-id metadata preserved
    expect((a?.metadata as Record<string, unknown>)?.sourceRunId).toBe('run-1');
    // A different subject's job is untouched (per-subject, not per-tenant).
    expect((( await sched.getJob('j-meta-b'))?.metadata as Record<string, unknown>)?.actingUserId).toBe(B_RAW);
  });

  // SCC-4 (review a8e2839d/aad88ec0) — the assistant loops (loops.ts) register AGENT-owned
  // jobs (rosterId/agentId, NO ownerUserId/ownerSubject) that still run AS the enabling
  // human via `metadata.actingUserId`. Those must be treated as owned-by-that-user for
  // erasure: DISABLED (must not keep firing as the erased person — ADR 0464) + scrubbed.
  it('disables + scrubs an AGENT-owned job that acts as the erased user via metadata.actingUserId', async () => {
    await sched.registerJob({ jobId: 'j-loop-a', tenantId: T, cronExpr: '* * * * *', workflowId: 'wf',
      rosterId: 'roster-x', agentId: 'agent-x', metadata: { assistantLoop: { loopId: 'daily' }, actingUserId: A_RAW } });
    await sched.registerJob({ jobId: 'j-loop-b', tenantId: T, cronExpr: '* * * * *', workflowId: 'wf',
      rosterId: 'roster-x', agentId: 'agent-x', metadata: { assistantLoop: { loopId: 'daily' }, actingUserId: B_RAW } });

    await sched.eraseSubjectSchedules(T, A);

    const a = await sched.getJob('j-loop-a');
    expect(a?.enabled).toBe(false); // no longer fires as the erased person
    expect((a?.metadata as Record<string, unknown>)?.actingUserId).toBe(ERASED);
    expect(((a?.metadata as Record<string, unknown>)?.assistantLoop as Record<string, unknown>)?.loopId).toBe('daily'); // non-id metadata preserved
    expect(a?.rosterId).toBe('roster-x'); // agent attribution is not a person — preserved
    // A loop acting as a DIFFERENT user is untouched.
    const b = await sched.getJob('j-loop-b');
    expect(b?.enabled).toBe(true);
    expect((b?.metadata as Record<string, unknown>)?.actingUserId).toBe(B_RAW);
  });

  it('is idempotent', async () => {
    await sched.registerJob({ jobId: 'j-a', tenantId: T, cronExpr: '* * * * *', ownerUserId: A_RAW });
    await sched.eraseSubjectSchedules(T, A);
    await sched.eraseSubjectSchedules(T, A);
    const ja = await sched.getJob('j-a');
    expect(ja?.enabled).toBe(false);
    expect(ja?.ownerUserId).toBe(ERASED);
  });
});

describe('ADR 0464 — twin grant erasure (delete the subject\'s grants)', () => {
  async function seedGrant(tenantId: string, userId: string): Promise<string> {
    const entry = await createRosterEntry({ tenantId, persona: `Aide ${userId}`, agentRef: { agentId: 'a.b.c.d' } });
    await twin.linkTwin(storage, tenantId, entry.rosterId, userId, 'admin');
    await twin.grantTwin(storage, tenantId, entry.rosterId, userId, ['memory']);
    return entry.rosterId;
  }

  it('deletes the subject\'s grants; other user + tenant intact', async () => {
    await seedGrant(T, A_RAW);
    await seedGrant(T, B_RAW);
    await seedGrant(T2, A_RAW);

    await twin.eraseSubjectTwinGrants(T, A);

    expect(await twin.listGrantsForUser(T, A_RAW)).toHaveLength(0);
    expect(await twin.listGrantsForUser(T, B_RAW)).toHaveLength(1);
    expect(await twin.listGrantsForUser(T2, A_RAW)).toHaveLength(1);
  });

  it('is idempotent', async () => {
    await seedGrant(T, A_RAW);
    await twin.eraseSubjectTwinGrants(T, A);
    await twin.eraseSubjectTwinGrants(T, A);
    expect(await twin.listGrantsForUser(T, A_RAW)).toHaveLength(0);
  });
});

describe('ADR 0464 — agent twin-link erasure (anonymize the link refs)', () => {
  const twinInit = { roleKey: 'aide', autonomy: { specLevel: 'draft-only' as const } };

  it('anonymizes userId/linkedBy refs on the twin link; other profiles + tenant intact', async () => {
    await setAgentTwin(T, 'agent-1', { userId: A_RAW, linkedBy: 'admin', linkedAt: '2026-01-01T00:00:00Z' }, twinInit);
    await setAgentTwin(T, 'agent-2', { userId: B_RAW, linkedBy: A_RAW, linkedAt: '2026-01-01T00:00:00Z' }, twinInit);
    await setAgentTwin(T2, 'agent-3', { userId: A_RAW, linkedBy: 'admin', linkedAt: '2026-01-01T00:00:00Z' }, twinInit);

    await eraseSubjectAgentTwinLinks(T, A);

    const p1 = await getAgentProfile(T, 'agent-1');
    expect(p1).not.toBeNull(); // profile never deleted
    expect(p1?.twin?.userId).toBe(ERASED);
    expect(p1?.twin?.linkedBy).toBe('admin'); // not the subject → untouched
    const p2 = await getAgentProfile(T, 'agent-2');
    expect(p2?.twin?.userId).toBe(B_RAW); // not the subject → kept
    expect(p2?.twin?.linkedBy).toBe(ERASED); // subject was the linker → redacted
    expect((await getAgentProfile(T2, 'agent-3'))?.twin?.userId).toBe(A_RAW); // other tenant
  });

  it('is idempotent', async () => {
    await setAgentTwin(T, 'agent-1', { userId: A_RAW, linkedBy: 'admin', linkedAt: '2026-01-01T00:00:00Z' }, twinInit);
    await eraseSubjectAgentTwinLinks(T, A);
    await eraseSubjectAgentTwinLinks(T, A);
    expect((await getAgentProfile(T, 'agent-1'))?.twin?.userId).toBe(ERASED);
  });
});

describe('ADR 0464 — access-control erasure (redact PII, keep ACL structure)', () => {
  it('redacts the member\'s PII but keeps subject + roles; org createdBy anonymized', async () => {
    const orgA = await acl.createOrg({ tenantId: T, createdBy: A, name: 'Org A' });
    const mA = await acl.createMember({ orgId: orgA.orgId, tenantId: T, displayName: 'Alice Smith', email: 'alice@x.com', subject: A, roles: ['owner'] });
    const mB = await acl.createMember({ orgId: orgA.orgId, tenantId: T, displayName: 'Bob Jones', email: 'bob@x.com', subject: B, roles: ['owner'] });
    const orgT2 = await acl.createOrg({ tenantId: T2, createdBy: A, name: 'Org T2' });

    await acl.eraseSubjectAccessControl(T, A);

    const redacted = await acl.getMember(mA.memberId);
    expect(redacted?.displayName).toBe(ERASED);
    expect(redacted?.email).toBe(ERASED);
    expect(redacted?.subject).toBe(A); // opaque key KEPT (ACL structure)
    expect(redacted?.roles).toEqual(['owner']); // authority KEPT

    const bob = await acl.getMember(mB.memberId);
    expect(bob?.displayName).toBe('Bob Jones');

    expect((await acl.getOrg(orgA.orgId))?.createdBy).toBe(ERASED);
    expect((await acl.getOrg(orgT2.orgId))?.createdBy).toBe(A); // other tenant
  });

  it('is idempotent', async () => {
    const org = await acl.createOrg({ tenantId: T, createdBy: A, name: 'Org' });
    const m = await acl.createMember({ orgId: org.orgId, tenantId: T, displayName: 'Alice', email: 'a@x.com', subject: A, roles: ['owner'] });
    await acl.eraseSubjectAccessControl(T, A);
    await acl.eraseSubjectAccessControl(T, A);
    expect((await acl.getMember(m.memberId))?.displayName).toBe(ERASED);
    expect((await acl.getMember(m.memberId))?.roles).toEqual(['owner']);
  });
});

describe('ADR 0464 — conversation erasure (anonymize, never delete)', () => {
  it('anonymizes owner + participant, keeps the conversation + other participants', async () => {
    await convo.ensureConversationMeta(T, 'c-group', { type: 'group', ownerUserId: A_RAW, participants: [convo.userRef(A_RAW), convo.userRef(B_RAW)] });
    await convo.ensureConversationMeta(T, 'c-dm', { type: 'person', ownerUserId: A_RAW, participants: [convo.userRef(B_RAW)], dmKey: convo.dmKeyOf(convo.userRef(A_RAW), convo.userRef(B_RAW)) });
    await convo.ensureConversationMeta(T2, 'c-t2', { type: 'group', ownerUserId: A_RAW, participants: [convo.userRef(A_RAW)] });

    await convo.eraseSubjectConversations(T, A);

    const g = await convo.getConversationMeta(T, 'c-group');
    expect(g).not.toBeNull(); // conversation survives
    expect(g?.ownerUserId).toBe(ERASED);
    expect(g?.participants.map((p) => p.subjectRef).sort()).toEqual([ERASED_USER_REF, convo.userRef(B_RAW)]);

    const dm = await convo.getConversationMeta(T, 'c-dm');
    expect(dm?.dmKey?.includes(A_RAW)).toBe(false);
    expect(dm?.dmKey?.includes(ERASED_USER_REF)).toBe(true);

    const t2 = await convo.getConversationMeta(T2, 'c-t2');
    expect(t2?.ownerUserId).toBe(A_RAW); // other tenant intact
  });

  it('is idempotent', async () => {
    await convo.ensureConversationMeta(T, 'c1', { type: 'group', ownerUserId: A_RAW, participants: [convo.userRef(A_RAW)] });
    await convo.eraseSubjectConversations(T, A);
    await convo.eraseSubjectConversations(T, A);
    const g = await convo.getConversationMeta(T, 'c1');
    expect(g?.ownerUserId).toBe(ERASED);
    expect(g?.participants[0]!.subjectRef).toBe(ERASED_USER_REF);
  });
});

describe('ADR 0464 — chat sidecar erasure (delete the subject\'s own rows)', () => {
  it('deletes read markers, feedback, reactions authored by the subject; others intact', async () => {
    await readState.setReadMarker(T, 'c1', convo.userRef(A_RAW), '2026-01-01T00:00:00Z', 3);
    await readState.setReadMarker(T, 'c1', convo.userRef(B_RAW), '2026-01-01T00:00:00Z', 3);
    await readState.setReadMarker(T2, 'c1', convo.userRef(A_RAW), '2026-01-01T00:00:00Z', 3);
    await feedback.setMessageFeedback({ tenantId: T, conversationId: 'c1', messageId: 'm1', subjectRef: convo.userRef(A_RAW), rating: 'down', reason: 'bad' });
    await feedback.setMessageFeedback({ tenantId: T, conversationId: 'c1', messageId: 'm1', subjectRef: convo.userRef(B_RAW), rating: 'up' });
    await reactions.addReaction({ tenantId: T, conversationId: 'c1', messageId: 'm1', subjectRef: convo.userRef(A_RAW), emoji: '🎉' });
    await reactions.addReaction({ tenantId: T, conversationId: 'c1', messageId: 'm1', subjectRef: convo.userRef(B_RAW), emoji: '🎉' });

    await readState.eraseSubjectReadState(T, A);
    await feedback.eraseSubjectFeedback(T, A);
    await reactions.eraseSubjectReactions(T, A);

    expect(await readState.getReadMarker(T, 'c1', convo.userRef(A_RAW))).toBeNull();
    expect(await readState.getReadMarker(T, 'c1', convo.userRef(B_RAW))).not.toBeNull();
    expect(await readState.getReadMarker(T2, 'c1', convo.userRef(A_RAW))).not.toBeNull(); // other tenant
    expect(await feedback.getMessageFeedback(T, 'c1', 'm1', convo.userRef(A_RAW))).toBeNull();
    expect(await feedback.getMessageFeedback(T, 'c1', 'm1', convo.userRef(B_RAW))).not.toBeNull();
    const rx = await reactions.listReactionsForConversation(T, 'c1');
    const refs = (rx.get('m1') ?? []).map((r) => r.subjectRef);
    expect(refs).toEqual([convo.userRef(B_RAW)]);
  });

  it('is idempotent', async () => {
    await feedback.setMessageFeedback({ tenantId: T, conversationId: 'c1', messageId: 'm1', subjectRef: convo.userRef(A_RAW), rating: 'down' });
    await feedback.eraseSubjectFeedback(T, A);
    await feedback.eraseSubjectFeedback(T, A);
    expect(await feedback.getMessageFeedback(T, 'c1', 'm1', convo.userRef(A_RAW))).toBeNull();
  });
});

describe('ADR 0464 — subject knowledge + memory erasure (delete own data)', () => {
  it('deletes the subject\'s knowledge binding; other subject + tenant intact', async () => {
    await sknow.setSubjectKnowledge(T, personSubject(A_RAW), { collectionIds: ['kb1'] });
    await sknow.setSubjectKnowledge(T, personSubject(B_RAW), { collectionIds: ['kb2'] });
    await sknow.setSubjectKnowledge(T2, personSubject(A_RAW), { collectionIds: ['kb3'] });

    await sknow.eraseSubjectKnowledge(T, A);

    expect((await sknow.getSubjectKnowledge(T, personSubject(A_RAW))).collectionIds ?? []).toHaveLength(0);
    expect((await sknow.getSubjectKnowledge(T, personSubject(B_RAW))).collectionIds).toEqual(['kb2']);
    expect((await sknow.getSubjectKnowledge(T2, personSubject(A_RAW))).collectionIds).toEqual(['kb3']);
  });

  it('deletes the subject\'s memory notes; other subject + tenant intact', async () => {
    await smem.addSubjectNote(T, personSubject(A_RAW), 'Alice private fact');
    await smem.addSubjectNote(T, personSubject(B_RAW), 'Bob fact');
    await smem.addSubjectNote(T2, personSubject(A_RAW), 'Alice T2 fact');

    await smem.eraseSubjectMemory(T, A);

    expect(await smem.listSubjectNotes(T, personSubject(A_RAW))).toHaveLength(0);
    expect(await smem.listSubjectNotes(T, personSubject(B_RAW))).toHaveLength(1);
    expect(await smem.listSubjectNotes(T2, personSubject(A_RAW))).toHaveLength(1);
  });

  it('is idempotent (knowledge + memory)', async () => {
    await sknow.setSubjectKnowledge(T, personSubject(A_RAW), { collectionIds: ['kb1'] });
    await smem.addSubjectNote(T, personSubject(A_RAW), 'fact');
    await sknow.eraseSubjectKnowledge(T, A);
    await sknow.eraseSubjectKnowledge(T, A);
    await smem.eraseSubjectMemory(T, A);
    await smem.eraseSubjectMemory(T, A);
    expect((await sknow.getSubjectKnowledge(T, personSubject(A_RAW))).collectionIds ?? []).toHaveLength(0);
    expect(await smem.listSubjectNotes(T, personSubject(A_RAW))).toHaveLength(0);
  });
});

describe('ADR 0464 — self-hosted runner erasure (delete dispatch residue)', () => {
  it('deletes the subject\'s dispatch results (re-dispatch no longer deduped)', async () => {
    runner.registerRunner({ runnerId: 'r-a', subject: A, capabilities: {} });
    runner.registerRunner({ runnerId: 'r-b', subject: B, capabilities: {} });
    const exec = async (): Promise<unknown> => ({ ok: true });
    await runner.dispatchToRunner({ subject: A, runId: 'run1', stepId: 's1', frame: {} }, exec);
    await runner.dispatchToRunner({ subject: B, runId: 'run1', stepId: 's1', frame: {} }, exec);
    // Before erasure a redelivery dedups.
    expect((await runner.dispatchToRunner({ subject: A, runId: 'run1', stepId: 's1', frame: {} }, exec)).deduped).toBe(true);

    await runner.eraseSubjectRunnerDispatches(T, A);

    // After erasure the subject's row is gone → re-executes (not deduped).
    expect((await runner.dispatchToRunner({ subject: A, runId: 'run1', stepId: 's1', frame: {} }, exec)).deduped).toBe(false);
    // Other subject's residue is intact.
    expect((await runner.dispatchToRunner({ subject: B, runId: 'run1', stepId: 's1', frame: {} }, exec)).deduped).toBe(true);
  });

  it('is idempotent', async () => {
    runner.registerRunner({ runnerId: 'r-a', subject: A, capabilities: {} });
    const exec = async (): Promise<unknown> => ({ ok: true });
    await runner.dispatchToRunner({ subject: A, runId: 'run1', stepId: 's1', frame: {} }, exec);
    await runner.eraseSubjectRunnerDispatches(T, A);
    await runner.eraseSubjectRunnerDispatches(T, A);
    expect((await runner.dispatchToRunner({ subject: A, runId: 'run1', stepId: 's1', frame: {} }, exec)).deduped).toBe(false);
  });
});

describe('ADR 0464 — host fan-out wiring (eraseSubject reaches host stores)', () => {
  beforeEach(() => {
    __resetSubjectErasers();
    __resetSubjectKeyResolvers();
    registerHostSubjectErasers();
  });

  it('a single eraseSubject anonymizes/deletes across host stores', async () => {
    const board = await kanban.createBoard({ tenantId: T, name: 'Board' });
    const card = await kanban.createCard({ boardId: board.id, columnId: 'todo', title: 'x', assigneeId: A_RAW });
    await sched.registerJob({ jobId: 'j-a', tenantId: T, cronExpr: '* * * * *', ownerUserId: A_RAW });
    await smem.addSubjectNote(T, personSubject(A_RAW), 'fact');

    const res = await eraseSubject(T, A);
    expect(res.total).toBeGreaterThanOrEqual(17);
    expect(res.failed).toBe(0);

    expect((await kanban.getCard(card.id))?.assigneeId).toBe(ERASED);
    expect((await sched.getJob('j-a'))?.enabled).toBe(false);
    expect(await smem.listSubjectNotes(T, personSubject(A_RAW))).toHaveLength(0);
  });
});

describe('R2 CN-SP-1 — a throwing subject-key RESOLVER makes the erasure incomplete', () => {
  beforeEach(() => { __resetSubjectErasers(); __resetSubjectKeyResolvers(); });

  it('resolver failures COUNT into failed (linked-key data was never enumerated, so it was never erased)', async () => {
    const erased: string[] = [];
    registerSubjectEraser(async function recordingEraser(_t, key) { erased.push(key); });
    registerSubjectKeyResolver(async () => { throw new Error('identity link store down'); });
    const r = await eraseSubject('tR2', 'user:alpha');
    // The bare key still erased; the resolver failure is REPORTED, not hidden.
    expect(erased).toEqual(['user:alpha']);
    expect(r.resolverFailures).toBe(1);
    expect(r.failed).toBeGreaterThan(0); // ok:false at the route (failed === 0 is the success gate)
  });

  it('the positive case: a healthy resolver expands keys and failed stays 0', async () => {
    const erased: string[] = [];
    registerSubjectEraser(async function recordingEraser(_t, key) { erased.push(key); });
    registerSubjectKeyResolver(async () => ['contact:linked-1']);
    const r = await eraseSubject('tR2', 'user:beta');
    expect(erased.sort()).toEqual(['contact:linked-1', 'user:beta']);
    expect(r.failed).toBe(0);
    expect(r.resolverFailures).toBe(0);
  });
});

