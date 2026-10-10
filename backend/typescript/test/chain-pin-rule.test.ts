/**
 * ADR 0766 — RFC 0177 §E.1 exact pins for workflow-chain references
 * (`spec/v2/core/workflow-chain-packs.md` §"Exact pins").
 *
 * Pins, in the order the ADR's decisions land:
 *   D1  the rule has ONE owner (`host/chainPinRule.ts`) and reads all three
 *       reference sites — node `typeId`, `compensation.nodeTypeId`, and an
 *       external sub-chain's `ref.version`; normalization is idempotent;
 *   D2  the vendored/operator loader REFUSES an unpinned chain (unless its pack is
 *       on the shrinking ratchet) and refuses a range or a double pin outright —
 *       the same rule the registry install gate applies;
 *   D1  a registered chain carries BARE typeIds plus a `nodePins` side record;
 *   D4  expansion keeps definitions bare and records the pins in
 *       `metadata.expandedFrom.nodePins`;
 *   D3  a pin the installed version cannot honour is reported as an install gap.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chainPinFindings,
  normalizeChainPins,
  parseNodeRef,
  unmetNodePins,
} from '../src/host/chainPinRule.js';
import { checkPackManifestForMajor } from '../src/host/packManifestV2Gate.js';
import {
  _resetChainRegistryForTest,
  chainRequirements,
  expandChain,
  getChain,
  loadWorkflowChainPacks,
  type WorkflowChain,
} from '../src/host/workflowChainPackLoader.js';
import { __setUnpinnedChainPackWaiversForTests } from '../src/host/unpinnedChainPackAllowlist.js';

/** A synthetic pack the tests waive through the seam — the real ratchet is empty
 *  since ADR 0766 P3, so no real name can stand in for "a waived pack". */
const WAIVED = 'vendor.test.pin-waived';

afterEach(() => { _resetChainRegistryForTest(); __setUnpinnedChainPackWaiversForTests(null); });

type FixtureNode = { id: string; typeId: string; [key: string]: unknown };

function chain(nodes: FixtureNode[], extra: Record<string, unknown> = {}): WorkflowChain {
  return {
    chainId: 'pin.fixture',
    version: '1.0.0',
    label: 'Pin fixture',
    description: 'A chain whose references are the thing under test.',
    parameters: { type: 'object', properties: {} },
    dag: { nodes: nodes as WorkflowChain['dag']['nodes'] },
    ...extra,
  } as WorkflowChain;
}

function packRoot(name: string, nodes: FixtureNode[]): string {
  const root = mkdtempSync(join(tmpdir(), 'owp-chain-pin-'));
  mkdirSync(join(root, 'p'), { recursive: true });
  writeFileSync(join(root, 'p', 'pack.json'), JSON.stringify({
    name, version: '1.0.0', kind: 'workflow-chain', engines: { openwop: '>=1.0.0 <3.0.0' },
    chains: [{ ...chain(nodes), chainId: `${name}.chain` }],
  }));
  return root;
}

describe('ADR 0766 D1 — parseNodeRef', () => {
  it('splits an exact pin, and reads a missing or ranged suffix as unpinned', () => {
    expect(parseNodeRef('core.ai.callPrompt@1.0.0')).toEqual({ typeId: 'core.ai.callPrompt', version: '1.0.0', ranged: false });
    expect(parseNodeRef('core.ai.callPrompt')).toEqual({ typeId: 'core.ai.callPrompt', version: null, ranged: false });
    expect(parseNodeRef('core.ai.callPrompt@^1')).toEqual({ typeId: 'core.ai.callPrompt', version: null, ranged: true });
    // The rule follows the v2 typeId grammar: a prerelease node pin is not an exact pin.
    expect(parseNodeRef('core.ai.callPrompt@1.0.0-rc.1')).toMatchObject({ version: null, ranged: true });
  });
});

