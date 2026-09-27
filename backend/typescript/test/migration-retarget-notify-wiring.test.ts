/**
 * ADR 0498 DATA-1 — the WIRING half.
 *
 * ADR 0502's lesson, paid for in production: a mechanism and its wiring fail
 * independently, so they need separate tests. `migration-retarget-notify.test.ts`
 * proves the surgical edit; nothing there would notice if `APP_MIGRATIONS` never
 * listed version 15, listed it with the wrong version, or called a different
 * function — the helper would be perfect and never run.
 *
 * This file exercises the REAL `APP_MIGRATIONS` array through the REAL
 * `runAppMigrations`, and then the real loader/registry end to end.
 */
import { describe, expect, it, vi } from 'vitest';
import { APP_MIGRATIONS, latestAppMigration, runAppMigrations, APP_MIGRATION_KEY } from '../src/host/appMigrations.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';

const MIGRATION_NAME = 'retarget-seeded-notification-push';
const NOTIFY = 'feature.notifications.nodes.notify';
const RETIRED = 'core.openwop.integration.notification-push';

describe('migration 15 is actually registered', () => {
  it('exists in the real array, at a contiguous version, with a run function', () => {
    const m = APP_MIGRATIONS.find((x) => x.name === MIGRATION_NAME);
    expect(m, `no migration named \`${MIGRATION_NAME}\` — the helper would never run`).toBeDefined();
    expect(m!.version).toBe(15);
    expect(typeof m!.run).toBe('function');
    // Contiguity: a gap or a duplicate silently skips or double-runs work.
    const versions = APP_MIGRATIONS.map((x) => x.version).sort((a, b) => a - b);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
    // `>=`, not `===`. This asserted `latestAppMigration() === 15`, which is a
    // SNAPSHOT of the array's length rather than a fact about migration 15 — it
    // fails every time anyone appends a migration, and the fix is always to bump
    // a number, which trains people to edit assertions instead of reading them.
    // What this test is FOR is that migration 15 is wired and reachable; that it
    // is the newest is not its business, and contiguity above already catches a
    // gap or duplicate. (Bumped when PHBC-5 added version 16.)
    expect(latestAppMigration()).toBeGreaterThanOrEqual(15);
  });

  it('is reached by runAppMigrations on an install sitting at version 14', async () => {
    const storage = await openStorage('memory://');
    // The real boot order (`index.ts:183`) — migrations read host-ext collections.
    initHostExtPersistence(storage);
    await storage.setAppMeta(APP_MIGRATION_KEY, '14');
    const seen: number[] = [];
    const spy = APP_MIGRATIONS.find((x) => x.version === 15);
    expect(spy, 'migration 15 is missing — the assertion below would throw a TypeError instead of naming the fault').toBeDefined();
    const original = spy!.run;
    const patched = vi.fn(async (s: Storage) => { seen.push(15); await original(s); });
    // Temporarily swap in a recorder, then restore — the array is module state
    // other suites share.
    Object.defineProperty(spy!, 'run', { value: patched, configurable: true, writable: true });
    try {
      await runAppMigrations(storage);
    } finally {
      Object.defineProperty(spy!, 'run', { value: original, configurable: true, writable: true });
    }
    expect(seen, 'migration 15 was never invoked from version 14').toEqual([15]);
  });
});

describe('end-to-end through the REAL loader, registry and revision store', () => {
  it('repairs a definition that looks exactly like an old tenant\'s', async () => {
    // The mocked suite drives the branches through a stub `expandChain`; this one
    // proves the repair against real packs, real expansion and the real registry.
    // Without it, "the mock agrees with itself" would be the whole coverage.
    const storage = await openStorage('memory://');
    initHostExtPersistence(storage);
    const { listChains, loadWorkflowChainPacks, defaultWorkflowChainPackRoots, expandChain, _resetChainRegistryForTest } =
      await import('../src/host/workflowChainPackLoader.js');
    const { registerWorkflowDurable, getRegisteredWorkflowAsync } = await import('../src/host/workflowsRegistry.js');
    const { seedWorkflowId } = await import('../src/host/seedWorkflows.js');
    _resetChainRegistryForTest();
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });

    // A real, currently-seedable chain that carries a notify node.
    const entry = listChains().find(({ chain }) => {
      if (chain.internal === true) return false;
      const required = (chain.parameters as { required?: unknown } | undefined)?.required;
      if (Array.isArray(required) && required.length > 0) return false;
      try {
        return (expandChain(chain, { deferred: true }).nodes ?? [])
          .some((n) => n.typeId === NOTIFY);
      } catch { return false; }
    });
    expect(entry, 'no zero-config chain carries a notify node — the test would be vacuous').toBeDefined();
    const chain = entry!.chain;

    // Reconstruct what a pre-retarget tenant actually holds: the SAME expansion,
    // with the notify node reverted to the retired type and empty config/inputs
    // (all 55 shipped that way), plus metadata only a tenant would have.
    const expanded = expandChain(chain, { deferred: true });
    const workflowId = seedWorkflowId(chain.chainId);
    const notifyNodeId = expanded.nodes.find((n) => n.typeId === NOTIFY)!.nodeId;
    await registerWorkflowDurable({
      ...expanded,
      workflowId,
      nodes: expanded.nodes.map((n) => (n.typeId === NOTIFY
        ? { ...n, typeId: RETIRED, config: {}, inputs: {} }
        : n)),
      metadata: { ...expanded.metadata, name: 'Tenant renamed this', requiresAgentId: 'agent-42' },
    });

    const m = APP_MIGRATIONS.find((x) => x.version === 15);
    expect(m, 'migration 15 is missing').toBeDefined();
    await m!.run(storage);

    const after = await getRegisteredWorkflowAsync(workflowId);
    const repaired = after!.nodes.find((n) => n.nodeId === notifyNodeId);
    expect(repaired, 'the node id changed — replay would lose its checkpoints').toBeDefined();
    expect(repaired!.typeId).toBe(NOTIFY);
    expect(repaired!.config).toHaveProperty('audience');
    expect(after!.nodes).toHaveLength(expanded.nodes.length);
    // The two metadata keys a wholesale rebuild would have destroyed.
    expect(after!.metadata?.name).toBe('Tenant renamed this');
    expect(after!.metadata?.requiresAgentId).toBe('agent-42');
  });
});
