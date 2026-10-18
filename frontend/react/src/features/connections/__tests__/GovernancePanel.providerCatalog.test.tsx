/**
 * UX_UPGRADE-access-data P4 / DEF-1 — the last bare swallow in GovernancePanel
 * was not a harmless companion read: with `listProviders()` failed and
 * providerIds stuck at [], ticking "Restrict providers" wrote an EMPTY
 * allowlist — a block-everything policy built from a failed read, silently.
 * Failure now joins the sections-unavailable warning and the allowlist
 * controls disable with a stated reason.
 *
 * Both cases Save and read the PUT body. After a good read, ticking the toggle
 * writes the catalog's ids. After a it carries the catalog's ids. After a
 * failed read the toggle is disabled (the ONLY guard — jsdom delivers clicks to
 * disabled inputs, so the tick itself is a ceiling here) and a Save writes
 * `providerAllowlist: null`. Sabotage that turns it red (wave 52): enabling the toggle on a
 * failed read (case 1: not disabled), swallowing the catalog failure, dropping the
 * hint or the aggregate warning, or building the allowlist from anything but the
 * catalog (case 2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import { config } from '../../../client/config.js';
import type { Provider } from '../connectionsClient.js';

const listProviders = vi.hoisted(() => vi.fn<() => Promise<Provider[]>>());
vi.mock('../connectionsClient.js', () => ({ listProviders }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { GovernancePanel } from '../GovernancePanel.js';

const POLICY_URL = `${config.baseUrl}/host/openwop-app/governance/policy`;
const POLICY = { policy: {}, defaults: { actionPolicy: 'approval-required', providerAllowlist: null }, actionKinds: ['email.send'] };
const PROVIDERS: Provider[] = [
  { id: 'openai', label: 'OpenAI', kind: 'api_key', reach: 'user', refreshable: false },
  { id: 'anthropic', label: 'Anthropic', kind: 'api_key', reach: 'user', refreshable: false },
];
const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Put { url: string; body: { providerAllowlist?: unknown } }
let puts: Put[] = [];

beforeEach(() => {
  listProviders.mockReset();
  puts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u === POLICY_URL) {
      if ((init?.method ?? 'GET').toUpperCase() === 'PUT') {
        puts.push({ url: u, body: JSON.parse(String(init?.body ?? '{}')) as Put['body'] });
        return jsonRes({ ok: true });
      }
      return jsonRes(POLICY);
    }
    // Other sections stay hidden (403 = genuinely not permitted).
    return jsonRes({ error: 'forbidden' }, 403);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

const toggle = (): HTMLInputElement => screen.getByRole('checkbox', { name: /restrict connectable providers/i });

describe('GovernancePanel — provider-catalog read honesty (DEF-1)', () => {
  it('a failed catalog read disables the allowlist toggle and says why', async () => {
    listProviders.mockRejectedValue(new Error('503'));
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText(/Restrict connectable providers/i)).toBeTruthy());
    await waitFor(() => expect(toggle().disabled).toBe(true));
    expect(document.body.textContent).toContain('provider catalog could not be loaded');
    // And it participates in the aggregate warning.
    expect(document.body.textContent).toMatch(/governance readout\(s\) could not be loaded/i);
    // The hazard itself is guarded by `disabled` ALONE: a browser never delivers a
    // click to a disabled checkbox, but jsdom's fireEvent does (MEASURED wave 52:
    // ticking it here wrote `[]`), so the tick cannot be driven honestly in this
    // layer — HONEST CEILING; the guard is witnessed by the `disabled` assertion
    // above. What IS asserted: a Save on this page writes no allowlist (null).
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body.providerAllowlist).toBeNull();
  });

  it('a successful catalog read keeps the toggle enabled and shows no hint', async () => {
    listProviders.mockResolvedValue(PROVIDERS);
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText(/Restrict connectable providers/i)).toBeTruthy());
    expect(toggle().disabled).toBe(false);
    expect(document.body.textContent).not.toContain('provider catalog could not be loaded');
    // The catalog must have landed before ticking, or the allowlist is built from [].
    await waitFor(() => expect(listProviders).toHaveBeenCalledTimes(1));
    await act(async () => { await listProviders.mock.results[0]!.value; });
    fireEvent.click(toggle());
    expect(await screen.findByRole('checkbox', { name: 'openai' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body.providerAllowlist).toEqual(['openai', 'anthropic']);
  });
});
