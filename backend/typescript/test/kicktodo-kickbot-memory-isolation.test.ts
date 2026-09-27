/**
 * ADR 0442 P3 — KickBot memory is PER-USER (the F1 isolation invariant) and its
 * KB grounding is real + teardown-clean.
 *
 * The crux the ADR flagged: a standing agent SHARED across a cohort tenant must
 * recall the ACTING participant's own memory and NEVER another participant's.
 * P3 keys KickBot's recall on the acting `user:<id>` (Option B) — F1-safe by
 * construction and teardown-trivial (the scope is the participant's own, which
 * they own and outlive; deleting KickBot must NOT touch it).
 *
 * These tests prove:
 *  - the generic `resolveAgentMemoryScope` decision (per-user vs shared, and the
 *    fail-closed no-actor sentinel that is NEVER the shared scope),
 *  - end-to-end isolation: participant A recalls A's fact, B recalls B's, a
 *    turn with no acting user recalls neither,
 *  - the KB half: challenge content + guidance are ingested, publish/retire keep
 *    it in lockstep, and KickBot deletion drops the collection while the
 *    participant's own memory SURVIVES.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { resolveAgentMemoryScope } from '../src/host/agentMemoryAdapter.js';
import { resolveAgentKnowledgeRetrieve } from '../src/host/agentKnowledgeComposition.js';
import { createSubjectMemoryPort, addSubjectNote, listSubjectNotes, subjectMemoryScope } from '../src/host/subjectMemory.js';
import { personSubject } from '../src/host/subject.js';
import { getAgentProfile, upsertAgentProfile, setAgentKnowledge } from '../src/host/agentProfileService.js';
import { deleteRosterMemberCascade } from '../src/host/rosterCascade.js';
import { listAllTenantCollections } from '../src/features/kb/kbService.js';
import { __resetRosterLifecycleHooks } from '../src/host/rosterLifecycle.js';
import { ensureKickBot, KICKBOT_ROSTER_ID, registerKickbotLifecycleHooks } from '../src/features/kicktodo-core/kickbotService.js';
import { kickbotKbCollectionId, flattenChallenge } from '../src/features/kicktodo-core/kicktodoKnowledgeService.js';
import { createDraft, publishChallenge, retireChallenge } from '../src/features/kicktodo-core/challengeService.js';

const T = 'tenant-kb-iso';

let storage: Storage;

beforeEach(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kickbot-kb-')) });
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  registerKickbotLifecycleHooks(); // the feature-boot wiring the cascade fires
});

afterEach(async () => {
  __resetRosterLifecycleHooks(); // don't leak the handler into other suites
  __resetHostExtPersistence();
  const { getAgentRegistry } = await import('../src/executor/agentRegistry.js');
  getAgentRegistry()._resetForTest();
});

const kbCollection = async (tenantId: string) =>
  (await listAllTenantCollections(tenantId)).find((c) => c.collectionId === kickbotKbCollectionId(tenantId));

async function publishSample(tenantId: string, title: string): Promise<{ id: string; version: number }> {
  const draft = await createDraft({
    tenantId, title, summary: `${title} summary`, outcome: `${title} outcome`, durationDays: 2,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Warm up', instructions: 'Do the first thing', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(tenantId, draft.id, 1);
  return { id: draft.id, version: 1 };
}

describe('resolveAgentMemoryScope (the generic decision point)', () => {
  it('per-user + acting user → the participant own `user:<id>` scope', () => {
    expect(resolveAgentMemoryScope({ profileId: 'host:kickbot', memoryScope: 'per-user' }, { userId: 'alice' }))
      .toBe(subjectMemoryScope(personSubject('alice')));
  });

  it('per-user + NO actor → a fail-closed sentinel that is NEVER the shared scope', () => {
    const shared = subjectMemoryScope({ kind: 'agent', id: 'host:kickbot' });
    const scope = resolveAgentMemoryScope({ profileId: 'host:kickbot', memoryScope: 'per-user' }, undefined);
    expect(scope).not.toBe(shared); // the whole point: no fall-back to the shared scope
    expect(scope.startsWith(shared)).toBe(true); // agent-unique + deterministic
  });

  it('default (no memoryScope) → the shared `agent:<id>` scope, ignoring any actor', () => {
    expect(resolveAgentMemoryScope({ profileId: 'host:x' }, { userId: 'alice' }))
      .toBe(subjectMemoryScope({ kind: 'agent', id: 'host:x' }));
  });

  /**
   * F7 (review of ADR 0587) — the AGMEM-12 sentinel warn fires ONCE per profile.
   *
   * `resolveAgentMemoryScope` runs per RETRIEVE (`agentKnowledgeComposition.ts:199`),
   * so a misconfigured `per-user` agent on an actor-less lane emitted an identical
   * line on every call, forever. An unbounded repeat buries the signal it was added
   * to provide. The condition is a profile MISCONFIGURATION, not an event, so once
   * is the honest cardinality.
   *
   * Asserted as a pair — fires once, and does NOT fire again — because "warned at
   * least once" and "warned exactly once" are different claims and only the second
   * one is the fix.
   */
  it('F7: the AGMEM-12 sentinel warn is logged ONCE per profile, not per call', async () => {
    const { __resetPerUserNoActorWarnDedupe } = await import('../src/host/agentMemoryAdapter.js');
    __resetPerUserNoActorWarnDedupe();

    // `createLogger` binds its sink at module load, so spy the SINK: a non-error
    // level writes one JSON line to stdout (`observability/logger.ts:81`).
    const capture = (fn: () => void): string[] => {
      const lines: string[] = [];
      const sink = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        lines.push(String(chunk));
        return true;
      });
      try { fn(); } finally { sink.mockRestore(); }
      return lines.filter((l) => l.includes('agent_memory_per_user_no_actor'));
    };

    const profile = { profileId: 'host:f7-warn-once', memoryScope: 'per-user' as const };
    const emitted = capture(() => {
      resolveAgentMemoryScope(profile, undefined);
      resolveAgentMemoryScope(profile, undefined);
      resolveAgentMemoryScope(profile, undefined);
    });
    expect(emitted, `sink lines: ${JSON.stringify(emitted)}`).toHaveLength(1);

    // …and a DIFFERENT profile is still warned about — the dedupe is per profile,
    // not a global latch that silences every later misconfiguration.
    expect(capture(() => {
      resolveAgentMemoryScope({ profileId: 'host:f7-other', memoryScope: 'per-user' }, undefined);
    })).toHaveLength(1);

    // BEHAVIOUR UNCHANGED: dedupe silences the LOG, never the sentinel.
    expect(resolveAgentMemoryScope(profile, undefined))
      .toBe(`${subjectMemoryScope({ kind: 'agent', id: profile.profileId })}:no-actor`);
  });
});

