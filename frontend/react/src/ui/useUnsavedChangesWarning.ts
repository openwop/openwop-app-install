import { useEffect } from 'react';
/**
 * Warn the user before they lose unsaved edits via a browser-level navigation
 * (tab close, refresh, external link). While `dirty` is true a `beforeunload`
 * listener triggers the native "Leave site?" prompt. (In-app react-router
 * navigation is not blocked — this is the lightweight guard for the most common
 * data-loss path.)  UX CONT-6.
 */
export function useUnsavedChangesWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}
