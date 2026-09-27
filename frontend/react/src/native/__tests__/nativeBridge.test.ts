import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isNativeShell,
  nativeShellKind,
  nativeNotify,
  setNativeBadgeCount,
  onNativeNotificationActivated,
  type NativeShellApi,
} from '../nativeBridge.js';

/** Install a fake native shell on `window.openwopNative`; auto-cleaned.
 *  Every member except `kind` is optional on `NativeShellApi`, so a partial
 *  mock is a valid value with no cast. */
function installShell(api: NativeShellApi): void {
  window.openwopNative = api;
}

afterEach(() => {
  window.openwopNative = undefined;
  vi.restoreAllMocks();
});

describe('nativeBridge — plain browser (no shell injected)', () => {
  it('reports not-native and null kind', () => {
    expect(isNativeShell()).toBe(false);
    expect(nativeShellKind()).toBeNull();
  });

  it('nativeNotify resolves false and never touches a shell', async () => {
    await expect(nativeNotify({ title: 't', body: 'b' })).resolves.toBe(false);
  });

  it('setNativeBadgeCount is a no-op that does not throw', () => {
    expect(() => setNativeBadgeCount(5)).not.toThrow();
  });

  it('onNativeNotificationActivated returns a no-op unsubscribe', () => {
    const unsub = onNativeNotificationActivated(() => {});
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });
});

describe('nativeBridge — malformed / partial injection', () => {
  it('treats an object without a valid kind as not-native', () => {
    // A shell that injects an unrecognised discriminator must be rejected.
    window.openwopNative = { kind: 'bogus' as NativeShellApi['kind'] };
    expect(isNativeShell()).toBe(false);
    expect(nativeShellKind()).toBeNull();
  });

  it('a shell missing optional members degrades to no-op / false', async () => {
    installShell({ kind: 'electron' }); // no notify / setBadgeCount / activation
    expect(isNativeShell()).toBe(true);
    await expect(nativeNotify({ title: 't', body: 'b' })).resolves.toBe(false);
    expect(() => setNativeBadgeCount(3)).not.toThrow();
    expect(typeof onNativeNotificationActivated(() => {})).toBe('function');
  });
});

describe('nativeBridge — native shell present', () => {
  it('routes notify through the shell and returns its boolean result', async () => {
    const notify = vi.fn().mockResolvedValue(true);
    installShell({ kind: 'electron', notify });
    const ok = await nativeNotify({ title: 'Run done', body: 'Finished', tag: 'n1', navigatePath: '/runs/1' });
    expect(ok).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Run done', body: 'Finished', tag: 'n1', navigatePath: '/runs/1' }),
    );
  });

  it('reports the shell kind', () => {
    installShell({ kind: 'ios' });
    expect(isNativeShell()).toBe(true);
    expect(nativeShellKind()).toBe('ios');
  });

  it('floors + clamps the badge count and forwards it', () => {
    const setBadgeCount = vi.fn();
    installShell({ kind: 'electron', setBadgeCount });
    setNativeBadgeCount(4.9);
    setNativeBadgeCount(-2);
    setNativeBadgeCount(0);
    expect(setBadgeCount).toHaveBeenNthCalledWith(1, 4);
    expect(setBadgeCount).toHaveBeenNthCalledWith(2, 0); // negative clears
    expect(setBadgeCount).toHaveBeenNthCalledWith(3, 0);
  });

  it('subscribes to activation and forwards the carried path', () => {
    let handler: ((path: string) => void) | undefined;
    const unsubscribe = vi.fn();
    installShell({
      kind: 'electron',
      onNotificationActivated: (cb) => { handler = cb; return unsubscribe; },
    });
    const seen: string[] = [];
    const unsub = onNativeNotificationActivated((p) => seen.push(p));
    if (!handler) throw new Error('shell did not receive an activation handler');
    handler('/approvals/42');
    expect(seen).toEqual(['/approvals/42']);
    unsub();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

describe('nativeBridge — never throws even when the shell misbehaves', () => {
  it('nativeNotify resolves false when the shell notify throws', async () => {
    installShell({ kind: 'electron', notify: vi.fn().mockRejectedValue(new Error('ipc down')) });
    await expect(nativeNotify({ title: 't', body: 'b' })).resolves.toBe(false);
  });

  it('setNativeBadgeCount swallows a throwing shell', () => {
    installShell({ kind: 'electron', setBadgeCount: () => { throw new Error('ipc down'); } });
    expect(() => setNativeBadgeCount(2)).not.toThrow();
  });

  it('onNativeNotificationActivated returns a no-op unsub when the shell throws', () => {
    installShell({ kind: 'electron', onNotificationActivated: () => { throw new Error('ipc down'); } });
    const unsub = onNativeNotificationActivated(() => {});
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });
});
