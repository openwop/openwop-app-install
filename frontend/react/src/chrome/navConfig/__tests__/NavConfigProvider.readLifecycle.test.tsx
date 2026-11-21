/**
 * ADR 0139 correction: exercise the actual provider, delayed reads and existing
 * auth-change seam. UI uses returned bundles/errors rather than mirroring refs.
 * No real config writes, network requests or auth mutations occur.
 */
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuConfigBundle } from '../types.js';
const h = vi.hoisted(() => ({
  read: vi.fn<() => Promise<MenuConfigBundle>>(),
  save: vi.fn<() => Promise<MenuConfigBundle['tenant']>>(),
  auth: new Set<() => void>(),
}));
vi.mock('../../../client/config.js', () => ({ onAuthChange: (fn: () => void) => { h.auth.add(fn); return () => h.auth.delete(fn); } }));
vi.mock('../../features.js', () => ({ FEATURES: [] }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureVisible: () => () => true }));
vi.mock('../../../client/useEffectiveAccess.js', () => ({ useEffectiveAccessState: () => ({ access: { roles: [], scopes: [], basis: 'none' } }), isAdminCaller: () => false }));
// Keep the genuine namespace so concurrent lazy imports cannot enter Vitest's
// manual-mock fallback. Spy on all request exports before mounting the provider.
import * as menuClient from '../menuConfigClient.js';
import { NavConfigProvider, useNavConfig } from '../NavConfigProvider.js';
function deferred<T>() {
  let resolve: (v: T) => void = () => { throw new Error('not initialized'); };
  let reject: (e: Error) => void = () => { throw new Error('not initialized'); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const bundle = (label: string): MenuConfigBundle => ({ tenant: { items: {}, headers: [{ id: 'custom', tier: 'admin', label }] }, user: { items: {}, headers: [] } });
function Probe() {
  const { bundle: value, failed, loading, reload, saveTenant } = useNavConfig();
  return <><output aria-label="menu-label">{value.tenant.headers[0]?.label ?? 'declared-default'}</output><output aria-label="read-state">{loading ? 'loading' : failed ? 'failed' : 'ready'}</output><button onClick={reload}>Retry menu</button><button onClick={() => { void saveTenant(bundle('saved').tenant); }}>Save menu</button></>;
}
function mount(strict = false) { const ui = <NavConfigProvider><Probe /></NavConfigProvider>; return render(strict ? <StrictMode>{ui}</StrictMode> : ui); }
function authChanged() { act(() => { for (const fn of h.auth) fn(); }); }
// The real client owns a module-lifetime auth subscription. Cleanup must
// remove only each mounted provider's listeners and preserve that baseline.
const baselineAuthListeners = new Set(h.auth);
let restoreClientSpies = (): void => {};
beforeEach(() => {
  expect(h.auth).toEqual(baselineAuthListeners);
  h.read.mockReset(); h.save.mockReset();
  const read = vi.spyOn(menuClient, 'getMenuConfig').mockImplementation(h.read);
  const tenant = vi.spyOn(menuClient, 'putTenantMenuConfig').mockImplementation(h.save);
  const user = vi.spyOn(menuClient, 'putMyMenuConfig').mockImplementation(h.save);
  restoreClientSpies = () => { read.mockRestore(); tenant.mockRestore(); user.mockRestore(); };
});
afterEach(async () => {
  cleanup();
  try {
    await vi.dynamicImportSettled();
    expect(h.auth).toEqual(baselineAuthListeners);
  } finally { restoreClientSpies(); }
});

describe('menu read lifecycle', () => {
  it('discloses a current read failure and recovers with one explicit retry', async () => {
    h.read.mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce(bundle('current'));
    mount();
    await waitFor(() => expect(screen.getByLabelText('read-state').textContent).toBe('failed'));
    expect(screen.getByLabelText('menu-label').textContent).toBe('declared-default');
    fireEvent.click(screen.getByRole('button', { name: 'Retry menu' }));
    await waitFor(() => expect(screen.getByLabelText('menu-label').textContent).toBe('current'));
    expect(screen.getByLabelText('read-state').textContent).toBe('ready'); expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('does not let an old failed auth read degrade a newer successful menu', async () => {
    const old = deferred<MenuConfigBundle>(); const current = deferred<MenuConfigBundle>();
    h.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise); mount();
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1)); authChanged();
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
    await act(async () => { current.resolve(bundle('current')); });
    await act(async () => { old.reject(new Error('old 429')); });
    expect(screen.getByLabelText('menu-label').textContent).toBe('current'); expect(screen.getByLabelText('read-state').textContent).toBe('ready');
  });

  it('clears old preferences immediately and never restores them from an obsolete successful read', async () => {
    const oldReload = deferred<MenuConfigBundle>(); const current = deferred<MenuConfigBundle>();
    h.read.mockResolvedValueOnce(bundle('old')).mockReturnValueOnce(oldReload.promise).mockReturnValueOnce(current.promise); mount();
    await waitFor(() => expect(screen.getByLabelText('menu-label').textContent).toBe('old'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry menu' }));
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2)); authChanged();
    expect(screen.getByLabelText('menu-label').textContent).toBe('declared-default');
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(3));
    await act(async () => { current.resolve(bundle('new')); oldReload.resolve(bundle('old-secret-preferences')); });
    expect(screen.getByLabelText('menu-label').textContent).toBe('new');
  });

  it('uses latest issuance for two same-auth reloads including an obsolete failure', async () => {
    const first = deferred<MenuConfigBundle>(); const last = deferred<MenuConfigBundle>();
    h.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise); mount();
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(1)); fireEvent.click(screen.getByRole('button', { name: 'Retry menu' }));
    await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
    await act(async () => { last.resolve(bundle('last')); first.reject(new Error('obsolete')); });
    expect(screen.getByLabelText('read-state').textContent).toBe('ready'); expect(screen.getByLabelText('menu-label').textContent).toBe('last');
  });

  it('keeps a successful empty bundle distinct from a failed read under StrictMode', async () => {
    h.read.mockResolvedValue({ tenant: { items: {}, headers: [] }, user: { items: {}, headers: [] } }); mount(true);
    await waitFor(() => expect(screen.getByLabelText('read-state').textContent).toBe('ready'));
    expect(screen.getByLabelText('menu-label').textContent).toBe('declared-default');
    // Obsolete dynamic-import continuations do not even dispatch a read.
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it('ignores a prior owner save aftermath after the current auth menu is loaded', async () => {
    const saved = deferred<MenuConfigBundle['tenant']>();
    h.read.mockResolvedValueOnce(bundle('old')).mockResolvedValueOnce(bundle('new')); h.save.mockReturnValueOnce(saved.promise); mount();
    await waitFor(() => expect(screen.getByLabelText('menu-label').textContent).toBe('old'));
    fireEvent.click(screen.getByRole('button', { name: 'Save menu' })); await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    authChanged(); await waitFor(() => expect(screen.getByLabelText('menu-label').textContent).toBe('new'));
    await act(async () => { saved.resolve(bundle('stale-save').tenant); });
    expect(screen.getByLabelText('menu-label').textContent).toBe('new');
  });
});
