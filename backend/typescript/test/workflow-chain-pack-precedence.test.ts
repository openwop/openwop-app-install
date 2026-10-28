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
 *
 * > CORRECTED (wave 64): claim 1 has been false since WF-DUP-2. Same-pack
 * > resolution is VERSION-aware: the newer SemVer wins whichever root holds it,
 * > and `chain-pack-duplicate-drift.test.ts` ("a NEWER copy in a LOWER-precedence
 * > root wins…") owns that rule. This file's case 1 puts the newer copy in the
 * > higher root, so it cannot tell "precedence" from "version" and no longer
 * > claims either: it pins the quiet shadow (claim 2). Claims 3 and 4 stand;
 * > claim 4 now asserts all three roots, so dropping the install dir reds it
 * > (round 1 asserted only the ends: probe 8fw5g2-pp-roots-install-dropped).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
    // ADR 0766 — pinned: an unpinned chain from an unwaived pack is refused at register.
    dag: { nodes: [{ id: 'n1', typeId: 'core.openwop.transform@1.0.0' }] },
  }],
});

const tmpRoots: string[] = [];
const tmpRoot = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
};
const savedExamples = process.env.OPENWOP_WORKFLOW_CHAIN_EXAMPLES;

afterEach(() => {
  _resetChainRegistryForTest();
  delete process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR;
  if (savedExamples === undefined) delete process.env.OPENWOP_WORKFLOW_CHAIN_EXAMPLES; else process.env.OPENWOP_WORKFLOW_CHAIN_EXAMPLES = savedExamples;
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ADR 0370 — chain-pack root precedence', () => {
  it('the same pack in two roots shadows quietly (no conflict error), and only the winning copy is installed', () => {
    const installRoot = tmpRoot('owp-cp-install-');
    const vendorRoot = tmpRoot('owp-cp-vendor-');
    packDir(installRoot, 'exec-ops', manifest('vendor.openwop.exec-ops', '1.2.0', 'exec-ops.daily-briefing'));
    packDir(vendorRoot, 'exec-ops', manifest('vendor.openwop.exec-ops', '1.1.0', 'exec-ops.daily-briefing'));

    const out = loadWorkflowChainPacks({ roots: [installRoot, vendorRoot] });

    expect(out.errors).toEqual([]); // the noise case: NOT a conflict
    expect(out.installed).toHaveLength(1); // fully-shadowed twin not "installed"
    expect(out.installed[0]).toMatchObject({ packName: 'vendor.openwop.exec-ops', packVersion: '1.2.0' });
    expect(getChain('exec-ops.daily-briefing')?.packVersion).toBe('1.2.0'); // the newer copy (version rule: duplicate-drift)
  });

  it('a duplicate chainId from a DIFFERENT pack stays a hard error naming the winner', () => {
    const rootA = tmpRoot('owp-cp-a-');
    const rootB = tmpRoot('owp-cp-b-');
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
    delete process.env.OPENWOP_WORKFLOW_CHAIN_EXAMPLES;
    // The install dir is the per-worker OPENWOP_PACK_DIR set by test/setup/isolatePackDir.ts.
    const installDir = process.env.OPENWOP_PACK_DIR;
    expect(installDir, 'the test setup pins an install dir').toMatch(/^.+$/);
    expect(defaultWorkflowChainPackRoots()).toEqual([
      '/tmp/operator-packs',
      installDir,
      expect.stringMatching(/[/\\]examples[/\\]workflow-chain-packs$/),
    ]);
  });
});
