/**
 * ADR 0203 correction: a failed access read is not a non-admin decision. These
 * mount the actual shared cache and AdminLayout; only the HTTP/auth boundaries
 * and unrelated nav/feature chrome are replaced. Deferred reads expose stale
 * auth/retry ownership without timers, network failures or role mutations.
 */
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from 'i18next';
import type { EffectiveAccess } from '../../client/accessClient.js';

const h = vi.hoisted(() => ({ read: vi.fn<() => Promise<EffectiveAccess>>(), auth: new Set<() => void>(), navFailed: false, reloadMenu: vi.fn() }));
vi.mock('../../client/accessClient.js', async (original) => ({ ...(await original<typeof import('../../client/accessClient.js')>()), getEffectiveAccess: h.read }));
vi.mock('../../client/config.js', async (original) => ({ ...(await original<typeof import('../../client/config.js')>()), onAuthChange: (fn: () => void) => { h.auth.add(fn); return () => h.auth.delete(fn); } }));
vi.mock('../../features/featureExtensions.js', () => ({}));
vi.mock('../navConfig/NavConfigProvider.js', () => ({
  useResolvedNav: () => ({ admin: [], workspace: [], site: [], degraded: h.navFailed }),
  useNavConfig: () => ({ loading: false, reload: h.reloadMenu }),
}));
vi.mock('../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureBadge: () => () => null, useFeatureLocked: () => () => false,
}));

