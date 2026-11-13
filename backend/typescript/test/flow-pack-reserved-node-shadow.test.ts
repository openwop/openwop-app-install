/**
 * #5808 — a pack never replaces a node the host registered itself.
 *
 * `core.openwop.flow` aliases the reserved `core.delay` to its own `waitNode`.
 * The loader registered every node a pack exports, and the registry's
 * `register` was a bare `set`, so the first run of any `core.flow.*` chain on an
 * instance swapped the host's `core.delay` for `waitNode` for every later run.
 * `waitNode` with `config: {}` fails `CONFIG_INVALID`, so plain delay workflows
 * started failing with `openwop-app.config_invalid` (certify 540/10, and real
 * user runs).
 *
 * Sabotage witnessed: `registerFromPack` as a bare set reds the first test
 * (`core.delay` resolves to the pack's module and fails), and so does the
 * loader calling `register` again.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import { loadPackFromManifest } from '../src/packs/tarballLoader.js';
import type { NodeContext } from '../src/executor/types.js';

const FLOW_PACK = fileURLToPath(new URL('../../../packs/core.openwop.flow', import.meta.url));

function ctxFor(nodeId: string): NodeContext {
  return {
    runId: 'r-5808', nodeId, config: {}, inputs: {},
    variables: { get: () => undefined, set: () => undefined },
  } as unknown as NodeContext;
}

describe('#5808 — host-owned typeIds survive a pack load', () => {
  it('core.delay stays the host node after the flow pack loads, and runs with config {}', async () => {
    ensureNodesRegistered();
    const registry = getNodeRegistry();
    const hostDelay = registry.get('core.delay');
    expect(hostDelay).not.toBeNull();

    await loadPackFromManifest(FLOW_PACK);

    // The pack loaded: its own nodes and the aliases the host does not own are there.
    expect(registry.has('core.flow.wait')).toBe(true);
    expect(registry.has('core.conditional')).toBe(true);
    // ...and the reserved id is still the host's module.
    const delay = await registry.resolve('core.delay');
    expect(delay).toBe(hostDelay);
    const outcome = await delay!.execute(ctxFor('delay'));
    expect(outcome).toMatchObject({ status: 'success' });
  });

  it('a later pack still replaces an earlier pack module for a typeId the host does not own', () => {
    const registry = getNodeRegistry();
    const first = { typeId: 'test.pack.only', version: '1.0.0', execute: async () => ({ status: 'success' as const, outputs: {} }) };
    const second = { ...first, version: '1.1.0' };
    expect(registry.registerFromPack(first)).toBe(true);
    expect(registry.registerFromPack(second)).toBe(true);
    expect(registry.get('test.pack.only')).toBe(second);
    expect(registry.registerFromPack({ ...first, typeId: 'core.delay' })).toBe(false);
  });
});
