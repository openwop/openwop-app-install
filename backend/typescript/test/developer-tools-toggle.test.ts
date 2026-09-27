/**
 * ADR 0196 Phase 1 — the `developer-tools` toggle registration contract.
 *
 * The feature is ROUTE-LESS: its whole backend surface is the toggle that
 * gates the frontend inspector surfaces (network inspector, envelope
 * inspector, manual-test runner nav). These tests pin:
 *   1. the feature is composed into BACKEND_FEATURES (so the toggle reaches
 *      the registry + FeatureTogglePanel),
 *   2. the default posture — OFF, tenant-bucketed (a clean install is
 *      inspector-free; an install-wide operator decision, not per-user),
 *   3. the demo-aware default — ON only when OPENWOP_DEMO_MODE is truthy at
 *      module-eval (asserted structurally: the default reflects demoMode()).
 */
import { describe, expect, it } from 'vitest';
import { BACKEND_FEATURES } from '../src/features/index.js';
import { developerToolsFeature } from '../src/features/developer-tools/feature.js';
import { LEGACY_PINNED_WORKFLOWS } from '../src/features/index.js';
import { demoMode } from '../src/host/demoMode.js';

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

  it('defaults follow the demo-aware posture (OFF clean, ON public demo)', () => {
    // The default is computed from demoMode() at module eval; in the test env
    // OPENWOP_DEMO_MODE is unset, so this pins the enterprise-clean OFF path
    // while staying honest if a suite runs with demo mode exported.
    expect(developerToolsFeature.toggleDefault?.status).toBe(demoMode() ? 'on' : 'off');
  });

  it('is route-less and contributes no packs, surface, or workflows', () => {
    expect(developerToolsFeature.requiredPacks ?? []).toHaveLength(0);
    expect(developerToolsFeature.surface).toBeUndefined();
    // ADR 0472 P3 — the builtinWorkflows FIELD is deleted; assert developer-tools
    // contributes nothing to the LEGACY_PINNED quarantine either.
    expect(LEGACY_PINNED_WORKFLOWS.some((w) => w.workflowId.startsWith('developer-tools'))).toBe(false);
    // registerRoutes is a deliberate no-op — calling it mounts nothing.
    expect(() => developerToolsFeature.registerRoutes({} as never)).not.toThrow();
  });
});
