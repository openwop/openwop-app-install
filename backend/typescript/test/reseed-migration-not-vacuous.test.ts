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
 *
 * Sabotages that red this file (8fw1g4 round 1 + 2): skipping the self-load
 * (`listChains().length === 0` guard), dropping the `absent` counter, counting
 * absent as `failed`, and stamping the rewrite as anything but `deferred` (the
 * seeded-row idempotency case). The fresh-install cases alone cannot see a
 * rewrite at all — every chain is absent — so the idempotency case seeds one
 * real expansion-time row first.
 *
 * RESEED-ACCT-1 (pinned below as `it.fails`, grade-code row): the already-deferred
 * branch `if (…expansionMode === 'deferred') continue;` in
 * `reseedChainWorkflowsDeferred` (`src/host/seedWorkflows.ts`) increments NO
 * counter, so on any install that already holds a deferred row the SESS-1
 * accounting (every examined chain lands in exactly one counter) is false.
 * Fix-probe `8fw1g4-rsm-acct-fix-r2` adds the missing counter and turns the
 * `it.fails` red.
 *
 * Floors are measured truth minus a margin (see EXAMINED_FLOOR / CHAINS_FLOOR),
 * never a multiple of 10.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  _resetChainRegistryForTest,
  listChains,
  expandChain,
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  type WorkflowChain,
} from '../src/host/workflowChainPackLoader.js';
import { reseedChainWorkflowsDeferred, seedWorkflowId } from '../src/host/seedWorkflows.js';
import {
  __resetWorkflowRegistryForTests,
  getRegisteredWorkflowStrict,
  registerWorkflowDurable,
} from '../src/host/workflowsRegistry.js';

// MEASURED on 7321e3612 (2026-10-18): examined = 63 (all absent on a fresh install),
// listChains() = 241. Floors sit a small margin below so adding/removing a chain or two
// does not red the file, while a self-load that silently drops the corpus does.
const EXAMINED_FLOOR = 59;
const CHAINS_FLOOR = 233;

type ReseedResult = Awaited<ReturnType<typeof reseedChainWorkflowsDeferred>>;

/** Every counter EXCEPT `examined`, summed — so a fix that adds a new bucket
 *  (RESEED-ACCT-1) is counted without editing this file. */
function accounted(r: ReseedResult): number {
  return Object.entries(r).filter(([k]) => k !== 'examined').reduce((s, [, v]) => s + v, 0);
}

/** A chain `reseedChainWorkflowsDeferred` examines AND would rewrite: public,
 *  zero-config (mirrors `isZeroConfig`), and no `x-openwop-sensitive` param. */
