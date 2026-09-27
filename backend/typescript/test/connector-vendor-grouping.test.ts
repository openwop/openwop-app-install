/**
 * ADR 0185 — connector-catalog vendor grouping. The built-in providers carry a
 * host-only `vendor` (commercial ecosystem) so the Connections catalog can group by
 * the vendors a company uses. Guards the BUILTIN_VENDOR map: presentational only,
 * never the auth key (RFC 0095 `provider.id` still resolves).
 */
import { describe, expect, it } from 'vitest';
import { getProvider, listProviders } from '../src/features/connections/providerRegistry.js';

describe('ADR 0185 built-in vendor grouping', () => {
  it('groups all Google surfaces under one vendor', () => {
    for (const id of ['google', 'gmail', 'bigquery']) {
      expect(getProvider(id)?.vendor).toBe('Google');
    }
  });

  it('maps Microsoft Graph to "Microsoft 365" and Workday to "Workday"', () => {
    expect(getProvider('microsoft-graph')?.vendor).toBe('Microsoft 365');
    expect(getProvider('workday')?.vendor).toBe('Workday');
  });

  it('gives every built-in provider a vendor label (nothing ungrouped)', () => {
    for (const p of listProviders()) {
      expect(typeof p.vendor).toBe('string');
      expect(p.vendor && p.vendor.length).toBeGreaterThan(0);
    }
  });

  it('does not repurpose vendor as the wire key — id is still distinct', () => {
    // google + gmail share a vendor but remain separate resolvable providers.
    expect(getProvider('google')?.id).toBe('google');
    expect(getProvider('gmail')?.id).toBe('gmail');
  });
});
