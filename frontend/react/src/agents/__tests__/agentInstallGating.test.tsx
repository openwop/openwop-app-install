/**
 * UX_UPGRADE-agents AG-G1/AG-G2/AG-G4/AG-G5 — the install screen.
 *
 * The headline property is a negative one: installing an agent pack hot-reloads
 * code into the running host and is superadmin-only server-side, but the page
 * offered the button to everyone — so a non-superadmin's only feedback was a 403
 * carrying a developer hint. The page now asks the server whether THIS caller
 * may install, and fails CLOSED when it can't tell.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listAvailableAgentPacks = vi.fn();
const installAgentPack = vi.fn();
vi.mock('../../client/agentsClient.js', () => ({
  listAvailableAgentPacks: () => listAvailableAgentPacks(),
  installAgentPack: (...a: unknown[]) => installAgentPack(...a),
}));

const { AgentInstallPage } = await import('../AgentInstallPage.js');

const PACKS = [
  { name: 'core.openwop.agents.sales', version: '1.2.0', description: 'Sales personas', personas: ['Ada'], installed: false },
  { name: 'core.openwop.agents.support', version: '0.9.0', description: 'Support personas', personas: ['Iris'], installed: true },
];

const renderPage = () => render(<MemoryRouter><AgentInstallPage /></MemoryRouter>);
const announced = () => document.querySelector('[aria-live="polite"]')?.textContent ?? '';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('agent install — offering only what the caller can do (AG-G1)', () => {
  it('offers Install to a caller the SERVER says may install', async () => {
    listAvailableAgentPacks.mockResolvedValue({ packs: PACKS, canInstall: true });
    renderPage();
    await screen.findByText('core.openwop.agents.sales');
    expect(screen.getByRole('button', { name: /install/i })).toBeTruthy();
    expect(screen.queryByText(/operator action/i)).toBeNull();
  });

  it('offers NO install button to a non-superadmin, and explains why once', async () => {
    listAvailableAgentPacks.mockResolvedValue({ packs: PACKS, canInstall: false });
    renderPage();
    await screen.findByText('core.openwop.agents.sales');
    // No per-row action that could only ever 403…
    expect(screen.queryByRole('button', { name: /^install$/i })).toBeNull();
    // …and ONE up-front explanation rather than a message per row.
    expect(screen.getAllByText(/operator action/i)).toHaveLength(1);
  });

  it('fails CLOSED when the host does not report the capability', async () => {
    // An older host that predates `canInstall` reports nothing ⇒ the client
    // resolves false. Offering nothing beats offering a guaranteed 403.
    listAvailableAgentPacks.mockResolvedValue({ packs: PACKS, canInstall: false });
    renderPage();
    await screen.findByText('core.openwop.agents.sales');
    expect(screen.queryByRole('button', { name: /^install$/i })).toBeNull();
  });
});

describe('agent install — already-installed rows (AG-G4)', () => {
  it('states the status as a chip and leaves the action slot EMPTY', async () => {
    listAvailableAgentPacks.mockResolvedValue({ packs: PACKS, canInstall: true });
    const { container } = renderPage();
    await screen.findByText('core.openwop.agents.support');
    // The installed row carries a real chip…
    expect(container.querySelector('.chip.chip--success')).toBeTruthy();
    // …and exactly one Install button overall (the not-installed pack only).
    expect(screen.getAllByRole('button', { name: /^install$/i })).toHaveLength(1);
    // The muted em-dash that used to sit where an action goes is gone.
    expect(screen.queryByText('—')).toBeNull();
  });
});

describe('agent install — outcomes are stated (AG-G2/AG-G5)', () => {
  it('announces a successful install', async () => {
    listAvailableAgentPacks.mockResolvedValue({ packs: PACKS, canInstall: true });
    installAgentPack.mockResolvedValue(undefined);
    renderPage();
    await screen.findByText('core.openwop.agents.sales');
    fireEvent.click(screen.getByRole('button', { name: /^install$/i }));
    await waitFor(() => expect(announced()).toMatch(/core\.openwop\.agents\.sales installed/i));
  });

  it('translates a 403 into guidance instead of dumping the developer hint', async () => {
    listAvailableAgentPacks.mockResolvedValue({ packs: PACKS, canInstall: true });
    installAgentPack.mockRejectedValue(new Error('Agent-pack registry install requires a superadmin principal. Add your tenant id to OPENWOP_SUPERADMIN_TENANTS'));
    renderPage();
    await screen.findByText('core.openwop.agents.sales');
    fireEvent.click(screen.getByRole('button', { name: /^install$/i }));

    await screen.findByText(/requires a superadmin\. Ask an operator/i);
    // The env-var hint is for an operator reading logs, not a person on a page.
    expect(screen.queryByText(/OPENWOP_SUPERADMIN_TENANTS/)).toBeNull();
  });

  it('keeps a non-403 message, which may be the only clue to a real fault', async () => {
    listAvailableAgentPacks.mockResolvedValue({ packs: PACKS, canInstall: true });
    installAgentPack.mockRejectedValue(new Error('pack signature verification failed'));
    renderPage();
    await screen.findByText('core.openwop.agents.sales');
    fireEvent.click(screen.getByRole('button', { name: /^install$/i }));
    await screen.findByText(/signature verification failed/i);
  });
});
