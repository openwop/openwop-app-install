/**
 * ADR 1053 D10 — the WhatsApp settings sub-view of the Connections page.
 *
 * Pins what the page must never get wrong:
 *  - the attestation cannot be recorded without the explicit confirmation, and a
 *    non-admin's 403 says who may act instead of a generic failure;
 *  - each section reads on its own: a failed connections read never blanks the
 *    attestation, and a 403 on failures is "admins only", not "no failures";
 *  - a personal connection says what it cannot do (send for others, grant START);
 *  - a recipient is shown by its last four digits only;
 *  - a failed org read is a retryable failure, never "no organizations".
 *
 * Sabotage-witnessed 2026-11-03 (each red here, restored): the canManage gate on the
 * confirmation forced open; the failure row's number column replaced by the raw id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../../featureToggles/__testing__/makeFeatureAccess.js';

type Client = typeof import('../whatsappClient.js');
const api = vi.hoisted(() => ({
  getAttestation: vi.fn<Client['getAttestation']>(),
  recordAttestation: vi.fn<Client['recordAttestation']>(),
  revokeAttestation: vi.fn<Client['revokeAttestation']>(),
  listWhatsAppConnections: vi.fn<Client['listWhatsAppConnections']>(),
  getHealth: vi.fn<Client['getHealth']>(),
  listDeliveryFailures: vi.fn<Client['listDeliveryFailures']>(),
}));
vi.mock('../whatsappClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});
const ws = vi.hoisted(() => ({ listMyWorkspaces: vi.fn() }));
vi.mock('../../../../client/workspaceClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...ws };
});
vi.mock('../../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, status: 'on', isBeta: false, variant: null, loading: false }),
}));

import { WhatsAppSettings } from '../WhatsAppSettings.js';
import { WhatsAppApiError } from '../whatsappClient.js';

/** The active workspace — the page addresses its ROOT, never an org (ADR 1053 D10). */
const WS = 'ws:acme';

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  ws.listMyWorkspaces.mockReset();
  ws.listMyWorkspaces.mockResolvedValue({ workspaces: [], active: WS, personal: 'user:me' });
  api.getAttestation.mockResolvedValue({ attested: false, canManage: true });
  api.listWhatsAppConnections.mockResolvedValue([]);
  api.listDeliveryFailures.mockResolvedValue([]);
});
afterEach(cleanup);

/** Presence is asserted as `isConnected` (no jest-dom in this lane): a missing node throws in the query. */
const renderPage = () => render(<MemoryRouter><WhatsAppSettings /></MemoryRouter>);

