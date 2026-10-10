/**
 * ADR 0800 D2 — the "API keys" Access Hub tab.
 *
 * Pins what the MCP-only key screen could not do for a CLI user: the default
 * preset declares the scopes a run-and-read flow needs (a key without
 * `runs:read` starts a run and is then refused reading it), the bare key is
 * shown once with the two lines the CLI needs, and a key that declares nothing
 * is called unrestricted instead of looking like a small one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../../../client/requestJson.js';

const canManage = vi.hoisted(() => ({ value: false }));
vi.mock('../../../lib/writeAccess.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useScopeWriteAccess: () => canManage.value,
}));
vi.mock('../../../chrome/hubContext.js', () => ({ useHub: () => ({ embedded: true }) }));
vi.mock('../../../auth/SignInButton.js', () => ({ SignInButton: () => <button type="button">Sign in</button> }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
const confirmed = vi.hoisted(() => ({ value: true, asked: 0 }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: async () => { confirmed.asked += 1; return confirmed.value; } }));
vi.mock('../apiKeysClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listDeveloperKeysWithPolicy: vi.fn(),
  createDeveloperKey: vi.fn(),
  revokeDeveloperKey: vi.fn(),
  rotateDeveloperKey: vi.fn(),
  setWorkspaceKeyPolicy: vi.fn(),
  getCliLoginRequest: vi.fn(),
  decideCliLogin: vi.fn(),
  publicApiBaseUrl: vi.fn(() => 'https://app.example/api'),
}));

import { ApiKeysPage } from '../ApiKeysPage.js';
import { decideCliLogin, getCliLoginRequest } from '../apiKeysClient.js';
import { API_KEY_PRESETS, cliSetupSnippet, createDeveloperKey, daysUntilExpiry, lifetimeChoices, listDeveloperKeysWithPolicy, presetOfKey, revokeDeveloperKey, rotateDeveloperKey, setWorkspaceKeyPolicy } from '../apiKeysClient.js';

const mListRaw = vi.mocked(listDeveloperKeysWithPolicy);
const POLICY = { defaultLifetimeDays: 90, maxLifetimeDays: 366, allowNoExpiry: false };
type Keys = Awaited<ReturnType<typeof listDeveloperKeysWithPolicy>>['keys'];
/** The page reads `{ keys, policy }`; the cases below only care about the keys. */
const mList = {
  mockImplementation: (fn: () => Promise<Keys>) => mListRaw.mockImplementation(async () => ({ keys: await fn(), policy: POLICY })),
  mockImplementationOnce: (fn: () => Promise<Keys>) => mListRaw.mockImplementationOnce(async () => ({ keys: await fn(), policy: POLICY })),
};
const mCreate = vi.mocked(createDeveloperKey);
const mRevoke = vi.mocked(revokeDeveloperKey);
const mRotate = vi.mocked(rotateDeveloperKey);
const mSetPolicy = vi.mocked(setWorkspaceKeyPolicy);
const mGetLogin = vi.mocked(getCliLoginRequest);
const mDecideLogin = vi.mocked(decideCliLogin);
const key = (over: Partial<Keys[number]> = {}) => ({
  keyId: 'dk:1', name: 'Laptop', scopes: [...API_KEY_PRESETS.run], createdAt: '2026-10-01T00:00:00Z', mine: true, ...over,
});
const renderPage = () => render(<MemoryRouter><ApiKeysPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  confirmed.value = true;
  confirmed.asked = 0;
  canManage.value = false;
  mList.mockImplementation(async () => []);
  mCreate.mockImplementation(async (name: string, scopes: string[]) => ({ token: 'owk_secret_once', key: key({ keyId: 'dk:new', name, scopes }) }));
  mRevoke.mockImplementation(async () => undefined);
});
afterEach(cleanup);

