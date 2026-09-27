/**
 * Phase 8 "demo-agent-depth" (app-seeding-strategy.md §4, ADR 0031).
 *
 * The 10 seeded personas ship EMPLOYABLE: memories + a bound knowledge collection
 * (auto-activating the knowledge capability), keyed by rosterId, seeded
 * idempotently and heal-aware. The demo NO LONGER seeds a kickoff AI-chat thread
 * (it polluted each agent's real chat history) — this test asserts none is
 * created (ADR 0321 addendum).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { seedExampleAgents, clearExampleAgents } from '../src/host/exampleDataSeed.js';
import { listRoster } from '../src/host/rosterService.js';
import { rosterSubject } from '../src/host/subject.js';
import { countSubjectNotes } from '../src/host/subjectMemory.js';
import { getAgentKnowledge } from '../src/features/agent-knowledge/service.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js'; // ADR 0643 R4 Blocker 2 — `getAgentKnowledge` takes a REQUIRED caller; a test reading its own unbound seed spells the bypass

let storage: Awaited<ReturnType<typeof openStorage>>;
beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-agent-depth-')) });
});

describe('demo-agent-depth', () => {
  it('seeds memories + knowledge per persona (NO kickoff chat); heal is idempotent', async () => {
    const tenantId = 'agent-depth-t1';
    await seedExampleAgents(tenantId, storage, { heal: true, skipWorkforces: true });

    const roster = await listRoster(tenantId);
    expect(roster.length).toBeGreaterThanOrEqual(10);

    // Every worker persona has memories + a knowledge collection — and NO seeded
    // kickoff chat thread (the demo no longer fabricates sample AI-chat history).
    let personasWithMemories = 0;
    let personasWithKnowledge = 0;
    for (const entry of roster) {
      const notes = await countSubjectNotes(tenantId, rosterSubject(entry.rosterId));
      if (notes > 0) personasWithMemories += 1;
      expect(notes).toBeLessThanOrEqual(200); // NOTE_CAP

      const kn = await getAgentKnowledge(tenantId, entry.rosterId, PREAUTHORIZED_CALLER).catch(() => null);
      if (kn?.knowledgeEnabled && (kn.collections?.length ?? 0) > 0 && kn.collections.some((c) => (c.documents?.length ?? 0) >= 3)) personasWithKnowledge += 1;

      // No kickoff chat session is created for any persona.
      expect(await hostExtStorage().getChatSession(tenantId, `demo-kickoff:${entry.rosterId}`)).toBeNull();
    }
    expect(personasWithMemories).toBeGreaterThanOrEqual(10);
    expect(personasWithKnowledge).toBeGreaterThanOrEqual(10);

    // Capture depth counts, then heal again — nothing should be duplicated.
    const sample = roster[0]!;
    const notesBefore = await countSubjectNotes(tenantId, rosterSubject(sample.rosterId));
    const knBefore = await getAgentKnowledge(tenantId, sample.rosterId, PREAUTHORIZED_CALLER);
    const docsBefore = knBefore.collections.reduce((n, c) => n + (c.documents?.length ?? 0), 0);

    await seedExampleAgents(tenantId, storage, { heal: true, skipWorkforces: true });

    expect(await countSubjectNotes(tenantId, rosterSubject(sample.rosterId))).toBe(notesBefore);
    const knAfter = await getAgentKnowledge(tenantId, sample.rosterId, PREAUTHORIZED_CALLER);
    expect(knAfter.collections.reduce((n, c) => n + (c.documents?.length ?? 0), 0)).toBe(docsBefore);
  });

  it('clearExampleAgents sweeps orphaned demo-kickoff chat threads (from older seeds)', async () => {
    const tenantId = 'agent-depth-kickoff-orphan';
    const s = hostExtStorage();
    const now = new Date().toISOString();
    // Simulate a thread left by an older seed that DID create kickoff chats, plus
    // a user's own chat that must survive the sweep.
    await s.createChatSession({ sessionId: 'demo-kickoff:host:some-agent', tenantId, title: 'Kickoff', createdAt: now, updatedAt: now, messageCount: 0 });
    await s.createChatSession({ sessionId: 'user-chat-keepme', tenantId, title: 'My chat', createdAt: now, updatedAt: now, messageCount: 0 });

    await clearExampleAgents(tenantId, storage);

    expect(await s.getChatSession(tenantId, 'demo-kickoff:host:some-agent')).toBeNull();
    expect(await s.getChatSession(tenantId, 'user-chat-keepme')).not.toBeNull();
  });
});
