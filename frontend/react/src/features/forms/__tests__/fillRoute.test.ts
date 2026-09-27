/**
 * ADR 0331 §D3 — the `/f/:formId` matcher must accept the app-generated
 * percent-encoded form (`hostedFormUrl` encodes `form:<uuid>` → `form%3A…`),
 * the literal-colon form, and never throw on malformed encoding — the same
 * contract pinned for /store and /p (the storeRoute precedent).
 */
import { describe, it, expect } from 'vitest';
import { matchFormFillId } from '../fillRoute.js';

describe('matchFormFillId', () => {
  it('decodes the percent-encoded hostedFormUrl round-trip and accepts the literal form', () => {
    expect(matchFormFillId(`/f/${encodeURIComponent('form:abc-123')}`)).toBe('form:abc-123');
    expect(matchFormFillId('/f/form:abc-123')).toBe('form:abc-123');
  });

  it('returns null (not a throw) for malformed percent-encoding', () => {
    expect(matchFormFillId('/f/100%')).toBeNull();
    expect(matchFormFillId('/f/bad%zzid')).toBeNull();
  });

  it('returns null for bare, nested, and foreign paths', () => {
    expect(matchFormFillId('/f')).toBeNull();
    expect(matchFormFillId('/f/')).toBeNull();
    expect(matchFormFillId('/f/x/extra')).toBeNull();
    expect(matchFormFillId('/forms')).toBeNull();
    expect(matchFormFillId('/')).toBeNull();
  });
});
