/**
 * ADR 0178 — the GovernancePanel BYOK chat-budget section (sibling of the media
 * budget). `fetch` is stubbed (routed by exact URL, real `Response`s);
 * `listProviders` + `toast` mocked. Covers: the section loads the OVERRIDE into
 * the inputs, an edit + Save PUTs the parsed override to the exact route, a blank
 * field clears the override (null), and a 403 on the byok-chat-budget read leaves
 * the section hidden WITHOUT reporting a failed readout.
 *
 * The fixture is asymmetric (override 1234/65, effective budget 1000/80, env
 * 5000) so "seeded from the override" cannot pass when seeded from the budget.
 * Every other governance read answers a real 403 (silent), so the "readout(s)
 * could not be loaded" warning counts only what a case provokes.
 *
 * Sabotage that turns it red (wave 52): seeding from `budget` (case 1), dropping
 * `softWarningPct` from the PUT body or the `Math.floor` (case 2), sending 0 for a
 * blank cap (case 3), or treating the 403 as a failure (case 4: the warning shows).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { config } from '../../../client/config.js';

vi.mock('../connectionsClient.js', () => ({ listProviders: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { GovernancePanel } from '../GovernancePanel.js';

const GOV = `${config.baseUrl}/host/openwop-app/governance`;
const POLICY = { policy: {}, defaults: { actionPolicy: 'approval-required', providerAllowlist: null }, actionKinds: ['email.send'] };
interface ByokChatBudgetResponse {
  date: string;
  budget: { dailyTokenCap: number; softWarningPct: number };
  envDefaults: { dailyTokenCap: number };
  override: { dailyTokenCap?: number; softWarningPct?: number } | null;
}
const BYOK: ByokChatBudgetResponse = {
  date: '2026-06-22',
  budget: { dailyTokenCap: 1000, softWarningPct: 80 },
  envDefaults: { dailyTokenCap: 5000 },
  override: { dailyTokenCap: 1234, softWarningPct: 65 },
};
const WARNING = /governance readout\(s\) could not be loaded/i;

interface Put { url: string; method: string; body: unknown }
let puts: Put[] = [];
let byokOk = true;

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(): void {
  puts = [];
  byokOk = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (u === `${GOV}/byok-chat-budget`) {
      if (!byokOk) return jsonRes({ error: 'forbidden' }, 403);
      if (method === 'PUT') {
        const body: unknown = JSON.parse(String(init?.body ?? '{}'));
        puts.push({ url: u, method, body });
        return jsonRes({ override: body, budget: BYOK.budget });
      }
      return jsonRes(BYOK);
    }
    if (u === `${GOV}/policy`) return jsonRes(POLICY);
    // media-budget, egress-rules, anything else: genuinely not permitted → silent.
    return jsonRes({ error: 'forbidden' }, 403);
  }));
}

beforeEach(stubFetch);
afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

const capInput = (): HTMLInputElement => screen.getByLabelText('Daily token cap (tokens/day)');
const pctInput = (): HTMLInputElement => screen.getByLabelText('Soft-warning threshold (% of cap)');

describe('GovernancePanel BYOK chat-budget override (ADR 0178)', () => {
  it('loads the override into the editable inputs', async () => {
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText('BYOK chat spend budget')).toBeTruthy());
    expect(capInput().value).toBe('1234'); // override.dailyTokenCap, not budget (1000) or env (5000)
    expect(pctInput().value).toBe('65'); // override.softWarningPct, not budget (80)
    expect(document.body.textContent).not.toMatch(WARNING);
  });

  it('saves an edited override via PUT (parsed to numbers)', async () => {
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText('BYOK chat spend budget')).toBeTruthy());
    fireEvent.change(capInput(), { target: { value: '500.7' } });
    fireEvent.change(pctInput(), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save chat budget' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ url: `${GOV}/byok-chat-budget`, method: 'PUT', body: { dailyTokenCap: 500, softWarningPct: 90 } });
  });

  it('blank fields CLEAR the override (null ⇒ falls back to env/default)', async () => {
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText('BYOK chat spend budget')).toBeTruthy());
    fireEvent.change(capInput(), { target: { value: '' } });
    fireEvent.change(pctInput(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save chat budget' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ url: `${GOV}/byok-chat-budget`, method: 'PUT', body: { dailyTokenCap: null, softWarningPct: null } });
  });

  it('stays hidden when the byok-chat-budget read 403s (non-superadmin)', async () => {
    byokOk = false;
    render(<GovernancePanel />);
    // The panel still mounts (policy 200), but the BYOK section never appears —
    // and the 403 is NOT reported as a failed readout (that is a different state).
    await waitFor(() => expect(screen.getByText('email.send')).toBeTruthy());
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u) === `${GOV}/byok-chat-budget`)).toBe(true));
    // Settle: the 403'd read's `.then/.catch` chain has committed.
    await act(async () => { for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => { setImmediate(r); }); });
    expect(screen.queryByText('BYOK chat spend budget')).toBeNull();
    expect(document.body.textContent).not.toMatch(WARNING);
  });
});
