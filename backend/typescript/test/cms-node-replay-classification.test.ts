/**
 * ADR 0668 D5 (CMSLWF-2) — the CMS node pack's three WRITERS are declared
 * `role:"side-effect"`, and the two kinds of writer land in different places.
 *
 * Born red: all six nodes were `role:"action"` and the pack's own description said "All
 * role:action — outputs are recorded; replay/fork read the recorded result." Two of them
 * mutate the pages store and a third also calls the model, so that sentence was false for
 * half the pack — the it.22 `PMXWF-9` shape, unbitten here only by accidental idempotency.
 *
 * Leg 3 is the one worth reading. `translate-section` is declared side-effect and is
 * DELIBERATELY NOT fast-path served: it reaches `ctx.callAI`, so the generator classifies it
 * `ai-invocation-log` and holds it back. The declaration buys floor membership, not service.
 * The ADR's first draft predicted the opposite and would have read the ratchet diff as a
 * regression.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED, MANIFEST_DECLARED_TYPE_IDS } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACK = JSON.parse(readFileSync(join(REPO, 'packs', 'feature.cms.nodes', 'pack.json'), 'utf8')) as {
  version: string; description: string; nodes: { typeId: string; role: string }[];
};
const id = (n: string): string => `feature.cms.nodes.${n}`;
const WRITERS_SERVED = ['update-section-draft', 'submit-page'];
const WRITER_HELD = 'translate-section';
const READS = ['get-page', 'list-pages', 'get-draft-page'];

describe('ADR 0668 D5 — CMS node replay classification', () => {
  it('leg 1: the three writers declare side-effect; the three reads stay action', () => {
    const byId = new Map(PACK.nodes.map((n) => [n.typeId, n.role]));
    for (const n of [...WRITERS_SERVED, WRITER_HELD]) expect(byId.get(id(n)), n).toBe('side-effect');
    for (const n of READS) expect(byId.get(id(n)), n).toBe('action');
  });

  it('leg 2: the two pure writers are floored AND replay-SERVED', () => {
    for (const n of WRITERS_SERVED) {
      expect(MANIFEST_DECLARED_TYPE_IDS.has(id(n)), n).toBe(true);
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(id(n)), `${n} is floored`).toBe(true);
      expect(MANIFEST_FAST_PATH_SERVED.has(id(n)), `${n} is served — this is what stops the replay re-execution`).toBe(true);
      expect(isSideEffectingNode(id(n))).toBe(true);
    }
  });

  it('leg 3: translate-section is floored but NOT served — a callAI node is held back on purpose', () => {
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has(id(WRITER_HELD)), 'floored').toBe(true);
    expect(MANIFEST_FAST_PATH_SERVED.has(id(WRITER_HELD)),
      'fast-pathing a callAI node would destroy RFC 0041 §B divergence injection',
    ).toBe(false);
    // ...and therefore it is NOT treated as side-effecting by the predicate that reads the
    // SERVED set. This asymmetry is the whole point of the leg.
    expect(isSideEffectingNode(id(WRITER_HELD))).toBe(false);
  });

  it('leg 4: the pack no longer claims "all role:action", and the feature pin matches', () => {
    expect(PACK.description, 'the blanket claim was false for half the pack').not.toContain('All role:action');
    expect(PACK.description).toContain('side-effect');
    const feature = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'features', 'cms', 'feature.ts'), 'utf8');
    expect(feature, 'a pin that lags the manifest runs a different pack').toContain(`{ name: 'feature.cms.nodes', version: '${PACK.version}' }`);
  });
});
