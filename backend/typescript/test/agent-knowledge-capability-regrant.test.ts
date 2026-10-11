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
 *
 * Cases 2-5 drive the REAL doors (`setMemoryWritable`, `unbindCollection`, the
 * `getAgentKnowledge` prune, `bindCollection`), not `setAgentKnowledge` with a flag the test
 * chose — the flag at each call site IS the decision, and grade-tests w11 found that flipping
 * it at `service.ts` could not turn the mechanism-level cases red. Case 6 stays
 * mechanism-level: the KickBot seed (`kickbotService.ts`) is too heavy to boot here.
 *
 * Sabotage that turns this red (w11 probes): ignoring `activateCapability` in
 * `setAgentKnowledge` (cases 2-4); never granting (5, 6); a patch-shape rule (4, 6); flipping
 * a door's flag at `service.ts` (that door's case); a no-op `deactivateAgentCapability` (1).
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
import {
  setMemoryWritable, unbindCollection, getAgentKnowledge, bindCollection,
} from '../src/features/agent-knowledge/service.js';
import { createCollection } from '../src/features/kb/kbService.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';

const INIT = { roleKey: 'kb-agent', autonomy: { specLevel: 'recommend' as const } };
let tenantId: string;
let agentId: string;
let n = 0;

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'adr0664-')) });
  await __resetAgentProfileStore();
  n += 1;
  tenantId = `t-adr0664-d4-${n}`;
  const roster = await createRosterEntry({ tenantId, persona: `Regrant probe ${n}`, agentRef: { agentId: 'agent:regrant' }, roleKey: 'kb-agent' });
  agentId = roster.rosterId;
  await upsertAgentProfile(tenantId, agentId, { ...INIT, capabilities: ['knowledge'] });
});

const capabilities = async (): Promise<string[]> => [...((await getAgentProfile(tenantId, agentId))?.capabilities ?? [])];
const boundIds = async (): Promise<string[]> => [...((await getAgentProfile(tenantId, agentId))?.knowledge?.collectionIds ?? [])];
/** Re-seed the profile with a binding, keeping the capability granted. */
const seedBinding = async (collectionIds: string[]): Promise<void> => {
  await upsertAgentProfile(tenantId, agentId, { ...INIT, capabilities: ['knowledge'], knowledge: { collectionIds } });
};

describe('ADR 0664 D4 — a revoked capability stays revoked', () => {
  it('non-vacuity: the capability is present, and revoking it actually removes it', async () => {
    expect(await capabilities()).toContain('knowledge');
    await deactivateAgentCapability(tenantId, agentId, 'knowledge');
    expect(await capabilities(), 'if this failed, every leg below would be vacuous').not.toContain('knowledge');
  });

  it('setMemoryWritable(false) — a PRIVACY action — does not re-grant it', async () => {
    await deactivateAgentCapability(tenantId, agentId, 'knowledge');
    await setMemoryWritable(tenantId, agentId, false);
    expect(await capabilities()).not.toContain('knowledge');
  });

  it('an unbind does not re-grant it', async () => {
    await seedBinding(['col-a']);
    await deactivateAgentCapability(tenantId, agentId, 'knowledge');
    await unbindCollection(tenantId, agentId, 'col-a');
    expect(await boundIds(), 'the unbind must actually have written, or this case proves nothing').toEqual([]);
    expect(await capabilities()).not.toContain('knowledge');
  });

  it('the dangling-binding self-heal — a durable write on a READ — does not re-grant it', async () => {
    const live = await createCollection(tenantId, 'org-d4', 'sys', { name: 'Live' });
    await seedBinding([live.collectionId, 'col-dangling']);
    await deactivateAgentCapability(tenantId, agentId, 'knowledge');
    await getAgentKnowledge(tenantId, agentId, PREAUTHORIZED_CALLER);
    // The prune ran (the dangling id is gone) — so the read DID write, and still did not re-grant.
    expect(await boundIds()).toEqual([live.collectionId]);
    expect(await capabilities(), 'merely reading the panel must not restore a revoked capability').not.toContain('knowledge');
  });

  it('a BIND still grants it — the fix must not become a blanket refusal', async () => {
    const col = await createCollection(tenantId, 'org-d4', 'sys', { name: 'Bind target' });
    await deactivateAgentCapability(tenantId, agentId, 'knowledge');
    await bindCollection(tenantId, agentId, col.collectionId, PREAUTHORIZED_CALLER, 'preauthorized');
    expect(await boundIds()).toEqual([col.collectionId]);
    expect(await capabilities()).toContain('knowledge');
  });

  it('a SEED with no collectionIds still grants it (the KickBot-with-KB-unavailable path)', async () => {
    await deactivateAgentCapability(tenantId, agentId, 'knowledge');
    // Exactly kickbotService.ts's patch when `ensureKickbotKnowledge` returns null.
    await setAgentKnowledge(tenantId, agentId, { retrieval: { sources: ['kb', 'memory'] } }, INIT, { activateCapability: true });
    expect(await capabilities(), 'a patch-shape rule would have left KickBot without recall, silently').toContain('knowledge');
  });
});