describe('WhatsAppSettings — the no-training attestation', () => {
  it('cannot record without the explicit confirmation; records after it', async () => {
    // The PUT's REAL shape (routes.ts attestationView): the GET's, canManage included.
    const recorded = { attested: true, canManage: true, attestedBy: 'user:admin', attestedByName: 'Ada Admin', attestedAt: '2026-11-03T10:00:00.000Z' };
    api.recordAttestation.mockResolvedValue(recorded);
    api.getAttestation.mockResolvedValueOnce({ attested: false, canManage: true }).mockResolvedValue(recorded);
    renderPage();
    const record = await screen.findByRole('button', { name: 'Record attestation' });
    expect((record as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Not attested: incoming WhatsApp messages will not start AI workflows.').isConnected).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm that no AI provider/ }));
    expect((record as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(record);
    await waitFor(() => expect(api.recordAttestation).toHaveBeenCalledWith(WS));
    expect((await screen.findByText('Attested')).isConnected).toBe(true);
    expect(screen.getByText(/by Ada Admin$/).isConnected).toBe(true);
    // WA85UX-11 — the admin who just acted can still act: Revoke is there, and the card re-read the server.
    expect((await screen.findByRole('button', { name: 'Revoke' })).isConnected).toBe(true);
    await waitFor(() => expect(api.getAttestation).toHaveBeenCalledTimes(2));
    // WA85UX-17 — focus lands on the card heading, never on <body>, after the button it was on is replaced.
    expect(document.activeElement?.textContent).toBe('No-training attestation');
  });

  it('a member who cannot manage it sees the state and who may change it, never the controls', async () => {
    api.getAttestation.mockResolvedValue({ attested: true, canManage: false, attestedBy: 'user:x', attestedAt: '2026-11-03T10:00:00.000Z' });
    renderPage();
    expect((await screen.findByText('Attested')).isConnected).toBe(true);
    expect(screen.getByText(/by an admin$/).isConnected).toBe(true);
    expect(screen.getByText('Only a workspace admin can change this.').isConnected).toBe(true);
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('a member who cannot manage it is not offered the confirmation either', async () => {
    api.getAttestation.mockResolvedValue({ attested: false, canManage: false });
    renderPage();
    expect((await screen.findByText('Not attested: incoming WhatsApp messages will not start AI workflows.')).isConnected).toBe(true);
    expect(screen.getByText('Only a workspace admin can change this.').isConnected).toBe(true);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record attestation' })).toBeNull();
  });

  it('reports every attestation state it shows to its host, so the Connections chip follows a record (WA85UX-23)', async () => {
    const recorded = { attested: true, canManage: true, attestedBy: 'user:admin', attestedAt: '2026-11-03T10:00:00.000Z' };
    api.recordAttestation.mockResolvedValue(recorded);
    api.getAttestation.mockResolvedValueOnce({ attested: false, canManage: true }).mockResolvedValue(recorded);
    const seen: boolean[] = [];
    render(<MemoryRouter><WhatsAppSettings onAttestationChange={(a) => seen.push(a)} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('checkbox', { name: /I confirm/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Record attestation' }));
    await waitFor(() => expect(seen.at(-1)).toBe(true));
    expect(seen[0]).toBe(false);
  });

  it("a non-admin's refusal says who may act", async () => {
    api.recordAttestation.mockRejectedValue(new WhatsAppApiError('Missing required scope', 'forbidden_scope', 403));
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: /I confirm/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Record attestation' }));
    expect((await screen.findByText('Only a workspace admin can change the attestation.')).isConnected).toBe(true);
  });
});

describe('WhatsAppSettings — sections read on their own', () => {
  it('a failed connections read leaves the attestation, and a 403 on failures reads "admins only", never "no failures"', async () => {
    api.listWhatsAppConnections.mockRejectedValue(new WhatsAppApiError('boom', 'internal_error', 500));
    api.listDeliveryFailures.mockRejectedValue(new WhatsAppApiError('forbidden', 'forbidden_scope', 403));
    renderPage();
    expect((await screen.findByText("Couldn't load your WhatsApp numbers")).isConnected).toBe(true);
    expect((await screen.findByText('Admins only')).isConnected).toBe(true);
    expect(screen.queryByText('No delivery failures')).toBeNull();
    expect(screen.getByRole('button', { name: 'Record attestation' }).isConnected).toBe(true);
  });

  it('a personal connection says what it cannot do; health is read on demand', async () => {
    api.listWhatsAppConnections.mockResolvedValue([
      { connectionId: 'c1', displayName: 'Support line', transport: 'whatsapp-twilio', sender: '+15550001111', axis: 'user', status: 'active', inbound: 'none' },
    ]);
    api.getHealth.mockResolvedValue({ bound: true, attested: false, sender: { senderNumber: '+15550001111', status: 'online', quality: 'low', messagingLimit: '1k' }, enforcementLadder: [], fetchedAt: '2026-11-03T10:00:00.000Z' });
    renderPage();
    expect((await screen.findByText('Support line')).isConnected).toBe(true);
    expect(screen.getByText('Personal').isConnected).toBe(true);
    expect(screen.getByText(/A personal connection sends only for its owner/).isConnected).toBe(true);
    expect(screen.getByText(/Without inbound there is no 24-hour reply window/).isConnected).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check health' }));
    expect((await screen.findByText('Quality: low')).isConnected).toBe(true);
    expect(api.getHealth).toHaveBeenCalledWith(WS, 'c1');
  });

  it("a health read Twilio did not rate says so, instead of a bare 'unknown'", async () => {
    api.listWhatsAppConnections.mockResolvedValue([
      { connectionId: 'c1', displayName: 'Support line', transport: 'whatsapp-twilio', sender: '+15550001111', axis: 'workspace', status: 'active', inbound: 'enabled' },
    ]);
    api.getHealth.mockResolvedValue({ bound: true, attested: true, sender: { senderNumber: '+15550001111', status: null, quality: 'unknown', messagingLimit: null }, enforcementLadder: [], fetchedAt: '2026-11-03T10:00:00.000Z' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Check health' }));
    expect((await screen.findByText("Twilio didn't return a rating for this sender.")).isConnected).toBe(true);
  });

  it('shows a failed delivery by the last four digits only', async () => {
    api.listWhatsAppConnections.mockResolvedValue([
      { connectionId: 'c1', displayName: 'Support line', transport: 'whatsapp-twilio', sender: '+15550001111', axis: 'workspace', status: 'active', inbound: 'enabled' },
    ]);
    api.listDeliveryFailures.mockResolvedValue([
      { connectionId: 'c1', providerSid: 'SM1', status: 'undelivered', errorCode: '63016', kind: 'template', recipientLast4: '6789', at: '2026-11-03T10:00:00.000Z' },
      { connectionId: 'c-gone', providerSid: 'SM2', status: 'failed', errorCode: null, kind: 'session', recipientLast4: '1234', at: '2026-11-02T10:00:00.000Z' },
    ]);
    renderPage();
    expect((await screen.findByText('Undelivered')).isConnected).toBe(true);
    // The digits are visual; assistive tech reads the sentence. Nowhere is more than four digits.
    expect(screen.getByText('•••• 6789').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('Number ending in 6789').className).toBe('sr-only');
    expect(screen.getByText('63016').isConnected).toBe(true);
    // WA85UX-4 — each failure names the number it was sent from.
    expect(screen.getAllByText('Support line').length).toBe(2); // the numbers card + the failure row
    expect(screen.getByText('Removed connection').isConnected).toBe(true);
  });
});

describe('WhatsAppSettings — the workspace', () => {
  it('a failed workspace read is a retryable failure, and no section reads', async () => {
    ws.listMyWorkspaces.mockRejectedValue(new Error('down'));
    renderPage();
    expect((await screen.findByText("Couldn't load your workspace")).isConnected).toBe(true);
    expect(screen.getByRole('button', { name: 'Try again' }).isConnected).toBe(true);
    expect(api.getAttestation).not.toHaveBeenCalled();
  });

  it('a caller who is not a member of the workspace root is told so once, not shown three failures', async () => {
    api.listWhatsAppConnections.mockRejectedValue(new WhatsAppApiError('forbidden', 'forbidden_scope', 403));
    api.getAttestation.mockRejectedValue(new WhatsAppApiError('forbidden', 'forbidden_scope', 403));
    renderPage();
    expect((await screen.findByText("You don't have access to WhatsApp settings")).isConnected).toBe(true);
    expect(screen.queryByText("Couldn't load your WhatsApp numbers")).toBeNull();
    expect(screen.queryByText('No-training attestation')).toBeNull();
  });
});
