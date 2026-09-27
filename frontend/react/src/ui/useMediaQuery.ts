/**
 * useMediaQuery — subscribe a component to a CSS media query (the
 * `ui/motion.ts` matchMedia precedent, made reactive). Used by the canvas
 * top bar's §7.2.1 breakpoint-driven `⋮` overflow (CV-15) — deterministic
 * breakpoints, never a measurement loop.
 */
import { useSyncExternalStore } from 'react';

/** jsdom ships no matchMedia — guard so tests render the wide layout. */
const canMatch = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (!canMatch()) return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener('change', notify);
      return () => mql.removeEventListener('change', notify);
    },
    () => (canMatch() ? window.matchMedia(query).matches : false),
    () => false,
  );
}
