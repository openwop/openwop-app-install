import { describe, it, expect } from 'vitest';
import { FEATURES } from '../features.js';

/**
 * ADR 0196 Phase 2 (Gate B) — manifest wiring for the developer-tools gate.
 * The manual-test runner is an engineering surface: its nav entry must be
 * hidden unless the `developer-tools` toggle resolves enabled. Pure manifest
 * derivation (the adr0145 pattern) — a manifest edit that re-exposes the QA
 * runner to every production deploy is caught here.
 */
describe('ADR 0196 — developer-tools gating (manifest)', () => {
  it('/test nav rides the developer-tools toggle', () => {
    const t = FEATURES.find((r) => r.path === '/test');
    expect(t).toBeDefined();
    expect(t?.nav?.featureId).toBe('developer-tools');
    // Still admin-tier chrome — Gate B composes with (not replaces) the tier.
    expect(t?.tier).toBe('admin');
  });
});
