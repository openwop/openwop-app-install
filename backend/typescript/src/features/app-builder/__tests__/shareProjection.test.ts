/** ADR 0345 3a (DS-08) — the public-share projection: sample rows redacted by
 *  default, sharePolicy opt-ins honored, app-contract facets never published. */
import { describe, it, expect, beforeAll } from 'vitest';
import { projectAppForShare } from '../shareProjection.js';
import { validateArtifact } from '../../../host/artifactTypes.js';
import { registerAppBuilderArtifactType } from '../artifactTypes.js';
import { registerAppBuilderComponents } from '../componentCatalog.js';
import { validateAppDoc } from '../validateAppDoc.js';

beforeAll(() => {
  registerAppBuilderArtifactType();
  registerAppBuilderComponents();
});

const state = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'App',
  themeColors: { primary: '#7c5cff' },
  screens: [{ id: 'home', name: 'Home', isInitial: true, components: [{ type: 'list', props: { bind: 'customers' } }] }],
  dataSources: [
    { id: 'customers', name: 'Customers', fields: ['email'], rows: [{ email: 'real.person@example.com' }] },
    { id: 'plans', name: 'Plans', fields: ['tier'], rows: [{ tier: 'Pro' }] },
  ],
  models: [{ id: 'customer', name: 'Customer', fields: [{ name: 'email', type: 'string' }] }],
  operations: [{ id: 'listCustomers', name: 'List', kind: 'list', mock: { status: 'ok', rows: [{ email: 'real.person@example.com' }] } }],
  envRequirements: [{ key: 'API_URL', purpose: 'origin' }],
  authProfile: { kind: 'sso' },
  designSystemRef: { id: 'ds1' },
  brandRef: { id: 'b1' },
  ...extra,
});

describe('projectAppForShare', () => {
  it('DEFAULT: redacts every source\'s rows, keeps the render-sufficient shape', () => {
    const out = projectAppForShare(state());
    const sources = out.dataSources as Record<string, unknown>[];
    expect(sources.every((s) => !('rows' in s))).toBe(true);
    expect(sources[0]).toMatchObject({ id: 'customers', name: 'Customers', fields: ['email'] });
    expect(JSON.stringify(out)).not.toContain('real.person@example.com');
    expect(out.screens).toEqual(state().screens);
    expect(out.themeColors).toEqual({ primary: '#7c5cff' });
  });
  it('strips the app-contract facets entirely (operations/env/auth/refs/policy)', () => {
    const out = projectAppForShare(state({ sharePolicy: { sampleData: 'include' } }));
    for (const k of ['operations', 'envRequirements', 'authProfile', 'designSystemRef', 'brandRef', 'sharePolicy']) {
      expect(out[k], k).toBeUndefined();
    }
  });
  it('sharePolicy sampleData:include publishes rows; perSource overrides both ways', () => {
    const all = projectAppForShare(state({ sharePolicy: { sampleData: 'include' } }));
    expect((all.dataSources as Record<string, unknown>[]).every((s) => 'rows' in s)).toBe(true);
    const mixed = projectAppForShare(state({ sharePolicy: { sampleData: 'include', perSource: { customers: false } } }));
    const byId = new Map((mixed.dataSources as { id: string; rows?: unknown }[]).map((s) => [s.id, s]));
    expect('rows' in byId.get('customers')!).toBe(false);
    expect('rows' in byId.get('plans')!).toBe(true);
    const optIn = projectAppForShare(state({ sharePolicy: { perSource: { plans: true } } }));
    const byId2 = new Map((optIn.dataSources as { id: string; rows?: unknown }[]).map((s) => [s.id, s]));
    expect('rows' in byId2.get('customers')!).toBe(false);
    expect('rows' in byId2.get('plans')!).toBe(true);
  });
  it('never mutates the input document', () => {
    const s = state();
    const before = JSON.stringify(s);
    projectAppForShare(s);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('sharePolicy facet — both gates', () => {
  it('schema + editor validator accept it; bad values reject', () => {
    const doc = state({ sharePolicy: { sampleData: 'include', perSource: { customers: true } } });
    expect(validateArtifact('canvas.app-builder', doc).valid).toBe(true);
    expect(validateAppDoc(doc).errors).toEqual([]);
    expect(validateAppDoc(state({ sharePolicy: { sampleData: 'always' } })).errors.some((e) => e.path === 'sharePolicy.sampleData')).toBe(true);
  });
  it('perSource referencing a missing source warns softly', () => {
    const v = validateAppDoc(state({ sharePolicy: { perSource: { ghost: true } } }));
    expect(v.errors).toEqual([]);
    expect(v.warnings.some((w) => w.path === 'sharePolicy.perSource.ghost')).toBe(true);
  });
});
