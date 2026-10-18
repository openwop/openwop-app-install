/**
 * ADR 0711 option B (SPA half): a REPORTED default is never laundered into a CHOICE.
 *
 * The server answers `GET /byok/active-config` with the effective managed default
 * and `stored: false` when nothing is bound. `useBYOKConfig` caches any binding it is
 * given, so without a discriminator the fallback would be written to localStorage as
 * though the user had picked it. It would then survive after an operator set a real
 * binding, and the heal path would re-PUT it, which for a plain member now 403s.
 *
 * Absent `stored` must read as "stored", not as "default": an older server omits the
 * field, and treating that as a default would stop caching real bindings.
 *
 * CORRECTED (grade-tests w48): this file used to assert a local copy of the predicate
 * (legs 1-3) plus a source grep for `envelope.stored !== false` (leg 4). The grep was
 * satisfied by the neighbouring `setStored(envelope.stored !== false)` line, so turning
 * the cache guard into `if (true)` left all four legs green. The legs below drive the
 * REAL hook and read localStorage after the refresh lands.
 *
 * Sabotage that turns these red (useBYOKConfig.ts `refresh`, step 1):
 *   `if (envelope.stored !== false) {` → `if (true) {`            reds legs 1 and 4
 *   `if (envelope.stored !== false) {` → `if (envelope.stored === true) {` reds leg 3
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type * as ByokClient from '../byokClient.js';

const getActiveConfig = vi.fn<typeof ByokClient.getActiveConfig>();
const listStoredRefs = vi.fn<typeof ByokClient.listStoredRefs>();
const putActiveConfig = vi.fn<typeof ByokClient.putActiveConfig>();
const clearActiveConfig = vi.fn<typeof ByokClient.clearActiveConfig>();

vi.mock('../../../platform/useStorageSubject.js', () => ({ useStorageSubject: () => ({ status: 'anonymous' }) }));
vi.mock('../byokClient.js', () => ({
  getActiveConfig: (...a: Parameters<typeof ByokClient.getActiveConfig>) => getActiveConfig(...a),
  listStoredRefs: (...a: Parameters<typeof ByokClient.listStoredRefs>) => listStoredRefs(...a),
  putActiveConfig: (...a: Parameters<typeof ByokClient.putActiveConfig>) => putActiveConfig(...a),
  clearActiveConfig: (...a: Parameters<typeof ByokClient.clearActiveConfig>) => clearActiveConfig(...a),
}));

const { useBYOKConfig } = await import('../useBYOKConfig.js');

const LS_KEY = 'openwop-app.byok.activeConfig';
const FREE = { provider: 'openwop-free', model: 'auto', credentialRef: 'managed:openwop-free' };
const GOOGLE = { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google' };

beforeEach(() => {
  localStorage.clear();
  getActiveConfig.mockReset();
  listStoredRefs.mockReset().mockResolvedValue([]);
  putActiveConfig.mockReset();
  clearActiveConfig.mockReset().mockResolvedValue(undefined);
});

describe('ADR 0711: the managed default is reported, never cached as a choice', () => {
  it('a reported default (stored:false) is NOT cached', async () => {
    getActiveConfig.mockResolvedValue({ config: FREE, valid: true, anonymous: false, stored: false });
    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.config).toEqual(FREE);
    expect(result.current.stored).toBe(false);
    expect(localStorage.getItem(LS_KEY)).toBeNull();
    // Nothing was re-PUT: the heal path never saw the default as a cached choice.
    expect(putActiveConfig).not.toHaveBeenCalled();
  });

  it('a chosen binding (stored:true) IS cached', async () => {
    getActiveConfig.mockResolvedValue({ config: GOOGLE, valid: true, anonymous: false, stored: true });
    listStoredRefs.mockResolvedValue(['byok:google']);
    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.stored).toBe(true);
    expect(JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')).toEqual(GOOGLE);
  });

  it('an OLDER server that omits `stored` is treated as stored, never as a default', async () => {
    // The compatibility direction that matters. Reading absent-as-default would stop
    // caching genuine bindings for every client talking to a server that predates this
    // field, which is a worse failure than the one the flag exists to prevent.
    getActiveConfig.mockResolvedValue({ config: GOOGLE, valid: true, anonymous: false });
    listStoredRefs.mockResolvedValue(['byok:google']);
    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.stored).toBe(true);
    expect(JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')).toEqual(GOOGLE);
  });

  it('leg 4: the HOOK applies the `envelope.stored !== false` cache guard on a LATER refresh too', async () => {
    // Twin of leg 1 ("a reported default (stored:false) is NOT cached"), which covers
    // the FIRST read. This is the drift the old leg 4 tried to catch with a source grep:
    // a chosen binding is cached, then a refresh reports the managed default instead.
    // The default must not overwrite the cached choice as though it had been picked.
    getActiveConfig.mockResolvedValue({ config: GOOGLE, valid: true, anonymous: false, stored: true });
    listStoredRefs.mockResolvedValue(['byok:google']);
    const { result } = renderHook(() => useBYOKConfig());
    await waitFor(() => expect(result.current.stored).toBe(true));
    expect(JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')).toEqual(GOOGLE);

    getActiveConfig.mockResolvedValue({ config: FREE, valid: true, anonymous: false, stored: false });
    await act(async () => { await result.current.refresh(); });
    expect(result.current.config).toEqual(FREE);
    expect(result.current.stored).toBe(false);
    expect(JSON.parse(localStorage.getItem(LS_KEY) ?? 'null')).toEqual(GOOGLE);
  });
});
