/**
 * ADR 0858 P3 storage follow-up — the storage probe has its OWN gate.
 *
 * It first shipped behind `conformanceNodesEnabled()`, and production runs with
 * that switch OFF, so prod kept advertising storage = [queueBus] after the probe
 * deployed (measured on 3b41066dc). These legs boot the registry the way prod
 * does — conformance nodes off — and pin that the probe, its fixture and the five
 * families still appear; and that `OPENWOP_CONFORMANCE_STORAGE_PROBE=false` takes
 * all three away together. Each leg resets the module graph, because registration
 * is a boot snapshot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV = ['OPENWOP_ENABLE_CONFORMANCE_NODES', 'OPENWOP_CONFORMANCE_STORAGE_PROBE'] as const;
const saved = new Map(ENV.map((k) => [k, process.env[k]]));
afterEach(() => { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

async function bootLikeProd(probe: 'default' | 'false') {
  vi.resetModules();
  process.env.OPENWOP_ENABLE_CONFORMANCE_NODES = 'false';
  if (probe === 'false') process.env.OPENWOP_CONFORMANCE_STORAGE_PROBE = 'false';
  else delete process.env.OPENWOP_CONFORMANCE_STORAGE_PROBE;
  const { ensureNodesRegistered } = await import('../src/bootstrap/nodes.js');
  ensureNodesRegistered();
  const { getNodeRegistry } = await import('../src/executor/nodeRegistry.js');
  const { listLoadedConformanceFixtures } = await import('../src/host/index.js');
  const { v2AdvertisedStorageFamilies } = await import('../src/host/storageFamilyAdvert.js');
  return {
    resolves: getNodeRegistry().isResolvable('core.conformance.storage-probe'),
    mockAgentResolves: getNodeRegistry().isResolvable('core.conformance.mock-agent'),
    fixtures: listLoadedConformanceFixtures(),
    families: v2AdvertisedStorageFamilies(),
  };
}

describe('storage probe gate — independent of the conformance-nodes switch', () => {
  it('with conformance nodes OFF (the prod posture) the probe, its fixture and the five families are advertised', async () => {
    const b = await bootLikeProd('default');
    expect(b.mockAgentResolves, 'control: the posture really is nodes-off').toBe(false);
    expect(b.resolves).toBe(true);
    expect(b.fixtures).toContain('conformance-storage-probe');
    expect(b.families).toEqual(['queueBus', 'kvStorage', 'cache', 'tableStorage', 'vectorStore', 'sql', 'blobStorage']);
  }, 60_000);

  it('OPENWOP_CONFORMANCE_STORAGE_PROBE=false withdraws the node, the fixture and the families together', async () => {
    const b = await bootLikeProd('false');
    expect(b.resolves).toBe(false);
    expect(b.fixtures).not.toContain('conformance-storage-probe');
    expect(b.families).toEqual(['queueBus']);
  }, 60_000);
});
