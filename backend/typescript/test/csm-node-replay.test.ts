/**
 * ADR 0645 D3 — `feature.csm.nodes.health-set` must never re-execute on a
 * `mode:'replay'` fork. The `crm-node-replay.test.ts` / `users-node-replay.test.ts`
 * shape, applied to the one CSM write node.
 *
 * WHY (CSMWF-3): at 1.3.0 `health-set` was `role:"action"` with no
 * `side-effectful` capability, and the pack header ASSERTED that this meant
 * "the engine records their outputs and replay/fork read the recorded result
 * rather than re-executing." That was false — the identical false claim
 * ADR 0587 §7 caught elsewhere and ADR 0627 D1 caught for CRM. MEASURED:
 * `git grep -nE "role\s*===\s*'action'" -- src/executor src/host` returns
 * NOTHING; `sideEffects.ts:185-190` states it verbatim. So `health-set` sat in
 * the manifest census only, and a `:fork` re-executed it against LIVE CRM state
 * and re-stamped a different score with a fresh `healthComputedAt`.
 *
 * The contrast was inside the same chain: `feature.crm.nodes.create-task`
 * declares `side-effect` + `side-effectful` and is floor-classified and served —
 * CSM's WRITER was classified like CRM's READERS.
 *
 * Legs:
 *   1. the manifest declares `side-effect` + `side-effectful` for `health-set`
 *      and ONLY it (`health-read` stays `action` — it is a pure read);
 *   2. the derived floor holds it AND the fast path SERVES it (membership alone
 *      is undischarged — ADR 0572);
 *   3. `isSideEffectingNode` — the exact predicate `executor.ts` branches on —
 *      returns true for it and false for the read;
 *   4. the feature pin equals the manifest version;
 *   5. CSMWF-6: `expandChain` is byte-identical across two builds of the same
 *      chain + params. The CMS pass has this assertion; the CSM pass did not,
 *      and `WORKFLOWS-ASSESSMENT.md` recorded the property as INFERRED.
 *
 * BORN RED: legs 2 and 3 fail against the 1.3.0 `action` role. Verified by
 * flipping the role back — see the ADR's implementation record.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { loadWorkflowChainPacks, getChain, expandChain, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MANIFEST = JSON.parse(readFileSync(join(REPO, 'packs', 'feature.csm.nodes', 'pack.json'), 'utf8')) as {
  version: string;
  nodes: { typeId: string; version: string; role: string; capabilities: string[] }[];
};
const WRITE = 'feature.csm.nodes.health-set';
const READ = 'feature.csm.nodes.health-read';

describe('ADR 0645 D3 — the CSM write node is classified, floored and served', () => {
  it('leg 1: the manifest declares side-effect + side-effectful for the WRITE node only', () => {
    const byId = new Map(MANIFEST.nodes.map((n) => [n.typeId, n]));
    expect(byId.get(WRITE)?.role).toBe('side-effect');
    expect(byId.get(WRITE)?.capabilities).toContain('side-effectful');
    // Non-vacuity in the other direction: the READ must NOT be widened. A pack
    // that declares everything side-effectful discharges nothing.
    expect(byId.get(READ)?.role).toBe('action');
    expect(byId.get(READ)?.capabilities ?? []).not.toContain('side-effectful');
  });

  it('leg 2: the derived floor HOLDS it and the fast path SERVES it', () => {
    // Floor membership alone is UNDISCHARGED (ADR 0572) — being in the floor
    // without being served means "classified but still re-executed", which is
    // exactly the state this fix exists to leave.
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has(WRITE), 'in the floor').toBe(true);
    expect(MANIFEST_FAST_PATH_SERVED.has(WRITE), 'and actually served').toBe(true);
    expect(MANIFEST_SIDE_EFFECT_FLOOR.has(READ), 'the read stays out').toBe(false);
  });

  it('leg 3: isSideEffectingNode — the predicate executor.ts branches on — says true', () => {
    expect(isSideEffectingNode(WRITE)).toBe(true);
    expect(isSideEffectingNode(READ)).toBe(false);
  });

  it('leg 4: the feature pin equals the manifest version', () => {
    const feature = readFileSync(join(REPO, 'backend', 'typescript', 'src', 'features', 'csm', 'feature.ts'), 'utf8');
    expect(feature).toContain(`{ name: 'feature.csm.nodes', version: '${MANIFEST.version}' }`);
  });

  it('leg 5 (CSMWF-6): expandChain is BYTE-IDENTICAL across two builds', () => {
    _resetChainRegistryForTest();
    const { errors } = loadWorkflowChainPacks({ roots: [join(REPO, 'examples', 'workflow-chain-packs')] });
    expect(errors, 'the pack must load cleanly — otherwise this leg is vacuous').toEqual([]);
    const entry = getChain('csm-ops.health-from-crm');
    expect(entry, 'the chain must load — otherwise this leg is vacuous').toBeTruthy();
    const params = { orgId: 'org-1', companyId: 'cmp:1', accountId: 'csm:1' };
    const a = expandChain(entry!.chain, { params });
    const b = expandChain(entry!.chain, { params });
    // Deep equality, not just the id shape: the prior pass asserted only that the
    // workflowId MATCHED a hash regex, which cannot see a non-deterministic node
    // id, edge order, or frozen config.
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
