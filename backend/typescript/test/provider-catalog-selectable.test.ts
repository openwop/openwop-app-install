/**
 * ADR 0164 Phase 1 — `listSelectableProviderIds()` is the server-side single source
 * of truth for "user-facing provider" (the chat model picker). It MUST exclude
 * `hidden` (MiniMax — reached only via the managed tier) and `managed` (the operator
 * holds the key) providers, so a hidden provider can never leak into the picker.
 *
 * What turns it red (sabotage-witnessed, /grade-tests 8f wave 1): dropping the
 * `hidden` half of the filter (8fw1g3-pv-hidden-r2) or the `managed` half
 * (8fw1g3-pv-managed-r2). Each exclusion case carries a fixture guard read
 * from `providers.json` itself, so a catalog that stops marking MiniMax hidden
 * (or ships no managed tier) cannot make the exclusion pass for the wrong reason.
 * The route-level twin is `chat-model-capabilities.test.ts` (the wiring); this
 * file is the mechanism.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { listSelectableProviderIds, listManagedProviderIds } from '../src/providers/catalog.js';

interface RawProvider { id: string; managed?: boolean; hidden?: boolean }
// The other side of the parity, read as DATA from the repo-root catalog — never
// from the function under test.
const RAW: RawProvider[] = (JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'providers.json'), 'utf8')) as { providers: RawProvider[] }).providers;

describe('ADR 0164 — listSelectableProviderIds', () => {
  const ids = listSelectableProviderIds();

  it('includes the user-facing BYOK providers', () => {
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openai');
    expect(ids).toContain('google');
    // Exactly the catalog's non-managed, non-hidden entries, in catalog order.
    expect([...ids]).toEqual(RAW.filter((p) => p.managed !== true && p.hidden !== true).map((p) => p.id));
  });

  it('EXCLUDES the hidden MiniMax provider (capability honesty)', () => {
    // Fixture guard: MiniMax is still in the catalog AND still hidden there.
    expect(RAW.find((p) => p.id === 'minimax')?.hidden).toBe(true);
    expect(ids).not.toContain('minimax');
  });

  it('excludes every managed tier (operator-held key)', () => {
    // Fixture guard: the managed list is non-empty, so the loop below runs.
    expect(listManagedProviderIds()).toContain('openwop-free');
    expect(RAW.find((p) => p.id === 'openwop-free')?.managed).toBe(true);
    for (const m of listManagedProviderIds()) {
      expect(ids).not.toContain(m);
    }
    expect(ids).not.toContain('openwop-free');
  });
});
