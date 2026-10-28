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
 * Also pinned (OPA-GAP-1..7, routed from /grade-tests w57): a change of signed-in
 * person reloads the list and forgets "just activated"; `not_eligible`,
 * `already_active` and an unsupported sign-in each have their own copy, and an
 * unknown error falls back to the generic one; a failed list read shows the load
 * error (never an empty, activatable form) and Retry reads again; "Switch into
 * the workspace" switches to `host-kicktodo`, fires the auth change, then
 * reloads, in that order; no fresh token after a successful MFA step restarts
 * step-up instead of re-showing the consumed code step; a failed "End now" shows
 * its refusal and leaves the activation live; and the 30 s tick counts the
 * minutes down and turns the activation into "expired" while the panel is open.
 * The count never exceeds the activation's own length, even when this browser's
 * clock runs behind the server that stamped it (seen live: 8 h read "481").
 *
 * Sabotage (witnessed, /grade-tests w57): rendering or loading without the
 * superadmin check, treating a tenant owner as eligible (r2), a minimum of 0, an
 * untrimmed length check (r2), the cached token instead of the re-auth token
 * (both paths), the wrong workspace / a fixed duration / an untrimmed reason
 * (r2), never or always announcing, skipping the end call, dropping the typed
 * MFA code (r2), ignoring the caller subject, staying on the code step or keeping
 * the consumed code (r2), and collapsing refusals into the generic message each
 * turn a case red. For the OPA-GAP cases: not resetting `justActivated` on a
 * subject change, dropping `callerSubject` from the effect, mapping an unknown
 * code to a specific refusal, rendering the form on a failed read, a Retry that
 * does not reload, switching to another workspace or skipping the auth change,
 * re-showing the code step after a consumed MFA, reloading or clearing the live
 * activation on a failed end, and removing the interval each turn a case red;
 * dropping the `activatedAt` cap turns the clock-skew case red.
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
  user: ME as User | null,
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
  useBackendSession: (): { user: User | null; resolved: boolean } => ({ user: state.user, resolved: true }),
}));
vi.mock('../../../client/operatorAccessClient.js', () => ({
  listOperatorActivations: (ws: string) => state.list(ws),
  activateOperatorAccess: (ws: string, b: { justification: string; durationMinutes: number }, token: string) => state.activate(ws, b, token),
  endOperatorAccess: (ws: string) => state.end(ws),
}));
vi.mock('../../../client/workspaceClient.js', () => ({ switchWorkspace: vi.fn(async () => {}) }));
vi.mock('../../../client/config.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/config.js')>()),
  fireAuthChanged: vi.fn(),
}));
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
import { StepUpUnsupportedError } from '../../../auth/stepUp.js';
import { switchWorkspace } from '../../../client/workspaceClient.js';
import { fireAuthChanged } from '../../../client/config.js';

beforeEach(() => {
  // The polite live region is module state: without this, a case could pass on
  // the announcement an EARLIER case made.
  announce('');
  state.access = SUPERADMIN;
  state.user = ME;
  state.rows = [];
  vi.mocked(switchWorkspace).mockClear();
  vi.mocked(fireAuthChanged).mockClear();
  // mockReset (not mockClear) so an unconsumed *Once never leaks into the next case.
  for (const f of [state.list, state.activate, state.end, state.reauth, state.completeMfa, state.freshToken]) f.mockReset();
  defaults();
});
afterEach(cleanup);

