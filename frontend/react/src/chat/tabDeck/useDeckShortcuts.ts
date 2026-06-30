/**
 * useDeckShortcuts — deck-level keyboard shortcuts for the multi-tab chat deck
 * (ADR 0140 P7). Mount-scoped (the listener lives only while the deck is mounted) and
 * input-guarded (never hijacks typing in the composer / a field).
 *
 * Bindings are ALT-based on purpose: `Cmd/Ctrl+T`, `Cmd/Ctrl+W`, and `Cmd/Ctrl+1..9`
 * are browser-reserved (new/close/switch BROWSER tab) and NOT reliably preventable —
 * `Cmd/Ctrl+W` in particular would close the whole browser tab and kill every live
 * background run, the exact opposite of this feature's thesis. `Alt`+key is not a
 * browser accelerator, so it's preventable and reliable (the VS Code `Alt+1..9`
 * editor-group precedent). Uses `e.code` (physical key) so it's layout-independent and
 * survives macOS Option-dead-keys (Alt+N → ñ).
 *
 *   Alt+N                  → new tab
 *   Alt+W                  → close the active tab (the focused-tab Delete path still works too)
 *   Alt+1..9               → focus the Nth tab
 *   Alt+Shift+Left/Right   → move the ACTIVE tab one position left/right (reorder; no-op at the edge)
 */

import { useEffect } from 'react';

export function useDeckShortcuts(opts: {
  onNewTab: () => void;
  onCloseActive: () => void;
  /** Focus the Nth tab (0-based). No-op if out of range — the deck guards. */
  onJumpTo: (index: number) => void;
  /** Move the active tab by `delta` slots (-1 left, +1 right). No-op at the edge. */
  onMoveActive: (delta: -1 | 1) => void;
}): void {
  const { onNewTab, onCloseActive, onJumpTo, onMoveActive } = opts;
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return; // Alt-based
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return; // don't hijack typing
      // Alt+Shift+Arrow → reorder the active tab. Uses `e.code` (physical key) like the rest.
      if (e.shiftKey) {
        if (e.code === 'ArrowLeft') { e.preventDefault(); onMoveActive(-1); return; }
        if (e.code === 'ArrowRight') { e.preventDefault(); onMoveActive(1); return; }
        return; // every other Alt+Shift combo is left to the browser
      }
      if (e.code === 'KeyN') { e.preventDefault(); onNewTab(); return; }
      if (e.code === 'KeyW') { e.preventDefault(); onCloseActive(); return; }
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m) { e.preventDefault(); onJumpTo(Number(m[1]) - 1); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onNewTab, onCloseActive, onJumpTo, onMoveActive]);
}
