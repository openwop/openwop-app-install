/**
 * ADR 1031 round 3 — three more host tables that a feature, first-party or an
 * adopter's, extends by DECLARATION (`BackendFeature.hostContributions`, recorded
 * once at composition by `host/featureContributions.ts`) instead of by editing an
 * upstream-owned file:
 *
 *  - `kbTenantNamespaces`: tenant-level KB namespaces (ADR 0830 D1). This was
 *    `TENANT_SCOPED_KB_ORGS` in `features/kb/kbService.ts`, which named `_kickbot`.
 *  - `kbManagedSources`: managed KB sources and the toggle their content is sold
 *    under (ADR 0820 G8). This was the `ManagedSource` union and
 *    `MANAGED_COLLECTION_OWNER`, which named `kickbot`.
 *  - `projectableComputeNodes`: pure compute nodes projected as live agent tools
 *    (ADR 0081 P3). This was `PROJECTABLE_COMPUTE_NODE_TYPE_IDS` in
 *    `host/agentToolProvider.ts`.
 *
 * Every table is ADD-ONLY. A declaration cannot override or remove a host entry,
 * whichever module loads first. Each case uses a FRESH module graph
 * (`vi.resetModules`), so it records stub features without the composed registry,
 * the same way an adopter checkout composes its own.
 *
 * Red when:
 *   - a shape check is dropped (L1);
 *   - a host value can be redeclared, in either load order (L2, L3, K3, P3);
 *   - two features can claim one value (L4);
 *   - the registry can record twice (L5);
 *   - a declared namespace or managed source is not seen by kbService (K1, K2);
 *   - an unknown managed source stops failing closed (K2);
 *   - a declared projection can replace a registered tool (P4), or registers twice
 *     (P5);
 *   - it runs without a `role:"pure"` manifest (P2), or is not gated on its
 *     declaring feature (P1).
 * The census over these declarations is test/feature-security-census.test.ts.
 *
 * No RFC needed. All three are host-internal tables:
 *   - KB org scoping and plan gating are host policy on host-local routes;
 *   - a projected tool is offered on the host's own chat lane.
 * None adds or changes a run event, endpoint contract, capability advert or schema
 * field, and the declaration lives in host TypeScript, not in a pack manifest.
 *
 * Sabotage-witnessed 2026-11-05 (/grade-tests w89), one edit at a time, each red on
 * its named case: each shape regex or the owner-toggle check dropped (L1); the
 * reserved check in `add` (L2) or in `reserveHostValues` (L3, K3, P3); the
 * two-owner check (L4); the record-once guard and the census line text (L5);
 * the declared namespaces or sources not read by kbService, or an unknown source
 * reading `null` (K1+K2); kbService or agentToolProvider not reserving its own
 * values (K3, P3); the pure check, the declared `schemaCarrying` (P1+P2); the
 * gate read from the typeId instead of the declaring feature, or the toggle
 * refusal returning another code (P1b); the no-replace and register-once guards
 * (P4+P5).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackendFeature } from '../src/features/types.js';
import type { FeatureHostContributions } from '../src/host/featureContributions.js';
import type { NodeModule } from '../src/executor/types.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';

type Leaf = typeof import('../src/host/featureContributions.js');
type Stub = Pick<BackendFeature, 'id' | 'hostContributions'>;

async function freshLeaf(): Promise<Leaf> {
  vi.resetModules();
  return import('../src/host/featureContributions.js');
}

afterEach(() => { vi.resetModules(); });

describe('the leaf — shape, add-only, one owner, once', () => {
  it('L1. a declaration of the wrong shape is a boot error', async () => {
    // Typed as the declaration shape so each literal is checked on its own, not as
    // one inferred union (which TS2322-fails on the optional keys).
    const bads: Array<[FeatureHostContributions, RegExp]> = [
      [{ kbTenantNamespaces: ['acme'] }, /kb tenant namespace 'acme' declared by 'acme' does not match/], // a namespace is `_<name>`
      [{ kbTenantNamespaces: ['_Acme'] }, /kb tenant namespace '_Acme' declared by 'acme' does not match/],
      [{ kbManagedSources: { 'Acme Notes': null } }, /kb managed source 'Acme Notes' declared by 'acme' does not match/],
      [{ kbManagedSources: { 'acme-notes': 'Not A Toggle' } }, /names owner 'Not A Toggle', which is neither a toggle id nor null/],
      [{ projectableComputeNodes: [{ typeId: 'nodots' }] }, /projected compute node 'nodots' declared by 'acme' does not match/],
    ];
    for (const [bad, message] of bads) {
      const leaf = await freshLeaf();
      expect(() => leaf.recordFeatureHostContributions([{ id: 'acme', hostContributions: bad }]), JSON.stringify(bad)).toThrow(message);
    }
  });

  it('L2. a feature cannot redeclare a host value (host module loaded FIRST)', async () => {
    const leaf = await freshLeaf();
    leaf.reserveHostValues('kb tenant namespace', ['_team']);
    expect(() => leaf.recordFeatureHostContributions([{ id: 'acme', hostContributions: { kbTenantNamespaces: ['_team'] } }])).toThrow(/is a host value/);
  });

  it('L3. …nor when the registry records first and the host module loads after', async () => {
    const leaf = await freshLeaf();
    leaf.recordFeatureHostContributions([{ id: 'acme', hostContributions: { kbManagedSources: { strategy: null } } }]);
    expect(() => leaf.reserveHostValues('kb managed source', ['strategy'])).toThrow(/is a host value; 'acme'/);
  });

  it('L4. two features cannot claim one value', async () => {
    const shared: FeatureHostContributions[] = [{ kbTenantNamespaces: ['_shared'] }, { kbManagedSources: { shared: null } }, { projectableComputeNodes: [{ typeId: 'vendor.x.nodes.y' }] }];
    for (const hc of shared) {
      const leaf = await freshLeaf();
      const both: Stub[] = [{ id: 'a', hostContributions: hc }, { id: 'b', hostContributions: hc }];
      expect(() => leaf.recordFeatureHostContributions(both)).toThrow(/declared by both 'a' and 'b'/);
    }
  });

  it('L5. the composed declarations are recorded once; the census lines name the owner', async () => {
    const leaf = await freshLeaf();
    leaf.recordFeatureHostContributions([{ id: 'acme', hostContributions: {
      kbTenantNamespaces: ['_acme'], kbManagedSources: { 'acme-notes': null, 'acme-paid': 'acme' },
      projectableComputeNodes: [{ typeId: 'vendor.acme.nodes.score', schemaCarrying: true }],
    } }]);
    expect(() => leaf.recordFeatureHostContributions([])).toThrow(/recorded twice/);
    expect(leaf.featureHostTableSurface().sort((a, b) => a.entry.localeCompare(b.entry))).toEqual([
      { featureId: 'acme', entry: 'kb-managed-source acme-notes -> (not plan-gated)' },
      { featureId: 'acme', entry: 'kb-managed-source acme-paid -> acme' },
      { featureId: 'acme', entry: 'kb-tenant-namespace _acme' },
      { featureId: 'acme', entry: 'projected-compute-node vendor.acme.nodes.score (schema-carrying)' },
    ]);
  });
});

describe('the KB tables read the host set ∪ the declared, and only add', () => {
  it('K1+K2. a declared namespace is tenant-scoped; a declared source has its owner; unknown fails closed; the host keeps its own', async () => {
    const leaf = await freshLeaf();
    leaf.recordFeatureHostContributions([{ id: 'acme', hostContributions: { kbTenantNamespaces: ['_acme'], kbManagedSources: { 'acme-notes': null, 'acme-paid': 'acme' } } }]);
    const kb = await import('../src/features/kb/kbService.js');
    expect(kb.isTenantScopedKbOrg('_acme')).toBe(true);
    expect(kb.TENANT_SCOPED_KB_ORGS.has('_acme'), 'the live view the org floor reads').toBe(true);
    expect(kb.TENANT_SCOPED_KB_ORGS.has('_team')).toBe(true);
    expect(kb.TENANT_SCOPED_KB_ORGS.has('_unlisted')).toBe(false);
    expect(kb.managedCollectionOwner('strategy')).toBe('strategy');
    expect(kb.managedCollectionOwner('acme-notes')).toBeNull();
    expect(kb.managedCollectionOwner('acme-paid')).toBe('acme');
    expect(kb.managedCollectionOwner('not-declared'), 'unknown ⇒ the plan gate hides the row').toBeUndefined();
    // The host no longer names any feature's namespace or source.
    expect([...kb.HOST_TENANT_SCOPED_KB_ORGS]).toEqual(['_team']);
    expect(Object.keys(kb.MANAGED_COLLECTION_OWNER).sort()).toEqual(['docs', 'priority-matrix', 'production', 'strategy']);
  });

  it('K3. a feature that redeclares `_team` or `strategy` (to un-gate it) fails when kbService loads', async () => {
    for (const hc of [{ kbTenantNamespaces: ['_team'] }, { kbManagedSources: { strategy: null } }]) {
      const leaf = await freshLeaf();
      leaf.recordFeatureHostContributions([{ id: 'acme', hostContributions: hc }]);
      await expect(import('../src/features/kb/kbService.js'), JSON.stringify(hc)).rejects.toThrow(/is a host value/);
    }
  });
});

describe('declared compute projections — add-only tools, gated, pure only', () => {
  const PURE = 'vendor.acme.nodes.score';
  const NOT_PURE = 'vendor.acme.nodes.push';

  async function compose(nodes: Array<{ typeId: string; schemaCarrying?: true }>) {
    const leaf = await freshLeaf();
    leaf.recordFeatureHostContributions([{ id: 'acme-feature', hostContributions: { projectableComputeNodes: nodes } }]);
    const atp = await import('../src/host/agentToolProvider.js');
    const { getNodeRegistry } = await import('../src/executor/nodeRegistry.js');
    const { __setNodeRolesForTests } = await import('../src/host/nodeCatalogBuilder.js');
    return { leaf, atp, getNodeRegistry, __setNodeRolesForTests };
  }

  it('P1+P2. registers the tool, gated on the declaring feature, refusing unless the manifest says pure', async () => {
    const { atp, getNodeRegistry, __setNodeRolesForTests } = await compose([{ typeId: PURE, schemaCarrying: true }, { typeId: NOT_PURE }]);
    expect(atp.registerDeclaredComputeProjections().sort()).toEqual([`openwop:${NOT_PURE}`, `openwop:${PURE}`]);
    const tool = atp.builtinAgentTool(`openwop:${PURE}`);
    expect(tool).toMatchObject({ effect: 'read', contentTrust: 'untrusted', schemaCarrying: true });
    expect(atp.builtinAgentTool(`openwop:${NOT_PURE}`)?.schemaCarrying).toBeUndefined();

    let ran = 0;
    for (const typeId of [PURE, NOT_PURE]) {
      const node: NodeModule = { typeId, version: '1.0.0', async execute(ctx) { ran += 1; return { status: 'success', outputs: { echoed: ctx.inputs } }; } };
      getNodeRegistry().register(node);
    }
    __setNodeRolesForTests({ [PURE]: 'pure', [NOT_PURE]: 'side-effect' });
    try {
      const scope: BundleScope = { tenantId: 't-r3', runId: 'r-r3' };
      const refused = await atp.builtinAgentTool(`openwop:${NOT_PURE}`)!.run({ a: 1 }, scope);
      expect(refused.isError).toBe(true);
      expect(refused.content).toContain('node_not_projectable');
      expect(ran, 'a non-pure declared node never executes').toBe(0);
      // No toggle is registered for 'acme-feature' ⇒ always-on, served.
      const ok = await tool!.run({ a: 1 }, scope);
      expect(ok.isError, ok.content).toBeFalsy();
      expect(JSON.parse(ok.content)).toEqual({ echoed: { a: 1 } });
      expect(ran).toBe(1);
      // The manifest role is read at CALL time: demote it and the tool refuses.
      __setNodeRolesForTests({ [PURE]: 'action' });
      expect((await tool!.run({ a: 1 }, scope)).content).toContain('node_not_projectable');
    } finally {
      __setNodeRolesForTests(null);
    }
  });

  it('P1b. the declared tool is gated on the DECLARING feature (a disabled toggle refuses it)', async () => {
    const { atp, __setNodeRolesForTests } = await compose([{ typeId: PURE }]);
    atp.registerDeclaredComputeProjections();
    const { registerToggleDefault } = await import('../src/host/featureToggles/registry.js');
    registerToggleDefault({ id: 'acme-feature', label: 'Acme', status: 'off', bucketUnit: 'tenant', salt: 'acme-feature' });
    // The resolver reads tenant overrides from host-ext storage. Without it the read
    // throws and the gate fails closed as `feature_unavailable`, so the toggle branch
    // this case claims is never reached (w89: the old any-of-three regex hid that).
    const { initHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
    const { openStorage } = await import('../src/storage/index.js');
    const storage = await openStorage('memory://');
    initHostExtPersistence(storage);
    __setNodeRolesForTests({ [PURE]: 'pure' });
    try {
      const scope: BundleScope = { tenantId: 't-r3b', runId: 'r' };
      const r = await atp.builtinAgentTool(`openwop:${PURE}`)!.run({}, scope);
      expect(r.isError).toBe(true);
      // The toggle refusal itself (`toolError` writes `{ error, message }`), not any refusal.
      expect(JSON.parse(r.content)).toEqual({ error: 'feature_disabled', message: 'The acme-feature feature is not enabled for this workspace.' });
    } finally {
      __setNodeRolesForTests(null);
      await storage.close();
    }
  });

  it('P3. a feature cannot redeclare a HOST projection (fails when agentToolProvider loads)', async () => {
    const leaf = await freshLeaf();
    leaf.recordFeatureHostContributions([{ id: 'acme-feature', hostContributions: { projectableComputeNodes: [{ typeId: 'core.flow.aggregate-text' }] } }]);
    await expect(import('../src/host/agentToolProvider.js')).rejects.toThrow(/is a host value/);
  });

  it('P4+P5. a declaration never replaces a registered tool, and the set is registered once', async () => {
    const { atp } = await compose([{ typeId: 'knowledge.search' }]); // tool name `openwop:knowledge.search` is a builtin
    const before = atp.builtinAgentTool('openwop:knowledge.search');
    expect(before).toBeDefined();
    expect(() => atp.registerDeclaredComputeProjections()).toThrow(/already registered; a declaration may add a tool, never replace one/);
    expect(atp.builtinAgentTool('openwop:knowledge.search'), 'the builtin is untouched').toBe(before);
    expect(() => atp.registerDeclaredComputeProjections()).toThrow(/registered twice/);
  });
});
