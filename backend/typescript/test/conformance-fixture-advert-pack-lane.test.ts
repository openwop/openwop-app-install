/**
 * WS0 — the fixture advert's resolvability check has TWO lanes, the same two
 * `NodeRegistry.resolve()` walks: in-process registration and an installed
 * pack whose manifest declares the typeId. The ratchet in
 * `conformance-fixture-advert-gating.test.ts` runs with no pack resolver
 * installed (vitest isolates the pack dir), so it only ever exercises the first
 * lane. This file installs a probe and proves the second lane is consulted —
 * without it, a broken probe would silently withhold every pack-backed fixture
 * (`core.ai.structuredOutput` from `core.openwop.ai` backs ten of them) in a real
 * boot while every test stayed green. Its own file because the resolver is a
 * process-global the other file must not inherit.
 *
 * Tracker: TST-CGK-5 (WS0, 2026-09-24 — the structural advert rule in
 * host/index.ts `fixtureIsAdvertisable`). Red when `NodeRegistry.isResolvable`
 * (executor/nodeRegistry.ts) stops consulting the installed-pack probe.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

beforeAll(async () => {
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'true';
  const { ensureNodesRegistered } = await import('../src/bootstrap/nodes.js');
  ensureNodesRegistered();
});

afterAll(async () => {
  // The resolver is process-global: leave none installed behind this file.
  const { setNodePackResolver } = await import('../src/executor/nodeRegistry.js');
  setNodePackResolver(async () => null);
});

describe('fixture advert — the installed-pack lane of isResolvable', () => {
  it('a fixture whose node only a PACK declares is withheld without the probe and advertised with it', async () => {
    const { listLoadedConformanceFixtures } = await import('../src/host/index.js');
    const { setNodePackResolver, getNodeRegistry } = await import('../src/executor/nodeRegistry.js');
    const PACK_ONLY = 'vendor.openwop.rust-hello.greet';
    expect(getNodeRegistry().has(PACK_ONLY), 'premise: not registered in-process').toBe(false);

    setNodePackResolver(async () => null, () => false);
    expect(listLoadedConformanceFixtures()).not.toContain('conformance-wasm-pack-roundtrip');

    setNodePackResolver(async () => null, (typeId) => typeId === PACK_ONLY);
    expect(getNodeRegistry().isResolvable(PACK_ONLY)).toBe(true);
    expect(listLoadedConformanceFixtures()).toContain('conformance-wasm-pack-roundtrip');
  });
});
