/**
 * The house client and the two-mode registration dialog (the house-client ADR,
 * amending ADR 0921 D1 and ADR 0926). Real inbox, real dialog and the real API
 * transport (fetch stubbed); the list reads are mocked.
 *
 * What turns each case red:
 *  - the dialog stops opening in "New client" mode, or a new client's POST
 *    carries an `orgId` (the server would then adopt instead of create);
 *  - the admin empty state loses either next step, or a non-admin is offered one;
 *  - "Set up your own business" stops calling POST /house, or the brand kit is
 *    copied without the admin asking for it;
 *  - the house client stops leading the switcher, or loses its "Your business" chip;
 *  - the root refusal stops offering the house client instead;
 *  - an admin with clients but no house client loses the set-up button (CC-OPS-3).
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { config } from '../../../client/config.js';
import type { listOrgs } from '../../../client/accessClient.js';
import type { ClientAccount, listAssets, listClients, listRequests } from '../campaignOpsClient.js';
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

const TENANT = 'ws:harbor';
const account = (orgId: string, displayName: string, extra: Partial<ClientAccount> = {}): ClientAccount => ({
  tenantId: TENANT, orgId, displayName, mode: 'preview', approvalPolicy: 'agency', status: 'active', createdAt: '', updatedAt: '', ...extra,
});
const HOUSE = account('org:house', 'Zeta Studio', { house: true });
const ACME = account('org:acme', 'Acme Bakery');
const FRESH = account('org:fresh', 'Fresh Client');
const CLIENTS_URL = `${config.baseUrl}/host/openwop-app/campaign-ops/clients`;
const HOUSE_URL = `${config.baseUrl}/host/openwop-app/campaign-ops/house`;

const transport = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
/** Each POST the page sent: its URL and parsed body. */
function posts(): Array<{ url: string; body: unknown }> {
  return transport.mock.calls.map(([url, opts]) => ({ url: String(url), body: JSON.parse(String(opts?.body ?? 'null')) }));
}
function mount() { return render(<MemoryRouter><OperationsPage /></MemoryRouter>); }
function asSelect(element: HTMLElement): HTMLSelectElement { if (!(element instanceof HTMLSelectElement)) throw new Error('Expected a select'); return element; }