describe('ADR 0766 D1 — chainPinFindings reads every reference site', () => {
  it('a fully pinned chain has no findings', () => {
    expect(chainPinFindings(chain([{ id: 'n1', typeId: 'core.flow.noop@1.0.0' }]))).toEqual([]);
  });

  it('flags an unpinned node, a ranged node, and an unpinned compensation.nodeTypeId', () => {
    const findings = chainPinFindings(chain([
      { id: 'a', typeId: 'core.flow.noop' },
      { id: 'b', typeId: 'core.flow.delay@~1.0' },
      { id: 'c', typeId: 'core.http.request@1.0.0', compensation: { nodeTypeId: 'core.http.request' } },
    ]));
    expect(findings.map((f) => [f.site, f.problem])).toEqual([
      ['dag.nodes[a].typeId', 'unpinned'],
      ['dag.nodes[b].typeId', 'ranged'],
      ['dag.nodes[c].compensation.nodeTypeId', 'unpinned'],
    ]);
  });

  it('flags one type pinned to two versions as a conflict', () => {
    const findings = chainPinFindings(chain([
      { id: 'a', typeId: 'core.flow.noop@1.0.0' },
      { id: 'b', typeId: 'core.flow.noop@1.0.1' },
    ]));
    expect(findings).toEqual([expect.objectContaining({ site: 'dag.nodes[b].typeId', problem: 'conflict' })]);
  });

  it('refuses a ranged EXTERNAL sub-chain version and ignores a sibling string ref', () => {
    const findings = chainPinFindings(chain([{ id: 'a', typeId: 'core.flow.noop@1.0.0' }], {
      subChains: [{ ref: 'sibling.chain' }, { ref: { packName: 'core.x', chainId: 'c', version: '^1.0.0' } }],
    }));
    expect(findings).toEqual([expect.objectContaining({ site: 'subChains[1].ref.version', problem: 'ranged' })]);
  });

  it('the registry install gate applies the same rule — including compensation, which it used to skip', () => {
    const manifest = {
      name: 'core.openwop.pin-gate', version: '1.0.0', kind: 'workflow-chain', engines: { openwop: '>=1.0.0 <3.0.0' },
      chains: [chain([{ id: 'a', typeId: 'core.http.request@1.0.0', compensation: { nodeTypeId: 'core.http.request' } }])],
    };
    expect(checkPackManifestForMajor(manifest, 2)).toMatchObject({ code: 'validation_error' });
  });
});

describe('ADR 0766 D1 — normalizeChainPins', () => {
  it('lifts pins into a side record and leaves bare typeIds, in compensation too', () => {
    const { chain: bare, nodePins } = normalizeChainPins(chain([
      { id: 'a', typeId: 'core.flow.noop@1.0.0' },
      { id: 'b', typeId: 'core.http.request@2.1.0', compensation: { nodeTypeId: 'core.http.request@2.1.0' } },
    ]));
    expect(bare.dag.nodes.map((n) => n.typeId)).toEqual(['core.flow.noop', 'core.http.request']);
    expect(bare.dag.nodes[1]?.compensation?.nodeTypeId).toBe('core.http.request');
    expect(nodePins).toEqual({ 'core.flow.noop': '1.0.0', 'core.http.request': '2.1.0' });
  });

  it('is idempotent: a bare chain comes back as the SAME object with no pins', () => {
    const input = chain([{ id: 'a', typeId: 'core.flow.noop' }]);
    const out = normalizeChainPins(input);
    expect(out.chain).toBe(input);
    expect(out.nodePins).toEqual({});
  });
});

describe('ADR 0766 D2 — the vendored/operator loader refuses at register', () => {
  it('refuses an unpinned chain from a pack that is NOT on the ratchet', () => {
    const out = loadWorkflowChainPacks({ roots: [packRoot('vendor.test.pin-unlisted', [{ id: 'a', typeId: 'core.flow.noop' }])] });
    expect(out.errors).toEqual([expect.objectContaining({ pack: 'vendor.test.pin-unlisted', code: 'workflow_chain_unpinned' })]);
    expect(getChain('vendor.test.pin-unlisted.chain')).toBeNull();
  });

  it('refuses a node-level RANGE even from a pack the ratchet waives (the v2 schema catches this one)', () => {
    __setUnpinnedChainPackWaiversForTests([WAIVED]);
    const waived = WAIVED;
    const out = loadWorkflowChainPacks({ roots: [packRoot(waived, [{ id: 'a', typeId: 'core.flow.noop@^1' }])] });
    expect(out.errors).toHaveLength(1);
    expect(getChain(`${waived}.chain`)).toBeNull();
  });

  it('refuses a ranged EXTERNAL sub-chain version from a waived pack — the range only the host rule can catch', () => {
    __setUnpinnedChainPackWaiversForTests([WAIVED]);
    const waived = WAIVED;
    const root = mkdtempSync(join(tmpdir(), 'owp-chain-pin-ext-'));
    mkdirSync(join(root, 'p'), { recursive: true });
    writeFileSync(join(root, 'p', 'pack.json'), JSON.stringify({
      name: waived, version: '1.0.0', kind: 'workflow-chain', engines: { openwop: '>=1.0.0 <3.0.0' },
      chains: [{
        ...chain([{ id: 'a', typeId: 'core.flow.noop@1.0.0' }]),
        chainId: `${waived}.chain`,
        subChains: [{ ref: { packName: 'core.openwop.remote', chainId: 'c.remote', version: '^1.0.0' } }],
      }],
    }));
    const out = loadWorkflowChainPacks({ roots: [root] });
    expect(out.errors).toEqual([expect.objectContaining({ code: 'workflow_chain_pin_invalid' })]);
    expect(getChain(`${waived}.chain`)).toBeNull();
  });

  it('refuses a chain pinning one type to two versions', () => {
    const out = loadWorkflowChainPacks({ roots: [packRoot('vendor.test.pin-conflict', [
      { id: 'a', typeId: 'core.flow.noop@1.0.0' },
      { id: 'b', typeId: 'core.flow.noop@1.0.1' },
    ])] });
    expect(out.errors).toEqual([expect.objectContaining({ code: 'workflow_chain_pin_invalid' })]);
  });

  it('registers a pinned chain with BARE typeIds and its pins on the side (D1)', () => {
    const out = loadWorkflowChainPacks({ roots: [packRoot('vendor.test.pin-exact', [{ id: 'a', typeId: 'core.flow.noop@1.0.0' }])] });
    expect(out.errors).toEqual([]);
    const registered = getChain('vendor.test.pin-exact.chain');
    expect(registered?.chain.dag.nodes[0]?.typeId).toBe('core.flow.noop');
    expect(registered?.chain.nodePins).toEqual({ 'core.flow.noop': '1.0.0' });
  });

  it('still registers an unpinned chain from a pack the ratchet waives (P3 drains it)', () => {
    __setUnpinnedChainPackWaiversForTests([WAIVED]);
    const waived = WAIVED;
    const out = loadWorkflowChainPacks({ roots: [packRoot(waived, [{ id: 'a', typeId: 'core.flow.noop' }])] });
    expect(out.errors).toEqual([]);
    expect(getChain(`${waived}.chain`)?.chain.nodePins).toBeUndefined();
  });
});

