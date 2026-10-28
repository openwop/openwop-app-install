/**
 * Feature loop row 63 — conversation-search privacy and correctness probes.
 *
 * Each case is a defect the round-2 baseline found in the derived-index design
 * (ADR 0112 Phase 1), stated as the behaviour search must have:
 *
 * - CSP-1 A deleted message's text must not come back after the process that
 *   indexed it is gone. The index lives on the `db.search` host surface, which
 *   is DURABLE in prod (`OPENWOP_SURFACE_BACKEND=durable`), while the list of
 *   ids to clean up lived in process memory. A restart, or a second instance,
 *   could never delete the stale doc, and the snippet came from the doc.
 * - CSP-2 The same for a DSAR erasure (`redactChatMessagesByAuthor`).
 * - CSP-3 Private message text must not be readable through the generic
 *   tenant `db.search` surface a workflow run gets (`core.db.search-query`).
 * - CSP-4 Another member's matching messages must not crowd the caller's own
 *   hit out of the results (the old query took the tenant-wide top k, then
 *   filtered to the caller's conversations).
 *
 * `__resetProcessState` stands in for a restart: it drops what one process
 * holds, and leaves storage and host surfaces as they are.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces, buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { ensureConversationMeta } from '../src/host/conversationStore.js';
import type { Storage } from '../src/storage/storage.js';
import * as engine from '../src/features/conversation-search/searchEngine.js';

const TENANT = 't-search-privacy';
let storage: Storage;

/** The caller's hits — the result shape `searchVisibleConversations` has on the
 *  current engine (`{ hits }`) or had on the old one (an array). */
async function find(user: string, q: string, limit?: number): Promise<Array<{ conversationId: string; snippet: string }>> {
  const r = (await engine.searchVisibleConversations(storage, TENANT, user, q, limit ? { limit } : undefined)) as unknown;
  return (Array.isArray(r) ? r : (r as { hits: Array<{ conversationId: string; snippet: string }> }).hits);
}

/** Simulates a process restart where the engine still keeps per-process state. */
function restart(): void {
  const e = engine as unknown as Record<string, unknown>;
  for (const name of ['__resetSearchEngine', '__resetProcessState']) {
    const fn = e[name];
    if (typeof fn === 'function') (fn as () => void)();
  }
}

async function seed(conversationId: string, owner: string, msgs: Array<{ id: string; content: string; author?: string }>): Promise<void> {
  const now = new Date().toISOString();
  await storage.createChatSession({ sessionId: conversationId, tenantId: TENANT, title: `Thread ${conversationId.length}`, createdAt: now, updatedAt: now, messageCount: 0 });
  await ensureConversationMeta(TENANT, conversationId, { type: 'agent', ownerUserId: owner });
  let i = 0;
  for (const m of msgs) {
    await storage.appendChatMessage({
      messageId: m.id, sessionId: conversationId, role: 'user', content: m.content, meta: null,
      authorSubject: m.author ?? null, createdAt: new Date(Date.now() + i++ * 1000).toISOString(),
    });
  }
}

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-convsearch-privacy-')) });
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('conversation search privacy (row 63)', () => {
  it('CSP-1: a deleted message stays unsearchable after a restart', async () => {
    await seed('c-del', 'u-a', [{ id: 'c-del-m0', content: 'the launch codeword is marmalade' }]);
    // Positive control: the message is found while it exists.
    expect((await find('u-a', 'marmalade')).map((h) => h.conversationId)).toEqual(['c-del']);

    // The delete route's exact storage writes (routes/chatSessions.ts DELETE …/messages/:id).
    await storage.updateChatMessageContent('c-del', 'c-del-m0', '{"deleted":true}', JSON.stringify({ deletedAt: new Date().toISOString() }));
    await storage.updateChatSession(TENANT, 'c-del', { updatedAt: new Date(Date.now() + 60_000).toISOString() });
    restart();

    const hits = await find('u-a', 'marmalade');
    expect(hits, 'deleted text must not be returned as a snippet').toEqual([]);
  });

  it('CSP-2: a DSAR-erased message stays unsearchable after a restart', async () => {
    await seed('c-dsar', 'u-a', [
      { id: 'c-dsar-m0', content: 'my home address is 12 quince lane', author: 'user:u-erased' },
      { id: 'c-dsar-m1', content: 'noted', author: 'user:u-a' },
    ]);
    expect((await find('u-a', 'quince')).length).toBe(1);

    await storage.redactChatMessagesByAuthor(TENANT, ['user:u-erased'], 'user:__erased__', new Date(Date.now() + 120_000).toISOString());
    restart();

    expect(await find('u-a', 'quince')).toEqual([]);
  });

  it('CSP-3: private message text is not readable through the run-scoped db.search surface', async () => {
    await seed('c-private-dm', 'u-a', [{ id: 'c-private-dm-m0', content: 'salary negotiation target is zeppelin' }]);
    // Member A searches their own conversations (positive control).
    expect((await find('u-a', 'zeppelin')).length).toBe(1);

    // A workflow run by member B gets this bundle (executor/executor.ts), and
    // `core.db.search-query` delegates straight to `ctx.db.search.query`.
    const runSurface = buildHostSurfaceBundle({ tenantId: TENANT, runId: 'run-member-b', actingUserId: 'u-b' }).db.search;
    for (const index of ['chat-search', 'default']) {
      const res = await runSurface.query({ index, q: 'zeppelin', k: 50 }) as { hits?: Array<{ fields: Record<string, unknown> }> };
      const texts = (res.hits ?? []).map((h) => JSON.stringify(h.fields));
      expect(texts.some((t) => t.includes('zeppelin')), `index ${index} exposes member A's message`).toBe(false);
    }
  });

  it('CSP-5: only the text the person saw is searchable, never envelope internals', async () => {
    // The SPA stores the whole ChatMessage minus id/meta (`encodeMessageForStore`):
    // a run card has empty `content` and carries run state, thoughts and an
    // interrupt resume token beside it.
    const envelope = JSON.stringify({
      role: 'workflow_run', content: '',
      thoughts: 'private reasoning about the walrus',
      workflowRun: { runId: 'r1', interrupt: { resumeToken: 'tok-walrus-capability' } },
    });
    await seed('c-env', 'u-a', [
      { id: 'c-env-m0', content: envelope },
      { id: 'c-env-m1', content: JSON.stringify({ role: 'user', content: 'visible text about otters' }) },
    ]);
    // Positive control: the visible text is found.
    expect((await find('u-a', 'otters')).length).toBe(1);
    for (const q of ['walrus', 'capability', 'workflowRun']) {
      const hits = await find('u-a', q);
      expect(hits, `"${q}" must not match envelope internals`).toEqual([]);
    }
  });

  it("CSP-4: another member's matches do not crowd out the caller's own hit", async () => {
    // Member B has many matching messages, and B's search puts them in any shared index.
    const bMsgs = Array.from({ length: 200 }, (_, i) => ({ id: `c-b-m${i}`, content: 'gazebo gazebo gazebo gazebo' }));
    await seed('c-b', 'u-b', bMsgs);
    expect((await find('u-b', 'gazebo')).length).toBe(1);

    // Member A has one weaker match.
    await seed('c-a-gazebo', 'u-a', [{ id: 'c-a-gazebo-m0', content: 'we should build a gazebo' }]);
    const hits = await find('u-a', 'gazebo', 5);
    expect(hits.map((h) => h.conversationId)).toEqual(['c-a-gazebo']);
  });
});
