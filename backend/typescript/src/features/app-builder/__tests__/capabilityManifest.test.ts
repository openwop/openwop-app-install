/**
 * ADR 0343 Phase 1c — the generator capability manifests stay HONEST: every
 * claim is pinned against real generator output, and every unclaimed 0343
 * capability is pinned as genuinely absent. When Phase 6 teaches a generator a
 * new capability, the matching claim flips here IN THE SAME CHANGE — a manifest
 * that leads (or trails) implementation fails this suite.
 */
import { describe, it, expect } from 'vitest';
import { generate, EXPORT_TARGETS, type AppModel } from '../export/generators.js';
import { GENERATOR_CAPABILITIES, sourceAddress, type GeneratorCapabilityManifest } from '../export/capabilityManifest.js';

// The 0343 facets ride as excess keys (AppModel doesn't consume them yet —
// exactly what the honesty probes verify), hence the single widening cast.
const app = (extra: Record<string, unknown> = {}): AppModel =>
  ({
    name: 'Manifest Probe',
    theme: 'default',
    themeColors: { primary: '#7c5cff', secondary: '#22d3ee' },
    screens: [
      {
        id: 'home', name: 'Home', isInitial: true,
        components: [
          { type: 'button', props: { label: 'Go', navigateTo: 'next' } },
          { type: 'grid', props: { columns: 3, columnsMobile: 2 }, children: [{ type: 'text', props: { text: 'cell', hideOn: 'mobile' } }] },
          { type: 'list', props: { bind: 'rows' }, children: [{ type: 'text', props: { text: '{{title}}' } }] },
        ],
      },
      { id: 'next', name: 'Next', components: [] },
    ],
    dataSources: [{ id: 'rows', name: 'Rows', fields: ['title'], rows: [{ title: 'UNROLLED_MARKER' }] }],
    ...extra,
  }) as AppModel;

const allSource = (target: (typeof EXPORT_TARGETS)[number], extra: Record<string, unknown> = {}): string =>
  generate(target, app(extra)).files.map((f) => f.content).join('\n');

describe('every export target has a manifest, and vice versa', () => {
  it('manifest keys === EXPORT_TARGETS', () => {
    expect(Object.keys(GENERATOR_CAPABILITIES).sort()).toEqual([...EXPORT_TARGETS].sort());
    for (const t of EXPORT_TARGETS) expect(GENERATOR_CAPABILITIES[t].target).toBe(t);
  });
});

describe.each(EXPORT_TARGETS.map((t) => [t] as const))('manifest honesty — %s', (target) => {
  const m: GeneratorCapabilityManifest = GENERATOR_CAPABILITIES[target];
  const src = allSource(target);

  it('navigateToProp: the target screen id reaches the generated source', () => {
    expect(m.navigateToProp).toBe(true);
    expect(src).toContain('next');
  });
  it('sampleDataUnroll: bound sample rows are interpolated into output', () => {
    expect(m.sampleDataUnroll).toBe(true);
    expect(src).toContain('UNROLLED_MARKER');
  });
  it('themeColors: claim matches whether the primary hex reaches the output', () => {
    // Both directions: a claimed capability must be visible; an unclaimed one
    // must be genuinely absent (the recorded Phase-6 parity gap).
    expect(src.toLowerCase().includes('7c5cff')).toBe(m.themeColors);
  });
  it('responsive: claim matches whether hideOn/columnsMobile leave fingerprints', () => {
    expect(/hide|max-sm|cols-m/i.test(src)).toBe(m.responsive.length > 0);
  });
  it('actionKinds/bindingPathRoots/appContract: claimed EMPTY until Phase 6 implements them', () => {
    // The 0343 facets are not consumed by generators yet; a manifest claiming
    // otherwise would be a dishonest advert. (Flip together with real support.)
    expect(m.actionKinds).toEqual([]);
    expect(m.bindingPathRoots).toEqual([]);
    expect(m.appContract).toEqual([]);
    const withFacets = allSource(target, {
      stateVariables: [{ id: 'PROBE_STATE_VAR', type: 'string' }],
      operations: [{ id: 'PROBE_OPERATION', name: 'Probe', kind: 'list' }],
      envRequirements: [{ key: 'PROBE_ENV_KEY', purpose: 'probe' }],
    });
    expect(withFacets).not.toContain('PROBE_STATE_VAR');
    expect(withFacets).not.toContain('PROBE_OPERATION');
    expect(withFacets).not.toContain('PROBE_ENV_KEY');
  });
});

describe('source-map address convention (DA-10)', () => {
  it('addresses screens by ID and components by tree path — the validateAppDoc grammar', () => {
    expect(sourceAddress('home', [2])).toBe('screens[home].components[2]');
    expect(sourceAddress('home', [2, 0, 3])).toBe('screens[home].components[2].children[0].children[3]');
  });
});
