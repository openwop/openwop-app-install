/**
 * ADR 0873 D3 (boot registration) and D8 (sign-out purge), page side.
 *
 * Sabotage (wave 51 probes): dropping the native-shell or empty-table guard, a scope
 * other than SW_SCOPE, an undefined build constant reading true, an unfiltered purge,
 * a purge that throws on blocked storage, or running the purge AFTER signOut's
 * Firebase-unconfigured early return each red one case.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SW_SCOPE, SW_URL } from '../swUrl.js';
import { buildHasOfflineTable, registerOfflineWorkerAtBoot } from '../bootRegistration.js';
import { OFFLINE_CACHE_PREFIX, purgeOfflineCaches } from '../offlineCaches.js';
import { signOut } from '../../auth/firebase.js';

const nativeBridge = vi.hoisted(() => ({ native: false }));
vi.mock('../../native/nativeBridge.js', () => ({ isNativeShell: () => nativeBridge.native }));

function stubServiceWorker() {
  const register = vi.fn(async () => ({}));
  Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true });
  return register;
}

afterEach(() => {
  nativeBridge.native = false;
  Reflect.deleteProperty(navigator, 'serviceWorker');
  vi.unstubAllGlobals();
});

describe('ADR 0873 D3 — boot registration', () => {
  it('outside a build, the offline-table constant reads false', () => {
    expect(buildHasOfflineTable()).toBe(false);
  });

  it('an empty table registers nothing (push keeps registering on demand)', () => {
    const register = stubServiceWorker();
    registerOfflineWorkerAtBoot(false);
    expect(register).not.toHaveBeenCalled();
  });

  it('a non-empty table registers the ONE URL at the ONE scope', () => {
    const register = stubServiceWorker();
    registerOfflineWorkerAtBoot(true);
    expect(register).toHaveBeenCalledWith(SW_URL, { scope: SW_SCOPE });
  });

  it('never registers under the native shell', () => {
    nativeBridge.native = true;
    const register = stubServiceWorker();
    registerOfflineWorkerAtBoot(true);
    expect(register).not.toHaveBeenCalled();
  });
});

describe('ADR 0873 D8 — purgeOfflineCaches', () => {
  it('deletes only the offline caches', async () => {
    const names = [`${OFFLINE_CACHE_PREFIX}shell-v1`, `${OFFLINE_CACHE_PREFIX}meta`, 'other'];
    const deleted: string[] = [];
    vi.stubGlobal('caches', { keys: async () => names, delete: async (n: string) => { deleted.push(n); return true; } });
    await purgeOfflineCaches();
    expect(deleted.sort()).toEqual([`${OFFLINE_CACHE_PREFIX}meta`, `${OFFLINE_CACHE_PREFIX}shell-v1`]);
  });

  it('never throws when storage is blocked', async () => {
    vi.stubGlobal('caches', { keys: async () => { throw new Error('SecurityError'); }, delete: async () => true });
    await expect(purgeOfflineCaches()).resolves.toBeUndefined();
  });

  it('signOut() runs the purge, even when Firebase is not configured', async () => {
    const deleted: string[] = [];
    vi.stubGlobal('caches', { keys: async () => [`${OFFLINE_CACHE_PREFIX}shell-v1`], delete: async (n: string) => { deleted.push(n); return true; } });
    await signOut();
    expect(deleted).toEqual([`${OFFLINE_CACHE_PREFIX}shell-v1`]);
  });
});
