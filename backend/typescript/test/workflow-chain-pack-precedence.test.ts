/**
 * ADR 0370 — chain-pack root precedence + same-pack shadowing. Pins:
 *  1. roots load in precedence order — the FIRST root's copy of a pack wins
 *     (a registry-installed update beats the vendored twin);
 *  2. the same pack appearing in a lower-precedence root shadows quietly —
 *     NOT a workflow_chain_id_conflict (the daily 51-rejection noise), and a
 *     fully-shadowed pack is not reported as installed;
 *  3. a duplicate chainId from a DIFFERENT pack stays a hard error naming the
 *     winning pack ("no silent shadow" between unrelated packs);
 *  4. defaultWorkflowChainPackRoots orders operator > install dir > examples.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadWorkflowChainPacks,
  getChain,
  defaultWorkflowChainPackRoots,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';

function packDir(root: string, dir: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'pack.json'), JSON.stringify(manifest));
}

const manifest = (name: string, version: string, chainId: string) => ({
  name, version, kind: 'workflow-chain', engines: { openwop: '>=1.0.0' },
  chains: [{
    chainId, version: '1.0.0', label: chainId, description: 'test chain', parameters: {},
    dag: { nodes: [{ id: 'n1', typeId: 'core.openwop.transform' }] },
  }],
});

afterEach(() => {
  _resetChainRegistryForTest();
  delete process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR;
});

describe('ADR 0370 — chain-pack root precedence', () => {
  it('the higher-precedence root wins and the twin shadows quietly (no conflict error)', () => {
    const installRoot = mkdtempSync(join(tmpdir(), 'owp-cp-install-'));
    const vendorRoot = mkdtempSync(join(tmpdir(), 'owp-cp-vendor-'));
    packDir(installRoot, 'exec-ops', manifest('vendor.openwop.exec-ops', '1.2.0', 'exec-ops.daily-briefing'));
    packDir(vendorRoot, 'exec-ops', manifest('vendor.openwop.exec-ops', '1.1.0', 'exec-ops.daily-briefing'));

    const out = loadWorkflowChainPacks({ roots: [installRoot, vendorRoot] });

    expect(out.errors).toEqual([]); // the noise case: NOT a conflict
    expect(out.installed).toHaveLength(1); // fully-shadowed twin not "installed"
    expect(out.installed[0]).toMatchObject({ packName: 'vendor.openwop.exec-ops', packVersion: '1.2.0' });
    expect(getChain('exec-ops.daily-briefing')?.packVersion).toBe('1.2.0'); // the UPDATE won
  });

  it('a duplicate chainId from a DIFFERENT pack stays a hard error naming the winner', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'owp-cp-a-'));
    const rootB = mkdtempSync(join(tmpdir(), 'owp-cp-b-'));
    packDir(rootA, 'first', manifest('vendor.openwop.first', '1.0.0', 'shared.chain'));
    packDir(rootB, 'second', manifest('vendor.openwop.second', '1.0.0', 'shared.chain'));

    const out = loadWorkflowChainPacks({ roots: [rootA, rootB] });

    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatchObject({ pack: 'vendor.openwop.second', code: 'workflow_chain_id_conflict' });
    expect(out.errors[0]!.message).toContain('vendor.openwop.first');
    expect(getChain('shared.chain')?.packName).toBe('vendor.openwop.first');
  });

  it('defaultWorkflowChainPackRoots orders operator dir > install dir > in-tree examples', () => {
    process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR = '/tmp/operator-packs';
    const roots = defaultWorkflowChainPackRoots();
    expect(roots[0]).toBe('/tmp/operator-packs');
    expect(roots[roots.length - 1]).toContain('examples');
  });
});
