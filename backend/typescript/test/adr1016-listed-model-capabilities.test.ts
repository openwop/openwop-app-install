/**
 * ADR 1016 D4 (MR66WF-4) — the router's capability probe answers per MODEL.
 *
 * The old probe answered per PROVIDER, so any model of a provider that had one
 * vision model counted as vision-capable. Today's catalog lists `vision` on every
 * routable model, so this file adds ONE text-only model to the catalog (catalog
 * data, not the mechanism) to tell the two apart.
 *
 * Breaks if the per-model `vision` check is dropped (the text-only model would
 * report `vision-input`), or if an unlisted model is answered as capable instead
 * of `null` (never routed to).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/providers/catalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/catalog.js')>();
  return {
    ...actual,
    getProviderConfig: (id: string) => {
      const p = actual.getProviderConfig(id);
      if (!p || id !== 'anthropic') return p;
      return { ...p, models: [...p.models, { id: 'text-only-probe', label: 'Text only', contextWindow: 1000, capabilities: ['text', 'tools'] }] };
    },
  };
});

import { listedModelCapabilities } from '../src/features/model-router/routableProviders.js';

describe('listedModelCapabilities', () => {
  it('a vision model of a vision provider carries vision-input', () => {
    expect(listedModelCapabilities('anthropic', 'claude-opus-5-5')).toContain('vision-input');
  });
  it('a TEXT-ONLY model of the same provider does not', () => {
    const caps = listedModelCapabilities('anthropic', 'text-only-probe');
    expect(caps).not.toBeNull();
    expect(caps).not.toContain('vision-input');
  });
  it('an unlisted model answers null (never routed to)', () => {
    expect(listedModelCapabilities('anthropic', 'claude-typo')).toBeNull();
  });
});
