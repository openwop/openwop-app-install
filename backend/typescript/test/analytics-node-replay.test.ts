/**
 * ADR 0651 / ANLWF-10 — the analytics nodes are READS and must stay classified as
 * reads. The `crm-/csm-/forms-/kb-/users-/orgs-/comments-node-replay` shape, inverted.
 *
 * WHY: `WF-ANL-3` was filed as the writer-misclassification class that hit CSM and
 * Forms (a durable writer declared `role:"action"`, unserved, re-executing on
 * `:fork`). It is NOT that class: `query` → `analytics.summary` and `events` →
 * `analytics.events` are pure reads over a surface with zero writes, and the pack
 * header's "replay/fork read the recorded result" overclaim was already deleted.
 * So `action` is the honest label — and the REVERSE misclassification (someone adds
 * these reads to the served set, silently changing fork semantics for every chain
 * that binds them) was caught by nothing. This pins the honest state from both
 * directions. Legs 1–3 are the classification; leg 4 the pin; leg 5 (ANLWF-9) the
 * byte-identical double expansion the CMS/CSM/Forms passes have and this lacked.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { loadWorkflowChainPacks, getChain, expandChain, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const M = JSON.parse(readFileSync(join(REPO, 'packs', 'feature.analytics.nodes', 'pack.json'), 'utf8')) as {
  version: string; nodes: { typeId: string; role: string; capabilities?: string[] }[];
};
const READS = ['feature.analytics.nodes.query', 'feature.analytics.nodes.events'];

describe('ADR 0651 — the analytics nodes are reads, and stay classified as reads', () => {
  it('leg 1: the manifest declares role:"action" with NO side-effectful capability on both', () => {
    const byId = new Map(M.nodes.map((n) => [n.typeId, n]));
    for (const r of READS) {
      expect(byId.get(r)?.role, r).toBe('action');
      expect(byId.get(r)?.capabilities ?? [], r).not.toContain('side-effectful');
    }
    // Non-vacuity: the pack must actually declare these two and nothing else.
    expect(M.nodes.map((n) => n.typeId).sort()).toEqual([...READS].sort());
  });

  it('leg 2: neither read is in the derived floor NOR the served set', () => {
    for (const r of READS) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(r), `${r} must not be floored`).toBe(false);
      expect(MANIFEST_FAST_PATH_SERVED.has(r), `${r} must not be replay-served`).toBe(false);
    }
  });

  it('leg 3: isSideEffectingNode says false for both, and true for the writer they feed', () => {
    for (const r of READS) expect(isSideEffectingNode(r)).toBe(false);
    // The effect node every analytics-bearing chain terminates on IS protected —
    // the reads correctly are not.
    expect(isSideEffectingNode('feature.notifications.nodes.notify')).toBe(true);
  });

  it('leg 4: the feature pin equals the manifest version', () => {
    const feature = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'features', 'analytics', 'feature.ts'), 'utf8');
    expect(feature).toContain(`{ name: 'feature.analytics.nodes', version: '${M.version}' }`);
  });

  it('leg 5 (ANLWF-9): expandChain of exec-ops.daily-briefing is BYTE-IDENTICAL across two builds', () => {
    _resetChainRegistryForTest();
    const { errors } = loadWorkflowChainPacks({ roots: [join(REPO, 'examples', 'workflow-chain-packs')] });
    expect(errors, 'packs must load cleanly — otherwise this leg is vacuous').toEqual([]);
    const entry = getChain('exec-ops.daily-briefing');
    expect(entry, 'the chain must load').toBeTruthy();
    const params = { orgId: 'org-1', focusAreas: 'pipeline', provider: 'openai', model: 'gpt-4o-mini' };
    const a = expandChain(entry!.chain, { params });
    const b = expandChain(entry!.chain, { params });
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
