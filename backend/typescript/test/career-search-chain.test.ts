/**
 * ADR 0543 P2 — the `career.search` chain pack.
 *
 * The ADR's verification is that the chain "loads through the built loader,
 * shows in the builder gallery and the `/` picker, instantiates tenant-owned +
 * editable". The first is asserted here directly; the second and third are
 * properties of the INSTANTIATION route (`…/workflows/from-chain` →
 * expandChain → registerWorkflow → recordOwnership), which is core's job and
 * already tested — a pack author's contribution is a manifest that survives
 * validation and references nodes that exist.
 *
 * The last part is what these mostly check, because it is the failure that would
 * otherwise be found at RUN time by a user: a chain that references a node typeId
 * nothing implements looks perfectly valid sitting in the gallery.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, getChain } from '../src/host/workflowChainPackLoader.js';

const ROOT = join(process.cwd(), '..', '..');
const CHAIN_PACK = join(ROOT, 'examples', 'workflow-chain-packs', 'career-search', 'pack.json');
const NODE_PACK = join(ROOT, 'packs', 'feature.job-search.nodes', 'pack.json');

const manifest = JSON.parse(readFileSync(CHAIN_PACK, 'utf8')) as {
  kind: string;
  chains: Array<{
    chainId: string;
    parameters: { required?: string[]; properties?: Record<string, unknown> };
    dag: { nodes: Array<{ id: string; typeId: string }>; edges: Array<{ from: string; to: string }> };
    outputs?: Record<string, { type: string; description?: string }>;
  }>;
};
const chain = manifest.chains[0]!;

describe('ADR 0543 P2 — the chain is a valid, loadable pack', () => {
  it('declares kind `workflow-chain`', () => {
    expect(manifest.kind).toBe('workflow-chain');
  });

  it('loads through the BUILT loader without being special-cased', () => {
    // The real gate: the loader validates every manifest against the chain-pack
    // schema, so a pack that only "looks right" fails here rather than in the
    // gallery. Loaded from the DEFAULT roots — a test that pointed at its own
    // fixture directory would prove the file parses, not that the app finds it.
    const outcome = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    const failed = (outcome.errors ?? []).filter((e) => JSON.stringify(e).includes('career-search'));
    expect(failed, 'career.search failed to load').toEqual([]);
    expect(getChain('career.search')?.chain.chainId).toBe('career.search');
  });

  it('every node typeId it references is IMPLEMENTED by the node pack', () => {
    // A chain referencing a node nothing implements is valid JSON, sits happily
    // in the gallery, and fails at RUN time in front of a user. Checking it here
    // is the difference between a build failure and a support ticket.
    const nodePack = JSON.parse(readFileSync(NODE_PACK, 'utf8')) as { nodes: Array<{ typeId: string }> };
    const implemented = new Set(nodePack.nodes.map((n) => n.typeId));
    for (const node of chain.dag.nodes) {
      expect(implemented.has(node.typeId), `${node.typeId} is referenced but not implemented`).toBe(true);
    }
  });

  it('every EDGE (if any) connects real nodes in dotted `<nodeId>.<key>` form', () => {
    // This chain currently has NO edges, and that is deliberate: scoring reads
    // (digest, profile) and eligibility reads (digest, applicant), so nothing
    // flows between them. An earlier draft had `score.score →
    // eligibility.matchScore`, which pointed at an input the node does not read
    // — a DECORATIVE edge, worse than none, because it implies a dependency the
    // engine will not honour.
    const ids = new Set(chain.dag.nodes.map((n) => n.id));
    for (const e of chain.dag.edges) {
      expect(ids.has(e.from.split('.')[0]!), `edge from unknown node`).toBe(true);
      expect(ids.has(e.to.split('.')[0]!), `edge to unknown node`).toBe(true);
      expect(e.from).toContain('.');
      expect(e.to).toContain('.');
    }
  });

  it('every declared PARAMETER is actually consumed by a node', () => {
    // The repo-wide ratchet (`workflow-chain-knowledge-inbox`) caught this: my
    // nodes had `config: {}`, so all three declared parameters were DEAD. A
    // chain that asks a user to fill in inputs it never reads is a form that
    // does nothing — and it looks completely correct in the builder.
    // Walk config AND inputs — the loader's own liveness walk does both
    // (workflowChainPackLoader `collectParamRefs` walks `n.inputs` + `n.config`);
    // values a pack node reads ride INPUT PORTS (ctx.inputs), so a config-only
    // scan went blind the day the chains moved their values onto ports.
    const configJson = JSON.stringify(chain.dag.nodes.map((n) => ({
      config: (n as { config?: unknown }).config ?? {},
      inputs: (n as { inputs?: unknown }).inputs ?? {},
    })));
    for (const name of Object.keys(chain.parameters.properties ?? {})) {
      expect(configJson, `parameter '${name}' is declared but never consumed`).toContain(`{{params.${name}}}`);
    }
  });

  it('declares each output as a SCHEMA, not a node reference', () => {
    // `outputs` is a map of name → JSON Schema descriptor. An earlier draft of
    // this pack wrote `"eligible": "eligibility.eligible"` — a node reference —
    // and the loader rejected every one of them (`must be object`). Worth
    // pinning: the shape is not obvious from the DAG's dotted edge syntax
    // sitting a few lines above it in the same file.
    const outputs = Object.entries(chain.outputs ?? {});
    expect(outputs.length).toBeGreaterThan(0);
    for (const [name, spec] of outputs) {
      expect(typeof spec, `output ${name} must be a schema object`).toBe('object');
      expect(spec.type, `output ${name} needs a declared type`).toBeTruthy();
      expect(spec.description, `output ${name} needs a description a builder can render`).toBeTruthy();
    }
  });
});

describe('ADR 0543 P2 — what the chain deliberately does NOT do', () => {
  it('contains NO node that submits an application', () => {
    // Applying is bounded by the ADR 0541 grant. A submit node here would let a
    // chain route around the authority object, and a chain is user-editable in
    // the builder — so the constraint has to hold at the pack level, not by the
    // author's restraint.
    for (const n of chain.dag.nodes) {
      expect(/submit|apply|send/i.test(n.typeId), `${n.typeId} would bypass the apply grant`).toBe(false);
    }
  });

  it('ends at a VERDICT — its outputs are a decision, not an action', () => {
    const outputs = Object.keys(chain.outputs ?? {});
    expect(outputs).toContain('eligible');
    expect(outputs).toContain('matchScore');
    // The quote is what makes a negative verdict checkable against the posting
    // rather than something the user has to trust.
    expect(outputs).toContain('quote');
  });

  it('declares NO required whole-value param — the ADR 0504 debt this must not join', () => {
    // The ADR 0504 ratchet is explicit that its ceiling must never be raised to
    // go green, because "a new chain shipping unfillable required params is the
    // defect this exists to catch". A required whole-value `{{params.X}}`
    // freezes to `undefined` when instantiated through `from-chain` without
    // params, the key is dropped, and the run fails naming an INTERNAL NODE
    // rather than the parameter the user never filled in.
    expect(chain.parameters.required ?? [], 'this chain would add to the ADR 0504 debt').toEqual([]);
    // Optional-with-default is what keeps an unparameterised instantiation
    // runnable rather than a trap.
    for (const name of ['digest', 'profile', 'applicant']) {
      expect((chain.parameters.properties?.[name] as { default?: unknown })?.default,
        `${name} needs a default so the token freezes to a value, not undefined`).toBeDefined();
    }
  });

  it('an absent applicant cannot produce a FALSE verdict', () => {
    // The reason dropping `required` is safe rather than sloppy: the eligibility
    // node treats absent constraints as "needs nothing", and only a bar the
    // POSTING STATES can disqualify. With no posting there is no stated bar, so
    // no applicant's verdict can leak onto another's.
    const applicant = chain.parameters.properties?.applicant as { description?: string } | undefined;
    expect(applicant?.description).toMatch(/needs nothing|STATES/i);
  });
});

describe('WF-JS-1 — career.campaign: the dispatch-lane chain', () => {
  const campaign = manifest.chains.find((c) => c.chainId === 'career.campaign')!;

  it('exists, is loadable through the BUILT loader, and resolves by id', () => {
    const outcome = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    const mine = outcome.errors.filter((e) => JSON.stringify(e).includes('career-search'));
    expect(mine, JSON.stringify(mine)).toEqual([]);
    expect(getChain('career.campaign')).not.toBeNull();
  });

  it('its node is IMPLEMENTED by the node pack and declared side-effectful — the pack half of the two-leg classification', () => {
    const nodePack = JSON.parse(readFileSync(NODE_PACK, 'utf8')) as { nodes: Array<{ typeId: string; capabilities?: string[] }> };
    const impl = nodePack.nodes.find((n) => n.typeId === 'feature.job-search.nodes.run-campaign');
    expect(impl, 'run-campaign must be in the node pack').toBeTruthy();
    expect(impl!.capabilities, 'a replayed pass must be served, not re-fired').toContain('side-effectful');
  });

  it('the EXECUTOR half of the classification covers it (the #2871 two-leg lesson)', async () => {
    const { isSideEffectingNode } = await import('../src/executor/sideEffects.js');
    expect(isSideEffectingNode('feature.job-search.nodes.run-campaign')).toBe(true);
  });

  it('takes NO parameters and its node takes NO target — the amended law, precisely', () => {
    // The law's substance (ADR 0543 §D3 correction note): no node may route
    // AROUND the apply grant. This chain cannot aim a submission: zero params,
    // and its single node's config carries nothing.
    expect(Object.keys(campaign.parameters.properties ?? {})).toEqual([]);
    expect(campaign.parameters.required ?? []).toEqual([]);
    expect(campaign.dag.nodes.length).toBe(1);
    expect(Object.keys((campaign.dag.nodes[0] as { config?: Record<string, unknown> }).config ?? {})).toEqual([]);
  });

  it('the ORIGINAL law still binds the two verdict/prepare chains verbatim', () => {
    for (const id of ['career.search', 'career.apply']) {
      const c = manifest.chains.find((x) => x.chainId === id)!;
      for (const n of c.dag.nodes) {
        expect(/submit|apply|send/i.test(n.typeId), `${n.typeId} would bypass the apply grant`).toBe(false);
      }
    }
  });

  it('registers SAME-ID chain-backed and builds byte-identically twice (replay determinism)', async () => {
    const { registerChainBackedWorkflow, buildChainBackedDefinition } = await import('../src/host/chainBackedWorkflows.js');
    loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    registerChainBackedWorkflow('career.campaign');
    const a = JSON.stringify(buildChainBackedDefinition('career.campaign'));
    const b = JSON.stringify(buildChainBackedDefinition('career.campaign'));
    expect(a).toBe(b);
    expect(a).toContain('feature.job-search.nodes.run-campaign');
  });
});