describe('ApiKeysPage', () => {
  it('a signed-out caller is offered sign-in, not an error', async () => {
    mList.mockImplementationOnce(async () => { throw new ApiError({ status: 401, statusText: 'Unauthorized', url: 'developer keys', body: {}, message: 'no' }); });
    renderPage();
    expect(await screen.findByText('Sign in to create an API key')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('a network failure reads as a failure with a retry', async () => {
    mList.mockImplementationOnce(async () => { throw new TypeError('Failed to fetch'); });
    renderPage();
    expect(await screen.findByText('API keys didn’t load')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText(/No keys yet/)).toBeTruthy();
  });

  it('the default preset mints a key that can READ the run it creates', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Name this key'), { target: { value: 'Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await waitFor(() => expect(mCreate).toHaveBeenCalledTimes(1));
    const [name, scopes, lifetimeDays] = mCreate.mock.calls[0]!;
    expect(name).toBe('Laptop');
    expect(lifetimeDays, 'the deployment default, sent explicitly').toBe(90);
    // Exactly the preset — `runs:read` is the scope the MCP key lacked.
    expect(scopes).toEqual(API_KEY_PRESETS.run);
    expect(scopes).toContain('runs:read');
  });

  it('the chosen preset is the one minted', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Name this key'), { target: { value: 'Reader' } });
    fireEvent.click(screen.getByRole('radio', { name: /Read only/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await waitFor(() => expect(mCreate).toHaveBeenCalledTimes(1));
    expect(mCreate.mock.calls[0]![1]).toEqual(API_KEY_PRESETS.read);
  });

  it('shows the bare key once, with the two lines the CLI needs, and Done removes both', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Name this key'), { target: { value: 'Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    const region = await screen.findByRole('region', { name: 'Your new key' });
    expect(region.textContent).toContain('owk_secret_once');
    expect(region.textContent).toContain('export OPENWOP_BASE_URL=https://app.example/api');
    expect(region.textContent).toContain('export OPENWOP_API_KEY=owk_secret_once');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(/owk_secret_once/)).toBeNull();
  });

  it('a blank name is refused in place; nothing is minted', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create key' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(mCreate).not.toHaveBeenCalled();
  });

  it('a refused create says why and shows no key', async () => {
    mCreate.mockImplementationOnce(async () => { throw new ApiError({ status: 400, statusText: 'Bad Request', url: 'developer key issue', body: { message: 'at most 100 keys.' }, message: 'at most 100 keys.' }); });
    renderPage();
    fireEvent.change(await screen.findByLabelText('Name this key'), { target: { value: 'One too many' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByText('at most 100 keys.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Your new key' })).toBeNull();
  });

  it('lists every key honestly: preset, AI-client keys, unrestricted keys, other people’s', async () => {
    mList.mockImplementation(async () => [
      key({ keyId: 'dk:1', name: 'Laptop' }),
      key({ keyId: 'dk:2', name: 'MCP: Cursor', scopes: ['workspace:read'] }),
      key({ keyId: 'dk:3', name: 'Old script', scopes: [] }),
      key({ keyId: 'dk:4', name: 'CI', scopes: [...API_KEY_PRESETS.read], mine: false }),
      key({ keyId: 'dk:5', name: 'Hand-rolled', scopes: ['runs:read'] }),
    ]);
    renderPage();
    expect(await screen.findByText('Laptop')).toBeTruthy();
    expect(screen.getByText('AI client')).toBeTruthy();
    expect(screen.getByText('Unrestricted')).toBeTruthy();
    expect(screen.getByText('Custom scopes')).toBeTruthy();
    expect(screen.getByText('Someone else’s')).toBeTruthy();
    expect(screen.getByText(/An unrestricted key can do everything/)).toBeTruthy();
    expect(screen.getByText(/Workspace admins see every key/)).toBeTruthy();
  });

  it('revoke asks first; a declined confirm revokes nothing', async () => {
    mList.mockImplementation(async () => [key()]);
    confirmed.value = false;
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke key Laptop' }));
    // Wait until the confirm was ASKED and its answer consumed; only then is
    // "not revoked" a fact rather than "not revoked yet".
    await waitFor(() => expect(confirmed.asked).toBe(1));
    await Promise.resolve(); await Promise.resolve();
    expect(mRevoke).not.toHaveBeenCalled();
    confirmed.value = true;
    fireEvent.click(screen.getByRole('button', { name: 'Revoke key Laptop' }));
    await waitFor(() => expect(mRevoke).toHaveBeenCalledWith('dk:1'));
  });

  it('revoking the key that was just issued removes it from the page', async () => {
    mList.mockImplementation(async () => (mCreate.mock.calls.length ? [key({ keyId: 'dk:new', name: 'Laptop' })] : []));
    renderPage();
    fireEvent.change(await screen.findByLabelText('Name this key'), { target: { value: 'Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByRole('region', { name: 'Your new key' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke key Laptop' }));
    await waitFor(() => expect(mRevoke).toHaveBeenCalledWith('dk:new'));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Your new key' })).toBeNull());
    expect(screen.queryByText(/owk_secret_once/)).toBeNull();
  });

  it('a list refresh that fails after a create keeps the once-only key on the page', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Name this key'), { target: { value: 'Laptop' } });
    mList.mockImplementationOnce(async () => { throw new TypeError('Failed to fetch'); });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    const region = await screen.findByRole('region', { name: 'Your new key' });
    await waitFor(() => expect(mListRaw).toHaveBeenCalledTimes(2));
    expect(region.textContent).toContain('owk_secret_once');
    expect(screen.queryByText('API keys didn’t load')).toBeNull();
  });

  it('a key NAMED like an AI-client key but holding API scopes is not relabelled', async () => {
    mList.mockImplementation(async () => [key({ keyId: 'dk:9', name: 'MCP: sneaky', scopes: [...API_KEY_PRESETS.cli] })]);
    renderPage();
    const row = (await screen.findByText('MCP: sneaky')).closest('li')!;
    expect(row.textContent).not.toContain('AI client');
    expect(row.textContent).toContain('CLI — act as me');
  });
});

describe('ApiKeysPage — lifetime (ADR 0795 D4)', () => {
  it('offers the lifetimes the deployment will issue and sends the one chosen', async () => {
    renderPage();
    const select = (await screen.findByLabelText('Expires after')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['30', '90', '180', '366']);
    expect(select.value).toBe('90');
    fireEvent.change(select, { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Name this key'), { target: { value: 'Short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await waitFor(() => expect(mCreate).toHaveBeenCalledTimes(1));
    expect(mCreate.mock.calls[0]![2]).toBe(30);
  });

  it('"Never" appears only where the operator allows it, and is sent as null', async () => {
    renderPage();
    const first = (await screen.findByLabelText('Expires after')) as HTMLSelectElement;
    expect([...first.options].some((o) => o.value === 'never')).toBe(false);
    cleanup();
    mListRaw.mockImplementation(async () => ({ keys: [], policy: { defaultLifetimeDays: 90, maxLifetimeDays: 90, allowNoExpiry: true } }));
    renderPage();
    const select = (await screen.findByLabelText('Expires after')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['30', '90', 'never']);
    fireEvent.change(select, { target: { value: 'never' } });
    fireEvent.change(screen.getByLabelText('Name this key'), { target: { value: 'Forever' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await waitFor(() => expect(mCreate).toHaveBeenCalledTimes(1));
    expect(mCreate.mock.calls[0]![2]).toBeNull();
  });

  it('a key close to expiry is flagged; one with months left shows its date only', async () => {
    const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000 + 3_600_000).toISOString();
    mList.mockImplementation(async () => [
      key({ keyId: 'dk:1', name: 'Soon', expiresAt: inDays(3) }),
      key({ keyId: 'dk:2', name: 'Later', expiresAt: inDays(80) }),
      key({ keyId: 'dk:3', name: 'Forever' }),
    ]);
    renderPage();
    const soon = (await screen.findByText('Soon')).closest('li')!;
    expect(soon.textContent).toContain('Expires in 3 days');
    const later = screen.getByText('Later').closest('li')!;
    expect(later.textContent).not.toContain('Expires in');
    expect(later.textContent).toMatch(/expires /);
    expect(screen.getByText('Forever').closest('li')!.textContent).toContain('no expiry');
  });
});

describe('ApiKeysPage — hint, rotation, workspace rules (ADR 0798)', () => {
  it('a key shows its hint and where it was last used from', async () => {
    mList.mockImplementation(async () => [key({ hint: 'owk_AbCd…WxYz', lastUsedAt: '2026-10-01T00:00:00Z', lastUsedIp: '203.0.113.9' })]);
    renderPage();
    const row = (await screen.findByText('Laptop')).closest('li')!;
    expect(row.textContent).toContain('owk_AbCd…WxYz');
    expect(row.textContent).toContain('from 203.0.113.9');
  });

  it('Rotate asks first, then shows the REPLACEMENT key once; a declined confirm rotates nothing', async () => {
    mList.mockImplementation(async () => [key()]);
    mRotate.mockImplementation(async () => ({ token: 'owk_rotated_once', key: key({ keyId: 'dk:2' }), previous: key({ rotatedTo: 'dk:2' }) }));
    confirmed.value = false;
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate key Laptop' }));
    await waitFor(() => expect(confirmed.asked).toBe(1));
    await Promise.resolve(); await Promise.resolve();
    expect(mRotate).not.toHaveBeenCalled();
    confirmed.value = true;
    fireEvent.click(screen.getByRole('button', { name: 'Rotate key Laptop' }));
    const region = await screen.findByRole('region', { name: 'Your new key' });
    expect(mRotate).toHaveBeenCalledWith('dk:1');
    expect(region.textContent).toContain('owk_rotated_once');
  });

  it('a key that was already replaced says so and offers no second rotation', async () => {
    mList.mockImplementation(async () => [key({ rotatedTo: 'dk:2' })]);
    renderPage();
    const row = (await screen.findByText('Laptop')).closest('li')!;
    expect(row.textContent).toContain('Replaced by a newer key');
    expect(screen.queryByRole('button', { name: 'Rotate key Laptop' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke key Laptop' })).toBeTruthy();
  });

  it('when the workspace has keys turned off, the page says so and offers no way to create or rotate one', async () => {
    mListRaw.mockImplementation(async () => ({ keys: [key()], policy: { ...POLICY, disabled: true } }));
    renderPage();
    expect(await screen.findByText(/API keys are turned off for this workspace/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create key' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rotate key Laptop' })).toBeNull();
    // Revoking stays possible: turning keys off must not trap a key in place.
    expect(screen.getByRole('button', { name: 'Revoke key Laptop' })).toBeTruthy();
  });

  it('the rules card is offered only to someone who manages the workspace', async () => {
    renderPage();
    await screen.findByLabelText('Name this key');
    expect(screen.queryByText('Workspace rules for API keys')).toBeNull();
    cleanup();
    canManage.value = true;
    renderPage();
    expect(await screen.findByText('Workspace rules for API keys')).toBeTruthy();
  });

  it('saving the rules sends what is on the form; an out-of-range cap cannot be saved', async () => {
    canManage.value = true;
    mSetPolicy.mockImplementation(async () => ({ effective: { ...POLICY, maxLifetimeDays: 30, defaultLifetimeDays: 30 } }));
    renderPage();
    const cap = (await screen.findByLabelText('Longest lifetime (days)')) as HTMLInputElement;
    fireEvent.change(cap, { target: { value: '0' } });
    expect((screen.getByRole('button', { name: 'Save rules' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(cap, { target: { value: '30' } });
    fireEvent.click(screen.getByLabelText('Allow API keys in this workspace'));
    fireEvent.click(screen.getByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(mSetPolicy).toHaveBeenCalledWith({ disabled: true, maxLifetimeDays: 30 }));
  });

  it('a refused save shows the server’s reason', async () => {
    canManage.value = true;
    mSetPolicy.mockImplementation(async () => { throw new ApiError({ status: 403, statusText: 'Forbidden', url: 'developer key policy', body: { message: 'Only a workspace admin or owner can change the API key policy.' }, message: 'no' }); });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Save rules' }));
    await waitFor(() => expect(mSetPolicy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector('.alert.error')).not.toBeNull());
  });
});

describe('ApiKeysPage — approve a CLI sign-in (ADR 0799)', () => {
  const REQ = { userCode: 'BCDF-GHJK', label: 'laptop', requestedFrom: '203.0.113.9', createdAt: '2026-10-01T12:00:00Z', expiresAt: '2026-10-01T12:10:00Z' };

  it('a blank code is refused in place; nothing is looked up', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Find sign-in' }));
    expect(await screen.findByText('Type the code your terminal is showing.')).toBeTruthy();
    expect(mGetLogin).not.toHaveBeenCalled();
  });

  it('typing the code shows WHAT is asking before anything is approved; approving refreshes the key list', async () => {
    mGetLogin.mockImplementation(async () => ({ request: REQ, workspaceId: 'user:x' }));
    mDecideLogin.mockImplementation(async () => undefined);
    renderPage();
    fireEvent.change(await screen.findByLabelText('Code from your terminal'), { target: { value: 'bcdfghjk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find sign-in' }));
    const region = await screen.findByRole('region', { name: 'CLI sign-in waiting for you' });
    expect(mGetLogin).toHaveBeenCalledWith('bcdfghjk');
    expect(mDecideLogin).not.toHaveBeenCalled();
    expect(region.textContent).toContain('“laptop” is asking to sign in as you.');
    expect(region.textContent).toContain('BCDF-GHJK');
    expect(region.textContent).toContain('203.0.113.9');
    const listsBefore = mListRaw.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Approve sign-in' }));
    await waitFor(() => expect(mDecideLogin).toHaveBeenCalledWith('BCDF-GHJK', 'approve'));
    expect(await screen.findByText(/“laptop” is signed in/)).toBeTruthy();
    await waitFor(() => expect(mListRaw.mock.calls.length).toBeGreaterThan(listsBefore));
  });

  it('Deny sends deny, says so, and does not refresh the list as if a key had appeared', async () => {
    mGetLogin.mockImplementation(async () => ({ request: REQ, workspaceId: 'user:x' }));
    mDecideLogin.mockImplementation(async () => undefined);
    renderPage();
    fireEvent.change(await screen.findByLabelText('Code from your terminal'), { target: { value: 'BCDF-GHJK' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find sign-in' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(mDecideLogin).toHaveBeenCalledWith('BCDF-GHJK', 'deny'));
    expect(await screen.findByText(/Sign-in for “laptop” was denied/)).toBeTruthy();
  });

  it('a wrong, expired or used code reads the same, with what to do next', async () => {
    mGetLogin.mockImplementation(async () => { throw new ApiError({ status: 404, statusText: 'Not Found', url: 'cli sign-in', body: {}, message: 'no' }); });
    renderPage();
    fireEvent.change(await screen.findByLabelText('Code from your terminal'), { target: { value: 'ZZZZ-ZZZZ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find sign-in' }));
    expect(await screen.findByText(/That code is not waiting for approval/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve sign-in' })).toBeNull();
  });

  it('is not offered when the workspace has keys turned off', async () => {
    mListRaw.mockImplementation(async () => ({ keys: [], policy: { ...POLICY, disabled: true } }));
    renderPage();
    await screen.findByText(/API keys are turned off for this workspace/);
    expect(screen.queryByText('Sign in the OpenWOP CLI')).toBeNull();
  });
});

describe('apiKeysClient', () => {
  it('lifetimeChoices stays under the cap and always includes the default', () => {
    expect(lifetimeChoices({ defaultLifetimeDays: 90, maxLifetimeDays: 366, allowNoExpiry: false })).toEqual([30, 90, 180, 366]);
    expect(lifetimeChoices({ defaultLifetimeDays: 45, maxLifetimeDays: 60, allowNoExpiry: false })).toEqual([30, 45]);
  });

  it('daysUntilExpiry: null without an expiry, 0 on the last day and for an unparseable one', () => {
    const now = Date.parse('2026-10-01T00:00:00Z');
    expect(daysUntilExpiry({}, now)).toBeNull();
    expect(daysUntilExpiry({ expiresAt: '2026-10-04T12:00:00Z' }, now)).toBe(3);
    expect(daysUntilExpiry({ expiresAt: '2026-10-01T06:00:00Z' }, now)).toBe(0);
    expect(daysUntilExpiry({ expiresAt: 'tomorrow' }, now)).toBe(0);
  });

  it('presetOfKey reads the declaration, not the name', () => {
    expect(presetOfKey({ scopes: [...API_KEY_PRESETS.run].reverse() })).toBe('run');
    expect(presetOfKey({ scopes: [...API_KEY_PRESETS.cli] })).toBe('cli');
    expect(presetOfKey({ scopes: [] })).toBe('unrestricted');
    expect(presetOfKey({ scopes: ['*'] })).toBe('unrestricted');
    expect(presetOfKey({ scopes: ['runs:read'] })).toBe('custom');
  });

  it('publicApiBaseUrl makes a same-origin base absolute and leaves an absolute one alone', async () => {
    const real = await vi.importActual<typeof import('../apiKeysClient.js')>('../apiKeysClient.js');
    const url = real.publicApiBaseUrl('https://app.example');
    expect(url).toMatch(/^https?:\/\//);
    expect(url.endsWith('/')).toBe(false);
  });

  it('the CLI snippet names the two variables the CLI reads', () => {
    expect(cliSetupSnippet('https://h.example/api', 'owk_x')).toBe('export OPENWOP_BASE_URL=https://h.example/api\nexport OPENWOP_API_KEY=owk_x');
  });
});