describe('ADR 0766 D4 — expansion keeps definitions bare and records the pins', () => {
  it('a pinned chain expands to bare typeIds with metadata.expandedFrom.nodePins', () => {
    const def = expandChain(chain([{ id: 'a', typeId: 'core.flow.noop@1.0.0' }]));
    expect(def.nodes.map((n) => n.typeId)).toEqual(['core.flow.noop']);
    expect((def.metadata as { expandedFrom?: { nodePins?: unknown } }).expandedFrom?.nodePins).toEqual({ 'core.flow.noop': '1.0.0' });
  });

  it('an unpinned chain expands exactly as before — no nodePins key', () => {
    const def = expandChain(chain([{ id: 'a', typeId: 'core.flow.noop' }]));
    expect((def.metadata as { expandedFrom?: Record<string, unknown> }).expandedFrom).not.toHaveProperty('nodePins');
  });
});

describe('ADR 0766 D3 — an unhonourable pin is an install gap', () => {
  it('unmetNodePins reports only a type installed at a DIFFERENT version', () => {
    const installed: Record<string, string> = { 'core.flow.noop': '1.0.1', 'core.http.request': '2.1.0' };
    expect(unmetNodePins(
      { 'core.flow.noop': '1.0.0', 'core.http.request': '2.1.0', 'core.not.installed': '1.0.0' },
      (t) => installed[t],
    )).toEqual(['core.flow.noop@1.0.0']);
  });

  it('chainRequirements reports it in pinMismatches, labelled, NOT as a missing type (grade-ux U-1)', () => {
    const { chain: bare, nodePins } = normalizeChainPins(chain([
      { id: 'a', typeId: 'core.flow.noop@1.0.0' },
      { id: 'b', typeId: 'core.absent@1.0.0' },
    ]));
    const req = chainRequirements(
      { ...bare, nodePins },
      new Set(['core.flow.noop']),
      () => true,
      () => null,
      (t) => (t === 'core.flow.noop' ? { version: '1.0.1', label: 'No-op' } : undefined),
    );
    // An installed node is never "not installed" — that was the defect.
    expect(req.missingNodeTypeIds).toEqual(['core.absent']);
    expect(req.pinMismatches).toEqual([{ typeId: 'core.flow.noop', label: 'No-op', pinned: '1.0.0', installed: '1.0.1' }]);
  });

  it('an honoured pin and an unknown label both degrade cleanly', () => {
    const { chain: bare, nodePins } = normalizeChainPins(chain([
      { id: 'a', typeId: 'core.flow.noop@1.0.0' },
      { id: 'b', typeId: 'core.http.request@2.0.0' },
    ]));
    const req = chainRequirements(
      { ...bare, nodePins },
      new Set(['core.flow.noop', 'core.http.request']),
      () => true,
      () => null,
      (t) => ({ 'core.flow.noop': { version: '1.0.0' }, 'core.http.request': { version: '2.1.0' } } as Record<string, { version: string }>)[t],
    );
    expect(req.pinMismatches).toEqual([{ typeId: 'core.http.request', label: 'core.http.request', pinned: '2.0.0', installed: '2.1.0' }]);
  });
});
