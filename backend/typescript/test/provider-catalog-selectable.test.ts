/**
 * ADR 0164 Phase 1 — `listSelectableProviderIds()` is the server-side single source
 * of truth for "user-facing provider" (the chat model picker). It MUST exclude
 * `hidden` (MiniMax — reached only via the managed tier) and `managed` (the operator
 * holds the key) providers, so a hidden provider can never leak into the picker.
 */
import { describe, it, expect } from 'vitest';
import { listSelectableProviderIds, listManagedProviderIds } from '../src/providers/catalog.js';

describe('ADR 0164 — listSelectableProviderIds', () => {
  const ids = listSelectableProviderIds();

  it('includes the user-facing BYOK providers', () => {
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('google');
  });

  it('EXCLUDES the hidden MiniMax provider (capability honesty)', () => {
    expect(ids).not.toContain('minimax');
  });

  it('excludes every managed tier (operator-held key)', () => {
    for (const m of listManagedProviderIds()) {
      expect(ids).not.toContain(m);
    }
    expect(ids).not.toContain('openwop-free');
  });
});
