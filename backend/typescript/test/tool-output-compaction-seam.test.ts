/**
 * ADR 0099 — the core seams + run-start decision + replay/fork invariant.
 *
 * Verifies (without a full run) the architectural contract:
 *   - the run-start contributor freezes the decision into run.metadata when the
 *     tenant toggle is on, and stamps nothing when off;
 *   - stampRunStartContext NEVER overwrites a pre-existing decision (so a
 *     :fork-copied value wins on replay — never re-resolved);
 *   - applyToolResultTransform compacts with a live decision, is identity
 *     without one, and fail-opens to identity when the kernel throws.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  registerToolResultTransform,
  applyToolResultTransform,
  __resetToolResultTransform,
} from '../src/host/toolResultTransform.js';
import {
  registerRunStartContributor,
  stampRunStartContext,
  __resetRunStartContributors,
} from '../src/host/runStartContext.js';
import { readCompactionDecision, COMPACTION_METADATA_KEY } from '../src/executor/compaction.js';
import { resolveCompactionDecision, TOGGLE_ID } from '../src/features/tool-output-compaction/decision.js';
import { compactToolOutput } from '../src/features/tool-output-compaction/compact.js';
import { toolOutputCompactionFeature } from '../src/features/tool-output-compaction/feature.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig, __clearToggleStore } from '../src/host/featureToggles/service.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';

const TENANT = 'tenant-a';
const storage = openSqliteStorage(':memory:');

async function setToggle(status: 'on' | 'off'): Promise<void> {
  await saveConfig({ ...toolOutputCompactionFeature.toggleDefault!, status }, 'test');
}

beforeAll(() => {
  initHostExtPersistence(storage);
});
afterAll(async () => {
  await storage.close();
});

beforeEach(async () => {
  initHostExtPersistence(storage);
  __resetToolResultTransform();
  __resetRunStartContributors();
  await __clearToggleStore();
  registerToggleDefault(toolOutputCompactionFeature.toggleDefault!);
});

describe('run-start decision (contributor)', () => {
  it('freezes { compaction: { mode: "lossless" } } when the tenant toggle is ON', async () => {
    await setToggle('on');
    const patch = await resolveCompactionDecision({ tenantId: TENANT });
    expect(patch).toEqual({ [COMPACTION_METADATA_KEY]: { mode: 'lossless' } });
  });

  it('stamps nothing when the toggle is OFF (run replays uncompacted, as born)', async () => {
    await setToggle('off');
    const patch = await resolveCompactionDecision({ tenantId: TENANT });
    expect(patch).toEqual({});
  });

  it('stamps nothing on a DERIVED run, whatever the toggle says (ADR 0604 TOCWF-1)', async () => {
    // The unit half of the fork invariant: on a `:fork`-copied metadata blob the
    // ABSENCE of a key is inherited state, so the contributor must resolve
    // nothing even with the toggle ON. The end-to-end half runs the real route
    // in test/tool-output-compaction-fork-real-path.test.ts.
    await setToggle('on');
    expect(await resolveCompactionDecision({ tenantId: TENANT })).toEqual({ [COMPACTION_METADATA_KEY]: { mode: 'lossless' } });
    expect(await resolveCompactionDecision({ tenantId: TENANT, derivedFromRun: true })).toEqual({});
  });

  it('merges into run.metadata without clobbering existing attribution', async () => {
    await setToggle('on');
    registerRunStartContributor(resolveCompactionDecision);
    const meta = await stampRunStartContext({ source: 'schedule', actingUserId: 'u1' }, { tenantId: TENANT });
    expect(meta.source).toBe('schedule');
    expect(meta.actingUserId).toBe('u1');
    expect(readCompactionDecision(meta)).toEqual({ mode: 'lossless' });
  });
});

describe('replay / fork — decision read verbatim, never re-resolved', () => {
  /**
   * ADR 0604 (TOCWF-2) — WHAT USED TO BE HERE, AND WHY IT IS GONE.
   *
   * This block held two tests built on a local helper
   *
   *     const fork = (sourceMetadata) => ({ ...sourceMetadata });
   *
   * introduced by a comment asserting, as fact, that the real route "copies
   * `sourceRun.metadata` VERBATIM and never re-stamps". The first half was
   * true; the second was not. `routes/runs.ts` hands the copied blob to
   * `insertRunWithStartContext`, which RE-RUNS every run-start contributor —
   * and a shallow spread cannot re-run a contributor. So the helper measured
   * itself, the "born-OFF stays uncompacted" test was green against a path
   * that was red, and all 61 shipped compaction tests were green through the
   * defect.
   *
   * The invariant is now witnessed where it actually lives — a real
   * `POST /v1/runs/{id}:fork` against a real app, asserted by reading the row
   * back out of storage — in `test/tool-output-compaction-fork-real-path.test.ts`.
   * It is NOT re-modelled here: a second stand-in would only re-earn the same
   * false confidence. What remains below is the one claim this file CAN make
   * honestly, because it is a claim about `stampRunStartContext` itself.
   */
  it('stampRunStartContext never overwrites an already-frozen decision (safety net)', async () => {
    await setToggle('off'); // contributor would now resolve to "nothing"
    registerRunStartContributor(resolveCompactionDecision);
    // A metadata blob that already carries a frozen lossless decision.
    const preStamped = { source: 'api', [COMPACTION_METADATA_KEY]: { mode: 'lossless' as const } };
    const out = await stampRunStartContext(preStamped, { tenantId: TENANT });
    expect(readCompactionDecision(out)).toEqual({ mode: 'lossless' });
  });
});

