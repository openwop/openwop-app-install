/**
 * Zero-config workflow seed idempotency (2026-07-16) — the fix for the
 * workflow-screen "X, X-2, X-3" duplication.
 *
 * The old silent frontend preload POSTed /workflows/from-chain (RANDOM id) on
 * every fresh client, so re-runs duplicated. The seed now owns this with a
 * DETERMINISTIC id, so a re-seed upserts the SAME owned row — never a copy.
 * The duplication claim is carried by COUNTS (seeded == population; a re-seed
 * seeds 0 and leaves the owned count unchanged).
 *
 * The mint itself (`seedWorkflowId` is a pure function of the chainId) is owned
 * by `workflow-id-grammar.test.ts` "every origin in the closed set has a mint,
 * and every mint is in the grammar"; the case that duplicated it here was cut
 * (grade-tests 8f w2: probes id-mint and id-mint-cover reddened both).
 * Sabotage witnesses: id-count, id-internal, id-zeroconfig.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { loadWorkflowChainPacks, listChains, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { seedZeroConfigWorkflows } from '../src/host/seedWorkflows.js';
import { listOwned } from '../src/host/workflowOwnership.js';
import type { Storage } from '../src/storage/storage.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const CHAIN_PACK_ROOT = join(REPO_ROOT, 'examples', 'workflow-chain-packs');

let storage: Storage;

/** The seeder's own population, counted from the CURRENT registry: zero-config
 *  AND not RFC 0135 `internal` (the ADR 0788 D3 MCP projection chains are
 *  internal and zero-config). */
function zeroConfigCount(): number {
  return listChains().filter(({ chain }) => chain.internal !== true).filter(
    ({ chain }) => !Array.isArray((chain.parameters as { required?: unknown }).required)
      || ((chain.parameters as { required?: string[] }).required ?? []).length === 0,
  ).length;
}

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  _resetChainRegistryForTest();
  loadWorkflowChainPacks({ roots: [CHAIN_PACK_ROOT] });
});
beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(storage); });

describe('seedZeroConfigWorkflows', () => {
  it('seeds every zero-config chain as an owned workflow with a deterministic id', async () => {
    const population = zeroConfigCount();
    expect(population, 'the chain packs must include ≥1 zero-config chain to make this test meaningful').toBeGreaterThan(0);
    const TENANT = 'user:seed1';
    const res = await seedZeroConfigWorkflows(TENANT);
    expect(res.seeded).toBe(population);

    const owned = await listOwned(TENANT);
    expect(owned.length).toBe(population);
    // Every id is the deterministic seed id — no random suffix.
    for (const row of owned) expect(row.workflowId).toMatch(/^wf\.seed\./);
  });

  it('is IDEMPOTENT — re-seeding does NOT create duplicates', async () => {
    const TENANT = 'user:seed2';
    await seedZeroConfigWorkflows(TENANT);
    const afterFirst = (await listOwned(TENANT)).length;
    const res2 = await seedZeroConfigWorkflows(TENANT);
    expect(res2.seeded, 'a re-seed creates nothing new').toBe(0);
    expect((await listOwned(TENANT)).length, 'the owned count is unchanged after a re-seed').toBe(afterFirst);
  });

});

// RFC 0135 — a zero-config chain marked `internal: true` (a composition-only
// fragment) is NEVER seeded as a directly-runnable owned workflow. No shipped
// pack has a zero-config internal chain, so this leg witnesses the guard with a
// synthetic pack through the REAL loader. It repoints the chain registry at the
// synthetic root, so it restores the shipped registry in `finally` (shuffle-safe).
describe('seedZeroConfigWorkflows — RFC 0135 internal guard', () => {
  it('skips a zero-config internal chain and seeds its non-internal sibling', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'owp-seed-internal-'));
    mkdirSync(join(root, 'pack'));
    const chain = (chainId: string, internal: boolean) => ({
      chainId, version: '1.0.0', label: chainId, description: 'seed-guard fixture', ...(internal ? { internal: true } : {}),
      parameters: {}, dag: { nodes: [{ id: 'n1', typeId: 'core.noop', config: {} }] },
    });
    writeFileSync(join(root, 'pack', 'pack.json'), JSON.stringify({
      name: 'core.openwop.seedguard', version: '1.0.0', kind: 'workflow-chain', engines: { openwop: '^1' },
      chains: [chain('seedguard.public', false), chain('seedguard.child', true)],
    }, null, 2));
    try {
      _resetChainRegistryForTest();
      // ADR 0766 — the subject here is the RFC 0135 internal guard, not pins; the
      // synthetic pack is waived rather than pinned so it keeps its v1 shape.
      const { __setUnpinnedChainPackWaiversForTests } = await import('../src/host/unpinnedChainPackAllowlist.js');
      __setUnpinnedChainPackWaiversForTests(['core.openwop.seedguard']);
      const { errors } = loadWorkflowChainPacks({ roots: [root] });
      __setUnpinnedChainPackWaiversForTests(null);
      expect(errors).toEqual([]);

      const TENANT = 'user:seed-internal';
      await seedZeroConfigWorkflows(TENANT);
      const ownedIds = (await listOwned(TENANT)).map((r) => r.workflowId);
      // Literal ids (never minted by the function under test).
      expect(ownedIds).toContain('wf.seed.seedguard-public');
      expect(ownedIds).not.toContain('wf.seed.seedguard-child');
    } finally {
      _resetChainRegistryForTest();
      loadWorkflowChainPacks({ roots: [CHAIN_PACK_ROOT] });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
