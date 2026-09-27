/**
 * Zero-config workflow seed idempotency (2026-07-16) — the fix for the
 * workflow-screen "X, X-2, X-3" duplication.
 *
 * The old silent frontend preload POSTed /workflows/from-chain (RANDOM id) on
 * every fresh client, so re-runs duplicated. The seed now owns this with a
 * DETERMINISTIC id, so a re-seed upserts the SAME owned row — never a copy.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { loadWorkflowChainPacks, listChains } from '../src/host/workflowChainPackLoader.js';
import { seedZeroConfigWorkflows, seedWorkflowId } from '../src/host/seedWorkflows.js';
import { listOwned } from '../src/host/workflowOwnership.js';
import type { Storage } from '../src/storage/storage.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const CHAIN_PACK_ROOT = join(REPO_ROOT, 'examples', 'workflow-chain-packs');

let storage: Storage;
let zeroConfigCount = 0;

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  loadWorkflowChainPacks({ roots: [CHAIN_PACK_ROOT] });
  zeroConfigCount = listChains().filter(
    ({ chain }) => !Array.isArray((chain.parameters as { required?: unknown }).required)
      || ((chain.parameters as { required?: string[] }).required ?? []).length === 0,
  ).length;
});
beforeEach(() => { __resetHostExtPersistence(); initHostExtPersistence(storage); });

describe('seedZeroConfigWorkflows', () => {
  it('seeds every zero-config chain as an owned workflow with a deterministic id', async () => {
    expect(zeroConfigCount, 'the chain packs must include ≥1 zero-config chain to make this test meaningful').toBeGreaterThan(0);
    const TENANT = 'user:seed1';
    const res = await seedZeroConfigWorkflows(TENANT);
    expect(res.seeded).toBe(zeroConfigCount);

    const owned = await listOwned(TENANT);
    expect(owned.length).toBe(zeroConfigCount);
    // Every id is the deterministic seed id — no random suffix.
    for (const row of owned) expect(row.workflowId).toMatch(/^wf\.seed\./);
    // No "-2/-3" names (the duplication signature).
    expect(owned.some((r) => /-\d+$/.test(r.name ?? ''))).toBe(false);
  });

  it('is IDEMPOTENT — re-seeding does NOT create duplicates', async () => {
    const TENANT = 'user:seed2';
    await seedZeroConfigWorkflows(TENANT);
    const afterFirst = (await listOwned(TENANT)).length;
    const res2 = await seedZeroConfigWorkflows(TENANT);
    expect(res2.seeded, 'a re-seed creates nothing new').toBe(0);
    expect((await listOwned(TENANT)).length, 'the owned count is unchanged after a re-seed').toBe(afterFirst);
  });

  it('the id is a pure function of the chainId (fold-collision safe)', () => {
    expect(seedWorkflowId('core.foo.bar')).toBe('wf.seed.core-foo-bar');
    expect(seedWorkflowId('core.foo.bar')).toBe(seedWorkflowId('core.foo.bar'));
  });
});

// RFC 0135 — a zero-config chain marked `internal: true` (a composition-only
// fragment) is NEVER seeded as a directly-runnable owned workflow. No shipped
// pack has a zero-config internal chain, so this leg witnesses the guard with a
// synthetic pack through the REAL loader (runs LAST — it repoints the chain
// registry at the synthetic root).
describe('seedZeroConfigWorkflows — RFC 0135 internal guard', () => {
  it('skips a zero-config internal chain and seeds its non-internal sibling', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { _resetChainRegistryForTest } = await import('../src/host/workflowChainPackLoader.js');
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
    _resetChainRegistryForTest();
    const { errors } = loadWorkflowChainPacks({ roots: [root] });
    expect(errors).toEqual([]);

    const TENANT = 'user:seed-internal';
    await seedZeroConfigWorkflows(TENANT);
    const ownedIds = (await listOwned(TENANT)).map((r) => r.workflowId);
    expect(ownedIds).toContain(seedWorkflowId('seedguard.public'));
    expect(ownedIds).not.toContain(seedWorkflowId('seedguard.child'));
  });
});
