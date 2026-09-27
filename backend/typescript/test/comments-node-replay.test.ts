/**
 * WF-CMNT-1 — `feature.comments.nodes.post` must never re-fire on a `:fork`.
 *
 * THE DEFECT. The node mints a durable `cmt:${randomUUID()}` row and emits an
 * ADDRESSED, user-visible notification, reaching `getNotificationEmitter()`
 * through `ctx.features.comments` — invisible in pack source, which is exactly
 * why `feature.notifications.nodes.notify` and
 * `feature.kicktodo.nodes.session-reminder` needed explicit entries before it.
 * It was in NEITHER effect set, so a fork posted a second comment under a
 * DIFFERENT `agent:${newRunId}` author and notified the recipient again. Both the
 * pack header and the surface header asserted the opposite.
 *
 * THE #2871 TWO-LEG LESSON is what this file pins: a pack `.mjs` node cannot set
 * `module.sideEffecting`, so the manifest declaration and the explicit typeId
 * pattern are two INDEPENDENT paths to the same protection and a fix that lands
 * only one of them looks identical to a fix that landed both.
 *
 * WHAT THIS DOES NOT PROVE. It does not execute a run and fork it — that is
 * `PROBE-CMNT-3`, a live probe. It proves the predicate `executor.ts:958`
 * branches on, and that both legs are independently present.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const POST = 'feature.comments.nodes.post';

describe('WF-CMNT-1 — the write node is classified, on both legs', () => {
  it('leg 1: the pack manifest declares role side-effect AND the side-effectful capability', () => {
    const pack = JSON.parse(readFileSync(join(REPO, 'packs/feature.comments.nodes/pack.json'), 'utf8')) as {
      nodes: Array<{ typeId: string; role?: string; capabilities?: string[] }>;
    };
    const post = pack.nodes.find((n) => n.typeId === POST);
    expect(post, `${POST} not found in the manifest — this test would pass vacuously`).toBeTruthy();
    expect(post!.role).toBe('side-effect');
    expect(post!.capabilities ?? []).toContain('side-effectful');
  });

  it('leg 2: sideEffects.ts carries the explicit typeId pattern (independent of the manifest)', () => {
    // The manifest leg reaches the DERIVED floor; this leg reaches
    // `SIDE_EFFECTING_TYPE_PATTERNS`. Asserted at source level because the array
    // is module-private — and asserted with a hard failure if the anchor is
    // missing, so a rename cannot turn this into a silent pass.
    const src = readFileSync(join(REPO, 'backend/typescript/src/executor/sideEffects.ts'), 'utf8');
    const patterns = /const SIDE_EFFECTING_TYPE_PATTERNS: readonly RegExp\[\] = \[([\s\S]*?)\n\];/.exec(src);
    expect(patterns, 'SIDE_EFFECTING_TYPE_PATTERNS literal not found — this gate is inert').toBeTruthy();
    expect(patterns![1]).toContain(String.raw`/^feature\.comments\.nodes\.post$/`);
  });

  it('the derived floor holds it AND the fast path SERVES it', () => {
    // Floor membership alone is UNDISCHARGED — a node that is "held" rather than
    // "served" still re-posts. Both are asserted for that reason.
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has(POST)).toBe(true);
    expect(MANIFEST_FAST_PATH_SERVED.has(POST)).toBe(true);
  });

  it('isSideEffectingNode — the exact predicate executor.ts branches on — returns true', () => {
    expect(isSideEffectingNode(POST, null)).toBe(true);
  });

  it('the READ node is deliberately NOT classified (a read may re-execute on a fork)', () => {
    expect(isSideEffectingNode('feature.comments.nodes.list', null)).toBe(false);
  });

  it('`resolve` is deliberately NOT classified — recorded as a judgement, not an omission', () => {
    // It is a durable write, but re-execution converges on the SAME terminal
    // state, mints no row and emits no notification: a fork duplicates nothing
    // observable. Revisit if it ever notifies or records `resolvedBy` (CMNT-10).
    expect(isSideEffectingNode('feature.comments.nodes.resolve', null)).toBe(false);
  });
});