function rewritableChain(): WorkflowChain {
  if (listChains().length === 0) loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  const found = listChains().map((e) => e.chain).find((c) => {
    if (c.internal === true) return false;
    const required = (c.parameters as { required?: unknown }).required;
    if (Array.isArray(required) && required.length > 0) return false;
    const props = (c.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    return !Object.values(props).some((p) => typeof p === 'object' && p !== null && (p as Record<string, unknown>)['x-openwop-sensitive'] === true);
  });
  if (!found) throw new Error('fixture: no public zero-config chain is loaded — this file proves nothing');
  return found;
}

/** Seed the row a PRE-ADR-0507 install holds: the chain's expansion-time head. */
async function seedExpansionTimeRow(chain: WorkflowChain): Promise<string> {
  const workflowId = seedWorkflowId(chain.chainId);
  const expanded = expandChain(chain, {});
  expect(expanded.metadata?.expansionMode, 'fixture: must be the pre-0507 mode').toBe('expansion-time');
  await registerWorkflowDurable({ ...expanded, workflowId });
  return workflowId;
}

describe('the re-seed migration self-loads the chain registry', () => {
  beforeEach(() => {
    // Reproduce migration-time conditions exactly: registry EMPTY, as it is at
    // index.ts:186. The workflow registry (the store, in a file with no durable
    // Storage wired) is reset too, so a row seeded by one case never leaks into
    // another under shuffle.
    _resetChainRegistryForTest();
    __resetWorkflowRegistryForTests();
  });

  it('examines a real population even when the registry starts empty', async () => {
    expect(listChains(), 'precondition: the registry must start empty or this proves nothing').toHaveLength(0);
    const result = await reseedChainWorkflowsDeferred();
    // The assertion that matters. Zero examined = the migration did nothing and
    // said it succeeded.
    expect(result.examined, 'migration examined no chains — it ran vacuously').toBeGreaterThanOrEqual(EXAMINED_FLOOR);
  });

  it('leaves the registry populated for the rest of boot', async () => {
    await reseedChainWorkflowsDeferred();
    expect(listChains().length).toBeGreaterThanOrEqual(CHAINS_FLOOR);
  });

  it('rewrites nothing when no definition was previously seeded', async () => {
    // A fresh install has no `wfreg:` rows, so every chain reports ABSENT and the
    // migration must NOT mint definitions the seeder has not been asked for.
    const result = await reseedChainWorkflowsDeferred();
    expect(result.rewritten).toBe(0);
    expect(result.absent, 'fresh install: every examined chain is absent').toBe(result.examined);
    expect(result.absent).toBeGreaterThanOrEqual(EXAMINED_FLOOR);
  });

  it('is idempotent — a second run changes nothing', async () => {
    // A seeded expansion-time row, so the first run really REWRITES (without it
    // `rewritten` is 0 on every run whatever the idempotency guard does).
    const workflowId = await seedExpansionTimeRow(rewritableChain());
    const first = await reseedChainWorkflowsDeferred();
    expect(first.examined, 'guard: 0 === 0 would satisfy idempotence vacuously').toBeGreaterThanOrEqual(EXAMINED_FLOOR);
    expect(first.rewritten, 'the seeded row must be rewritten on the first run').toBe(1);
    const stored = await getRegisteredWorkflowStrict(workflowId);
    expect(stored?.metadata?.expansionMode, 'the rewrite must land as deferred').toBe('deferred');
    const second = await reseedChainWorkflowsDeferred();
    expect(second.examined).toBe(first.examined);
    expect(second.rewritten, 'an already-deferred row must not be rewritten again').toBe(0);
    expect(second.failed).toBe(0);
  });
});

describe('SESS-1 — the result can report failure', () => {
  beforeEach(() => {
    _resetChainRegistryForTest();
    __resetWorkflowRegistryForTests();
  });

  it('every examined chain is accounted for by exactly one counter', async () => {
    // The original result had no `failed`, so a run where every chain threw
    // reported `rewritten: 0` and was indistinguishable from a clean no-op — a
    // result object blind to its own failures, in a change about invisible
    // failures. Fresh-install leg; the populated leg is RESEED-ACCT-1 below.
    const r = await reseedChainWorkflowsDeferred();
    expect(r.examined).toBeGreaterThanOrEqual(EXAMINED_FLOOR);
    expect(
      accounted(r),
      'a chain vanished from the accounting — some path returns without incrementing a counter',
    ).toBe(r.examined);
  });

  it('reports zero failures on a healthy run', async () => {
    const r = await reseedChainWorkflowsDeferred();
    expect(r.examined).toBeGreaterThanOrEqual(EXAMINED_FLOOR);
    expect(r.failed).toBe(0);
  });

  // RESEED-ACCT-1 — the CORRECT expectation, failing today: the second run meets an
  // already-deferred row, and that branch increments no counter, so one examined
  // chain is missing from the sum. Fix-probe 8fw1g4-rsm-acct-fix-r2 turns this red.
  it.fails('a re-run over an already-deferred row still accounts for every examined chain (RESEED-ACCT-1)', async () => {
    await seedExpansionTimeRow(rewritableChain());
    const first = await reseedChainWorkflowsDeferred();
    expect(first.rewritten, 'fixture: the first run must rewrite the seeded row').toBe(1);
    const second = await reseedChainWorkflowsDeferred();
    expect(accounted(second), 'the already-deferred row landed in no counter').toBe(second.examined);
  });
});
