/**
 * ADR 0464 correction 2026-10-26 (DSAR-DBL) — the doubled `user:user:<hash>` ratchet.
 *
 * `User.userId` is ITSELF `user:<hash>` (`usersService.userIdFor`), and several writers
 * apply `userRef()` (or a literal `user:${…}`) to it, so live rows hold
 * `user:user:<hash>`. The erasers matched `subjectKeyForms(key).forms`, which never
 * contained that spelling, so a DSAR keyed by `User.userId` (the users-route key) left
 * those rows behind. MEASURED in prod 2026-10-26 (read-only): 12 of 16 `chat:read-state`
 * rows, 1 of 57 conversation `dmKey`s, 11 participant metas and 61 of 141 chat-message
 * authors carried the doubled form.
 *
 * Every store below is seeded the way its live writer writes, with the DOUBLED spelling,
 * then `eraseSubject(T, User.userId)` runs through the real host fan-out. A second person
 * seeded the same way must survive (no over-erasure). The production key is a real
 * `userIdFor` id, not a toy string.
 *
 * Sabotage witness (run 2026-10-26): with `subjectKeyForms` reverted to `{key, raw, scope}`
 * this file goes red on read-state, reactions, the dmKey, feedback, the arena rater,
 * participants, chat authors and manual-test runs. With `eraseSubjectKnowledge` reverted to
 * its raw-only key it goes red on knowledge alone. Projects and subject memory had their
 * own doubled-form arms already (PRJC-1, GEN-TWIN-4) and stay green under both; they are
 * here so a regression in those arms is caught too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { DurableCollection, hostExtStorage, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseSubject, registerSubjectEraser, __resetSubjectErasers, __resetSubjectKeyResolvers } from '../src/host/subjectErasure.js';
import { registerHostSubjectErasers } from '../src/host/hostSubjectErasers.js';
import { ERASED_USER_REF, subjectKeyForms } from '../src/host/subjectErasureRedaction.js';
import * as convo from '../src/host/conversationStore.js';
import * as readState from '../src/host/conversationReadState.js';
import * as feedback from '../src/host/messageFeedbackStore.js';
import * as reactions from '../src/host/messageReactionsStore.js';
import * as sknow from '../src/host/subjectKnowledge.js';
import * as smem from '../src/host/subjectMemory.js';
import { personSubject } from '../src/host/subject.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { eraseArenaRaterSubject, type ArenaMatch } from '../src/features/evals/arena.js';
import { eraseSubjectProjects, type Project } from '../src/features/projects/projectsService.js';
import { eraseManualTestRunsSubject, listRuns, saveRun } from '../src/features/manual-tests/manualTestsService.js';
import { createVoiceSession, eraseSubjectVoiceSessions, type VoiceSession } from '../src/features/voice/voiceSession.js';

const T = 'ws:dsar-dbl';
const A = userIdFor(T, 'oidc:alice'); // `user:<32hex>` — the DSAR key the users route passes
const B = userIdFor(T, 'oidc:bob');
const dbl = (id: string): string => convo.userRef(id); // what `userRef(req.userId)` writes

const arenaRaw = new DurableCollection<ArenaMatch>('evals:arena-match', (m) => m.matchId, undefined, (m) => m.tenantId);
const projectsRaw = new DurableCollection<Project>('projects:project', (p) => p.id, undefined, (p) => p.tenantId);
const voiceRaw = new DurableCollection<VoiceSession>('voice:session', (v) => `${v.tenantId}:${v.sessionId}`, undefined, (v) => v.tenantId);

let storage: Storage;

beforeEach(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-dsar-dbl-')) });
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  __resetSubjectErasers();
  __resetSubjectKeyResolvers();
  registerHostSubjectErasers();
  registerSubjectEraser(eraseArenaRaterSubject);
  registerSubjectEraser(eraseSubjectProjects);
  registerSubjectEraser(eraseManualTestRunsSubject);
  registerSubjectEraser(eraseSubjectVoiceSessions);
});

async function seed(id: string, tag: string): Promise<void> {
  const ref = dbl(id);
  const at = '2026-10-26T00:00:00.000Z';
  await readState.setReadMarker(T, `c-${tag}`, ref, at, 3);
  await reactions.addReaction({ tenantId: T, conversationId: `c-${tag}`, messageId: 'm1', subjectRef: ref, emoji: '🎉' });
  await feedback.setMessageFeedback({ tenantId: T, conversationId: `c-${tag}`, messageId: 'm1', subjectRef: ref, rating: 'down', reason: 'private reason' });
  // A DM (dmKey + owner) and a group the person is only a participant of.
  await convo.ensureConversationMeta(T, `dm-${tag}`, { type: 'agent', ownerUserId: id, dmKey: convo.dmKeyOf(ref, 'agent:helper') });
  await convo.ensureConversationMeta(T, `grp-${tag}`, { type: 'group', ownerUserId: 'someone-else', participants: [ref] });
  await hostExtStorage().createChatSession({ sessionId: `grp-${tag}`, tenantId: T, title: 'g', createdAt: at, updatedAt: at, messageCount: 0 });
  await hostExtStorage().appendChatMessage({ messageId: `msg-${tag}`, sessionId: `grp-${tag}`, role: 'user', content: JSON.stringify({ role: 'user', content: `secret of ${tag}` }), meta: null, authorSubject: ref, createdAt: at });
  await arenaRaw.put({ matchId: `am-${tag}`, tenantId: T, modelA: 'a', modelB: 'b', winner: 'A', raterSubject: ref, createdAt: at });
  await projectsRaw.put({ id: `p-${tag}`, tenantId: T, orgId: 'org-1', name: 'P', workflows: [], members: [{ ref, role: 'contributor', addedAt: at }], createdAt: at, updatedAt: at });
  await smem.addSubjectNote(T, personSubject(id), `note of ${tag}`);
  await sknow.setSubjectKnowledge(T, personSubject(id), { collectionIds: [`kb-${tag}`] });
  await saveRun(T, ref, 'suite-1', { 'case-1': { status: 'fail', note: `notes of ${tag}` } });
}

interface Residue {
  readState: boolean; reaction: boolean; feedback: boolean; dmKey: boolean; participant: boolean;
  chatAuthor: boolean; arenaRater: boolean; projectMember: boolean; memory: boolean; knowledge: boolean; manualRun: boolean;
}

async function residue(id: string, tag: string): Promise<Residue> {
  const ref = dbl(id);
  const dm = await convo.getConversationMeta(T, `dm-${tag}`);
  const grp = await convo.getConversationMeta(T, `grp-${tag}`);
  const msg = await hostExtStorage().getChatMessage(`grp-${tag}`, `msg-${tag}`);
  const hash = id.slice('user:'.length);
  return {
    readState: (await readState.getReadMarker(T, `c-${tag}`, ref)) !== null,
    reaction: ((await reactions.listReactionsForConversation(T, `c-${tag}`)).get('m1') ?? []).some((r) => r.subjectRef === ref),
    feedback: (await feedback.getMessageFeedback(T, `c-${tag}`, 'm1', ref)) !== null,
    dmKey: (dm?.dmKey ?? '').includes(hash),
    participant: (grp?.participants ?? []).some((p) => p.subjectRef === ref),
    chatAuthor: msg?.authorSubject === ref,
    arenaRater: (await arenaRaw.get(`am-${tag}`))?.raterSubject === ref,
    projectMember: ((await projectsRaw.get(`p-${tag}`))?.members ?? []).some((m) => m.ref === ref),
    memory: (await smem.listSubjectNotes(T, personSubject(id))).length > 0,
    knowledge: ((await sknow.getSubjectKnowledge(T, personSubject(id))).collectionIds ?? []).length > 0,
    manualRun: (await listRuns(T, ref)).length > 0,
  };
}

const ALL_TRUE: Residue = {
  readState: true, reaction: true, feedback: true, dmKey: true, participant: true,
  chatAuthor: true, arenaRater: true, projectMember: true, memory: true, knowledge: true, manualRun: true,
};
const ALL_FALSE: Residue = Object.fromEntries(Object.keys(ALL_TRUE).map((k) => [k, false])) as unknown as Residue;

describe('ADR 0464 DSAR-DBL — a `user:user:<hash>` row is erased in every subject-bearing store', () => {
  it('the subject key forms contain the doubled spelling, and only of the key and the scope', () => {
    expect(subjectKeyForms(A).forms.has(dbl(A))).toBe(true);
    expect(subjectKeyForms(A.slice('user:'.length)).forms.has(dbl(A))).toBe(true); // a bare-hash key
    // A legacy pre-`userIdFor` id (`user:<uuid>`, one live in prod) and the principal
    // fallbacks (`userRef(principalId)`) keep the spelling the old `subjectRefForms` gave them.
    const legacy = 'user:6f1c2a9e-0b4d-4c55-9a1e-3d2b7c8e9f00';
    expect(subjectKeyForms(legacy).forms.has(`user:${legacy}`)).toBe(true);
    expect(subjectKeyForms('oidc:sub-1').forms.has('user:oidc:sub-1')).toBe(true);
    expect(subjectKeyForms('session:s1').forms.has('user:session:s1')).toBe(true);
    // No tag bridge: an agent key never matches a person's ref.
    const agent = subjectKeyForms('agent:X').forms;
    expect(agent.has('user:X')).toBe(false);
    expect(agent.has('user:agent:X')).toBe(true);
  });

  it('seeds are visible before erasure (non-vacuity)', async () => {
    await seed(A, 'a');
    expect(await residue(A, 'a')).toEqual(ALL_TRUE);
  });

  it('eraseSubject(User.userId) removes the doubled form everywhere and leaves another person intact', async () => {
    await seed(A, 'a');
    await seed(B, 'b');
    const result = await eraseSubject(T, A);
    expect(result.failed).toBe(0);
    expect(await residue(A, 'a')).toEqual(ALL_FALSE);
    expect(await residue(B, 'b')).toEqual(ALL_TRUE);
    // The anonymized shapes, where a row is kept rather than deleted.
    const dm = await convo.getConversationMeta(T, 'dm-a');
    expect(dm?.dmKey?.split('|')).toContain(ERASED_USER_REF);
    expect((await hostExtStorage().getChatMessage('grp-a', 'msg-a'))?.authorSubject).toBe(ERASED_USER_REF);
  });
});

// ── The stores that used to match through the `user:`+raw bridge ────────────────────────
// Dropping that arm NARROWS what a DSAR matches, so the narrowing is pinned both ways:
// every spelling a live writer stores under today is still erased (positive), and the one
// spelling the bridge used to reach — a person's `user:X` from an `agent:X` key — is not
// (negative). Sabotage-witnessed 2026-10-26: re-adding `user:`+raw reddens the first
// negative case; dropping the two `userRef` arms reddens all five "its userRef" positives.
// The second negative case (an `agent:X` row survives erasing `user:X`) is a guard the
// bridge never touched, so no sabotage of this change can redden it; it is here for
// symmetry.

async function seedBridgeRow(ref: string, tag: string): Promise<void> {
  const at = '2026-10-26T00:00:00.000Z';
  await convo.ensureConversationMeta(T, `bp-${tag}`, { type: 'group', ownerUserId: `owner-${tag}`, participants: [ref] });
  await convo.ensureConversationMeta(T, `bd-${tag}`, { type: 'agent', ownerUserId: `owner-${tag}`, dmKey: convo.dmKeyOf(ref, 'workspace:helper') });
  await hostExtStorage().createChatSession({ sessionId: `bp-${tag}`, tenantId: T, title: 'g', createdAt: at, updatedAt: at, messageCount: 0 });
  await hostExtStorage().appendChatMessage({ messageId: `bm-${tag}`, sessionId: `bp-${tag}`, role: 'user', content: JSON.stringify({ role: 'user', content: 'hi' }), meta: null, authorSubject: ref, createdAt: at });
  await createVoiceSession(T, { sessionId: `bv-${tag}`, subject: ref, streamRef: 'sr' });
  await feedback.setMessageFeedback({ tenantId: T, conversationId: `bp-${tag}`, messageId: `bm-${tag}`, subjectRef: ref, rating: 'up' });
  await arenaRaw.put({ matchId: `ba-${tag}`, tenantId: T, modelA: 'a', modelB: 'b', winner: 'tie', raterSubject: ref, createdAt: at });
}

async function bridgeRowPresent(ref: string, tag: string): Promise<Record<string, boolean>> {
  const grp = await convo.getConversationMeta(T, `bp-${tag}`);
  const dm = await convo.getConversationMeta(T, `bd-${tag}`);
  return {
    participants: (grp?.participants ?? []).some((p) => p.subjectRef === ref),
    dmKey: (dm?.dmKey ?? '').split('|').includes(ref),
    chatAuthor: (await hostExtStorage().getChatMessage(`bp-${tag}`, `bm-${tag}`))?.authorSubject === ref,
    voice: (await voiceRaw.get(`${T}:bv-${tag}`))?.subject === ref,
    feedback: (await feedback.getMessageFeedback(T, `bp-${tag}`, `bm-${tag}`, ref)) !== null,
    arena: (await arenaRaw.get(`ba-${tag}`))?.raterSubject === ref,
  };
}

const BRIDGE_ALL = { participants: true, dmKey: true, chatAuthor: true, voice: true, feedback: true, arena: true };
const BRIDGE_NONE = { participants: false, dmKey: false, chatAuthor: false, voice: false, feedback: false, arena: false };

/** Every key shape a real row is written under today (prod census 2026-10-26), with a
 *  same-shape control person. The stored spellings are the key itself (member rows,
 *  `callerSubject` for a principal) and its `userRef` (`userRef(req.userId ?? principalId)`). */
