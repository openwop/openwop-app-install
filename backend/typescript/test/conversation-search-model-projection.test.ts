/**
 * ADR 0685 D1 (`CSWF-2`, upgraded from the instance to its generator) — the conversation-search
 * agent tool projects an EXPLICIT allowlist, so the engine's internal shape is no longer the
 * model-facing contract by default.
 *
 * Born red: `agentTools.ts` returned `JSON.stringify({ hits })` — the engine's `SearchHit`
 * verbatim. `matchedAt` was declared, populated, typed on the FE client and read by NOTHING
 * (zero consumers repo-wide), so it shipped to every model calling the tool as an undocumented
 * timestamp. Removing that one field would have left the NEXT internal field to reach a model
 * silently, which is why the fix is the allowlist rather than the deletion.
 *
 * Asserted on the tool's OUTPUT (wave 24 correction): the previous legs grepped `agentTools.ts`
 * source, and a `...h` spread inside the projection — re-leaking every engine field, `matchedAt`
 * included — kept every one of them green. Breaks if: the projection re-serializes the engine hit
 * (spread / `JSON.stringify({ hits })`) or names any key outside the allowlist (probes
 * w24g1-proj-*).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { builtinAgentTool } from '../src/host/agentToolProvider.js';
import { registerConversationSearchAgentTools, CONVERSATIONS_SEARCH_TOOL_ID } from '../src/features/conversation-search/agentTools.js';

const T = 't-search-projection';

/** The keys a model may see. Adding one here is the deliberate edit the ADR asks for. */
const MODEL_FACING_KEYS = ['conversationId', 'title', 'type', 'messageId', 'snippet', 'score', 'role'];

let storage: Storage;

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-convsearch-proj-')) });
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  registerConversationSearchAgentTools(storage);
  const now = new Date().toISOString();
  // Unowned (no conversation meta) ⇒ tenant-visible under the ADR 0043 predicate.
  await storage.createChatSession({ sessionId: 'c-proj', tenantId: T, title: 'Projection', createdAt: now, updatedAt: now, messageCount: 0 });
  await storage.appendChatMessage({
    messageId: 'c-proj-m0', sessionId: 'c-proj', role: 'user', content: 'where is the wombat report',
    meta: null, authorSubject: null, createdAt: now,
  });
});

describe('ADR 0685 D1 — the tool projects an allowlist, not the engine shape', () => {
  it('leg 1-3: the tool OUTPUT carries exactly the allowlisted keys — matchedAt reaches no model', async () => {
    const tool = builtinAgentTool(CONVERSATIONS_SEARCH_TOOL_ID);
    expect(tool, 'the feature registers the tool').toBeDefined();
    const res = await tool!.run({ query: 'wombat' }, { tenantId: T, runId: 'run-proj', actingUserId: 'u-proj' });
    const out = JSON.parse(res.content) as { hits: Array<Record<string, unknown>> };

    expect(out.hits, 'non-vacuous: the seeded message is found').toHaveLength(1);
    const hit = out.hits[0]!;
    // The engine populates matchedAt for this hit; the projection must drop it.
    expect('matchedAt' in hit, 'matchedAt must not reach the model').toBe(false);
    // Exactly the allowlist — every optional key is present for a message hit.
    expect(Object.keys(hit).sort()).toEqual([...MODEL_FACING_KEYS].sort());
    expect(hit.conversationId).toBe('c-proj');
    expect(hit.messageId).toBe('c-proj-m0');
  });
});