describe('KickBot per-user memory isolation (ADR 0442 P3 — F1)', () => {
  it('recalls the ACTING participant own memory and never another participant', async () => {
    await ensureKickBot(T);
    // Two participants in the SAME (cohort) tenant train distinct facts into
    // their OWN memory (auto-extract writes here in production; a curated note is
    // the same `user:<id>` scope).
    await addSubjectNote(T, personSubject('alice'), 'Alice mentor is Zephyrine.');
    await addSubjectNote(T, personSubject('bob'), 'Bob mentor is Quintus.');

    const memory = createSubjectMemoryPort(T);
    const forAlice = await resolveAgentKnowledgeRetrieve(T, KICKBOT_ROSTER_ID, memory, { userId: 'alice' });
    const forBob = await resolveAgentKnowledgeRetrieve(T, KICKBOT_ROSTER_ID, memory, { userId: 'bob' });
    expect(forAlice, 'KickBot has the knowledge capability after provisioning').toBeDefined();

    // Empty query ⇒ recency (deterministic, no embedding flake): the memory port
    // returns exactly the acting participant scope entries.
    const aliceChunks = (await forAlice!('')).map((c) => c.content).join('\n');
    const bobChunks = (await forBob!('')).map((c) => c.content).join('\n');
    expect(aliceChunks).toContain('Zephyrine');
    expect(aliceChunks).not.toContain('Quintus'); // never Bob memory
    expect(bobChunks).toContain('Quintus');
    expect(bobChunks).not.toContain('Zephyrine'); // never Alice memory
  });

  it('a turn with NO acting user recalls neither participant memory (fail-closed)', async () => {
    await ensureKickBot(T);
    await addSubjectNote(T, personSubject('alice'), 'Alice mentor is Zephyrine.');
    await addSubjectNote(T, personSubject('bob'), 'Bob mentor is Quintus.');
    const retrieve = await resolveAgentKnowledgeRetrieve(T, KICKBOT_ROSTER_ID, createSubjectMemoryPort(T), undefined);
    const text = (await retrieve!('')).map((c) => c.content).join('\n');
    expect(text).not.toContain('Zephyrine');
    expect(text).not.toContain('Quintus');
  });

  it('the profile carries per-user scope + the knowledge capability (the recall gate)', async () => {
    await ensureKickBot(T);
    const profile = await getAgentProfile(T, KICKBOT_ROSTER_ID);
    expect(profile?.memoryScope).toBe('per-user');
    expect(profile?.capabilities).toContain('knowledge'); // gates memory recall in chat
    expect(profile?.capabilities).toContain('coaching');   // P1 capability intact
  });

  it('forward-repairs a pre-P3 profile (adds per-user + knowledge) WITHOUT clobbering a governance edit', async () => {
    await ensureKickBot(T);
    // Simulate a pre-P3 build's profile: coaching only, no memoryScope/knowledge,
    // plus a user's governance edit (a custom HITL gate) that must survive.
    await upsertAgentProfile(T, KICKBOT_ROSTER_ID, {
      roleKey: 'kicktodo-guide',
      capabilities: ['coaching'],
      hitl: ['custom-operator-gate'],
      autonomy: { specLevel: 'recommend' },
    });
    await ensureKickBot(T); // re-provision heals forward

    const healed = await getAgentProfile(T, KICKBOT_ROSTER_ID);
    expect(healed?.memoryScope).toBe('per-user');          // healed
    expect(healed?.capabilities).toContain('knowledge');   // healed
    expect(healed?.capabilities).toContain('coaching');    // preserved
    expect(healed?.hitl).toContain('custom-operator-gate'); // governance edit NOT clobbered
  });

  it('re-provision preserves an admin-bound extra collection (grade fixes: guard + additive union)', async () => {
    await ensureKickBot(T);
    const managed = kickbotKbCollectionId(T);
    const init = { roleKey: 'kicktodo-guide', autonomy: { specLevel: 'recommend' as const } };

    // (a) An admin binds an extra collection ALONGSIDE the managed one. Re-provision
    //     must not clobber it — the guard skips the bind (already bound).
    await setAgentKnowledge(T, KICKBOT_ROSTER_ID, { collectionIds: [managed, 'extra-admin-col'] }, init);
    await ensureKickBot(T);
    const afterGuard = await getAgentProfile(T, KICKBOT_ROSTER_ID);
    expect(afterGuard?.knowledge?.collectionIds).toContain('extra-admin-col');
    expect(afterGuard?.knowledge?.collectionIds).toContain(managed);

    // (b) A binding MISSING the managed id (forward-repair path) but carrying an
    //     extra — re-provision runs and UNIONS the managed id in, preserving the extra.
    await setAgentKnowledge(T, KICKBOT_ROSTER_ID, { collectionIds: ['only-extra-col'] }, init);
    await ensureKickBot(T);
    const afterUnion = await getAgentProfile(T, KICKBOT_ROSTER_ID);
    expect(afterUnion?.knowledge?.collectionIds).toContain('only-extra-col'); // additive: not clobbered
    expect(afterUnion?.knowledge?.collectionIds).toContain(managed);          // managed re-added
  });
});

