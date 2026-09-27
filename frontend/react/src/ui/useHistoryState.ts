import { useCallback, useRef, useState } from 'react';

/**
 * Bounded undo/redo history over an immutable state value (ADR 0305 Phase B).
 * Generic extraction of the builder-store snapshot pattern (`builder/store/
 * builderStore.ts` — fixed-depth past/future stacks, one entry per gesture);
 * migrating the builder onto this hook is a recorded follow-up.
 *
 * Contract: every `set` value must be a FRESH immutable snapshot (the caller
 * clones before mutating — the app-builder editor's clone-on-edit pattern), so
 * entries are stored by reference with no deep copy here.
 *
 * `replace` swaps the current value WITHOUT pushing history — for text inputs
 * whose keystrokes would bury structural operations (the builder DEF-6
 * lesson: field-level ⌘Z is the browser's native text undo).
 *
 * All stack mutations happen OUTSIDE React state updaters (updaters must stay
 * pure — StrictMode double-invokes them); `stateRef` mirrors the current value
 * so the stacks and the state update atomically per call.
 */
export interface HistoryState<T> {
  state: T;
  /** Push a new snapshot (one history entry — call once per user gesture). */
  set: (next: T) => void;
  /** Swap the current snapshot without a history entry (text-input typing). */
  replace: (next: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Reset to a new baseline and clear both stacks (e.g. after a reload). */
  reset: (next: T) => void;
}

const HISTORY_MAX = 30;

export function useHistoryState<T>(initial: T, opts?: { depth?: number }): HistoryState<T> {
  const [state, setState] = useState<T>(initial);
  const stateRef = useRef<T>(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  // ADR 0333 Phase 3: parametrized depth (stroke-heavy canvases want 200);
  // still bounded — one snapshot per GESTURE, never per input event.
  const depth = opts?.depth && opts.depth > 0 ? opts.depth : HISTORY_MAX;
  // canUndo/canRedo mirrored into state so toolbar buttons re-render on flips.
  const [marks, setMarks] = useState({ canUndo: false, canRedo: false });

  const commit = useCallback((next: T) => {
    stateRef.current = next;
    setState(next);
    setMarks((m) => {
      const nm = { canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
      return m.canUndo === nm.canUndo && m.canRedo === nm.canRedo ? m : nm;
    });
  }, []);

  const set = useCallback((next: T) => {
    past.current.push(stateRef.current);
    if (past.current.length > depth) past.current.shift();
    future.current = [];
    commit(next);
  }, [commit, depth]);

  const replace = useCallback((next: T) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (prev === undefined) return;
    future.current.push(stateRef.current);
    commit(prev);
  }, [commit]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(stateRef.current);
    commit(next);
  }, [commit]);

  const reset = useCallback((next: T) => {
    past.current = [];
    future.current = [];
    commit(next);
  }, [commit]);

  return { state, set, replace, undo, redo, canUndo: marks.canUndo, canRedo: marks.canRedo, reset };
}
