/**
 * ADR 0120 — the consent client's gating. A 404 (feature unavailable for the
 * tenant) returns null so the toggle hides; a 200 returns the grant state; and
 * ONLY a 404 hides — any other failure throws, so the control renders UNKNOWN
 * instead of silently vanishing (the swallowed-403/500 defect that
 * `ProfileMemoryTab.consent.test.tsx` pins at the component layer; that test mocks
 * this client, so the client's own discrimination is pinned here).
 *
 * Witnessed (wave 12 probes): returning a value on 404 reds case 1; ignoring the
 * body on 200 reds case 2; widening the hide to `!res.ok` reds case 3. Row 57: dropping
 * the `available` read reds the unavailable case; dropping the 401 arm reds the sign-in case.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { getExtractionGrant } from '../memoryExtractionClient.js';

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); });

describe('getExtractionGrant', () => {
  it('returns null on 404 (consent control hidden)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 404)));
    expect(await getExtractionGrant()).toBeNull();
  });

  it('returns the grant on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ granted: true, updatedAt: '2026-06-24', available: true }, 200)));
    expect(await getExtractionGrant()).toEqual({ granted: true, updatedAt: '2026-06-24', available: true });
  });

  it('ADR 0982 D2 — an account with no personal workspace is reported unavailable, with the reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ granted: false, updatedAt: null, available: false }, 200)));
    expect(await getExtractionGrant()).toEqual({ granted: false, updatedAt: null, available: false, unavailableReason: 'no-personal-workspace' });
  });

  it('ADR 0982 D2 — a 401 (anonymous; the server refuses them a grant) is "off, sign in", not a load failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 401)));
    expect(await getExtractionGrant()).toEqual({ granted: false, updatedAt: null, available: false, unavailableReason: 'sign-in' });
  });

  it('a non-404 failure THROWS — never collapses into the 404 hide', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 500)));
    await expect(getExtractionGrant()).rejects.toMatchObject({ status: 500 });
  });
});