describe('KickBot KB grounding (ADR 0442 P3 — challenge content + guidance)', () => {
  it('flattenChallenge is deterministic day-ordered text', () => {
    const text = flattenChallenge({
      tenantId: T, id: 'c1', version: 1, status: 'published', title: 'Sleep', summary: 's', outcome: 'o',
      durationDays: 2, contentHash: 'h', publishedAt: 'now', createdAt: 'now',
      activities: [
        { stableActivityId: 'b', day: 2, title: 'Night 2', instructions: 'Sleep well again', evidencePolicy: 'attestation' },
        { stableActivityId: 'a', day: 1, title: 'Night 1', instructions: 'Sleep well', evidencePolicy: 'attestation' },
      ],
    });
    expect(text).toContain('Challenge: Sleep');
    expect(text.indexOf('Day 1')).toBeLessThan(text.indexOf('Day 2')); // day-ordered
  });

  it('provisioning ingests guidance; publish adds a challenge doc; retire removes it', async () => {
    const pub = await publishSample(T, 'Hydration'); // published BEFORE provisioning
    await ensureKickBot(T);
    const afterProvision = await kbCollection(T);
    expect(afterProvision, 'the managed KickBot collection exists').toBeDefined();
    // guidance doc + the pre-published challenge were backfilled.
    expect(afterProvision!.documentCount).toBeGreaterThanOrEqual(2);

    // A challenge published AFTER provisioning rides the publish hook.
    await publishSample(T, 'Focus');
    const afterPublish = await kbCollection(T);
    expect(afterPublish!.documentCount).toBeGreaterThan(afterProvision!.documentCount);

    // Retiring a challenge drops its doc (never cite a retired plan).
    await retireChallenge(T, pub.id, pub.version);
    const afterRetire = await kbCollection(T);
    expect(afterRetire!.documentCount).toBeLessThan(afterPublish!.documentCount);
  });

  it('publishing in a tenant that never provisions KickBot creates NO orphan collection', async () => {
    await publishSample(T, 'Orphanless'); // no ensureKickBot in this test
    // sync-into-existing-only: nothing to sync into ⇒ no collection is created.
    expect(await kbCollection(T)).toBeUndefined();
  });
});

describe('KickBot teardown (ADR 0442 P3 — no orphan, participant memory survives)', () => {
  it('deleting KickBot drops its KB collection but the participant own memory survives', async () => {
    await ensureKickBot(T);
    await publishSample(T, 'Momentum');
    await addSubjectNote(T, personSubject('alice'), 'Alice mentor is Zephyrine.');
    expect(await kbCollection(T)).toBeDefined();

    await deleteRosterMemberCascade(T, storage, KICKBOT_ROSTER_ID);

    // KickBot-OWNED state is gone: profile + KB collection (no orphan).
    expect(await getAgentProfile(T, KICKBOT_ROSTER_ID)).toBeNull();
    expect(await kbCollection(T)).toBeUndefined();
    // The PARTICIPANT own memory is NOT KickBot's to delete — it must survive.
    const aliceNotes = await listSubjectNotes(T, personSubject('alice'));
    expect(aliceNotes.some((n) => n.content.includes('Zephyrine'))).toBe(true);
  });
});
