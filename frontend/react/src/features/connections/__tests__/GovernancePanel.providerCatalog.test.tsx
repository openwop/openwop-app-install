/**
 * UX_UPGRADE-access-data P4 / DEF-1 — the last bare swallow in GovernancePanel
 * was not a harmless companion read: with `listProviders()` failed and
 * providerIds stuck at [], ticking "Restrict providers" wrote an EMPTY
 * allowlist — a block-everything policy built from a failed read, silently.
 * Failure now joins the sections-unavailable warning and the allowlist
 * controls disable with a stated reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

const listProviders = vi.hoisted(() => vi.fn());
vi.mock('../connectionsClient.js', () => ({ listProviders }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { GovernancePanel } from '../GovernancePanel.js';

const POLICY = { policy: {}, defaults: { actionPolicy: 'approval-required', providerAllowlist: null }, actionKinds: ['email.send'] };
const jsonRes = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body } as unknown as Response);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/governance/policy')) return jsonRes(POLICY);
    // Other sections stay hidden (403 = genuinely not permitted).
    return { ok: false, status: 403, json: async () => ({}) } as unknown as Response;
  }));
});
afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

describe('GovernancePanel — provider-catalog read honesty (DEF-1)', () => {
  it('a failed catalog read disables the allowlist toggle and says why', async () => {
    listProviders.mockRejectedValue(new Error('503'));
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText(/Restrict connectable providers/i)).toBeTruthy());
    const toggle = screen.getByRole('checkbox', { name: /restrict connectable providers/i }) as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(true));
    expect(document.body.textContent).toContain('provider catalog could not be loaded');
    // And it participates in the aggregate warning.
    expect(document.body.textContent).toMatch(/governance readout\(s\) could not be loaded/i);
  });

  it('a successful catalog read keeps the toggle enabled and shows no hint', async () => {
    listProviders.mockResolvedValue([{ id: 'openai' }, { id: 'anthropic' }]);
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText(/Restrict connectable providers/i)).toBeTruthy());
    const toggle = screen.getByRole('checkbox', { name: /restrict connectable providers/i }) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
    expect(document.body.textContent).not.toContain('provider catalog could not be loaded');
  });
});
