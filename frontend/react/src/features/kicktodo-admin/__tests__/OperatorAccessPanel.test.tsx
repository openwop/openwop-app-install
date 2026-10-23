/**
 * ADR 0910 D11 — the Operator access panel (613c610ee; announce-once 72b544f7d;
 * caller binding + step-up restart 2edb7b04d).
 *
 * Pins: hidden unless the caller is a LISTED superadmin (a workspace owner with
 * every role is NOT enough); the copy names what is granted, self-approval
 * included; a justification of at least 10 characters AFTER trimming is
 * required; activation re-authenticates FIRST and sends that fresh token, on the
 * `host-kicktodo` workspace, with the chosen duration and the trimmed reason; an
 * MFA challenge gets its own code step and the TYPED code is what completes it;
 * only THIS caller's activation counts as live (another operator's stays in the
 * history); a failed activation after MFA restarts step-up with the consumed
 * code cleared; `mfa_required` / `reauth_required` render their own states; a
 * live activation shows minutes left, is announced only right after activating,
 * and can be ended.
 *
 * Sabotage (witnessed, /grade-tests w57): rendering or loading without the
 * superadmin check, treating a tenant owner as eligible (r2), a minimum of 0, an
 * untrimmed length check (r2), the cached token instead of the re-auth token
 * (both paths), the wrong workspace / a fixed duration / an untrimmed reason
 * (r2), never or always announcing, skipping the end call, dropping the typed
 * MFA code (r2), ignoring the caller subject, staying on the code step or keeping
 * the consumed code (r2), and collapsing refusals into the generic message each
 * turn a case red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../../../client/requestJson.js';
import { announce, currentAnnouncements } from '../../../ui/announce.js';
import type {
  activateOperatorAccess, endOperatorAccess, listOperatorActivations, OperatorActivation,
} from '../../../client/operatorAccessClient.js';
import type { EffectiveAccess } from '../../../client/accessClient.js';
import type { User } from '../../users/usersClient.js';

const SUPERADMIN: EffectiveAccess = { roles: [], scopes: [], basis: 'none', superadmin: true };
const ME: User = {
  userId: 'user:me', tenantId: 'acme', principalId: 'user:me', groups: [], source: 'oidc', status: 'active',
  createdAt: '2026-01-05T10:00:00.000Z', updatedAt: '2026-01-05T10:00:00.000Z',
};

const state = {
  access: SUPERADMIN,
  rows: [] as OperatorActivation[],
  list: vi.fn<typeof listOperatorActivations>(),
  activate: vi.fn<typeof activateOperatorAccess>(),
  end: vi.fn<typeof endOperatorAccess>(),
  reauth: vi.fn<() => Promise<string>>(),
  completeMfa: vi.fn<(code: string) => Promise<void>>(),
  freshToken: vi.fn<() => Promise<string | null>>(),
};

function defaults(): void {
  state.list.mockImplementation(async () => state.rows);
  state.activate.mockImplementation(async (workspaceId, body) => {
    const a: OperatorActivation = {
      activationId: 'opa_1', workspaceId, subject: 'user:me', justification: body.justification,
      activatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    };
    state.rows = [a];
    return a;
  });
  state.end.mockImplementation(async () => { state.rows = state.rows.map((r) => ({ ...r, revokedAt: new Date().toISOString() })); });
  state.reauth.mockImplementation(async () => 'fresh-token');
  state.completeMfa.mockImplementation(async () => {});
  state.freshToken.mockImplementation(async () => 'fresh-after-mfa');
}

vi.mock('../../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: (): { access: EffectiveAccess; resolved: boolean } => ({ access: state.access, resolved: true }),
}));
vi.mock('../../../auth/backendSession.js', () => ({
  useBackendSession: (): { user: User | null; resolved: boolean } => ({ user: ME, resolved: true }),
}));
vi.mock('../../../client/operatorAccessClient.js', () => ({
  listOperatorActivations: (ws: string) => state.list(ws),
  activateOperatorAccess: (ws: string, b: { justification: string; durationMinutes: number }, token: string) => state.activate(ws, b, token),
  endOperatorAccess: (ws: string) => state.end(ws),
}));
vi.mock('../../../client/workspaceClient.js', () => ({ switchWorkspace: vi.fn(async () => {}) }));
vi.mock('../../../auth/firebase.js', () => {
  class MfaRequiredError extends Error {}
  return { MfaRequiredError, completeMfaSignIn: (code: string) => state.completeMfa(code) };
});
vi.mock('../../../auth/stepUp.js', () => {
  class StepUpUnsupportedError extends Error {}
  return {
    StepUpUnsupportedError,
    reauthenticateForStepUp: () => state.reauth(),
    getFreshIdToken: () => state.freshToken(),
  };
});

import { OperatorAccessPanel } from '../OperatorAccessPanel.js';
import { MfaRequiredError } from '../../../auth/firebase.js';

beforeEach(() => {
  // The polite live region is module state: without this, a case could pass on
  // the announcement an EARLIER case made.
  announce('');
  state.access = SUPERADMIN;
  state.rows = [];
  // mockReset (not mockClear) so an unconsumed *Once never leaks into the next case.
  for (const f of [state.list, state.activate, state.end, state.reauth, state.completeMfa, state.freshToken]) f.mockReset();
  defaults();
});
afterEach(cleanup);

const refusal = (code: string) => new ApiError({ status: 403, statusText: 'Forbidden', url: '/x', body: { error: 'forbidden', details: { code } } });
const justify = (value = 'A-08 first catalog / D-23') => fireEvent.change(screen.getByLabelText(/Why do you need operator access/), { target: { value } });
const activateButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Sign in again and activate' });

describe('OperatorAccessPanel', () => {
  it('is hidden from anyone who is not a listed superadmin', () => {
    // A workspace OWNER with every role, but not a listed superadmin.
    state.access = { roles: ['owner', 'admin'], scopes: ['*'], basis: 'tenant-owner' };
    render(<OperatorAccessPanel />);
    expect(screen.queryByText('Operator access')).toBeNull();
    expect(state.list).not.toHaveBeenCalled();
    cleanup();
    state.access = { roles: [], scopes: [], basis: 'member', superadmin: false };
    render(<OperatorAccessPanel />);
    expect(screen.queryByText('Operator access')).toBeNull();
    expect(state.list).not.toHaveBeenCalled();
  });

  it('says what is granted, self-approval included, and requires a justification', async () => {
    render(<OperatorAccessPanel />);
    expect(await screen.findByText(/including approving your own submission/)).toBeTruthy();
    expect(activateButton().disabled).toBe(true);
    // 11 characters raw, 5 once trimmed: still too short.
    justify('   short   ');
    expect(activateButton().disabled).toBe(true);
    // 9 once trimmed: one short. Exactly 10 once trimmed: enough.
    justify('  123456789  ');
    expect(activateButton().disabled).toBe(true);
    justify('  0123456789  ');
    expect(activateButton().disabled).toBe(false);
  });

  it('re-authenticates first and activates with THAT fresh token, then shows minutes left and can end it', async () => {
    render(<OperatorAccessPanel />);
    await screen.findByText(/including approving your own submission/);
    expect(state.list).toHaveBeenCalledWith('host-kicktodo');
    justify('  A-08 first catalog / D-23  ');
    fireEvent.change(screen.getByLabelText('For how long'), { target: { value: '120' } });
    fireEvent.click(activateButton());
    await waitFor(() => expect(state.activate).toHaveBeenCalledTimes(1));
    expect(state.reauth).toHaveBeenCalledTimes(1);
    expect(state.activate).toHaveBeenCalledWith(
      'host-kicktodo', { justification: 'A-08 first catalog / D-23', durationMinutes: 120 }, 'fresh-token',
    );
    expect(await screen.findByText('Operator access is active: 90 minutes left.')).toBeTruthy();
    // The completed activation is ANNOUNCED (a status region that mounts already
    // holding its text is silent — check-notice-announce).
    await waitFor(() => expect(currentAnnouncements().polite).toContain('Operator access is now active.'));
    fireEvent.click(screen.getByRole('button', { name: 'End now' }));
    await waitFor(() => expect(state.end).toHaveBeenCalledTimes(1));
    expect(state.end).toHaveBeenCalledWith('host-kicktodo');
    expect(await screen.findByText(/ended early/)).toBeTruthy();
  });

  it('a page that merely SHOWS an existing live activation does not announce it (state, not an action)', async () => {
    state.rows = [{ activationId: 'opa_0', workspaceId: 'host-kicktodo', subject: 'user:me', justification: 'earlier', activatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }];
    render(<OperatorAccessPanel />);
    expect(await screen.findByText('Operator access is active: 30 minutes left.')).toBeTruthy();
    expect(currentAnnouncements().polite).not.toContain('Operator access is now active.');
  });

  it('an MFA challenge gets a code step, then activates with the post-MFA token', async () => {
    state.reauth.mockRejectedValueOnce(new MfaRequiredError());
    render(<OperatorAccessPanel />);
    await screen.findByText(/including approving your own submission/);
    justify();
    fireEvent.click(activateButton());
    const code = await screen.findByLabelText('Authenticator code');
    fireEvent.change(code, { target: { value: ' 123456 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and activate' }));
    await waitFor(() => expect(state.activate).toHaveBeenCalledTimes(1));
    expect(state.completeMfa).toHaveBeenCalledTimes(1);
    expect(state.completeMfa).toHaveBeenCalledWith('123456');
    expect(state.activate.mock.calls[0]![2]).toBe('fresh-after-mfa');
  });

  it('keeps another operator in history while allowing this person to activate', async () => {
    state.rows = [{ activationId: 'opa_other', workspaceId: 'host-kicktodo', subject: 'user:other', justification: 'Other operator session', activatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }];
    render(<OperatorAccessPanel />);
    expect(await screen.findByText(/Other operator session/)).toBeTruthy();
    expect(screen.queryByText('Operator access is active: 30 minutes left.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'End now' })).toBeNull();
    justify();
    fireEvent.click(activateButton());
    await waitFor(() => expect(state.activate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Operator access is active: 90 minutes left.')).toBeTruthy();
  });

  it('restarts step-up if activation fails after MFA consumed the challenge', async () => {
    state.reauth.mockRejectedValueOnce(new MfaRequiredError());
    state.activate.mockRejectedValueOnce(refusal('reauth_required'));
    render(<OperatorAccessPanel />);
    await screen.findByText(/including approving your own submission/);
    justify();
    fireEvent.click(activateButton());
    fireEvent.change(await screen.findByLabelText('Authenticator code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and activate' }));
    await screen.findByText(/That sign-in was too long ago/);
    expect(screen.queryByLabelText('Authenticator code')).toBeNull();
    // Hold the second re-auth open: while it works, the consumed code must be
    // gone (a kept code re-renders the code field during `working`).
    let release!: (token: string) => void;
    state.reauth.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    fireEvent.click(activateButton());
    await waitFor(() => expect(state.reauth).toHaveBeenCalledTimes(2));
    expect(screen.queryByLabelText('Authenticator code')).toBeNull();
    await act(async () => { release('fresh-token'); });
    await waitFor(() => expect(state.activate).toHaveBeenCalledTimes(2));
    expect(state.completeMfa).toHaveBeenCalledTimes(1);
    expect(state.activate.mock.calls[1]![2]).toBe('fresh-token');
    expect(await screen.findByText('Operator access is active: 90 minutes left.')).toBeTruthy();
  });

  it('mfa_required and reauth_required each render their own state', async () => {
    state.activate.mockRejectedValueOnce(refusal('mfa_required'));
    render(<OperatorAccessPanel />);
    await screen.findByText(/including approving your own submission/);
    justify();
    fireEvent.click(activateButton());
    expect(await screen.findByText(/needs two-step verification first/)).toBeTruthy();
    state.activate.mockRejectedValueOnce(refusal('reauth_required'));
    fireEvent.click(activateButton());
    expect(await screen.findByText(/That sign-in was too long ago/)).toBeTruthy();
    expect(screen.queryByText(/needs two-step verification first/)).toBeNull();
  });
});
