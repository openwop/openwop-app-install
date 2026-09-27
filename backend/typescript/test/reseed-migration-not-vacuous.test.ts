/**
 * ADR 0507 — the re-seed migration must not be VACUOUS.
 *
 * The trap this exists for, caught in review before shipping: `runAppMigrations`
 * fires at `index.ts:186`, but the chain registry is not populated until
 * `loadWorkflowChainPacks` at `index.ts:427`. A migration that iterates
 * `listChains()` therefore sees ZERO chains, rewrites nothing, and is still
 * RECORDED as complete — a one-shot migration that silently never runs.
 *
 * That failure is invisible by construction: it returns success, logs a clean
 * result, and leaves every definition broken. Nothing else in the suite would
 * notice, which is exactly why it gets its own file.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { _resetChainRegistryForTest, listChains } from '../src/host/workflowChainPackLoader.js';
import { reseedChainWorkflowsDeferred } from '../src/host/seedWorkflows.js';

describe('the re-seed migration self-loads the chain registry', () => {
  beforeEach(() => {
    // Reproduce migration-time conditions exactly: registry EMPTY, as it is at
    // index.ts:186.
    _resetChainRegistryForTest();
  });

  it('examines a real population even when the registry starts empty', async () => {
    expect(listChains(), 'precondition: the registry must start empty or this proves nothing').toHaveLength(0);
    const result = await reseedChainWorkflowsDeferred();
    // The assertion that matters. Zero examined = the migration did nothing and
    // said it succeeded.
    expect(result.examined, 'migration examined no chains — it ran vacuously').toBeGreaterThan(20);
  });

  it('leaves the registry populated for the rest of boot', async () => {
    await reseedChainWorkflowsDeferred();
    expect(listChains().length).toBeGreaterThan(100);
  });

  it('rewrites nothing when no definition was previously seeded', async () => {
    // A fresh install has no `wfreg:` rows, so every chain reports ABSENT and the
    // migration must NOT mint definitions the seeder has not been asked for.
    const result = await reseedChainWorkflowsDeferred();
    expect(result.rewritten).toBe(0);
    expect(result.absent).toBeGreaterThan(20);
  });

  it('is idempotent — a second run changes nothing', async () => {
    const first = await reseedChainWorkflowsDeferred();
    const second = await reseedChainWorkflowsDeferred();
    expect(first.examined, 'guard: 0 === 0 would satisfy idempotence vacuously').toBeGreaterThan(20);
    expect(second.examined).toBe(first.examined);
    expect(second.rewritten).toBe(0);
  });
});

describe('SESS-1 — the result can report failure', () => {
  it('every examined chain is accounted for by exactly one counter', async () => {
    // The original result had no `failed`, so a run where every chain threw
    // reported `rewritten: 0` and was indistinguishable from a clean no-op — a
    // result object blind to its own failures, in a change about invisible
    // failures. This invariant makes a silent loss impossible.
    const r = await reseedChainWorkflowsDeferred();
    expect(r.examined).toBeGreaterThan(20);
    expect(
      r.rewritten + r.skippedSensitive + r.absent + r.failed,
      'a chain vanished from the accounting — some path returns without incrementing a counter',
    ).toBe(r.examined);
  });

  it('reports zero failures on a healthy run', async () => {
    const r = await reseedChainWorkflowsDeferred();
    expect(r.failed).toBe(0);
  });
});
