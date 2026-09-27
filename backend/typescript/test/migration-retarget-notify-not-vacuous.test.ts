/**
 * ADR 0498 DATA-1 — the retarget migration must not be VACUOUS.
 *
 * Same trap as ADR 0507's re-seed, which this file deliberately mirrors:
 * `runAppMigrations` fires at `index.ts:186`, but the chain registry is not
 * populated until `loadWorkflowChainPacks` at `index.ts:427`. A migration that
 * iterates `listChains()` therefore sees ZERO chains, rewrites nothing, and is
 * still RECORDED as complete — a one-shot migration that silently never runs
 * and can never run again.
 *
 * The companion `migration-retarget-notify.test.ts` mocks the loader to drive
 * the guard's branches; that mock cannot see this failure, because the mock is
 * never empty. This file uses the REAL loader for exactly that reason.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { _resetChainRegistryForTest, listChains } from '../src/host/workflowChainPackLoader.js';
import { retargetSeededNotifyNodes } from '../src/host/seedWorkflows.js';
import type { Storage } from '../src/storage/storage.js';

/** The surgical design needs NO run history, so the migration must never ask for it. */
let listRunsCalls = 0;
const storage = {
  listRuns: async () => {
    listRunsCalls += 1;
    return [];
  },
} as unknown as Storage;

beforeEach(() => {
  // Reproduce migration-time conditions exactly: registry EMPTY, as at index.ts:186.
  _resetChainRegistryForTest();
  listRunsCalls = 0;
});

describe('the retarget migration self-loads the chain registry', () => {
  it('examines a real population even when the registry starts empty', async () => {
    expect(listChains(), 'precondition: the registry must start empty or this proves nothing').toHaveLength(0);
    const result = await retargetSeededNotifyNodes(storage);
    // The assertion that matters. Zero examined = it did nothing and said it succeeded.
    expect(result.examined, 'migration examined no chains — it ran vacuously').toBeGreaterThan(20);
  });

  it('rewrites nothing on a fresh install, and never MINTS a definition', async () => {
    const result = await retargetSeededNotifyNodes(storage);
    expect(result.rewritten).toBe(0);
    expect(result.absent).toBeGreaterThan(20);
  });

  it('never queries run history — preserving node ids is what removed that need', async () => {
    // The first design paged `listRuns` per chain to decide whether a rewrite was
    // safe. The surgical edit keeps node ids, so no run can be disturbed and the
    // scan is gone. A regression to re-expansion would reintroduce this call.
    await retargetSeededNotifyNodes(storage);
    expect(listRunsCalls).toBe(0);
  });

  it('every examined chain is accounted for by exactly one counter', async () => {
    const r = await retargetSeededNotifyNodes(storage);
    expect(r.examined).toBeGreaterThan(20);
    expect(
      r.rewritten + r.skippedUnmatchedNode + r.skippedRefBearingReplacement + r.skippedConcurrentEdit
        + r.absent + r.alreadyClean + r.failed,
      'a chain vanished from the accounting — some path returns without incrementing a counter',
    ).toBe(r.examined);
  });

  it('examines only the population the seeder actually seeds', async () => {
    // The seeder seeds ZERO-CONFIG, non-internal chains only. Iterating all 169
    // would make `examined` a meaningless denominator dominated by chains that
    // never had a `wf.seed.*` row (168 vs migration 14's 52).
    const r = await retargetSeededNotifyNodes(storage);
    expect(r.examined).toBeLessThan(100);
  });

  it('reports zero failures on a healthy run', async () => {
    const r = await retargetSeededNotifyNodes(storage);
    expect(r.failed).toBe(0);
  });
});

describe('the shipped packs no longer carry the retired node', () => {
  it('no chain expands to `core.openwop.integration.notification-push`', async () => {
    // Phases B+C retargeted all 55 occurrences. If a pack regresses, this
    // migration would start rewriting definitions back to a broken node —
    // so the migration is only safe while this holds.
    const { expandChain } = await import('../src/host/workflowChainPackLoader.js');
    _resetChainRegistryForTest();
    const { loadWorkflowChainPacks, defaultWorkflowChainPackRoots } = await import('../src/host/workflowChainPackLoader.js');
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    const chains = listChains();
    expect(chains.length, 'no chains loaded — this assertion would pass vacuously').toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const { chain } of chains) {
      let expanded;
      try {
        expanded = expandChain(chain, { deferred: true });
      } catch {
        continue; // expansion failures are covered by their own suites
      }
      if ((expanded.nodes ?? []).some((n: { typeId?: string }) => n.typeId === 'core.openwop.integration.notification-push')) {
        offenders.push(chain.chainId);
      }
    }
    expect(offenders, 'a pack regressed to the retired notification-push node').toEqual([]);
  });
});
