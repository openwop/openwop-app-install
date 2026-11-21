/**
 * ADR 0139 correction: a save is authorized by the mounted auth owner that
 * initiated it, including the lazy import BEFORE PUT dispatch. Keep the actual
 * provider and exercise its asynchronous import continuation. No real writes.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuConfig, MenuConfigBundle } from '../types.js';
const h = vi.hoisted(() => ({
  auth: new Set<() => void>(),
  read: vi.fn<() => Promise<MenuConfigBundle>>(),
  tenant: vi.fn<(cfg: MenuConfig) => Promise<MenuConfig>>(),
  user: vi.fn<(cfg: MenuConfig) => Promise<MenuConfig>>(),
}));
vi.mock('../../../client/config.js', () => ({ onAuthChange: (fn: () => void) => { h.auth.add(fn); return () => h.auth.delete(fn); } }));
vi.mock('../../features.js', () => ({ FEATURES: [] }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureVisible: () => () => true }));
vi.mock('../../../client/useEffectiveAccess.js', () => ({ useEffectiveAccessState: () => ({ access: { roles: [], scopes: [], basis: 'none' } }), isAdminCaller: () => false }));

// Use the ordinary namespace: manual module mocks share Vitest's import
// callstack and can send concurrent imports down the real-function fallback.
import * as menuClient from '../menuConfigClient.js';
import { NavConfigProvider as Provider, useNavConfig as useMenu } from '../NavConfigProvider.js';

const cfg = (label: string): MenuConfig => ({ items: {}, headers: [{ id: 'custom', tier: 'admin', label }] });
// The real client may subscribe at module evaluation. Preserve that baseline;
// each mounted provider must remove only its own subscription on cleanup.
const baselineAuthListeners = new Set(h.auth);
let restoreClientSpies = (): void => {};
beforeEach(() => {
  expect(h.auth).toEqual(baselineAuthListeners);
  h.read.mockReset(); h.tenant.mockReset(); h.user.mockReset();
  h.read.mockResolvedValue({ tenant: cfg('current'), user: cfg('current-user') });
  h.tenant.mockImplementation(async (value) => value); h.user.mockImplementation(async (value) => value);
  const read = vi.spyOn(menuClient, 'getMenuConfig').mockImplementation(h.read);
  const tenant = vi.spyOn(menuClient, 'putTenantMenuConfig').mockImplementation(h.tenant);
  const user = vi.spyOn(menuClient, 'putMyMenuConfig').mockImplementation(h.user);
  restoreClientSpies = () => { read.mockRestore(); tenant.mockRestore(); user.mockRestore(); };
});
afterEach(async () => {
  cleanup();
  try {
    await vi.dynamicImportSettled();
    expect(h.auth).toEqual(baselineAuthListeners);
  } finally { restoreClientSpies(); }
});
function Probe() {
  const value = useMenu();
  return <><output aria-label="tenant-menu">{value.bundle.tenant.headers[0]?.label ?? 'default'}</output><output aria-label="user-menu">{value.bundle.user.headers[0]?.label ?? 'default'}</output><button onClick={() => { void value.saveTenant(cfg('tenant-edit')); }}>Save tenant</button><button onClick={() => { void value.saveUser(cfg('user-edit')); }}>Save personal</button></>;
}
function mount() { return render(<Provider><Probe /></Provider>); }
function authChanged() { act(() => { for (const fn of h.auth) fn(); }); }
// Keep the actual provider's cached real-module import() continuation. All three
// request exports are spied before mount; no manual mock registry or live fetch.
async function settleClientImports() { await act(async () => { await vi.dynamicImportSettled(); }); }

describe('menu save lazy-import admission', () => {
  it('does not dispatch a tenant PUT if auth changes while its module import is pending', async () => {
    mount();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Save tenant' }));
      expect(h.tenant).not.toHaveBeenCalled(); expect(h.user).not.toHaveBeenCalled();
      authChanged();
    });
    await settleClientImports();
    expect(h.tenant).not.toHaveBeenCalled(); expect(h.user).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText('tenant-menu').textContent).toBe('current'));
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a personal PUT if workspace auth changes during its module import', async () => {
    mount();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Save personal' }));
      expect(h.user).not.toHaveBeenCalled(); expect(h.tenant).not.toHaveBeenCalled();
      authChanged();
    });
    await settleClientImports();
    expect(h.user).not.toHaveBeenCalled(); expect(h.tenant).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText('user-menu').textContent).toBe('current-user'));
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch either pending save after the initiating provider unmounts', async () => {
    const view = mount();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Save tenant' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save personal' }));
      expect(h.tenant).not.toHaveBeenCalled(); expect(h.user).not.toHaveBeenCalled();
      view.unmount();
    });
    await settleClientImports();
    expect(h.tenant).not.toHaveBeenCalled(); expect(h.user).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
    expect(h.auth).toEqual(baselineAuthListeners);
  });

  it('still dispatches current-owner tenant and personal edits after the import settles', async () => {
    mount(); await settleClientImports();
    await waitFor(() => expect(screen.getByLabelText('tenant-menu').textContent).toBe('current'));
    expect(h.read).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Save tenant' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save personal' }));
    await waitFor(() => expect(h.tenant).toHaveBeenCalledTimes(1)); await waitFor(() => expect(h.user).toHaveBeenCalledTimes(1));
    expect(h.tenant).toHaveBeenCalledWith(cfg('tenant-edit')); expect(h.user).toHaveBeenCalledWith(cfg('user-edit'));
    expect(screen.getByLabelText('tenant-menu').textContent).toBe('tenant-edit'); expect(screen.getByLabelText('user-menu').textContent).toBe('user-edit');
  });
});
