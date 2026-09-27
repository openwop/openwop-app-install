/**
 * ADR 0646 D1 — the forms-intake chain's ONLY durable writer must never re-execute on
 * a `mode:'replay'` fork. The `crm-/csm-/users-/orgs-/comments-node-replay` shape.
 *
 * WHY (FRMWF-1): the writer is NOT a Forms node — it is
 * `feature.priority-matrix.nodes.submit-idea`, which Forms composes. At pack 1.3.0 it
 * declared `role:"action"` with no `side-effectful` capability, so it sat in the
 * manifest census only: in neither the derived floor nor the fast-path served set.
 * MEASURED: nothing in the executor compares `role` to `"action"` (`sideEffects.ts`
 * says so verbatim), so `replayServed` was never set and a replay fork RE-EXECUTED
 * `submitIdea`, which mints a fresh random card id — a DUPLICATE card with the same
 * `sourceSubmissionId`. The prior assessment asserted the opposite.
 *
 * The tell was inside the same pack: `update-intake` declares `["side-effectful"]` and
 * IS classified. The node that EDITS a card was protected; the node that CREATES one
 * was not. Same class as ADR 0645 D3 (CSM), one feature over.
 *
 * Legs:
 *   1. the priority-matrix manifest declares `side-effect` + `side-effectful` for
 *      `submit-idea` (and `update-intake` stays classified — a pack that widens
 *      everything discharges nothing, so the READ nodes must stay `action`);
 *   2. the derived floor HOLDS it AND the fast path SERVES it (membership alone is
 *      undischarged — ADR 0572);
 *   3. `isSideEffectingNode` — the predicate `executor.ts` branches on — says true;
 *   4. the priority-matrix feature pin equals the manifest version;
 *   5. `expandChain` of `forms-intake.route-submission` is BYTE-IDENTICAL across two
 *      builds (the chain has zero params, so this also pins Path-A ≡ seeded).
 *
 * BORN RED: legs 1, 2, 3 fail against the 1.3.0 `action` role.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { loadWorkflowChainPacks, getChain, expandChain, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PM = JSON.parse(readFileSync(join(REPO, 'packs', 'feature.priority-matrix.nodes', 'pack.json'), 'utf8')) as {
  version: string;
  nodes: { typeId: string; role: string; capabilities?: string[] }[];
};
const WRITE = 'feature.priority-matrix.nodes.submit-idea';
const SIBLING_WRITE = 'feature.priority-matrix.nodes.update-intake';
const READS = ['feature.forms.nodes.list-forms', 'feature.forms.nodes.list-submissions', 'feature.forms.nodes.get-submission'];

describe('ADR 0646 D1 — the intake chain\'s writer is classified, floored and served', () => {
  it('leg 1: the priority-matrix manifest declares side-effect + side-effectful for submit-idea', () => {
    const byId = new Map(PM.nodes.map((n) => [n.typeId, n]));
    expect(byId.get(WRITE)?.role).toBe('side-effect');
    expect(byId.get(WRITE)?.capabilities).toContain('side-effectful');
    // The sibling that was ALREADY classified must stay so — this is a widening,
    // not a reshuffle.
    expect(byId.get(SIBLING_WRITE)?.capabilities).toContain('side-effectful');
  });

  it('leg 2: the derived floor HOLDS it and the fast path SERVES it', () => {
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has(WRITE), 'in the floor').toBe(true);
    expect(MANIFEST_FAST_PATH_SERVED.has(WRITE), 'and actually served').toBe(true);
    // Non-vacuity in the other direction: the Forms READ nodes are correctly
    // `action` and must NOT be widened into the floor.
    for (const r of READS) expect(MANIFEST_SIDE_EFFECT_FLOOR.has(r), `${r} is a read`).toBe(false);
  });

  it('leg 3: isSideEffectingNode says true for the writer, false for the reads', () => {
    expect(isSideEffectingNode(WRITE)).toBe(true);
    for (const r of READS) expect(isSideEffectingNode(r)).toBe(false);
  });

  it('leg 4: the priority-matrix feature pin equals the manifest version', () => {
    const feature = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'features', 'priority-matrix', 'feature.ts'), 'utf8');
    expect(feature).toContain(`{ name: 'feature.priority-matrix.nodes', version: '${PM.version}' }`);
  });

  it('leg 5: expandChain of forms-intake.route-submission is BYTE-IDENTICAL across two builds', () => {
    _resetChainRegistryForTest();
    const { errors } = loadWorkflowChainPacks({ roots: [join(REPO, 'examples', 'workflow-chain-packs')] });
    expect(errors, 'the pack must load cleanly — otherwise this leg is vacuous').toEqual([]);
    const entry = getChain('forms-intake.route-submission');
    expect(entry, 'the chain must load').toBeTruthy();
    const a = expandChain(entry!.chain, { params: {} });
    const b = expandChain(entry!.chain, { params: {} });
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
