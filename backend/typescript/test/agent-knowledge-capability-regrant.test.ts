/**
 * ADR 0664 D4 — a privacy action must not re-grant the capability it narrows.
 *
 * Born red on `ff6ad89e1`: `setAgentKnowledge` unioned `knowledge` onto the profile on
 * EVERY write, so ADR 0373's `DELETE …/capabilities/knowledge` was undone by the next
 * unbind, by `setMemoryWritable(false)` — a privacy action restoring the very capability it
 * was exercised to remove — and even by a plain read, because the dangling-binding self-heal
 * (`agent-knowledge/service.ts:160`) is a durable write on a GET.
 *
 * The fourth case is the one that shaped the fix: a KickBot seed with KB unavailable carries
 * no `collectionIds`, so a rule that inferred the answer from the patch shape would leave it
 * without the capability — and `resolveAgentKnowledgeRetrieve` fails closed, so memory recall
 * would go dead silently. A seed is a grant; an unbind is not. Only the caller knows which.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createRosterEntry } from '../src/host/rosterService.js';
import {
  setAgentKnowledge, getAgentProfile, upsertAgentProfile,
  deactivateAgentCapability, __resetAgentProfileStore,
} from '../src/host/agentProfileService.js';

const INIT = { roleKey: 'kb-agent', autonomy: { specLevel: 'recommend' as const } };
let tenantId: string;
let agentId: string;

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'adr0664-')) });
  await __resetAgentProfileStore();
  tenantId = `t-adr0664-d4-${Math.random().toString(16).slice(2)}`;
  const roster = await createRosterEntry({ tenantId, persona: `Regrant probe ${Math.random().toString(16).slice(2)}`, agentRef: { agentId: 'agent:regrant' }, roleKey: 'kb-agent' });
  agentId = roster.rosterId;
  await upsertAgentProfile(tenantId, agentId, { ...INIT, capabilities: ['knowledge'] } as never);
});

const capabilities = async (): Promise<string[]> => [...((await getAgentProfile(tenantId, agentId))?.capabilities ?? [])];

describe('ADR 0664 D4 — a revoked capability stays revoked', () => {
  it('non-vacuity: the capability is present, and revoking it actually removes it', async () => {
    expect(await capabilities()).toContain('knowledge');
    await deactivateAgentCapability(tenantId, agentId, 'knowledge');
    expect(await capabilities(), 'if this failed, every leg below would be vacuous').not.toContain('knowledge');
  });

  it('setMemoryWritable(false) — a PRIVACY action — does not re-grant it', async () => {
    await deactivateAgentCapability(tenantId, agentId, 'knowledge');
    await setAgentKnowledge(tenantId, agentId, { memoryWritable: false }, INIT, { activateCapability: false });
    expect(await capabilities()).not.toContain('knowledge');
  });

  it('an unbind does not re-grant it', async () => {
    await deactivateAgentCapability(tenantId, agentId, 'knowledge');
    await setAgentKnowledge(tenantId, agentId, { collectionIds: [] }, INIT, { activateCapability: false });
    expect(await capabilities()).not.toContain('knowledge');
  });

  it('the dangling-binding self-heal — a durable write on a READ — does not re-grant it', async () => {
    await deactivateAgentCapability(tenantId, agentId, 'knowledge');
    // The shape `getAgentKnowledge`'s prune performs: rewrite the surviving ids.
    await setAgentKnowledge(tenantId, agentId, { collectionIds: ['col-still-live'] }, INIT, { activateCapability: false });
    expect(await capabilities(), 'merely reading the panel must not restore a revoked capability').not.toContain('knowledge');
  });

  it('a BIND still grants it — the fix must not become a blanket refusal', async () => {
    await deactivateAgentCapability(tenantId, agentId, 'knowledge');
    await setAgentKnowledge(tenantId, agentId, { collectionIds: ['col-a'] }, INIT, { activateCapability: true });
    expect(await capabilities()).toContain('knowledge');
  });

  it('a SEED with no collectionIds still grants it (the KickBot-with-KB-unavailable path)', async () => {
    await deactivateAgentCapability(tenantId, agentId, 'knowledge');
    // Exactly kickbotService.ts's patch when `ensureKickbotKnowledge` returns null.
    await setAgentKnowledge(tenantId, agentId, { retrieval: { sources: ['kb', 'memory'] } }, INIT, { activateCapability: true });
    expect(await capabilities(), 'a patch-shape rule would have left KickBot without recall, silently').toContain('knowledge');
  });
});
