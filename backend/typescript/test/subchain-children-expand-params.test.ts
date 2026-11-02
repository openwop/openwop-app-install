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
 *  2. A NON-funnel witness, red on main: the kicktodo challenge factory's
 *     `lesson-batch` child (candidate, days, the BYOK `credentialRef`s, …).
 *  3. No child reads a param through node CONFIG (grade-code FN72CD-1): deferred
 *     mode binds only whole-value INPUT tokens, so a config token freezes to nothing
 *     however the parent maps it. The funnel step chains' `provider`/`model` were
 *     exactly that and are removed in this change.
 *
 * Sabotage-witnessed: `asChild: false` in `coRegisterSubChains` turns 1 and 2 red;
 * a `{{params.provider}}` put back into a funnel step's copy-node config turns 3 red.
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
    expect(ps.length, 'the census: parents with sub-chains').toBeGreaterThanOrEqual(6);
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
          const expanded = childDef.nodes.find((x) => x.nodeId.endsWith(`_${node}`));
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

  it('a NON-funnel child: the kicktodo lesson-batch receives its candidate, days and credential refs', async () => {
    const factory = chainById('openwop-app.kicktodo.challenge-factory');
    expect(factory, 'the kicktodo challenge factory is loaded').toBeTruthy();
    const lessonBatch = (await registeredChildren(factory!)).find((d) => d.metadata?.chainId === 'openwop-app.kicktodo.lesson-batch');
    expect(lessonBatch, 'lesson-batch is co-registered').toBeTruthy();
    const build = lessonBatch!.nodes.find((n) => n.nodeId.endsWith('_lesson-batch-build'));
    expect(build).toBeTruthy();
    for (const p of ['candidateId', 'days', 'generateMedia', 'credentialRef', 'imageCredentialRef']) {
      expect((build!.inputs as Record<string, unknown>)[p], p).toEqual({ type: 'variable', variableName: p });
    }
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
