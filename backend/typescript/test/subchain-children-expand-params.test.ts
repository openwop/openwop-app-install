/**
 * ADR 1023 D2 (FN72WF-3) — a sub-chain CHILD receives what its parent maps.
 *
 * `coRegisterSubChains` (the gallery / `from-chain` lane) used to expand every child
 * Path-A with `params: {}`. Path A drops each `{{params.x}}` it cannot resolve, so a
 * gallery copy's child nodes lost every input the parent's `core.subWorkflow`
 * `inputMapping` seeds into the child's bag — and the child variables the loader
 * declared for exactly those values were read by nothing. A child now expands
 * DEFERRED with bare param names (`restoreBareParamNames`, shared with the same-id
 * chain-backed lane), so each such input reads the bag variable dispatch seeds.
 *
 *  1. Every loaded parent with sub-chains: each child node input authored as a
 *     whole-value `{{params.X}}` is the variable binding `X`, and `X` is declared.
 *     Replay: the child's expansion id and its node ids are the ones Path A
 *     produced, so a run recorded before the fix re-resolves the same id and the
 *     same node ids.
 *  2. A NON-funnel witness, red on main, lives with its owner:
 *     test/kicktodo/kicktodo-subchain-children-expand-params.test.ts (ADR 1031 P2).
 *  3. No child reads a param through node CONFIG (grade-code FN72CD-1): deferred
 *     mode binds only whole-value INPUT tokens, so a config token freezes to nothing
 *     however the parent maps it. The funnel step chains' `provider`/`model` were
 *     exactly that and are removed in this change.
 *
 * Sabotage-witnessed (wave 92 probes): `asChild: false` in `coRegisterSubChains` turns
 * case 1 red here (and the KickTodo witness, item 2, red downstream); so do a
 * `restoreBareParamNames` input rewrite left on the materialized name and an expansion
 * id that hashes deferred mode differently from Path A (the replay half). A
 * `{{params.provider}}` put into a child node's config turns case 2 red.
 *
 * DOUBLE GUARD on "X is declared": `restoreBareParamNames` renames the materialized
 * variable to the bare name AND `coRegisterSubChains` appends `childInputVars` (every
 * child parameter, bare). Breaking either alone stays green by design; one edit that
 * drops both at the child `variables:` line turns case 1 red.
 *
 * Census floors (measured 5161aec5e): 5 parents, 12 co-registered children, 42 bound
 * inputs (floor >20), 11 distinct children (floor >=10). Tightening the slack floors is
 * a human decision (TST-GUA-H1).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { listChains, coRegisterSubChains, expandChain, reloadWorkflowChainPacks, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

/** Every whole-value `{{params.NAME}}` an authored node input carries. */
function wholeParamInputs(chain: WorkflowChain): Array<{ node: string; port: string; param: string }> {
  const out: Array<{ node: string; port: string; param: string }> = [];
  for (const node of chain.dag.nodes) {
    for (const [port, val] of Object.entries((node.inputs ?? {}) as Record<string, unknown>)) {
      const m = typeof val === 'string' ? /^\{\{\s*params\.([a-zA-Z0-9_]+)\s*\}\}$/.exec(val) : null;
      if (m) out.push({ node: node.id, port, param: m[1]! });
    }
  }
  return out;
}

const chainById = (id: string): WorkflowChain | undefined => listChains().find((e) => e.chain.chainId === id)?.chain;
const parents = (): WorkflowChain[] => listChains().filter((e) => (e.chain.subChains?.length ?? 0) > 0).map((e) => e.chain);
const childIdsOf = (c: WorkflowChain): string[] => (c.subChains ?? []).map((sc) => (typeof sc.ref === 'string' ? sc.ref : sc.ref.chainId));

async function registeredChildren(parent: WorkflowChain): Promise<WorkflowDefinition[]> {
  const registered: WorkflowDefinition[] = [];
  await coRegisterSubChains(parent, { params: {}, tenantId: 't-subchain-params' }, { register: (d) => { registered.push(d); }, own: async () => {}, supported: true });
  return registered;
}

// The REAL loader over the shipped pack roots (no synthetic registry).
beforeAll(() => { reloadWorkflowChainPacks(); });

describe('ADR 1023 D2 — sub-chain children bind what their parent maps', () => {
  it('every loaded child binds each param input to its bare bag variable; ids and node ids are unchanged', async () => {
    const ps = parents();
    // 5 first-party parents since KickTodo's challenge factory left (ADR 1031 P3); its
    // lesson-batch leg runs downstream in test/kicktodo/kicktodo-subchain-children-expand-params.
    expect(ps.length, 'the census: parents with sub-chains').toBeGreaterThanOrEqual(5);
    let children = 0;
    let bound = 0;
    for (const parent of ps) {
      for (const childDef of await registeredChildren(parent)) {
        children += 1;
        const childChainId = String(childDef.metadata?.chainId ?? '');
        const child = chainById(childChainId);
        expect(child, `${parent.chainId} → ${childChainId} must resolve`).toBeTruthy();
        const pathA = expandChain(child!, { params: {} });
        expect(childDef.metadata?.expansionId, childChainId).toBe(pathA.metadata?.expansionId);
        expect(childDef.nodes.map((x) => x.nodeId).sort(), childChainId).toEqual(pathA.nodes.map((x) => x.nodeId).sort());
        for (const { node, port, param } of wholeParamInputs(child!)) {
          // Exact id, not a suffix match: `copy` must never match `repair_copy`. The
          // documented shape is `<chainSlug>_<expansionId>_<node>`, read from Path A.
          const prefix = `${child!.chainId.replace(/\./g, '_')}_${String(pathA.metadata?.expansionId)}_`;
          const expanded = childDef.nodes.find((x) => x.nodeId === `${prefix}${node}`);
          expect(expanded, `${childChainId}.${node}`).toBeTruthy();
          expect((expanded!.inputs as Record<string, unknown>)[port], `${childChainId}.${node}.${port}`).toEqual({ type: 'variable', variableName: param });
          expect((childDef.variables ?? []).map((v) => v.name), `${childChainId} declares ${param}`).toContain(param);
          bound += 1;
        }
      }
    }
    expect(children, 'the census: co-registered children').toBeGreaterThanOrEqual(12);
    expect(bound, 'children read params').toBeGreaterThan(20);
  });

  it('no sub-chain child reads a parameter through node config (it could never arrive)', () => {
    const ids = new Set(parents().flatMap(childIdsOf));
    expect(ids.size, 'the census: distinct children').toBeGreaterThanOrEqual(10);
    const offenders: string[] = [];
    for (const id of ids) {
      const child = chainById(id);
      // An unresolved child is a FAILURE here, never a skip: a skip would let this
      // scan go quiet if the binding test above were ever removed.
      expect(child, `child ${id} must resolve`).toBeTruthy();
      for (const node of child!.dag.nodes) {
        if (/\{\{\s*params\./.test(JSON.stringify(node.config ?? {}))) offenders.push(`${id}.${node.id}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