const refusal = (code: string) => new ApiError({ status: 403, statusText: 'Forbidden', url: '/x', body: { error: 'forbidden', details: { code } } });
const justify = (value = 'A-08 first catalog / D-23') => fireEvent.change(screen.getByLabelText(/Why do you need operator access/), { target: { value } });
const liveRow = (subject: string, minutesFromNow: number, id = 'opa_live'): OperatorActivation => ({
  activationId: id, workspaceId: 'host-kicktodo', subject, justification: 'live session',
  activatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + minutesFromNow * 60_000).toISOString(),
});
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

  it('OPA-GAP-1: a change of signed-in person reloads the list and forgets "just activated"', async () => {
    const { rerender } = render(<OperatorAccessPanel />);
    await screen.findByText(/including approving your own submission/);
    justify();
    fireEvent.click(activateButton());
    await waitFor(() => expect(currentAnnouncements().polite).toContain('Operator access is now active.'));
    const readsBefore = state.list.mock.calls.length;
    announce('');
    // The next person already holds a live activation of their own.
    state.user = { ...ME, userId: 'user:next', principalId: 'user:next' };
    state.rows = [liveRow('user:next', 30, 'opa_next')];
    rerender(<OperatorAccessPanel />);
    // The panel's clock was last set at the earlier activation, so the minute
    // count can round up by one; WHOSE activation is live is what matters here.
    expect(await screen.findByText(/^Operator access is active: (30|31) minutes left\.$/)).toBeTruthy();
    expect(screen.getByText(/live session/)).toBeTruthy();
    expect(state.list.mock.calls.length).toBe(readsBefore + 1);
    expect(state.list).toHaveBeenLastCalledWith('host-kicktodo');
    // Their activation is state they arrived to, not an action they just took.
    expect(currentAnnouncements().polite).not.toContain('Operator access is now active.');
  });

  it('OPA-GAP-2: not_eligible, already_active, an unsupported sign-in and an unknown error each get their own copy', async () => {
    state.activate.mockRejectedValueOnce(refusal('not_eligible'));
    render(<OperatorAccessPanel />);
    await screen.findByText(/including approving your own submission/);
    justify();
    fireEvent.click(activateButton());
    expect(await screen.findByText('Operator access is limited to the operators of this site.')).toBeTruthy();

    state.activate.mockRejectedValueOnce(refusal('already_active'));
    fireEvent.click(activateButton());
    expect(await screen.findByText('Operator access is already active.')).toBeTruthy();
    expect(screen.queryByText('Operator access is limited to the operators of this site.')).toBeNull();

    state.reauth.mockRejectedValueOnce(new StepUpUnsupportedError());
    fireEvent.click(activateButton());
    expect(await screen.findByText(/Your sign-in method cannot confirm here/)).toBeTruthy();
    expect(state.activate).toHaveBeenCalledTimes(2);

    state.activate.mockRejectedValueOnce(refusal('something_new'));
    fireEvent.click(activateButton());
    expect(await screen.findByText('Operator access could not be changed. Try again.')).toBeTruthy();
    expect(screen.queryByText(/Your sign-in method cannot confirm here/)).toBeNull();
  });

  it('OPA-GAP-3: a failed list read shows the load error, not an activatable form, and Retry reads again', async () => {
    state.list.mockRejectedValueOnce(new Error('network'));
    render(<OperatorAccessPanel />);
    expect(await screen.findByText(/Operator access could not be loaded/)).toBeTruthy();
    expect(screen.queryByLabelText(/Why do you need operator access/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in again and activate' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText(/Why do you need operator access/)).toBeTruthy();
    expect(state.list).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Operator access could not be loaded/)).toBeNull();
  });

  it('OPA-GAP-4: "Switch into the workspace" switches to host-kicktodo, fires the auth change, then reloads', async () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      state.rows = [liveRow('user:me', 30)];
      render(<OperatorAccessPanel />);
      fireEvent.click(await screen.findByRole('button', { name: 'Switch into the workspace' }));
      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(switchWorkspace).toHaveBeenCalledWith('host-kicktodo');
      expect(fireAuthChanged).toHaveBeenCalledTimes(1);
      const switched = vi.mocked(switchWorkspace).mock.invocationCallOrder[0]!;
      const fired = vi.mocked(fireAuthChanged).mock.invocationCallOrder[0]!;
      expect(switched).toBeLessThan(fired);
      expect(fired).toBeLessThan(reload.mock.invocationCallOrder[0]!);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('OPA-GAP-5: no fresh token after a successful MFA step restarts step-up instead of re-showing the code step', async () => {
    state.reauth.mockRejectedValueOnce(new MfaRequiredError());
    state.freshToken.mockResolvedValueOnce(null);
    render(<OperatorAccessPanel />);
    await screen.findByText(/including approving your own submission/);
    justify();
    fireEvent.click(activateButton());
    fireEvent.change(await screen.findByLabelText('Authenticator code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and activate' }));
    expect(await screen.findByText('Operator access could not be changed. Try again.')).toBeTruthy();
    expect(state.completeMfa).toHaveBeenCalledTimes(1);
    expect(state.activate).not.toHaveBeenCalled();
    // The consumed challenge is gone: back to the activate step, not the code step.
    expect(screen.queryByLabelText('Authenticator code')).toBeNull();
    fireEvent.click(activateButton());
    await waitFor(() => expect(state.activate).toHaveBeenCalledTimes(1));
    expect(state.reauth).toHaveBeenCalledTimes(2);
    expect(state.completeMfa).toHaveBeenCalledTimes(1);
    expect(state.activate.mock.calls[0]![2]).toBe('fresh-token');
  });

  it('OPA-GAP-6: a failed "End now" shows its refusal and leaves the activation live', async () => {
    state.rows = [liveRow('user:me', 30)];
    state.end.mockRejectedValueOnce(refusal('not_eligible'));
    render(<OperatorAccessPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'End now' }));
    expect(await screen.findByText('Operator access is limited to the operators of this site.')).toBeTruthy();
    expect(state.end).toHaveBeenCalledWith('host-kicktodo');
    expect(state.list).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Operator access is active: 30 minutes left.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'End now' })).toBeTruthy();
    expect(screen.queryByText(/ended early/)).toBeNull();
  });

  it('OPA-GAP-7: the 30 s tick counts the minutes down and turns the activation into "expired" while open', async () => {
    // Only the interval and the clock are faked; promises and testing-library's
    // own timers stay real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: new Date('2026-10-23T12:00:00.000Z') });
    try {
      state.rows = [liveRow('user:me', 1.5)];
      render(<OperatorAccessPanel />);
      expect(await screen.findByText('Operator access is active: 2 minutes left.')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(screen.getByText('Operator access is active: 1 minute left.')).toBeTruthy();
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(screen.queryByText(/Operator access is active/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'End now' })).toBeNull();
      expect(screen.getByText(/ — expired — live session/)).toBeTruthy();
      expect(screen.getByLabelText(/Why do you need operator access/)).toBeTruthy();
      expect(state.list).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never shows more minutes than the activation lasts when this clock runs behind the server', async () => {
    // The server stamped an 8 h activation 20 s "in the future" of this browser.
    const serverNow = Date.now() + 20_000;
    state.rows = [{
      activationId: 'opa_skew', workspaceId: 'host-kicktodo', subject: 'user:me', justification: 'skewed clock',
      activatedAt: new Date(serverNow).toISOString(), expiresAt: new Date(serverNow + 480 * 60_000).toISOString(),
    }];
    render(<OperatorAccessPanel />);
    expect(await screen.findByText('Operator access is active: 480 minutes left.')).toBeTruthy();
  });
});
