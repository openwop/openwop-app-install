/**
 * Small optimistic-value hook for a controlled `<select>` (or any single
 * value control) backed by a network round trip — the small-form sibling of
 * KanbanBoardView's optimistic card move (CRMGAP-FE-4). The board mirrors
 * `cards` into local state and reconciles on the next parent refetch; this
 * hook does the same for one field: the picked value shows immediately,
 * reconciles to the server value once the prop updates, and reverts on a
 * failed commit so the caller can toast without leaving a stale selection.
 */
import { useCallback, useEffect, useState } from 'react';

export function useOptimisticField<T>(
  serverValue: T,
  commit: (next: T) => Promise<unknown>,
): [T, (next: T) => Promise<void>] {
  const [value, setValue] = useState(serverValue);
  // Reconcile to the server value whenever it changes underneath us (a
  // reload, an org switch, another tab's edit) — mirrors the board's
  // `useEffect(() => setLocal(cards), [cards])`.
  useEffect(() => { setValue(serverValue); }, [serverValue]);

  const set = useCallback(async (next: T) => {
    if (next === value) return;
    const prev = value;
    setValue(next);
    try {
      await commit(next);
    } catch (err) {
      setValue(prev);
      throw err;
    }
  }, [value, commit]);

  return [value, set];
}
