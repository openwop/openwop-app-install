/**
 * ADR 0120 — the consent client's gating. A 404 (feature unavailable for the
 * tenant) returns null so the toggle hides; a 200 returns the grant state.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getExtractionGrant } from '../memoryExtractionClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('getExtractionGrant', () => {
  it('returns null on 404 (consent control hidden)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response)));
    expect(await getExtractionGrant()).toBeNull();
  });

  it('returns the grant on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ granted: true, updatedAt: '2026-06-24' }) } as unknown as Response)));
    expect(await getExtractionGrant()).toEqual({ granted: true, updatedAt: '2026-06-24' });
  });
});
