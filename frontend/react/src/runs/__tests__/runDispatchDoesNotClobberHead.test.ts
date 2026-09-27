/**
 * ADR 0524 §1 — running a workflow must not overwrite the server head with a
 * stale localStorage copy, and must FAIL CLOSED when it cannot tell.
 *
 * The runs index and the chat `@workflow` mention register-then-run by
 * serializing a `SavedWorkflow` read from localStorage. A record written by a
 * pre-ADR-0523 bundle carries no node `inputs`, and the CORRECTED serializer
 * then faithfully emits the nothing that is there — so pressing Run re-strips
 * the head. A refresh does not help: the staleness is in browser storage, not in
 * the JS bundle, so a workflow the user only ever RUNS is never healed.
 *
 * WHAT THIS FILE IS, honestly: a SOURCE-SHAPE ratchet over the two call sites,
 * not behavioural coverage. An earlier version of it also exercised a helper
 * declared in this file that no production module imports — a grade pass pointed
 * out that all three of those tests stayed green if both lanes were reverted
 * wholesale, which is a test asserting itself. Those are gone. What remains
 * checks the two properties whose loss is silent, at the only place they live.
 *
 * Behavioural coverage of these lanes is owed and tracked (`GUARD-CODE-3`): both
 * are testable — `useWorkflowRunMentions` is a hook and `RunsIndexPage` is
 * RTL-renderable with `vi.mock('…/registerClient')`, for which there is
 * precedent in this suite.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string): string =>
  readFileSync(join(import.meta.dirname, '..', '..', rel), 'utf8');

const LANES: ReadonlyArray<readonly [label: string, path: string]> = [
  ['the runs index', 'runs/RunsIndexPage.tsx'],
  ['the chat @workflow mention', 'chat/hooks/chatSession/useWorkflowRunMentions.ts'],
];

describe('both run-dispatch lanes guard the register', () => {
  it('fixture guard: both sources are readable and non-trivial', () => {
    // Without this a path typo yields '' and every assertion below passes
    // vacuously — the failure mode this whole ADR family keeps hitting.
    for (const [label, path] of LANES) {
      expect(read(path).length, `${label}: source unreadable or empty`).toBeGreaterThan(2000);
    }
  });

  it.each(LANES)('%s probes the backend before registering', (_label, path) => {
    expect(read(path)).toContain('fetchRegisteredWorkflow');
  });

  it.each(LANES)('%s registers ONLY when the probe says the head is absent', (_label, path) => {
    // The property whose loss is silent: without the guard, a stale local copy
    // overwrites a live head on every Run.
    expect(read(path)).toMatch(/if \(!probe && !probeFailed\)/);
  });

  it.each(LANES)('%s FAILS CLOSED — a probe error must not reach the register', (_label, path) => {
    const src = read(path);
    // `.catch(() => null)` here would fall through to the destructive branch on
    // a 429/5xx/offline — and the per-IP read budget makes 429 a real source on
    // fan-out pages. The catch must set a flag that SUPPRESSES the register.
    expect(src, 'a swallowed probe error must not fall through to the register').not.toMatch(
      /fetchRegisteredWorkflow\([^)]*\)\.catch/,
    );
    expect(src).toMatch(/catch \{ probeFailed = true; \}/);
  });
});
