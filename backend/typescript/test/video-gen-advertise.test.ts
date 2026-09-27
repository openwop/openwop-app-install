/**
 * ADR 0411 P1 — videoGeneration advertisement honesty gate (the image-gen
 * precedent: default false; the operator opts in only when a provider is wired).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { videoGenerationAdvertised } from '../src/aiProviders/aiProvidersHost.js';

afterEach(() => { delete process.env.OPENWOP_VIDEO_PROVIDER_ENABLED; });

describe('videoGenerationAdvertised', () => {
  it('is false by default (production-honest — no provider configured)', () => {
    expect(videoGenerationAdvertised()).toBe(false);
  });
  it('is true only when the operator opts in', () => {
    process.env.OPENWOP_VIDEO_PROVIDER_ENABLED = 'true';
    expect(videoGenerationAdvertised()).toBe(true);
  });
  it('any other value stays false', () => {
    process.env.OPENWOP_VIDEO_PROVIDER_ENABLED = '1';
    expect(videoGenerationAdvertised()).toBe(false);
  });
});
