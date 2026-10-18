/**
 * ADR 0784 P3 — the receipt's effect cache. A failed read caches NOTHING (the
 * neutral copy stays and a later render may retry); an unknown name is cached
 * as unknown and never re-asked; known names come back as effects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

let impl: (names: readonly string[]) => Promise<Record<string, 'read' | 'write'>> = async () => ({});
const asked: string[][] = [];
vi.mock('../../../client/chatSessionsClient.js', () => ({
  getToolEffects: (names: readonly string[]) => { asked.push([...names]); return impl(names); },
}));

import { useToolEffects, _resetToolEffectsCache } from '../toolEffects.js';

beforeEach(() => { _resetToolEffectsCache(); asked.length = 0; impl = async () => ({}); });

describe('useToolEffects (ADR 0784 P3)', () => {
  it('returns declared effects; an unknown name is asked once and never again', async () => {
    impl = async () => ({ a: 'read' });
    const { result, rerender } = renderHook(({ n }) => useToolEffects(n), { initialProps: { n: ['a', 'mcp_x'] } });
    await waitFor(() => expect(result.current.get('a')).toBe('read'));
    expect(result.current.has('mcp_x')).toBe(false);
    // A duplicate name in the same render is not a new ask.
    rerender({ n: ['a', 'mcp_x', 'a'] });
    await act(async () => { await Promise.resolve(); });
    expect(asked).toEqual([['a', 'mcp_x']]);
    // A FRESH mount runs the effect again — the unknown name, cached as unknown,
    // must not be re-asked (a rerender with the same key never re-runs it).
    const again = renderHook(() => useToolEffects(['mcp_x']));
    await act(async () => { await Promise.resolve(); });
    expect(asked).toEqual([['a', 'mcp_x']]);
    expect(again.result.current.has('mcp_x')).toBe(false);
  });

  it('a failed read caches nothing, so a later render asks again', async () => {
    impl = async () => { throw new Error('503'); };
    const first = renderHook(() => useToolEffects(['w']));
    await waitFor(() => expect(asked.length).toBe(1));
    await act(async () => { await Promise.resolve(); });
    expect(first.result.current.size).toBe(0);
    first.unmount();
    impl = async () => ({ w: 'write' });
    const second = renderHook(() => useToolEffects(['w']));
    await waitFor(() => expect(second.result.current.get('w')).toBe('write'));
    expect(asked).toEqual([['w'], ['w']]);
  });
});
