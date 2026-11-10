/**
 * ADR 0958 matrix row 10 — the agency's Collaborators panel.
 *
 *   - collaborators off (404 "not enabled") or not this client's manager (403)
 *     → renders nothing; a failed read is said with a retry, never "no
 *     collaborators";
 *   - every state reads as the server holds it: invite sent, active,
 *     suspended, removed (collapsed); link-only client approvers are not here;
 *     an expired or revoked grant is not shown as access;
 *   - each action calls its route and says so, and each refusal shows the
 *     server's own message: invite (the link shown once), give access (only
 *     the kind's actions), take back, suspend, reactivate, remove (behind a
 *     danger confirm; cancelling calls nothing);
 *   - an archived client: a warning, no invite form, and no give-access or
 *     reactivate.
 *
 * The two reads are typed module mocks; every ACTION is stubbed at the FETCH
 * level, so each case asserts the exact route, method and body, and each
 * refusal is the server's own body through the real `asJson`.
 *
 * Sabotage (witnessed 2026-10-28 and wave 78), each red when applied alone:
 *   - map a failed read to an empty list → the failed case red;
 *   - drop the 403 branch of `hidden()` → that it.each row red;
 *   - drop the link-only filter → the approver appears (red);
 *   - show every grant regardless of expiry or revocation → a dead grant appears (red);
 *   - call remove without the confirm, or a non-danger confirm → the remove case red;
 *   - leave the invite form up, or give-access enabled, for an archived client → the archived case red;
 *   - offer every action for every kind → the brief's "send files" box appears (red);
 *   - a generic message instead of the server's → every refusal case red;
 *   - send a different expiry, method or path → the request assertion of that case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { config } from '../../../client/config.js';
import type { Collaborator, CollaboratorGrant, CollaboratorStatus, GrantableKind } from '../collaboratorsClient.js';

type Client = typeof import('../collaboratorsClient.js');
const h = vi.hoisted(() => ({
  listCollaborators: vi.fn<Client['listCollaborators']>(), listGrantable: vi.fn<Client['listGrantable']>(),
}));
const c = vi.hoisted(() => ({ confirm: vi.fn<(opts: { title: string; danger?: boolean }) => Promise<boolean>>(), copyToClipboard: vi.fn() }));
vi.mock('../collaboratorsClient.js', async (orig) => ({ ...(await orig<Client>()), ...h }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: c.confirm }));
vi.mock('../../../ui/copyToClipboard.js', () => ({ copyToClipboard: c.copyToClipboard }));

import { ClientCollaboratorsPanel } from '../ClientCollaboratorsPanel.js';
import { CampaignOpsError } from '../campaignOpsClient.js';

const B = `${config.baseUrl}/host/openwop-app/campaign-ops/clients/o1/collaborators`;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refusal = (status: number, message: string): Response => json(status, { error: 'refused', message });
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
/** The last action request, as `[url, method, parsed body]`. */
const lastRequest = (): [string, string | undefined, unknown] => {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return [url, init?.method, init?.body ? JSON.parse(String(init.body)) : undefined];
};

const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2020-01-01T00:00:00Z';
const person = (id: string, status: CollaboratorStatus, extra: Partial<Collaborator> = {}): Collaborator => ({
  collaboratorId: id, orgId: 'o1', kind: 'vendor', email: `${id}@studio.test`, displayName: `Person ${id}`,
  status, mode: 'signed-in', accepted: status !== 'invited', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', grants: [], ...extra,
});
const grant = (id: string, extra: Partial<CollaboratorGrant> = {}): CollaboratorGrant => ({
  grantId: id, collaboratorId: 'a', resource: { kind: 'campaign', id: 'c1' }, actions: ['view', 'upload'], expiresAt: FUTURE, status: 'active', createdAt: '2026-10-01T00:00:00Z', ...extra,
});
const GRANTABLE: GrantableKind[] = [
  { kind: 'campaign', actions: ['view', 'upload'], items: [{ id: 'c1', title: 'Spring roast launch' }] },
  { kind: 'creative-brief', actions: ['view'], items: [{ id: 'b1', title: 'Hero shot brief' }] },
];

