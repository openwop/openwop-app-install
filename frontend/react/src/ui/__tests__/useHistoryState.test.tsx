/**
 * useHistoryState (ADR 0305 Phase B) — the shared bounded undo/redo hook.
 * The stacks live outside React updaters, so StrictMode double-invocation
 * must not double-pop; `replace` must not create history entries.
 */
import { describe, it, expect } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { useHistoryState } from '../useHistoryState.js';

describe('useHistoryState', () => {
  it('pushes one entry per set and walks undo/redo', () => {
    const { result } = renderHook(() => useHistoryState<number>(0));
    act(() => result.current.set(1));
    act(() => result.current.set(2));
    expect(result.current.state).toBe(2);
    expect(result.current.canUndo).toBe(true);
    act(() => result.current.undo());
    expect(result.current.state).toBe(1);
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    expect(result.current.state).toBe(2);
  });

  it('a new set clears the redo stack', () => {
    const { result } = renderHook(() => useHistoryState<number>(0));
    act(() => result.current.set(1));
    act(() => result.current.undo());
    act(() => result.current.set(9));
    expect(result.current.canRedo).toBe(false);
    expect(result.current.state).toBe(9);
  });

  it('replace swaps the value without a history entry', () => {
    const { result } = renderHook(() => useHistoryState<string>('a'));
    act(() => result.current.set('b'));
    act(() => result.current.replace('b-typed'));
    expect(result.current.state).toBe('b-typed');
    act(() => result.current.undo());
    expect(result.current.state).toBe('a'); // the replace never stacked
  });

  it('caps history depth at 30', () => {
    const { result } = renderHook(() => useHistoryState<number>(0));
    act(() => { for (let i = 1; i <= 40; i += 1) result.current.set(i); });
    let undos = 0;
    // Flush per undo — result.current only refreshes between act() calls.
    while (result.current.canUndo && undos < 100) { act(() => result.current.undo()); undos += 1; }
    expect(undos).toBe(30);
    expect(result.current.state).toBe(10); // oldest retained baseline
  });

  it('reset clears both stacks', () => {
    const { result } = renderHook(() => useHistoryState<number>(0));
    act(() => result.current.set(1));
    act(() => result.current.reset(42));
    expect(result.current.state).toBe(42);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('undo at the floor and redo at the tip are no-ops', () => {
    const { result } = renderHook(() => useHistoryState<number>(5));
    act(() => result.current.undo());
    act(() => result.current.redo());
    expect(result.current.state).toBe(5);
  });

  it('survives StrictMode double-invocation without double-popping', () => {
    const { result } = renderHook(() => useHistoryState<number>(0), { wrapper: StrictMode });
    act(() => result.current.set(1));
    act(() => result.current.set(2));
    act(() => result.current.undo());
    expect(result.current.state).toBe(1);
    act(() => result.current.undo());
    expect(result.current.state).toBe(0);
    expect(result.current.canUndo).toBe(false);
  });
});
