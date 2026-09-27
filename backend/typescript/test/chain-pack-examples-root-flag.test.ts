/**
 * ADR 0626 P2 — `OPENWOP_WORKFLOW_CHAIN_EXAMPLES=0` drops the in-tree
 * `examples/workflow-chain-packs` root.
 *
 * Root 1 (`OPENWOP_WORKFLOW_CHAIN_PACKS_DIR`) is a PRECEDENCE override, not an
 * exclusive one — pinning your own chains still inherits every example chain
 * underneath. That is what let routine edits to `examples/` (a reworded
 * description is enough) reflow the `/builder` snapshot and decay its baseline
 * in days.
 *
 * The default must not move: absent the flag, examples still load. A flag that
 * silently changed the default would take the demo gallery away from every
 * existing deployment.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defaultWorkflowChainPackRoots } from '../src/host/workflowChainPackLoader.js';

const EXAMPLES = 'examples/workflow-chain-packs';
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

const hasExamplesRoot = (): boolean =>
  defaultWorkflowChainPackRoots().some((r) => r.replace(/\\/g, '/').endsWith(EXAMPLES));

describe('ADR 0626 P2 — the examples root is suppressible', () => {
  it('loads the in-tree examples root by DEFAULT (the flag is opt-in)', () => {
    delete process.env.OPENWOP_WORKFLOW_CHAIN_EXAMPLES;
    expect(hasExamplesRoot()).toBe(true);
  });

  it('drops it for `=0`', () => {
    process.env.OPENWOP_WORKFLOW_CHAIN_EXAMPLES = '0';
    expect(hasExamplesRoot()).toBe(false);
  });

  it('keeps it for any OTHER value — only an explicit `0` suppresses', () => {
    // Matches `OPENWOP_CHAIN_SUBCHAINS`'s `!== '0'` in the same module. A
    // truthiness test would make `false`, `off` and `no` all silently suppress
    // the gallery, which is the class of bug where an operator sets what they
    // think is the safe value and loses their catalogue.
    for (const v of ['1', 'true', 'false', 'off', '']) {
      process.env.OPENWOP_WORKFLOW_CHAIN_EXAMPLES = v;
      expect(hasExamplesRoot(), `value ${JSON.stringify(v)} must not suppress`).toBe(true);
    }
  });

  it('suppresses ONLY that root — an explicit override dir still applies', () => {
    process.env.OPENWOP_WORKFLOW_CHAIN_EXAMPLES = '0';
    process.env.OPENWOP_WORKFLOW_CHAIN_PACKS_DIR = '/tmp/pinned-chain-fixture';
    const roots = defaultWorkflowChainPackRoots();
    expect(roots).toContain('/tmp/pinned-chain-fixture');
    expect(hasExamplesRoot()).toBe(false);
    // …and the override keeps its precedence over the registry-install dir.
    expect(roots[0]).toBe('/tmp/pinned-chain-fixture');
  });
});
