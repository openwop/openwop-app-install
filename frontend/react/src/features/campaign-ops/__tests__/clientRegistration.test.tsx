/**
 * ADR 0926 P2: an agency admin registers an EXISTING organization as a client. This runs the
 * real API transport (fetch stubbed), the real inbox and the real chooser, with no live writes.
 *
 * Invariants, and the sabotages that turn them red (wave 94, w94g2-cr-*):
 *  - Only an agency admin gets the affordance, and the chooser excludes the workspace root and
 *    already-registered orgs. It needs an explicit choice and a nonblank name. The server owns
 *    authority and defaults: the POST body is exactly `{orgId, name}`.
 *  - A returned account whose org OR tenant differs from the chosen org is never adopted. It
 *    stays uncertain until an authoritative GET confirms it. 400/403 refusals show the server's
 *    text. A lost response or a 409 stays blocked until a GET settles it.
 *  - An identity change (fireAuthChanged) invalidates everything in flight. Two guards refuse a
 *    same-act submit: the dialog onClick `isCurrent()` and the hook's `submit` `isCurrent()`. Both
 *    read OperationsPage `registrationCurrent`, which is where the break-both witness aims. Two
 *    guards also refuse a late POST success: the hook's `current()` (in useClientRegistration.ts)
 *    and the page's `onRegistered` guard (in OperationsPage.tsx). That is a held pair, one edit per
 *    file. A late org list is gated by the chooser's own `isCurrent()` read at render.
 *  - The pending registration outlives the dismissed chooser, blocks reopening, and preserves a
 *    client selection the user made meanwhile (A, B, A included).
 */
