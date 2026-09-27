/**
 * ADR 0178 — the GovernancePanel BYOK chat-budget section (sibling of the media
 * budget). `fetch` is stubbed (routed by URL); `listProviders` + `toast` mocked.
 * Covers: the section loads the override into the inputs, an edit + Save PUTs the
 * parsed override, a blank field clears the override (null), and a 403 on the
 * byok-chat-budget read leaves the section hidden.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../connectionsClient.js', () => ({ listProviders: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { GovernancePanel } from '../GovernancePanel.js';

const POLICY = { policy: {}, defaults: { actionPolicy: 'approval-required', providerAllowlist: null }, actionKinds: ['email.send'] };
const BYOK = {
  date: '2026-06-22',
  budget: { dailyTokenCap: 1000, softWarningPct: 80 },
  envDefaults: { dailyTokenCap: 1000 },
  override: { dailyTokenCap: 1000, softWarningPct: 80 },
};

let putBody: unknown = null;
let byokOk = true;

function stubFetch() {
  putBody = null;
  byokOk = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (u.includes('/governance/byok-chat-budget')) {
      if (!byokOk) return { ok: false, status: 403, json: async () => ({}) } as unknown as Response;
      if (method === 'PUT') { putBody = JSON.parse(String(init?.body ?? '{}')); return jsonRes({ override: putBody, budget: BYOK.budget }); }
      return jsonRes(BYOK);
    }
    // Media budget stays out of the way (kept null → its section is not rendered).
    if (u.includes('/governance/media-budget')) return { ok: false, status: 403, json: async () => ({}) } as unknown as Response;
    if (u.includes('/governance/policy')) return jsonRes(POLICY);
    return jsonRes({});
  }));
}
const jsonRes = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body } as unknown as Response);

beforeEach(stubFetch);
afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

describe('GovernancePanel BYOK chat-budget override (ADR 0178)', () => {
  it('loads the override into the editable inputs', async () => {
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText('BYOK chat spend budget')).toBeTruthy());
    const cap = screen.getByLabelText('Daily token cap (tokens/day)') as HTMLInputElement;
    expect(cap.value).toBe('1000'); // seeded from override.dailyTokenCap
    const pct = screen.getByLabelText('Soft-warning threshold (% of cap)') as HTMLInputElement;
    expect(pct.value).toBe('80'); // seeded from override.softWarningPct
  });

  it('saves an edited override via PUT (parsed to numbers)', async () => {
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText('BYOK chat spend budget')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Daily token cap (tokens/day)'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Soft-warning threshold (% of cap)'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save chat budget' }));
    await waitFor(() => expect(putBody).toEqual({ dailyTokenCap: 500, softWarningPct: 90 }));
  });

  it('blank fields CLEAR the override (null ⇒ falls back to env/default)', async () => {
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText('BYOK chat spend budget')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Daily token cap (tokens/day)'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Soft-warning threshold (% of cap)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save chat budget' }));
    await waitFor(() => expect(putBody).toEqual({ dailyTokenCap: null, softWarningPct: null }));
  });

  it('stays hidden when the byok-chat-budget read 403s (non-superadmin)', async () => {
    byokOk = false;
    render(<GovernancePanel />);
    // The panel still mounts (policy 200), but the BYOK section never appears.
    await waitFor(() => expect(screen.getByText('email.send')).toBeTruthy());
    expect(screen.queryByText('BYOK chat spend budget')).toBeNull();
  });
});
