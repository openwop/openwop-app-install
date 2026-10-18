/**
 * NP-V2-7 — agent-pack peer-dependency satisfaction reads the v2 spelling, and
 * never claims more than the v2 discovery document advertises.
 *
 * `capabilities.md` §2: presence on the document IS the claim. So the satisfier's
 * v2 table is a subset of the families `buildV2Advertisement` actually carries,
 * and every facet it claims is on that family's record. A satisfier that says
 * "yes" to a family the host does not advertise is the same dishonest wire claim
 * as advertising it, one layer in.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { AppConfig } from '../src/index.js';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import { hostSatisfies, v2SatisfiedFamilies } from '../src/bootstrap/agentPackResolver.js';
import { resolveDependencyDisposition } from '../src/packs/agentLoader.js';

const CONFIG = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false } as AppConfig;
let advertised: Record<string, unknown>;

beforeAll(async () => {
  await createApp(CONFIG);
  advertised = buildV2Advertisement(CONFIG);
}, 120_000);

describe('NP-V2-7 — the v2 satisfier is a subset of the v2 advertisement', () => {
  it('every family it satisfies is advertised, and every claimed facet is on that record', () => {
    const table = v2SatisfiedFamilies();
    expect(table.size, 'an empty table would pass vacuously').toBeGreaterThan(0);
    for (const [family, facets] of table) {
      const record = advertised[family];
      expect(record, `the satisfier claims v2 family "${family}", which the v2 document does not advertise`).toBeTruthy();
      for (const facet of facets) {
        expect((record as Record<string, unknown>)[facet], `claimed facet ${family}.${facet} is not on the advertised record`).toBeDefined();
      }
    }
  });

  it('does not satisfy a family the host does not advertise on v2', () => {
    // `queueBus` left this list in ADR 0858 P3: it is advertised, and satisfied, now.
    for (const family of ['agentRuntime', 'fs']) {
      expect(advertised[family], `${family} is now advertised — widen V2_SATISFIED_FAMILIES deliberately`).toBeUndefined();
      expect(hostSatisfies(family)).toBe(false);
    }
  });
});

describe('the v2 agents family is satisfied exactly as it is advertised', () => {
  it('agents is satisfied, with the facets its record carries and no others', () => {
    const record = advertised['agents'] as Record<string, unknown> | undefined;
    expect(record, 'v2 discovery advertises agents (#4198)').toBeTruthy();
    expect(hostSatisfies('agents')).toBe(true);
    expect(hostSatisfies('agents', ['orgChart', 'roster', 'manifestRuntime'])).toBe(true);
    // A facet the record does NOT carry is refused, whatever the family.
    // (ADR 0889 — `evalSuite` was this example until the host began serving it.)
    expect(record).not.toHaveProperty('deployment');
    expect(hostSatisfies('agents', ['deployment'])).toBe(false);
    // ADR 0889 — eval suites are served, so the facet is advertised AND satisfied.
    expect(record).toHaveProperty('evalSuite');
    expect(hostSatisfies('agents', ['evalSuite'])).toBe(true);
    // memoryBackends is conditional (durable memory only): claimed iff advertised.
    expect(hostSatisfies('agents', ['memoryBackends'])).toBe(record !== undefined && 'memoryBackends' in record);
  });
});

describe('NP-V2-7 — disposition reads the v2 spelling, facets included', () => {
  it('a v2 family alone is satisfied; the same family with an unclaimed facet is not', () => {
    expect(hostSatisfies('aiProviders')).toBe(true);
    expect(hostSatisfies('aiProviders', ['imageGeneration'])).toBe(false);
  });

  it('v1 legacy keys still resolve as before, and a facet cannot ride a v1 key', () => {
    expect(hostSatisfies('agents.manifestRuntime')).toBe(true);
    expect(hostSatisfies('host.agentRuntime')).toBe(false);
    expect(hostSatisfies('agents.manifestRuntime', ['x'])).toBe(false);
  });

  it('resolveDependencyDisposition passes peerDependenciesMeta facets to the satisfier', () => {
    const disp = resolveDependencyDisposition(
      { aiProviders: 'supported', agents: '>=longTerm' },
      { agents: { facets: ['memoryBackends'], optional: true } },
      hostSatisfies,
    );
    expect(disp).toEqual({ refused: [], degraded: ['agents'] });
  });
});
