/**
 * ADR 1053 D10 — WhatsApp settings is a lazy sub-view of the Connections page
 * (no top-level route: the entry chunk has no room). Pins:
 *  - with the `whatsapp` toggle off, the Connections page shows nothing of it;
 *  - with it on, a closed card; `?view=whatsapp` (the deep link) opens the
 *    settings, which load lazily, and Hide closes them;
 *  - the CLOSED card shows whether the attestation is recorded (WA85UX-20), and an
 *    unreadable status shows no chip rather than a guess;
 *  - Open/Hide names the region it controls (WA85UX-21).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const access = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: access.enabled, status: access.enabled ? 'on' : 'off', isBeta: false, variant: null, loading: false }),
}));
vi.mock('../whatsapp/WhatsAppSettings.js', () => ({
  WhatsAppSettings: ({ onAttestationChange }: { onAttestationChange?: (attested: boolean) => void }) => (
    <><p>whatsapp-settings-body</p><button type="button" onClick={() => onAttestationChange?.(true)}>simulate-record</button></>
  ),
}));
const api = vi.hoisted(() => ({ getAttestation: vi.fn(), listMyWorkspaces: vi.fn() }));
vi.mock('../whatsapp/whatsappClient.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), getAttestation: api.getAttestation }));
vi.mock('../../../client/workspaceClient.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), listMyWorkspaces: api.listMyWorkspaces }));

import { WhatsAppEntry } from '../ConnectionsPage.js';

beforeEach(() => {
  access.enabled = true;
  api.listMyWorkspaces.mockReset().mockResolvedValue({ workspaces: [], active: 'ws:acme', personal: 'user:me' });
  api.getAttestation.mockReset().mockResolvedValue({ attested: false, canManage: true });
});
afterEach(cleanup);

describe('WhatsApp settings inside Connections', () => {
  it('renders nothing with the whatsapp toggle off', () => {
    access.enabled = false;
    const { container } = render(<MemoryRouter><WhatsAppEntry /></MemoryRouter>);
    expect(container.textContent).toBe('');
  });

  it('is a closed card until opened; Hide closes it again', async () => {
    render(<MemoryRouter><WhatsAppEntry /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'WhatsApp settings' }).isConnected).toBe(true);
    expect(screen.queryByText('whatsapp-settings-body')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect((await screen.findByText('whatsapp-settings-body')).isConnected).toBe(true);
    expect(screen.getByRole('button', { name: 'Hide' }).getAttribute('aria-expanded')).toBe('true');
    const hide = screen.getByRole('button', { name: 'Hide' });
    const region = document.getElementById(hide.getAttribute('aria-controls') ?? '');
    expect(region?.textContent).toContain('whatsapp-settings-body');
    fireEvent.click(hide);
    expect(screen.queryByText('whatsapp-settings-body')).toBeNull();
  });

  it('the closed card says Not attested, or Attested, and nothing when the read fails', async () => {
    const { unmount } = render(<MemoryRouter><WhatsAppEntry /></MemoryRouter>);
    expect((await screen.findByText('Not attested')).className).toContain('chip--warning');
    expect(api.getAttestation).toHaveBeenCalledWith('ws:acme');
    unmount();
    api.getAttestation.mockResolvedValue({ attested: true, canManage: false });
    const second = render(<MemoryRouter><WhatsAppEntry /></MemoryRouter>);
    expect((await screen.findByText('Attested')).className).toContain('chip--success');
    second.unmount();
    api.getAttestation.mockRejectedValue(new Error('down'));
    render(<MemoryRouter><WhatsAppEntry /></MemoryRouter>);
    await waitFor(() => expect(api.getAttestation).toHaveBeenCalledTimes(3));
    expect(screen.queryByText('Attested')).toBeNull();
    expect(screen.queryByText('Not attested')).toBeNull();
  });

  it('recording inside the open view turns the card chip to Attested (WA85UX-23)', async () => {
    render(<MemoryRouter initialEntries={['/access?tab=connections&view=whatsapp']}><WhatsAppEntry /></MemoryRouter>);
    expect((await screen.findByText('Not attested')).isConnected).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: 'simulate-record' }));
    expect((await screen.findByText('Attested')).className).toContain('chip--success');
    expect(screen.queryByText('Not attested')).toBeNull();
  });

  it('the ?view=whatsapp deep link opens it directly', async () => {
    render(<MemoryRouter initialEntries={['/access?tab=connections&view=whatsapp']}><WhatsAppEntry /></MemoryRouter>);
    expect((await screen.findByText('whatsapp-settings-body')).isConnected).toBe(true);
  });
});
