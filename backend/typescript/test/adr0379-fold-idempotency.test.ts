/**
 * ADR 0379 Phase 4 — the fold-idempotency invariant, structural + test-pinned:
 * a folded tenant adds NOTHING the target already has.
 *
 * New-scheme rows (`user.<slug>` chat agents, `host:<slug>` roster ids) share
 * per-persona id VALUES across tenants, so the anon→user adopt fold
 * (dedupePersonasBeforeAdopt → reassignTenant) must collapse same-persona rows
 * instead of duplicating (the GEN-2a/2b root cure) — and the DEDUP MUST RUN
 * FIRST: without it the blanket `UPDATE tenant_id` fold would hit the
 * composite-PK conflict for a shared agent_id (pinned below, so nobody
 * "simplifies" the ordered pair at the one call site in routes/migrate.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { UserAgentRecord } from '../src/types.js';
import { dedupePersonasBeforeAdopt } from '../src/host/adoptDedup.js';
import { createRosterEntry, listRoster, __resetRosterStore } from '../src/host/rosterService.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';

const AGENT = (tenantId: string, slug: string, persona: string): UserAgentRecord => ({
  agentId: `user.${slug}`, // the Phase-2 persona-scoped scheme
  tenantId,
  persona,
  modelClass: 'chat',
  systemPrompt: 'x',
  toolAllowlist: [],
  memoryShape: { scratchpad: false, conversation: false, longTerm: false },
  createdAt: new Date().toISOString(),
});

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});
afterEach(async () => {
  await __resetRosterStore();
  __resetHostExtPersistence();
  await storage.close();
});

describe('ADR 0379 P4 — double-fold idempotency (new-scheme)', () => {
  it('a fold of a same-persona anon tenant adds nothing; a second fold adds nothing', async () => {
    // The user tenant already has Iris (chat agent + roster member).
    await storage.insertUserAgent(AGENT('u-t', 'iris', 'Iris'));
    await createRosterEntry({ tenantId: 'u-t', persona: 'Iris', agentRef: { agentId: 'user.iris' } });

    // Anon tenant #1: the seed gave it the SAME persona (same new-scheme ids)
    // plus one persona the user lacks.
    await storage.insertUserAgent(AGENT('anon:s1', 'iris', 'Iris'));
    await storage.insertUserAgent(AGENT('anon:s1', 'nova', 'Nova'));
    await createRosterEntry({ tenantId: 'anon:s1', persona: 'Iris', agentRef: { agentId: 'user.iris' } });
    await createRosterEntry({ tenantId: 'anon:s1', persona: 'Nova', agentRef: { agentId: 'user.nova' } });

    await dedupePersonasBeforeAdopt('anon:s1', 'u-t', storage);
    await storage.reassignTenant('anon:s1', 'u-t');

    // Exactly one Iris (the target's own), and Nova folded IN (the fold moves
    // only what the target lacks).
    const agents = await storage.listUserAgents('u-t');
    expect(agents.filter((a) => a.persona === 'Iris')).toHaveLength(1);
    expect(agents.filter((a) => a.persona === 'Nova')).toHaveLength(1);
    const roster = await listRoster('u-t');
    expect(roster.filter((e) => e.persona === 'Iris')).toHaveLength(1);
    expect(roster.filter((e) => e.persona === 'Nova')).toHaveLength(1);

    // Anon tenant #2 (a second adopted session with the full same seed).
    await storage.insertUserAgent(AGENT('anon:s2', 'iris', 'Iris'));
    await storage.insertUserAgent(AGENT('anon:s2', 'nova', 'Nova'));
    await createRosterEntry({ tenantId: 'anon:s2', persona: 'Iris', agentRef: { agentId: 'user.iris' } });
    await createRosterEntry({ tenantId: 'anon:s2', persona: 'Nova', agentRef: { agentId: 'user.nova' } });

    await dedupePersonasBeforeAdopt('anon:s2', 'u-t', storage);
    await storage.reassignTenant('anon:s2', 'u-t');

    // The invariant: the double fold added NOTHING.
    expect((await storage.listUserAgents('u-t')).length).toBe(2);
    expect((await listRoster('u-t')).length).toBe(2);
    expect((await storage.listUserAgents('anon:s2')).length).toBe(0); // drained
  });

  it('dedups in the SLUG domain: personas that differ as strings but share a slug still dedup', async () => {
    // Grade-pass regression pin: "Iris-Chen" and "Iris Chen" mint the SAME
    // `user.iris-chen`; a trim/lowercase-only dedup missed the pair and the
    // fold then hit the composite PK — permanently 500ing the adopt.
    await storage.insertUserAgent(AGENT('u-t', 'iris-chen', 'Iris Chen'));
    await storage.insertUserAgent(AGENT('anon:s4', 'iris-chen', 'Iris-Chen'));
    await dedupePersonasBeforeAdopt('anon:s4', 'u-t', storage);
    await storage.reassignTenant('anon:s4', 'u-t'); // must NOT throw
    expect((await storage.listUserAgents('u-t')).filter((a) => a.agentId === 'user.iris-chen')).toHaveLength(1);
  });

  it('pins the ORDER: skipping the dedup makes the fold collide on the composite PK', async () => {
    await storage.insertUserAgent(AGENT('u-t', 'iris', 'Iris'));
    await storage.insertUserAgent(AGENT('anon:s3', 'iris', 'Iris'));
    // No dedup — the blanket tenant UPDATE must hit (u-t, user.iris) already
    // existing. Either the storage layer throws, or (if an adapter ever makes
    // this tolerant) the fold must NOT produce a duplicate. Both outcomes are
    // acceptable; silently duplicating is the one failure mode.
    let threw = false;
    try {
      await storage.reassignTenant('anon:s3', 'u-t');
    } catch {
      threw = true;
    }
    if (!threw) {
      expect((await storage.listUserAgents('u-t')).filter((a) => a.persona === 'Iris')).toHaveLength(1);
    }
    expect(threw || (await storage.listUserAgents('anon:s3')).length === 0).toBe(true);
  });
});
