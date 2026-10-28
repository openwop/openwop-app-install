/**
 * ADR 0910 D8 — the Challenge Factory key card on AI & connections.
 *
 * Pins: hidden unless the caller is a LISTED superadmin; outside `host-kicktodo`
 * it reads no refs and says to switch in (the vault write lands in the ACTIVE
 * workspace); inside, it lists only `kicktodo-factory:*` refs by provider, and
 * Save writes `kicktodo-factory:<provider>` with the trimmed value — never a
 * `<provider>:<label>` ref the chat ladder would pick up — then clears the field
 * and re-reads; a 403 gets the operator-access copy, any other failure the
 * generic one, and a failed read shows the load error with a Retry that reads
 * again. The key value never reaches the page text.
 *
 * Sabotage (witnessed): dropping the superadmin check, skipping the workspace
 * check, writing `${provider}:kicktodo-factory`, not trimming, keeping the value
 * after a save, and collapsing a 403 into the generic refusal each turn a case red.
 *
 * Operator access up front (2026-10-24): with no live activation of THIS person
 * the card says so, links to People & access and disables the form, so a key is
 * never pasted into a save the host will refuse. Sabotage (witnessed): ignoring
 * the activation, counting an expired one, counting another operator's, and
 * blocking the form when the activation read failed each turn a case red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../../../client/requestJson.js';
import type { EffectiveAccess } from '../../../client/accessClient.js';
import { messages as en } from '../i18n/en.js';

const SUPERADMIN: EffectiveAccess = { roles: [], scopes: [], basis: 'none', superadmin: true };
const OWNER: EffectiveAccess = { roles: ['owner'], scopes: [], basis: 'none', superadmin: false };

const ME = 'user:me';
const live = (subject = ME, expiresAt = '2999-01-01T00:00:00.000Z'): Record<string, string> => ({
  activationId: 'a1', workspaceId: 'host-kicktodo', subject, justification: 'x', activatedAt: '2026-10-24T00:00:00.000Z', expiresAt,
});

const state = {
  access: SUPERADMIN,
  activations: vi.fn<() => Promise<unknown[]>>(),
  active: 'host-kicktodo',
  refs: [] as string[],
  workspaces: vi.fn<() => Promise<{ active: string }>>(),
  list: vi.fn<() => Promise<readonly string[]>>(),
  store: vi.fn<(ref: string, value: string) => Promise<{ credentialRef: string; masked: string }>>(),
};

vi.mock('../../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: (): { access: EffectiveAccess; resolved: boolean } => ({ access: state.access, resolved: true }),
}));
vi.mock('../../../client/workspaceClient.js', () => ({ listMyWorkspaces: () => state.workspaces() }));
vi.mock('../../../byok/lib/byokClient.js', () => ({
  listStoredRefs: () => state.list(),
  storeKey: (ref: string, value: string) => state.store(ref, value),
}));
vi.mock('../OperatorAccessPanel.js', () => ({ OPERATOR_WORKSPACE: 'host-kicktodo' }));
vi.mock('../../../client/operatorAccessClient.js', () => ({ listOperatorActivations: () => state.activations() }));
vi.mock('../../../auth/backendSession.js', () => ({ useBackendSession: () => ({ user: { userId: ME } }) }));

import { MemoryRouter } from 'react-router-dom';
import { FactoryKeyCard as Card } from '../FactoryKeyCard.js';

const FactoryKeyCard = (): JSX.Element => <MemoryRouter><Card /></MemoryRouter>;

const SECRET = 'AIzaTest-not-a-real-key';
const t = (s: string, vars: Record<string, string> = {}): string => s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');

beforeEach(() => {
  state.access = SUPERADMIN;
  state.active = 'host-kicktodo';
  state.refs = ['google:chat', 'web-search'];
  state.workspaces.mockImplementation(async () => ({ active: state.active }));
  state.list.mockImplementation(async () => state.refs);
  state.activations.mockImplementation(async () => [live()]);
  state.store.mockImplementation(async (ref) => { state.refs = [...state.refs, ref]; return { credentialRef: ref, masked: 'AIza…' }; });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const typeKey = (v: string): void => { fireEvent.change(screen.getByLabelText(en.factoryKeyValue), { target: { value: v } }); };

describe('FactoryKeyCard (ADR 0910 D8)', () => {
  it('renders nothing and reads nothing for a non-superadmin, even a workspace owner', () => {
    state.access = OWNER;
    const { container } = render(<FactoryKeyCard />);
    expect(container.textContent).toBe('');
    expect(state.workspaces).not.toHaveBeenCalled();
  });

  it('outside host-kicktodo: says to switch in, reads no refs, offers no form', async () => {
    state.active = 'acme';
    render(<FactoryKeyCard />);
    await waitFor(() => expect(screen.getByText(en.factoryKeySwitchFirst)).toBeTruthy());
    expect(state.list).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(en.factoryKeyValue)).toBeNull();
  });

  it('lists only the Factory refs; Save writes kicktodo-factory:<provider> with the trimmed value, then clears and re-reads', async () => {
    render(<FactoryKeyCard />);
    await waitFor(() => expect(screen.getByText(en.factoryKeyNone)).toBeTruthy());
    expect(screen.getByRole('button', { name: en.factoryKeySave }).hasAttribute('disabled')).toBe(true);

    typeKey(`  ${SECRET}  `);
    fireEvent.click(screen.getByRole('button', { name: en.factoryKeySave }));
    await waitFor(() => expect(screen.getByText(t(en.factoryKeySaved, { provider: 'Google (Gemini)' }))).toBeTruthy());
    expect(state.store).toHaveBeenCalledWith('kicktodo-factory:google', SECRET);
    expect(state.list).toHaveBeenCalledTimes(2);
    expect((screen.getByLabelText(en.factoryKeyValue) as HTMLInputElement).value).toBe('');
    expect(screen.getByText(t(en.factoryKeyStored, { provider: 'Google (Gemini)' }))).toBeTruthy();
    // A saved provider offers Replace, and the key value is never shown.
    expect(screen.getByRole('button', { name: en.factoryKeyReplace })).toBeTruthy();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('the chosen provider names the ref', async () => {
    render(<FactoryKeyCard />);
    await waitFor(() => expect(screen.getByLabelText(en.factoryKeyProvider)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(en.factoryKeyProvider), { target: { value: 'anthropic' } });
    typeKey(SECRET);
    fireEvent.click(screen.getByRole('button', { name: en.factoryKeySave }));
    await waitFor(() => expect(state.store).toHaveBeenCalledWith('kicktodo-factory:anthropic', SECRET));
  });

  it('a 403 says operator access is needed; another failure gets the generic copy; the value is kept to retry', async () => {
    state.store.mockRejectedValueOnce(new ApiError({ status: 403, statusText: 'Forbidden', url: '/x', message: 'no' }))
      .mockRejectedValueOnce(new Error('network'));
    render(<FactoryKeyCard />);
    await waitFor(() => expect(screen.getByLabelText(en.factoryKeyValue)).toBeTruthy());
    typeKey(SECRET);
    fireEvent.click(screen.getByRole('button', { name: en.factoryKeySave }));
    await waitFor(() => expect(screen.getByText(en.factoryKeyProblem_forbidden)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: en.factoryKeySave }));
    await waitFor(() => expect(screen.getByText(en.factoryKeyProblem_failed)).toBeTruthy());
    expect(screen.queryByText(en.factoryKeyProblem_forbidden)).toBeNull();
  });

  it('a failed read shows the load error, never the form, and Retry reads again', async () => {
    state.list.mockRejectedValueOnce(new Error('503'));
    render(<FactoryKeyCard />);
    await waitFor(() => expect(screen.getByText(en.factoryKeyLoadError)).toBeTruthy());
    expect(screen.queryByLabelText(en.factoryKeyValue)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.retry }));
    await waitFor(() => expect(screen.getByText(en.factoryKeyNone)).toBeTruthy());
  });
});

describe('FactoryKeyCard — operator access is stated before a key is pasted', () => {
  const formDisabled = (): boolean =>
    (screen.getByLabelText(en.factoryKeyValue) as HTMLInputElement).disabled
    && screen.getByRole('button', { name: en.factoryKeySave }).hasAttribute('disabled');

  it('no live activation: says so, links to People & access, and disables the form', async () => {
    state.activations.mockImplementation(async () => []);
    render(<FactoryKeyCard />);
    await waitFor(() => expect(screen.getByText(en.factoryKeyNeedsOperator)).toBeTruthy());
    expect(screen.getByRole('link', { name: en.factoryKeyActivateLink }).getAttribute('href')).toBe('/admin/kicktodo/people');
    expect(formDisabled()).toBe(true);
    expect((screen.getByLabelText(en.factoryKeyProvider) as HTMLSelectElement).disabled).toBe(true);
  });

  it('an EXPIRED activation is not live', async () => {
    state.activations.mockImplementation(async () => [live(ME, '2000-01-01T00:00:00.000Z')]);
    render(<FactoryKeyCard />);
    await waitFor(() => expect(screen.getByText(en.factoryKeyNeedsOperator)).toBeTruthy());
    expect(formDisabled()).toBe(true);
  });

  it("another operator's live activation is not this person's", async () => {
    state.activations.mockImplementation(async () => [live('user:someone-else')]);
    render(<FactoryKeyCard />);
    await waitFor(() => expect(screen.getByText(en.factoryKeyNeedsOperator)).toBeTruthy());
  });

  it('a live activation: no notice, and the form is usable', async () => {
    render(<FactoryKeyCard />);
    await waitFor(() => expect(screen.getByLabelText(en.factoryKeyValue)).toBeTruthy());
    expect(screen.queryByText(en.factoryKeyNeedsOperator)).toBeNull();
    expect((screen.getByLabelText(en.factoryKeyValue) as HTMLInputElement).disabled).toBe(false);
  });

  it('a FAILED activation read is unknown, not "off": the form stays usable and the 403 copy is the backstop', async () => {
    state.activations.mockRejectedValue(new Error('503'));
    render(<FactoryKeyCard />);
    await waitFor(() => expect(screen.getByLabelText(en.factoryKeyValue)).toBeTruthy());
    expect(screen.queryByText(en.factoryKeyNeedsOperator)).toBeNull();
    expect((screen.getByLabelText(en.factoryKeyValue) as HTMLInputElement).disabled).toBe(false);
  });

  it('no Factory key: a status chip plus the plain-language fallback', async () => {
    render(<FactoryKeyCard />);
    await waitFor(() => expect(screen.getByText(en.factoryKeyNone)).toBeTruthy());
    expect(screen.getByText(en.factoryKeyFallback)).toBeTruthy();
  });
});