beforeEach(() => {
  h.listCollaborators.mockReset(); h.listGrantable.mockReset(); c.confirm.mockReset(); c.copyToClipboard.mockReset();
  h.listGrantable.mockResolvedValue(GRANTABLE);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = (clientStatus: 'active' | 'archived' = 'active') => render(<ClientCollaboratorsPanel orgId="o1" clientStatus={clientStatus} />);
const rowOf = (name: string): HTMLElement => screen.getByText(name).closest('li') as HTMLElement;

describe('ClientCollaboratorsPanel — reading', () => {
  it.each([
    ['collaborators off', new CampaignOpsError('External collaborators is not enabled for this tenant.', 404)],
    ['not this client’s manager', new CampaignOpsError('Forbidden.', 403)],
  ])('renders nothing when %s', async (_l, err) => {
    h.listCollaborators.mockRejectedValueOnce(err);
    const { container } = mount();
    await waitFor(() => expect(h.listCollaborators).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('a failed read is said with a retry, never shown as no collaborators', async () => {
    h.listCollaborators.mockRejectedValueOnce(new CampaignOpsError('boom', 500));
    mount();
    expect((await screen.findAllByText(/Couldn’t load the collaborators/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/No collaborators yet/)).toBeNull();
    h.listCollaborators.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No collaborators yet/)).toBeTruthy();
  });

  it('shows each state as the server holds it, hides link-only approvers, and shows only live access', async () => {
    h.listCollaborators.mockResolvedValueOnce([
      person('a', 'active', { grants: [grant('g-live'), grant('g-expired', { expiresAt: PAST }), grant('g-revoked', { status: 'revoked' })] }),
      person('b', 'invited'),
      person('c', 'suspended'),
      person('d', 'revoked'),
      person('e', 'active', { mode: 'link-only', kind: 'client-stakeholder', displayName: 'Client Approver' }),
    ]);
    mount();
    await screen.findByText('Person a');
    expect(within(rowOf('Person a')).getByText('Active')).toBeTruthy();
    expect(within(rowOf('Person b')).getByText('Invite sent')).toBeTruthy();
    expect(within(rowOf('Person b')).getByText(/Not accepted yet/)).toBeTruthy();
    expect(within(rowOf('Person c')).getByText('Suspended')).toBeTruthy();
    expect(screen.getByText('Removed (1)')).toBeTruthy();
    expect(screen.queryByText('Client Approver')).toBeNull();
    const access = within(rowOf('Person a')).getByRole('list', { name: 'What Person a can access' });
    expect(within(access).getAllByRole('listitem')).toHaveLength(1);
    expect(access.textContent).toContain('Campaign: Spring roast launch');
    expect(access.textContent).toContain('view, send files');
  });
});

describe('ClientCollaboratorsPanel — actions', () => {
  it('invites and shows the link once; a refusal is shown verbatim and no link appears', async () => {
    h.listCollaborators.mockResolvedValue([]);
    mount();
    await screen.findByText(/No collaborators yet/);
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Dana Studio' } });
    fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: 'dana@studio.test' } });
    fetchMock.mockResolvedValueOnce(refusal(409, 'This person is already a collaborator for this client.'));
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    expect(await screen.findByText('This person is already a collaborator for this client.')).toBeTruthy();
    expect(screen.queryByLabelText(/Invite link for/)).toBeNull();

    fetchMock.mockResolvedValueOnce(json(201, { collaborator: person('n', 'invited'), invite: { token: 'tok-123', expiresAt: FUTURE } }));
    fireEvent.click(screen.getByRole('button', { name: 'Create invite' }));
    const link = await screen.findByLabelText('Invite link for Dana Studio');
    expect((link as HTMLInputElement).value).toBe(`${window.location.origin}/collab/accept/tok-123`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lastRequest()).toEqual([B, 'POST', { kind: 'vendor', displayName: 'Dana Studio', email: 'dana@studio.test' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(c.copyToClipboard).toHaveBeenCalledWith(`${window.location.origin}/collab/accept/tok-123`, 'Invite link copied');
  });

  it('gives access with only the kind’s actions; a refusal keeps the form and says why', async () => {
    h.listCollaborators.mockResolvedValue([person('a', 'active')]);
    mount();
    await screen.findByText('Person a');
    fireEvent.click(within(rowOf('Person a')).getByRole('button', { name: 'Give access' }));
    const form = screen.getByRole('form', { name: 'Give access' });
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: 'creative-brief:b1' } });
    expect(within(form).queryByLabelText('send files')).toBeNull();
    fireEvent.change(within(form).getByLabelText('To'), { target: { value: 'campaign:c1' } });
    fireEvent.click(within(form).getByLabelText('send files'));
    fireEvent.change(within(form).getByLabelText('For'), { target: { value: '7' } });
    fetchMock.mockResolvedValueOnce(refusal(404, 'Not found.'));
    fireEvent.click(within(form).getByRole('button', { name: 'Give access' }));
    expect(await screen.findByText('Not found.')).toBeTruthy();
    expect(screen.getByRole('form', { name: 'Give access' })).toBeTruthy();
    fetchMock.mockResolvedValueOnce(json(201, { grant: grant('g1') }));
    fireEvent.click(within(screen.getByRole('form', { name: 'Give access' })).getByRole('button', { name: 'Give access' }));
    expect(await screen.findByText('Person a has access.')).toBeTruthy();
    expect(lastRequest()).toEqual([`${B}/a/grants`, 'POST', { resource: { kind: 'campaign', id: 'c1' }, actions: ['view', 'upload'], expiresInDays: 7 }]);
    expect(screen.queryByRole('form', { name: 'Give access' })).toBeNull();
  });

  it('takes access back; a refusal is shown', async () => {
    h.listCollaborators.mockResolvedValue([person('a', 'active', { grants: [grant('g1')] })]);
    mount();
    const take = await screen.findByRole('button', { name: 'Take back access to Spring roast launch from Person a' });
    fetchMock.mockResolvedValueOnce(refusal(409, 'The grant changed. Reload and try again.'));
    fireEvent.click(take);
    expect(await screen.findByText('The grant changed. Reload and try again.')).toBeTruthy();
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Take back access to Spring roast launch from Person a' }));
    expect(await screen.findByText('Access taken back.')).toBeTruthy();
    expect(lastRequest()).toEqual([`${B}/a/grants/g1`, 'DELETE', undefined]);
  });

  it('suspends and reactivates; a refusal is shown', async () => {
    h.listCollaborators.mockResolvedValue([person('a', 'active'), person('c', 'suspended')]);
    mount();
    await screen.findByText('Person a');
    fetchMock.mockResolvedValueOnce(refusal(409, 'Keep at least one client approver.'));
    fireEvent.click(within(rowOf('Person a')).getByRole('button', { name: 'Suspend' }));
    expect(await screen.findByText('Keep at least one client approver.')).toBeTruthy();
    fetchMock.mockResolvedValueOnce(json(200, { ok: true })).mockResolvedValueOnce(json(200, { ok: true }));
    fireEvent.click(within(rowOf('Person a')).getByRole('button', { name: 'Suspend' }));
    expect(await screen.findByText('Person a is suspended.')).toBeTruthy();
    expect(lastRequest()).toEqual([`${B}/a/status`, 'POST', { status: 'suspended' }]);
    fireEvent.click(within(rowOf('Person c')).getByRole('button', { name: 'Reactivate' }));
    expect(await screen.findByText('Person c is active again.')).toBeTruthy();
    expect(lastRequest()).toEqual([`${B}/c/status`, 'POST', { status: 'active' }]);
  });

  it('removes only after a danger confirm; cancelling calls nothing', async () => {
    h.listCollaborators.mockResolvedValue([person('a', 'active')]);
    mount();
    await screen.findByText('Person a');
    c.confirm.mockResolvedValueOnce(false);
    fireEvent.click(within(rowOf('Person a')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(c.confirm).toHaveBeenCalledTimes(1));
    expect(c.confirm.mock.calls[0]![0]).toMatchObject({ danger: true, title: 'Remove Person a?' });
    expect(fetchMock).not.toHaveBeenCalled();
    c.confirm.mockResolvedValueOnce(true);
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    fireEvent.click(within(rowOf('Person a')).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Person a was removed.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastRequest()).toEqual([`${B}/a/status`, 'POST', { status: 'revoked' }]);
  });

  it('an archived client: a warning, no invite form, no give-access or reactivate', async () => {
    h.listCollaborators.mockResolvedValue([person('a', 'active'), person('c', 'suspended')]);
    mount('archived');
    await screen.findByText('Person a');
    expect(screen.getByText(/This client is archived/)).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Invite a collaborator' })).toBeNull();
    expect((within(rowOf('Person a')).getByRole('button', { name: 'Give access' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(rowOf('Person c')).getByRole('button', { name: 'Reactivate' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(rowOf('Person c')).getByText(/because the client was archived/)).toBeTruthy();
  });
});