beforeEach(() => {
  h.clients.mockReset().mockResolvedValue({ clients: [], agencyAdmin: true });
  h.orgs.mockReset().mockResolvedValue([]);
  h.assets.mockReset().mockResolvedValue([]); h.requests.mockReset().mockResolvedValue([]);
  transport.mockReset(); vi.stubGlobal('fetch', transport);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('offers an admin both next steps on the empty list, setting up their own business first', async () => {
  mount();
  await screen.findByText('Add a client, or set up your own business to plan campaigns for yourself.');
  const setUp = screen.getByRole('button', { name: 'Set up your own business' });
  const add = screen.getByRole('button', { name: 'Add a client' });
  // Primary first: the order a solo founder reads them in.
  expect(setUp.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Primary carries no variant class; the default (secondary) does.
  expect(setUp.classList.contains('secondary')).toBe(false);
  expect(add.classList.contains('secondary')).toBe(true);
  expect(screen.queryByText(/agency admin/i)).toBeNull();
});

it('tells a non-admin who adds clients, and offers neither action', async () => {
  h.clients.mockResolvedValue({ clients: [], agencyAdmin: false });
  mount();
  await screen.findByText('Clients you can work for appear here once a workspace admin adds them.');
  expect(screen.queryByRole('button', { name: 'Set up your own business' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add a client' })).toBeNull();
});

it('opens the dialog in New client mode and creates a new organization from a name alone', async () => {
  transport.mockResolvedValue(json({ client: FRESH }, 201));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Add a client' }));
  const dialog = screen.getByRole('dialog');
  const modes = within(dialog).getByRole('group', { name: 'How to add the client' });
  expect(within(modes).getByRole('button', { name: 'New client' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(modes).getByRole('button', { name: 'Existing organization' }).getAttribute('aria-pressed')).toBe('false');
  expect(within(dialog).queryByRole('combobox', { name: 'Organization' }), 'no detour through choosing an org').toBeNull();
  const submit = within(dialog).getByRole('button', { name: 'Add a client' });
  expect(submit).toHaveProperty('disabled', true);
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Client name' }), { target: { value: '  Fresh Client ' } });
  h.clients.mockResolvedValue({ clients: [FRESH], agencyAdmin: true });
  fireEvent.click(submit);
  await screen.findByText('Preview: nothing is written.');
  expect(posts()).toEqual([{ url: CLIENTS_URL, body: { name: 'Fresh Client' } }]);
});

it('switches to the existing-organization chooser, and back to New client from its empty state', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Add a client' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Existing organization' }));
  await within(dialog).findByText('No organizations available');
  // The empty chooser names its next action instead of sending the admin to Access.
  const empty = within(dialog).getByText('No other organization is available. Organizations already registered as clients are not shown. Add a new client instead.');
  expect(empty).toBeTruthy();
  const newButtons = within(dialog).getAllByRole('button', { name: 'New client' });
  fireEvent.click(newButtons[newButtons.length - 1]!);
  expect(within(dialog).getByRole('textbox', { name: 'Client name' })).toBeTruthy();
  expect(within(dialog).queryByText('No organizations available')).toBeNull();
});

it('sets up the house client in one step, selects it, and copies the brand kit only when asked', async () => {
  transport.mockResolvedValueOnce(json({ client: HOUSE, created: true }, 201));
  mount();
  h.clients.mockResolvedValue({ clients: [HOUSE], agencyAdmin: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Set up your own business' }));
  const offer = await screen.findByRole('button', { name: 'Use your workspace brand kit for it' });
  expect(screen.getByText('Your business')).toBeTruthy();
  expect(asSelect(screen.getByRole('combobox', { name: 'Client' })).value).toBe(HOUSE.orgId);
  expect(posts(), 'setup alone asks for no brand copy').toEqual([{ url: HOUSE_URL, body: {} }]);

  transport.mockResolvedValueOnce(json({ client: HOUSE, created: false, brandKit: { copied: true, brandId: 'brand-1' } }));
  fireEvent.click(offer);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Use your workspace brand kit for it' })).toBeNull());
  expect(posts()[1]).toEqual({ url: HOUSE_URL, body: { copyBrandKit: true } });
});

it('says so when the workspace has no brand kit to copy', async () => {
  transport.mockResolvedValueOnce(json({ client: HOUSE, created: true }, 201));
  mount();
  h.clients.mockResolvedValue({ clients: [HOUSE], agencyAdmin: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Set up your own business' }));
  transport.mockResolvedValueOnce(json({ client: HOUSE, created: false, brandKit: { copied: false, reason: 'no_workspace_brand' } }));
  fireEvent.click(await screen.findByRole('button', { name: 'Use your workspace brand kit for it' }));
  await screen.findByText('Your workspace has no brand kit to copy yet.');
});

it('lists the house client first with a muted "Your business" chip, whatever its name', async () => {
  h.clients.mockResolvedValue({ clients: [ACME, HOUSE], agencyAdmin: true });
  mount();
  const picker = asSelect(await screen.findByRole('combobox', { name: 'Client' }));
  expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['Zeta Studio', 'Acme Bakery']);
  expect(picker.value, 'the house client is the default selection').toBe(HOUSE.orgId);
  expect(screen.getByText('Your business').className).toBe('chip chip--muted');
  fireEvent.change(picker, { target: { value: ACME.orgId } });
  await waitFor(() => expect(screen.queryByText('Your business')).toBeNull());
});

it('answers the root refusal by offering the house client instead', async () => {
  const message = "Your workspace can't be a client itself. Set up your own business as a client instead.";
  transport.mockResolvedValueOnce(json({ error: 'validation_error', message, details: { reason: 'root_org_not_client' } }, 400));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Add a client' }));
  fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Client name' }), { target: { value: 'Ourselves' } });
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add a client' }));
  await screen.findByText(message);
  // One in the refusal, one in the empty state.
  expect(screen.getAllByRole('button', { name: 'Set up your own business' })).toHaveLength(2);
  transport.mockResolvedValueOnce(json({ client: HOUSE, created: true }, 201));
  h.clients.mockResolvedValue({ clients: [HOUSE], agencyAdmin: true });
  fireEvent.click(screen.getAllByRole('button', { name: 'Set up your own business' })[0]!);
  await screen.findByRole('button', { name: 'Use your workspace brand kit for it' });
  expect(posts()[1]).toEqual({ url: HOUSE_URL, body: {} });
});

// CC-OPS-3 (prod 2026-11-17): a workspace that already had a client had no way to set up
// its own business. The button lived only in the empty state and the root refusal,
// and the organization picker never lists the root org, so neither ever showed.
it('offers an admin with clients but no house client "Set up your own business", and calls POST /house', async () => {
  h.clients.mockResolvedValue({ clients: [ACME], agencyAdmin: true });
  transport.mockResolvedValueOnce(json({ client: HOUSE, created: true }, 201));
  mount();
  await screen.findByRole('combobox', { name: 'Client' });
  const setUp = screen.getByRole('button', { name: 'Set up your own business' });
  h.clients.mockResolvedValue({ clients: [ACME, HOUSE], agencyAdmin: true });
  fireEvent.click(setUp);
  await screen.findByRole('button', { name: 'Use your workspace brand kit for it' });
  expect(posts()).toEqual([{ url: HOUSE_URL, body: {} }]);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Set up your own business' })).toBeNull());
});

it('offers no second house client, and nothing to a non-admin', async () => {
  h.clients.mockResolvedValue({ clients: [ACME, HOUSE], agencyAdmin: true });
  const { unmount } = mount();
  await screen.findByRole('combobox', { name: 'Client' });
  expect(screen.getByRole('button', { name: 'Add a client' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Set up your own business' })).toBeNull();
  unmount();
  h.clients.mockResolvedValue({ clients: [ACME], agencyAdmin: false });
  mount();
  await screen.findByRole('combobox', { name: 'Client' });
  expect(screen.queryByRole('button', { name: 'Set up your own business' })).toBeNull();
});