const KEY_SHAPES: ReadonlyArray<readonly [string, string, string]> = [
  ['user:<hex32>', A, B],
  ['legacy user:<uuid>', 'user:6f1c2a9e-0b4d-4c55-9a1e-3d2b7c8e9f00', 'user:0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'],
  ['oidc principal', 'oidc:alice-sub', 'oidc:bob-sub'],
  ['session principal', 'session:s-alice', 'session:s-bob'],
  ['anon principal', 'anon:sid-alice', 'anon:sid-bob'],
];

describe('DSAR-DBL — positive ratchet: every live spelling is still erased without the bridge', () => {
  for (const [label, key, control] of KEY_SHAPES) {
    for (const [form, spell] of [['the key itself', (k: string) => k], ['its userRef', dbl]] as const) {
      it(`${label}: a row stored as ${form} is erased, and a same-shape person's is not`, async () => {
        await seedBridgeRow(spell(key), 'a');
        await seedBridgeRow(spell(control), 'b');
        expect(await bridgeRowPresent(spell(key), 'a')).toEqual(BRIDGE_ALL); // non-vacuity
        const result = await eraseSubject(T, key);
        expect(result.failed).toBe(0);
        expect(await bridgeRowPresent(spell(key), 'a')).toEqual(BRIDGE_NONE);
        expect(await bridgeRowPresent(spell(control), 'b')).toEqual(BRIDGE_ALL);
      });
    }
  }
});

describe('DSAR-DBL — negative: no tag bridge between a person and an agent', () => {
  it("erasing `agent:X` leaves a person's `user:X` rows alone (the dropped bridge)", async () => {
    await seedBridgeRow('user:X', 'p');
    expect(await bridgeRowPresent('user:X', 'p')).toEqual(BRIDGE_ALL);
    await eraseSubject(T, 'agent:X');
    expect(await bridgeRowPresent('user:X', 'p')).toEqual(BRIDGE_ALL);
  });

  it('erasing `user:X` leaves an `agent:X` row alone', async () => {
    await seedBridgeRow('agent:X', 'g');
    expect(await bridgeRowPresent('agent:X', 'g')).toEqual(BRIDGE_ALL);
    await eraseSubject(T, 'user:X');
    expect(await bridgeRowPresent('agent:X', 'g')).toEqual(BRIDGE_ALL);
  });
});