describe('applyToolResultTransform (the typed tool-result seam)', () => {
  const payload = JSON.stringify({ items: [{ id: 1, tags: [], note: null }, { id: 2, tags: [], note: '' }] });

  beforeEach(() => {
    registerToolResultTransform((content, ctx) => compactToolOutput(content, ctx.decision!));
  });

  it('compacts when a live decision is present', () => {
    // ADR 0604 (TOCC-3) — the fixture is indented, so `lossless` (minify-only)
    // still shrinks it; what it must NOT do is delete `tags`. The old assertion
    // here was `not.toContain('"tags"')`, pinning the lossy-in-lossless defect.
    const indented = JSON.stringify(JSON.parse(payload), null, 2);
    const out = applyToolResultTransform(indented, { decision: { mode: 'lossless' }, toolName: 'list' });
    expect(out.length).toBeLessThan(indented.length);
    expect(out).toContain('"tags"');
    expect(JSON.parse(out)).toEqual(JSON.parse(indented));
  });

  it('lossy drops the empty fields and discloses them', () => {
    // Enough empties that naming them still pays; on a payload with only one or
    // two, the never-regress guard returns the original rather than buying the
    // saving with a silent absence (pinned in the kernel test).
    const sparse = JSON.stringify({ a: '', b: '', c: '', d: '', e: '', f: '', g: '', h: '', keep: 1 });
    const out = applyToolResultTransform(sparse, { decision: { mode: 'lossy', head: 9, tail: 9 }, toolName: 'list' });
    expect(out).toContain('_emptied');
    expect(JSON.parse(out)._emptied).toHaveLength(8);
  });

  it('is identity with no decision', () => {
    expect(applyToolResultTransform(payload, {})).toBe(payload);
  });

  it('is identity with mode "off"', () => {
    expect(applyToolResultTransform(payload, { decision: { mode: 'off' } })).toBe(payload);
  });

  it('fail-opens to identity when the registered transform throws', () => {
    registerToolResultTransform(() => {
      throw new Error('boom');
    });
    expect(applyToolResultTransform(payload, { decision: { mode: 'lossless' } })).toBe(payload);
  });

  it('default (no feature registered) is identity', () => {
    __resetToolResultTransform();
    expect(applyToolResultTransform(payload, { decision: { mode: 'lossless' } })).toBe(payload);
  });
});

describe('insertRunWithStartContext (the single run-insert owner)', () => {
  it('derives the tenant from the run and freezes the decision into run.metadata', async () => {
    await setToggle('on');
    registerRunStartContributor(resolveCompactionDecision);
    const run = {
      runId: 'run-1',
      workflowId: 'wf-1',
      tenantId: TENANT,
      status: 'pending' as const,
      inputs: null,
      metadata: { source: 'test' } as Record<string, unknown>,
      configurable: {},
      createdAt: '2026-06-20T00:00:00Z',
      updatedAt: '2026-06-20T00:00:00Z',
    };
    await insertRunWithStartContext(storage, run);
    const stored = await storage.getRun('run-1');
    expect(readCompactionDecision(stored?.metadata)).toEqual({ mode: 'lossless' });
    expect((stored?.metadata as Record<string, unknown>).source).toBe('test');
  });

  it('stamps nothing when the toggle is OFF (run stored uncompacted)', async () => {
    await setToggle('off');
    registerRunStartContributor(resolveCompactionDecision);
    const run = {
      runId: 'run-2',
      workflowId: 'wf-1',
      tenantId: TENANT,
      status: 'pending' as const,
      inputs: null,
      metadata: {} as Record<string, unknown>,
      configurable: {},
      createdAt: '2026-06-20T00:00:00Z',
      updatedAt: '2026-06-20T00:00:00Z',
    };
    await insertRunWithStartContext(storage, run);
    const stored = await storage.getRun('run-2');
    expect(readCompactionDecision(stored?.metadata)).toBeUndefined();
  });
});

describe('TOGGLE_ID matches the feature', () => {
  it('the decision toggle id equals the feature toggle default', () => {
    expect(TOGGLE_ID).toBe(toolOutputCompactionFeature.toggleDefault!.id);
  });
});