function deferred<T>() {
  let resolve: (v: T) => void = () => { throw new Error('not initialized'); };
  let reject: (e: Error) => void = () => { throw new Error('not initialized'); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const OWNER: EffectiveAccess = { roles: ['owner'], scopes: ['workspace:read'], basis: 'member' };
const NONE: EffectiveAccess = { roles: [], scopes: [], basis: 'none' };
let hooks: typeof import('../../client/useEffectiveAccess.js');
let Layout: typeof import('../AdminLayout.js')['AdminLayout'];
beforeEach(async () => {
  vi.resetModules(); h.auth.clear(); h.read.mockReset(); h.navFailed = false; h.reloadMenu.mockReset();
  hooks = await import('../../client/useEffectiveAccess.js');
  Layout = (await import('../AdminLayout.js')).AdminLayout;
});
afterEach(cleanup);
function authChanged() { act(() => { for (const fn of h.auth) fn(); }); }
function mountLayout() {
  return render(<MemoryRouter initialEntries={['/media']}><Routes><Route element={<Layout />}><Route path="/media" element={<div>MEDIA OUTLET</div>} /></Route></Routes></MemoryRouter>);
}

describe('admin access read lifecycle', () => {
  it('reports a failed read instead of claiming non-admin and retries into the actual admin outlet', async () => {
    h.read.mockRejectedValueOnce(new Error('HTTP 429')).mockResolvedValueOnce(OWNER);
    mountLayout();
    expect(await screen.findByText(i18n.t('chrome:adminAccessReadFailedTitle'))).toBeTruthy();
    expect(screen.queryByText(i18n.t('chrome:adminAccessRequiredTitle'))).toBeNull();
    expect(screen.queryByText('MEDIA OUTLET')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common:retry') }));
    expect(await screen.findByText('MEDIA OUTLET')).toBeTruthy();
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(i18n.t('chrome:adminAccessReadFailedTitle'))).toBeNull();
  });

  it('offers the real menu warning retry without re-reading authority or changing roles', async () => {
    h.navFailed = true; h.read.mockResolvedValueOnce(OWNER); mountLayout();
    expect(await screen.findByText('MEDIA OUTLET')).toBeTruthy();
    expect(screen.getByText(i18n.t('chrome:adminNavDegraded'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common:retry') }));
    expect(h.reloadMenu).toHaveBeenCalledTimes(1); expect(h.read).toHaveBeenCalledTimes(1);
  });

  it('still denies a successful current NONE answer without offering a failed-read retry', async () => {
    h.read.mockResolvedValueOnce(NONE); mountLayout();
    expect(await screen.findByText(i18n.t('chrome:adminAccessRequiredTitle'))).toBeTruthy();
    expect(screen.queryByText('MEDIA OUTLET')).toBeNull();
    expect(screen.queryByRole('button', { name: i18n.t('common:retry') })).toBeNull();
  });

  it('shares one read in StrictMode and does not auto-retry a settled error for a new consumer', async () => {
    const read = deferred<EffectiveAccess>(); h.read.mockReturnValueOnce(read.promise);
    const first = renderHook(() => hooks.useEffectiveAccessState(), { wrapper: StrictMode });
    const second = renderHook(() => hooks.useEffectiveAccessState());
    expect(h.read).toHaveBeenCalledTimes(1);
    await act(async () => { read.reject(new Error('limited')); });
    expect(first.result.current.failed).toBe(true); expect(second.result.current.failed).toBe(true);
    const third = renderHook(() => hooks.useEffectiveAccessState());
    expect(third.result.current.failed).toBe(true); expect(h.read).toHaveBeenCalledTimes(1);
    expect(third.result.current.access).toEqual(NONE);
  });

  it('neutralizes current authority immediately when auth changes before the new read settles', async () => {
    const next = deferred<EffectiveAccess>(); h.read.mockResolvedValueOnce(OWNER).mockReturnValueOnce(next.promise);
    const hook = renderHook(() => hooks.useEffectiveAccessState());
    await waitFor(() => expect(hook.result.current.access).toEqual(OWNER));
    authChanged();
    expect(hook.result.current.resolved).toBe(false); expect(hook.result.current.access).toEqual(NONE);
    await act(async () => { next.resolve(NONE); });
    expect(hook.result.current.resolved).toBe(true); expect(hook.result.current.failed).toBe(false);
    expect(hooks.isAdminCaller(hook.result.current.access)).toBe(false);
  });

  it('ignores an obsolete failure after the current auth read grants owner', async () => {
    const old = deferred<EffectiveAccess>(); const current = deferred<EffectiveAccess>();
    h.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const hook = renderHook(() => hooks.useEffectiveAccessState()); authChanged();
    await act(async () => { current.resolve(OWNER); });
    await act(async () => { old.reject(new Error('old 429')); });
    expect(hook.result.current.access).toEqual(OWNER); expect(hook.result.current.failed).toBe(false);
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('never grants an obsolete owner answer after a current successful denial', async () => {
    const old = deferred<EffectiveAccess>(); const current = deferred<EffectiveAccess>();
    h.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const hook = renderHook(() => hooks.useEffectiveAccessState()); authChanged();
    await act(async () => { current.resolve(NONE); });
    await act(async () => { old.resolve(OWNER); });
    expect(hooks.isAdminCaller(hook.result.current.access)).toBe(false);
    expect(hook.result.current.failed).toBe(false); expect(hook.result.current.resolved).toBe(true);
  });

  it('keeps current ownership across auth A B A rather than accepting the first A answer', async () => {
    const a1 = deferred<EffectiveAccess>(); const b = deferred<EffectiveAccess>(); const a2 = deferred<EffectiveAccess>();
    h.read.mockReturnValueOnce(a1.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(a2.promise);
    const hook = renderHook(() => hooks.useEffectiveAccessState()); authChanged(); authChanged();
    await act(async () => { a2.resolve(NONE); b.reject(new Error('obsolete B')); a1.resolve(OWNER); });
    expect(hook.result.current.access).toEqual(NONE); expect(hook.result.current.failed).toBe(false);
    expect(h.read).toHaveBeenCalledTimes(3);
  });

  it('coalesces two retry requests and ignores that retry after a newer auth answer', async () => {
    const retry = deferred<EffectiveAccess>(); const current = deferred<EffectiveAccess>();
    h.read.mockRejectedValueOnce(new Error('limited')).mockReturnValueOnce(retry.promise).mockReturnValueOnce(current.promise);
    const hook = renderHook(() => hooks.useEffectiveAccessState());
    await waitFor(() => expect(hook.result.current.failed).toBe(true));
    act(() => { hook.result.current.retry(); hook.result.current.retry(); });
    expect(h.read).toHaveBeenCalledTimes(2); authChanged();
    await act(async () => { current.resolve(OWNER); retry.reject(new Error('obsolete retry')); });
    expect(hook.result.current.access).toEqual(OWNER); expect(hook.result.current.failed).toBe(false);
  });
});
