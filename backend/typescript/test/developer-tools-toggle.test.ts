/**
 * ADR 0196 Phase 1 — the `developer-tools` toggle registration contract (Gate B of the
 * enterprise-posture seam; `DTC-2`).
 *
 * The feature is ROUTE-LESS: its whole backend surface is the toggle that
 * gates the frontend inspector surfaces (network inspector, envelope
 * inspector, manual-test runner nav). The network inspector shows RAW request and
 * response bodies, so the default posture is the security claim. These tests pin:
 *   1. the feature is composed into BACKEND_FEATURES (so the toggle reaches
 *      the registry + FeatureTogglePanel),
 *   2. the toggle shape — tenant-bucketed, plain on/off (an install-wide operator
 *      decision, not per-user),
 *   3. the demo-aware default, BOTH halves EXECUTED: the module is re-evaluated under
 *      `OPENWOP_DEMO_MODE` unset / 'false' (→ OFF, a clean install is inspector-free)
 *      and 'true' (→ ON, the public demo). Before wave 32 only the branch the ambient
 *      env selected ran, so the ON half was never witnessed.
 *   4. route-lessness — `registerRoutes` reads nothing from its deps.
 *
 * Sabotage that turns it red: `status: 'on'` / `status: 'off'` in feature.ts, dropping
 * `developerToolsFeature` from BACKEND_FEATURES, `bucketUnit: 'user'`, or a
 * `registerRoutes` that touches `deps`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { developerToolsFeature } from '../src/features/developer-tools/feature.js';
import type { RouteDeps } from '../src/routes/registerAllRoutes.js';

/** Re-evaluate feature.ts (its default is computed from demoMode() at module eval). */
async function freshFeature(): Promise<typeof developerToolsFeature> {
  vi.resetModules();
  const mod = await import('../src/features/developer-tools/feature.js');
  return mod.developerToolsFeature;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('developer-tools toggle (ADR 0196 Phase 1)', () => {
  it('is composed into BACKEND_FEATURES exactly once', () => {
    const matches = BACKEND_FEATURES.filter((f) => f.id === 'developer-tools');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toBe(developerToolsFeature);
  });

  it('declares a tenant-bucketed toggle default matching the feature id', () => {
    const def = developerToolsFeature.toggleDefault;
    expect(def).toBeDefined();
    expect(def?.id).toBe('developer-tools');
    expect(def?.bucketUnit).toBe('tenant');
    expect(def?.salt).toBe('developer-tools');
    // Plain on/off — no variants, no beta cohort.
    expect(def?.variants ?? []).toHaveLength(0);
    expect(def?.betaCohort).toBeUndefined();
  });

  it('defaults OFF on a clean install (OPENWOP_DEMO_MODE unset or false)', async () => {
    vi.stubEnv('OPENWOP_DEMO_MODE', 'false');
    expect((await freshFeature()).toggleDefault?.status).toBe('off');
    delete process.env.OPENWOP_DEMO_MODE;
    expect((await freshFeature()).toggleDefault?.status).toBe('off');
  });

  it('defaults ON for the public demo (OPENWOP_DEMO_MODE=true)', async () => {
    vi.stubEnv('OPENWOP_DEMO_MODE', 'true');
    expect((await freshFeature()).toggleDefault?.status).toBe('on');
  });

  it('is route-less and contributes no packs or surface', () => {
    expect(developerToolsFeature.requiredPacks ?? []).toHaveLength(0);
    expect(developerToolsFeature.surface).toBeUndefined();
    // registerRoutes is a deliberate no-op: ANY read of its deps throws here.
    const deps: RouteDeps = new Proxy(Object.create(null), {
      get: (_t, k) => { throw new Error(`registerRoutes read deps.${String(k)}`); },
    });
    expect(() => developerToolsFeature.registerRoutes(deps)).not.toThrow();
  });
});
