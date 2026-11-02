/**
 * ADR 0115 Phase 2 — imageGeneration advertisement honesty gate.
 *
 * A host that advertises `imageGeneration` without an operator opt-in makes a
 * dishonest wire claim (ADR 0115 §honesty). TST-DGC-2. Red when the gate
 * defaults on, or accepts any truthy value instead of exactly `'true'`
 * (sabotage-witnessed, wave 71).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { imageGenerationAdvertised } from '../src/aiProviders/aiProvidersHost.js';

const prior = process.env.OPENWOP_IMAGE_PROVIDER_ENABLED;
beforeEach(() => { delete process.env.OPENWOP_IMAGE_PROVIDER_ENABLED; });
afterAll(() => {
  if (prior === undefined) delete process.env.OPENWOP_IMAGE_PROVIDER_ENABLED;
  else process.env.OPENWOP_IMAGE_PROVIDER_ENABLED = prior;
});

describe('imageGenerationAdvertised', () => {
  it('is false by default (production-honest — no provider configured)', () => {
    expect(imageGenerationAdvertised()).toBe(false);
  });
  it('is true only when the operator opts in', () => {
    process.env.OPENWOP_IMAGE_PROVIDER_ENABLED = 'true';
    expect(imageGenerationAdvertised()).toBe(true);
  });
  it('any other value stays false', () => {
    process.env.OPENWOP_IMAGE_PROVIDER_ENABLED = '1';
    expect(imageGenerationAdvertised()).toBe(false);
  });
});
