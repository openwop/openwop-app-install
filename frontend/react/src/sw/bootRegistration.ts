/**
 * ADR 0873 D3 — register the ONE worker at boot, but only when this build's
 * offline table is non-empty.
 *
 * `__OPENWOP_SW_OFFLINE__` is a build-time constant set by the
 * `openwop-service-worker` Vite plugin. With an empty table nothing registers
 * here, and push keeps registering on demand (`pushSubscription.ts`), so a
 * build that declares nothing behaves exactly as before. Never under the native
 * shell (ADR 0181): Electron and iOS keep their own offline story.
 */
import { isNativeShell } from '../native/nativeBridge.js';
import { SW_SCOPE, SW_URL } from './swUrl.js';

declare const __OPENWOP_SW_OFFLINE__: boolean | undefined;

/** True when this build ships an offline table (false under vitest, where the constant is undefined). */
export function buildHasOfflineTable(): boolean {
  return typeof __OPENWOP_SW_OFFLINE__ !== 'undefined' && __OPENWOP_SW_OFFLINE__ === true;
}

/** Fire-and-forget; a failed registration leaves the app exactly as online-only. */
export function registerOfflineWorkerAtBoot(hasTable: boolean = buildHasOfflineTable()): void {
  if (!hasTable || isNativeShell()) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE }).catch(() => undefined);
}
