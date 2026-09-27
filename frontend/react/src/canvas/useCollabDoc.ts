/**
 * `useCollabDoc` — the chassis facade over the generic element-doc binding
 * (ADR 0359 Phase 3). When a definition declares `collab: 'elements'` and the
 * session is live, this presents a `useHistoryState`-COMPATIBLE surface
 * (`state`/`set`/`replace`/`undo`/`redo`/`canUndo`/`canRedo`) backed by the
 * Yjs binding, so every existing chassis mutation call site works untouched —
 * `CanvasEditorPage` just swaps which object the `history` name points at.
 *
 * Lifecycle: waits for the transport to sync (`collab.synced`), dynamic-imports
 * the binding module (yjs stays out of eager chunks), runs the chassis-owned
 * seeder election (`collab.claimSeed()` — the winner writes the loaded working
 * copy into the room), then goes `live`. Remote/undo transactions land the
 * rebuilt doc AND the selection remap through ONE `onRemote` callback so the
 * chassis can shift `multiSel`/`frameIdx` in the same React commit (D4).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CollabState } from './useCollab.js';
import type { CollabDocBinding, CollabDocShape, CollabIndexRemap } from './collabDocBinding.js';

export interface CollabDocFacade<Doc extends object> {
  /** True once synced + seed-resolved — the binding drives the doc. */
  live: boolean;
  doc: Doc | null;
  set: (next: Doc) => void;
  replace: (next: Doc) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useCollabDoc<Doc extends object>({ active, collab, shape, initialDocRef, coerce, onRemote }: {
  /** definition.collab === 'elements' AND the toggle gate passed. */
  active: boolean;
  collab: CollabState;
  shape: CollabDocShape;
  /** The loaded working copy — read at seed time (election winner only). */
  initialDocRef: React.RefObject<Doc | null>;
  /** The definition's doc coercion — every materialized doc passes through it. */
  coerce: (state: Record<string, unknown>) => Doc;
  /** Remote/undo doc landed; remap selection in the same commit (D4). */
  onRemote: (remap: CollabIndexRemap) => void;
}): CollabDocFacade<Doc> {
  const [live, setLive] = useState(false);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [stack, setStack] = useState({ canUndo: false, canRedo: false });
  const bindingRef = useRef<CollabDocBinding<Doc> | null>(null);
  const coerceRef = useRef(coerce);
  coerceRef.current = coerce;
  const onRemoteRef = useRef(onRemote);
  onRemoteRef.current = onRemote;

  const enabled = active && collab.enabled;
  const synced = collab.enabled && collab.synced;
  const ydoc = collab.enabled ? collab.ydoc : null;
  const claimSeed = collab.enabled ? collab.claimSeed : null;

  useEffect(() => {
    if (!enabled || !synced || !ydoc || !claimSeed) {
      // Not (yet) live — ensure any prior binding is gone (session teardown).
      // Functional updates BAIL OUT when already-cleared: an unconditional
      // fresh-object setState here + an unstable dep from a consumer would be
      // an effect↔render feedback loop (this hung a fork at 100% CPU in dev).
      bindingRef.current?.destroy();
      bindingRef.current = null;
      setLive((v) => (v ? false : v));
      setDoc((d) => (d === null ? d : null));
      setStack((s) => (s.canUndo || s.canRedo ? { canUndo: false, canRedo: false } : s));
      return;
    }
    let disposed = false;
    let binding: CollabDocBinding<Doc> | null = null;
    let offDoc: (() => void) | null = null;
    let offStack: (() => void) | null = null;
    void (async () => {
      const { createCollabDocBinding } = await import('./collabDocBinding.js');
      if (disposed) return;
      binding = createCollabDocBinding<Doc>(ydoc, shape);
      const seed = await claimSeed();
      if (disposed) { binding.destroy(); return; }
      if (seed && initialDocRef.current) binding.seed(initialDocRef.current);
      bindingRef.current = binding;
      offDoc = binding.onDocChanged((raw, remap) => {
        setDoc(coerceRef.current(raw));
        onRemoteRef.current(remap);
      });
      offStack = binding.onStackChanged(() => {
        setStack({ canUndo: binding!.canUndo(), canRedo: binding!.canRedo() });
      });
      setDoc(coerceRef.current(binding.current()));
      setLive(true);
    })();
    return () => {
      disposed = true;
      offDoc?.(); offStack?.();
      binding?.destroy();
      if (bindingRef.current === binding) bindingRef.current = null;
    };
    // shape derives from the definition (stable per page); ydoc/claimSeed swap
    // identity per session — exactly the re-provision boundary.
  }, [enabled, synced, ydoc, claimSeed, shape, initialDocRef]);

  // Stable closures (they read the ref) so the chassis can memoize its composed
  // history facade without per-render identity churn.
  const set = useCallback((next: Doc) => { bindingRef.current?.set(next); setDoc(next); }, []);
  const replace = useCallback((next: Doc) => { bindingRef.current?.replace(next); setDoc(next); }, []);
  const undo = useCallback(() => bindingRef.current?.undo(), []);
  const redo = useCallback(() => bindingRef.current?.redo(), []);

  return {
    live: live && enabled,
    doc,
    set,
    replace,
    undo,
    redo,
    canUndo: stack.canUndo,
    canRedo: stack.canRedo,
  };
}
