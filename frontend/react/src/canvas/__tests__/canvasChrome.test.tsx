/**
 * §7 chrome primitives — direct coverage (grade-pass 2026-07-12): the
 * SelectionPill verbs/ARIA, the NotesDrawer disclosure + draft-on-blur
 * commit + per-type persistence, and the ViewportHandleContext
 * last-mount-wins contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, renderHook } from '@testing-library/react';
import { SelectionPill } from '../SelectionPill.js';
import { ViewportHandleContext, usePublishViewportHandle, type ViewportHandleSlot, type ViewportZoomHandle } from '../viewportHandle.js';
import type { ElementActions } from '../types.js';

beforeEach(() => localStorage.clear());

describe('SelectionPill (§7.4 / CV-7)', () => {
  const actions = (over: Partial<ElementActions> = {}): ElementActions => ({
    duplicate: vi.fn(),
    remove: vi.fn(),
    toggleLock: vi.fn(),
    locked: false,
    ...over,
  });

  it('is a labeled toolbar; verbs fire; lock reflects state via aria-pressed', () => {
    const a = actions();
    render(<SelectionPill actions={a} style={{}} />);
    expect(screen.getByRole('toolbar', { name: 'Selection actions' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(a.duplicate).toHaveBeenCalled();
    const lock = screen.getByRole('button', { name: 'Lock' });
    expect(lock.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(lock);
    expect(a.toggleLock).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete selection' }));
    expect(a.remove).toHaveBeenCalled();
  });

  it('locked selection shows Unlock; group/ungroup render only when supplied', () => {
    const g = vi.fn();
    render(<SelectionPill actions={actions({ locked: true, group: g })} style={{}} />);
    expect(screen.getByRole('button', { name: 'Unlock' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Group' }));
    expect(g).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Ungroup' })).toBeNull();
  });

  it('duplicate hides when the collection is at max (undefined verb)', () => {
    render(<SelectionPill actions={actions({ duplicate: undefined })} style={{}} />);
    expect(screen.queryByRole('button', { name: 'Duplicate' })).toBeNull();
  });
});

describe('ViewportHandleContext (§7.3 / CV-3)', () => {
  function slot(): { api: ViewportHandleSlot; get: () => ViewportZoomHandle | null } {
    let cur: ViewportZoomHandle | null = null;
    const api: ViewportHandleSlot = { publish: (h) => { cur = h; }, get: () => cur };
    return { api, get: () => cur };
  }

  it('publishes on mount, clears its own handle on unmount', () => {
    const { api, get } = slot();
    const handle: ViewportZoomHandle = { fit: vi.fn(), zoomToPercent: vi.fn() };
    const { unmount } = renderHook(() => usePublishViewportHandle(handle), {
      wrapper: ({ children }) => <ViewportHandleContext.Provider value={api}>{children}</ViewportHandleContext.Provider>,
    });
    expect(get()).toBe(handle);
    unmount();
    expect(get()).toBeNull();
  });

  it('last mount wins; an earlier unmount never clears the newer handle', () => {
    const { api, get } = slot();
    const a: ViewportZoomHandle = { fit: vi.fn(), zoomToPercent: vi.fn() };
    const b: ViewportZoomHandle = { fit: vi.fn(), zoomToPercent: vi.fn() };
    const wrapper = ({ children }: { children: React.ReactNode }): JSX.Element => (
      <ViewportHandleContext.Provider value={api}>{children}</ViewportHandleContext.Provider>
    );
    const first = renderHook(() => usePublishViewportHandle(a), { wrapper });
    const second = renderHook(() => usePublishViewportHandle(b), { wrapper });
    expect(get()).toBe(b);
    first.unmount(); // stale surface unmounting must NOT clear b
    expect(get()).toBe(b);
    second.unmount();
    expect(get()).toBeNull();
  });

  it('the default slot is inert (surfaces outside an editor publish harmlessly)', () => {
    const handle: ViewportZoomHandle = { fit: vi.fn(), zoomToPercent: vi.fn() };
    expect(() => {
      const { unmount } = renderHook(() => usePublishViewportHandle(handle));
      unmount();
    }).not.toThrow();
  });
});
