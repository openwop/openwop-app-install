/**
 * Shared account-presence signal. `SignInButton` (the single source of truth
 * for the signed-in account — Firebase OIDC user OR durable backend User)
 * publishes whether its account menu is available; the Sidebar reads it to
 * decide whether the footer needs the fallback accessibility/language
 * controls (they live inside the account menu when one is showing).
 *
 * Module-level like `useEffectiveAccess` — one value, every consumer shares
 * it. `null` = still resolving (render neither placement, avoids a flash).
 */
import { useSyncExternalStore } from 'react';

let present: boolean | null = null;
const listeners = new Set<() => void>();

export function publishAccountPresence(value: boolean | null): void {
  if (present === value) return;
  present = value;
  for (const fn of listeners) fn();
}

export function useAccountPresence(): boolean | null {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => present,
  );
}