import { StrictMode } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { config, fireAuthChanged } from '../../../client/config.js';
import type { Organization } from '../../../client/accessClient.js';
import type { ClientAccount } from '../campaignOpsClient.js';
import { ClientRegistrationDialog } from '../ClientRegistrationDialog.js';
import type { listOrgs } from '../../../client/accessClient.js';
import type { listAssets, listClients, listRequests } from '../campaignOpsClient.js';
const h = vi.hoisted(() => ({ clients: vi.fn<typeof listClients>(), orgs: vi.fn<typeof listOrgs>(), assets: vi.fn<typeof listAssets>(), requests: vi.fn<typeof listRequests>() }));
vi.mock('../../../client/accessClient.js', async orig => ({ ...await orig<Record<string, unknown>>(), listOrgs: h.orgs }));
vi.mock('../campaignOpsClient.js', async orig => ({ ...await orig<Record<string, unknown>>(),
  listClients: h.clients, listAssets: h.assets, listRequests: h.requests,
  listChangeSets: vi.fn(async () => []), listJobs: vi.fn(async () => []), listApprovers: vi.fn(async () => ({ approvers: [], portalEnabled: false })),
}));
vi.mock('../ClientReportsSection.js', () => ({ ClientReportsSection: () => null }));
vi.mock('../ClientIntakeSection.js', () => ({ ClientIntakeSection: () => null }));
vi.mock('../ClientCollabAuditSection.js', () => ({ ClientCollabAuditSection: () => null }));
vi.mock('../ClientCollaboratorsPanel.js', () => ({ ClientCollaboratorsPanel: () => null }));
vi.mock('../ClientMemoryPanel.js', () => ({ ClientMemoryPanel: () => null }));
import { OperationsPage } from '../OperationsPage.js';
import { createClient } from '../campaignOpsClient.js';
const ORG: Organization = { orgId: 'org:kick', tenantId: 'ws:qa', name: 'QA KickTodo', slug: 'kick', createdBy: 'qa', createdAt: '', updatedAt: '' };
const CLIENT: ClientAccount = { tenantId: ORG.tenantId, orgId: ORG.orgId, displayName: ORG.name, mode: 'preview', approvalPolicy: 'agency', status: 'active', createdAt: '', updatedAt: '' };
const transport = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function mount(strict = false) { const page = <MemoryRouter><OperationsPage /></MemoryRouter>; return render(strict ? <StrictMode>{page}</StrictMode> : page); }
async function open() { fireEvent.click(await screen.findByRole('button', { name: 'Add a client' })); await screen.findByRole('combobox', { name: 'Organization' }); }
function choose() { fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), { target: { value: ORG.orgId } }); }
function asButton(element: HTMLElement): HTMLButtonElement { if (!(element instanceof HTMLButtonElement)) throw new Error('Expected a button'); return element; }
function asSelect(element: HTMLElement): HTMLSelectElement { if (!(element instanceof HTMLSelectElement)) throw new Error('Expected a select'); return element; }
function submit() { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add a client' })); }
beforeEach(() => {
  h.clients.mockReset().mockResolvedValue({ clients: [], agencyAdmin: true }); h.orgs.mockReset().mockResolvedValue([ORG]);
  h.assets.mockReset().mockResolvedValue([]); h.requests.mockReset().mockResolvedValue([]);
  transport.mockReset().mockResolvedValue(json({ client: CLIENT }, 201)); vi.stubGlobal('fetch', transport);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('uses the shared POST transport and unwraps client without adding defaults or omitting orgId', async () => {
  expect(await createClient({ orgId: ORG.orgId, name: ORG.name })).toEqual(CLIENT);
  const firstCall = transport.mock.calls[0];
  if (!firstCall) throw new Error('Client creation must issue a POST');
  const [url, opts] = firstCall;
  expect(String(url)).toBe(`${config.baseUrl}/host/openwop-app/campaign-ops/clients`); expect(opts?.method).toBe('POST');
  expect(JSON.parse(String(opts?.body))).toEqual({ orgId: ORG.orgId, name: ORG.name });
  expect(new Headers(opts?.headers).get('content-type')).toBe('application/json');
});
it('adds the chosen existing client, selects its inbox, and restores the persisted preview account on remount', async () => {
  const mounted = mount(); await open(); choose();
  h.clients.mockResolvedValue({ clients: [CLIENT], agencyAdmin: true }); submit();
  await screen.findByText('Preview: nothing is written.');
  expect(h.assets).toHaveBeenCalledWith(ORG.orgId); expect(h.requests).toHaveBeenCalledWith(ORG.orgId);
  expect(screen.queryByRole('dialog')).toBeNull();
  const firstCall = transport.mock.calls[0];
  if (!firstCall) throw new Error('Client registration must issue a POST');
  expect(JSON.parse(String(firstCall[1]?.body)).orgId).toBe(ORG.orgId);
  mounted.unmount(); mount(); await screen.findByText('Preview: nothing is written.');
  expect(transport).toHaveBeenCalledTimes(1);
});
it('has no registration affordance or org reads for a non-admin empty inbox', async () => {
  h.clients.mockResolvedValue({ clients: [], agencyAdmin: false }); mount(); await screen.findByText('No clients yet');
  expect(screen.queryByRole('button', { name: 'Add a client' })).toBeNull(); expect(h.orgs).not.toHaveBeenCalled();
});
it('excludes root and registered organizations and requires an explicit choice and nonblank name', async () => {
  h.orgs.mockResolvedValue([{ ...ORG, orgId: ORG.tenantId, name: 'Workspace root' }, ORG]);
  mount(); await open(); expect(screen.queryByRole('option', { name: 'Workspace root' })).toBeNull();
  const picker = screen.getByRole('combobox', { name: 'Organization' });
  if (!(picker instanceof HTMLSelectElement)) throw new Error('Organization picker must be a select');
  expect(picker.value).toBe(''); // The shared hook must not auto-register its first org.
  const clientName = screen.getByRole('textbox', { name: 'Client name' });
  if (!(clientName instanceof HTMLInputElement)) throw new Error('Client name must be an input');
  expect(clientName.value).toBe('');
  const add = within(screen.getByRole('dialog')).getByRole('button', { name: 'Add a client' }); expect(asButton(add).disabled).toBe(true);
  choose(); fireEvent.change(screen.getByRole('textbox', { name: 'Client name' }), { target: { value: ' ' } });
  expect(asButton(add).disabled).toBe(true); expect(transport).not.toHaveBeenCalled();
});
it('shows no eligible orgs honestly when all are registered, and distinguishes failed org reads with Retry', async () => {
  h.orgs.mockRejectedValueOnce(new Error('offline')); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Add a client' }));
  await screen.findByText('Organizations could not be loaded. Try again.');
  expect(screen.queryByText('No organizations available')).toBeNull();
  h.orgs.mockResolvedValue([]); fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Try again' }));
  await screen.findByText('No organizations available'); expect(transport).not.toHaveBeenCalled();
});
it('treats successful201 followed by failed list refresh as GET recovery without another POST', async () => {
  mount(); await open(); choose(); h.clients.mockRejectedValueOnce(new Error('offline')); submit();
  await screen.findByText('QA KickTodo was added, but the client list could not be refreshed. Try again to load it.');
  h.clients.mockResolvedValue({ clients: [CLIENT], agencyAdmin: true }); fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('Preview: nothing is written.'); expect(transport).toHaveBeenCalledTimes(1);
});
it('blocks duplicate POST while pending and recovers a lost response through authoritative GET', async () => {
  const response = deferred<Response>(); transport.mockReturnValueOnce(response.promise);
  mount(); await open(); choose(); const add = within(screen.getByRole('dialog')).getByRole('button', { name: 'Add a client' });
  act(() => { fireEvent.click(add); fireEvent.click(add); }); expect(transport).toHaveBeenCalledTimes(1);
  await act(async () => response.reject(new Error('connection lost')));
  const check = await screen.findByRole('button', { name: 'Check client list' });
  h.clients.mockResolvedValue({ clients: [CLIENT], agencyAdmin: true }); fireEvent.click(check);
  await screen.findByText('Preview: nothing is written.'); expect(transport).toHaveBeenCalledTimes(1);
});
it.each([403, 400])('preserves server refusal%s without selecting a client', async status => {
  transport.mockResolvedValue(json({ message: status === 403 ? 'Only an agency admin can do this.' : 'The workspace itself cannot be a client.' }, status));
  mount(); await open(); choose(); submit(); await screen.findByText(status === 403 ? 'Only an agency admin can do this.' : 'The workspace itself cannot be a client.');
  expect(h.assets).not.toHaveBeenCalled(); expect(screen.queryByText('Preview: nothing is written.')).toBeNull();
});
it.each(['org', 'tenant'])('refuses a mismatched returned%s identity until authoritative GET confirms the account', async field => {
  transport.mockResolvedValue(json({ client: { ...CLIENT, ...(field === 'org' ? { orgId: 'foreign' } : { tenantId: 'foreign' }) } }, 201));
  mount(); await open(); choose(); submit(); await screen.findByRole('button', { name: 'Check client list' });
  expect(h.assets).not.toHaveBeenCalled(); expect(screen.queryByText('Preview: nothing is written.')).toBeNull();
});
it('closes on workspace change and rejects old same-act submit before transport', async () => {
  mount(); await open(); choose(); const add = within(screen.getByRole('dialog')).getByRole('button', { name: 'Add a client' });
  h.clients.mockResolvedValue({ clients: [], agencyAdmin: false });
  act(() => { fireAuthChanged(); fireEvent.click(add); });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(transport).not.toHaveBeenCalled();
});
it.each(['success', 'error'])('ignores late POST%s after workspace change', async outcome => {
  const response = deferred<Response>(); transport.mockReturnValueOnce(response.promise);
  mount(); await open(); choose(); submit(); h.clients.mockResolvedValue({ clients: [], agencyAdmin: false });
  act(() => fireAuthChanged()); await screen.findByText('No clients yet');
  await act(async () => { if (outcome === 'success') response.resolve(json({ client: CLIENT }, 201)); else response.reject(new Error('old failure')); });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(h.assets).not.toHaveBeenCalled();
  // The old identity's outcome never paints into the new one: no uncertain notice, and the new inbox shows as itself.
  expect(screen.queryByRole('button', { name: 'Check client list' })).toBeNull();
  expect(screen.queryByText('The registration outcome could not be confirmed. Check the client list before trying again.')).toBeNull();
  expect(screen.getByText('No clients yet')).toBeTruthy();
});
it('remains usable after StrictMode cleanup and does not commit after unmount', async () => {
  const response = deferred<Response>(); transport.mockReturnValueOnce(response.promise);
  const mounted = mount(true); await open(); choose(); submit(); expect(transport).toHaveBeenCalledTimes(1);
  // Usable after StrictMode's mount, cleanup, mount: the POST went out for the chosen org and the pending state is shown.
  const firstCall = transport.mock.calls[0];
  if (!firstCall) throw new Error('StrictMode registration must issue a POST');
  expect(JSON.parse(String(firstCall[1]?.body))).toEqual({ orgId: ORG.orgId, name: ORG.name });
  expect(screen.getByText('Adding the client. You can keep using Operations while this finishes.')).toBeTruthy();
  // No-crash leg: after unmount nothing can run an effect, so this cannot go red on its own.
  mounted.unmount(); await act(async () => response.resolve(json({ client: CLIENT }, 201)));
  expect(h.assets).not.toHaveBeenCalled();
});
it('keeps registration available for admins with clients and removes already-registered choices', async () => {
  const registered = { ...CLIENT, orgId: 'org:old', displayName: 'Existing client' };
  h.clients.mockResolvedValue({ clients: [registered], agencyAdmin: true });
  h.orgs.mockResolvedValue([ORG, { ...ORG, orgId: registered.orgId, name: registered.displayName }]);
  mount(); await open();
  expect(within(screen.getByRole('dialog')).queryByRole('option', { name: 'Existing client' })).toBeNull();
  expect(screen.getByRole('option', { name: ORG.name })).toBeTruthy();
});
// Rendered at the chooser layer: in the inbox an identity change unmounts the chooser, so a late
// read could never reach it there. Here it stays mounted while the identity guard flips.
it.each(['success', 'error'])('ignores late organization list%s after identity changes', async outcome => {
  const orgs = deferred<Organization[]>(); h.orgs.mockReturnValueOnce(orgs.promise);
  let current = true; const isCurrent = () => current;
  const onSubmit = vi.fn(); const onClose = vi.fn();
  const page = render(<ClientRegistrationDialog clients={[]} isCurrent={isCurrent} onClose={onClose} onSubmit={onSubmit} />);
  await screen.findByText('Loading…');
  current = false;
  page.rerender(<ClientRegistrationDialog clients={[]} isCurrent={isCurrent} onClose={onClose} onSubmit={onSubmit} />);
  await act(async () => { if (outcome === 'success') orgs.resolve([ORG]); else orgs.reject(new Error('old org error')); });
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.queryByRole('option', { name: ORG.name })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Client name' })).toBeNull();
  expect(screen.queryByText('Organizations could not be loaded. Try again.')).toBeNull();
  expect(onSubmit).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
});
it('keeps an uncertain409 blocked through failed GET then allows retry only after authoritative absence', async () => {
  transport.mockResolvedValueOnce(json({ message: 'This organization is already a client.' }, 409));
  mount(); await open(); choose(); submit(); await screen.findByRole('button', { name: 'Check client list' });
  h.clients.mockRejectedValueOnce(new Error('offline')); fireEvent.click(screen.getByRole('button', { name: 'Check client list' }));
  await screen.findByText('The client list could not be checked. Try checking again before adding this client.');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(asButton(screen.getByRole('button', { name: 'Add a client' })).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Check client list' }));
  await screen.findByText('No client is registered for this organization. You can try adding it again.');
  await open(); choose(); h.clients.mockResolvedValue({ clients: [CLIENT], agencyAdmin: true }); submit();
  await screen.findByText('Preview: nothing is written.'); expect(transport).toHaveBeenCalledTimes(2);
});
it('propagates API refusal without manufacturing a client entity', async () => {
  transport.mockResolvedValue(json({ message: 'Only an agency admin can do this.' }, 403));
  await expect(createClient({ orgId: ORG.orgId, name: ORG.name })).rejects.toMatchObject({ status: 403, message: 'Only an agency admin can do this.' });
});

it.each(['cancel', 'escape', 'scrim', 'close'])('keeps the chooser dismissible through %s without registering a client', async action => {
  mount(); await open(); choose();
  if (action === 'cancel') fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  else if (action === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
  else if (action === 'scrim') {
    const scrim = screen.getByRole('dialog').parentElement;
    if (!scrim) throw new Error('Chooser scrim missing');
    fireEvent.click(scrim);
  }
  else fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull(); expect(transport).not.toHaveBeenCalled();
  await open(); expect(screen.getByRole('combobox', { name: 'Organization' })).toBeTruthy();
});
it('owns pending registration outside the dismissed chooser and blocks reopening until201 settles', async () => {
  const response = deferred<Response>(); transport.mockReturnValueOnce(response.promise);
  mount(); await open(); choose(); submit();
  expect(screen.queryByRole('dialog')).toBeNull();
  const add = screen.getByRole('button', { name: 'Add a client' });
  expect(asButton(add).disabled).toBe(true); fireEvent.click(add);
  fireEvent.keyDown(window, { key: 'Escape' }); expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('Adding the client. You can keep using Operations while this finishes.')).toBeTruthy();
  h.clients.mockResolvedValue({ clients: [CLIENT], agencyAdmin: true });
  await act(async () => response.resolve(json({ client: CLIENT }, 201)));
  await screen.findByText('Preview: nothing is written.'); expect(transport).toHaveBeenCalledTimes(1);
});
it('leaves an existing inbox usable while failed registration remains uncertain and GET retry fails', async () => {
  const old = { ...CLIENT, orgId: 'org:old', displayName: 'Existing client' };
  h.clients.mockResolvedValue({ clients: [old], agencyAdmin: true }); transport.mockRejectedValueOnce(new Error('lost response'));
  mount(); await open(); choose(); submit(); await screen.findByRole('button', { name: 'Check client list' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('combobox', { name: 'Client' })).toBeTruthy();
  expect(asButton(screen.getByRole('button', { name: 'Add a client' })).disabled).toBe(true);
  h.clients.mockRejectedValueOnce(new Error('offline')); fireEvent.click(screen.getByRole('button', { name: 'Check client list' }));
  await screen.findByText('The client list could not be checked. Try checking again before adding this client.');
  expect(screen.getByRole('combobox', { name: 'Client' })).toBeTruthy(); expect(transport).toHaveBeenCalledTimes(1);
});

it('preserves a later client selection while a background201 registration finishes', async () => {
  const first = { ...CLIENT, orgId: 'org:first', displayName: 'First client' };
  const later = { ...CLIENT, orgId: 'org:later', displayName: 'Later client' };
  h.clients.mockResolvedValue({ clients: [first, later], agencyAdmin: true });
  const response = deferred<Response>(); transport.mockReturnValueOnce(response.promise);
  mount(); await open(); choose(); submit();
  fireEvent.change(screen.getByRole('combobox', { name: 'Client' }), { target: { value: later.orgId } });
  h.clients.mockResolvedValue({ clients: [first, later, CLIENT], agencyAdmin: true });
  await act(async () => response.resolve(json({ client: CLIENT }, 201)));
  await waitFor(() => expect(within(screen.getByRole('combobox', { name: 'Client' })).getByRole('option', { name: CLIENT.displayName })).toBeTruthy());
  expect(asSelect(screen.getByRole('combobox', { name: 'Client' })).value).toBe(later.orgId);
  expect(h.assets).not.toHaveBeenCalledWith(CLIENT.orgId);
});
it('preserves A-to-B-to-A client selection intent before a deferred201 completes', async () => {
  const first = { ...CLIENT, orgId: 'org:first', displayName: 'First client' };
  const later = { ...CLIENT, orgId: 'org:later', displayName: 'Later client' };
  h.clients.mockResolvedValue({ clients: [first, later], agencyAdmin: true });
  const response = deferred<Response>(); transport.mockReturnValueOnce(response.promise);
  mount(); await open(); choose(); submit();
  fireEvent.change(screen.getByRole('combobox', { name: 'Client' }), { target: { value: later.orgId } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Client' }), { target: { value: first.orgId } });
  expect(asSelect(screen.getByRole('combobox', { name: 'Client' })).value).toBe(first.orgId);
  h.clients.mockResolvedValue({ clients: [first, later, CLIENT], agencyAdmin: true });
  await act(async () => response.resolve(json({ client: CLIENT }, 201)));
  await waitFor(() => expect(within(screen.getByRole('combobox', { name: 'Client' })).getByRole('option', { name: CLIENT.displayName })).toBeTruthy());
  expect(asSelect(screen.getByRole('combobox', { name: 'Client' })).value).toBe(first.orgId);
  expect(h.assets).not.toHaveBeenCalledWith(CLIENT.orgId);
});


it('derives newly registered exclusions from current clients without refetching or submitting the old choice', async () => {
  const onSubmit = vi.fn();
  const isCurrent = () => true;
  const onClose = vi.fn();
  const page = render(<ClientRegistrationDialog clients={[]} isCurrent={isCurrent} onClose={onClose} onSubmit={onSubmit} />);
  await screen.findByRole('option', { name: ORG.name });
  choose();
  expect(h.orgs).toHaveBeenCalledTimes(1);
  page.rerender(<ClientRegistrationDialog clients={[CLIENT]} isCurrent={isCurrent} onClose={onClose} onSubmit={onSubmit} />);
  expect(screen.queryByRole('option', { name: ORG.name })).toBeNull();
  expect(screen.getByText('No organizations available')).toBeTruthy();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(h.orgs).toHaveBeenCalledTimes(1);
});

it('hides completed organization data when the existing identity guard invalidates the chooser', async () => {
  let current = true;
  const isCurrent = () => current;
  const onSubmit = vi.fn(); const onClose = vi.fn();
  const page = render(<ClientRegistrationDialog clients={[]} isCurrent={isCurrent} onClose={onClose} onSubmit={onSubmit} />);
  await screen.findByRole('option', { name: ORG.name }); choose();
  current = false;
  page.rerender(<ClientRegistrationDialog clients={[]} isCurrent={isCurrent} onClose={onClose} onSubmit={onSubmit} />);
  expect(screen.queryByRole('option', { name: ORG.name })).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Client name' })).toBeNull();
  expect(onSubmit).not.toHaveBeenCalled();
});
