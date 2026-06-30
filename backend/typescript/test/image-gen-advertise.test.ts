/**
 * ADR 0115 Phase 2 — imageGeneration advertisement honesty gate.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { imageGenerationAdvertised } from '../src/aiProviders/aiProvidersHost.js';

afterEach(() => { delete process.env.OPENWOP_IMAGE_PROVIDER_ENABLED; });

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
