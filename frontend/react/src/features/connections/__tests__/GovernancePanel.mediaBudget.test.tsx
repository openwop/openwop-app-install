/**
 * ADR 0106 editable override — the GovernancePanel media-budget section is now
 * editable. `fetch` is stubbed (routed by exact URL, real `Response`s);
 * `listProviders` + `toast` mocked. Covers: the section loads the OVERRIDE into
 * the inputs (and leaves an override-absent unit blank), an edit + Save PUTs the
 * parsed override to the exact route, and a blank field clears the override (null).
 *
 * The fixture is asymmetric (override tts 1234 / images 7, effective budget
 * 1000/3, env 5000/3) so "seeded from the override" cannot pass when seeded from
 * the budget. Every other governance read answers a real 403 (silent), so no case
 * runs with a failed readout it does not know about.
 *
 * Sabotage that turns it red (wave 52): seeding tts from `budgets` (case 1),
 * renaming `videoJobs` in the PUT body (cases 2, 3), `0 → null` for a kept zero
 * (case 2), or sending 0 for a blank field (case 3).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { config } from '../../../client/config.js';

vi.mock('../connectionsClient.js', () => ({ listProviders: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { GovernancePanel } from '../GovernancePanel.js';

const GOV = `${config.baseUrl}/host/openwop-app/governance`;
const POLICY = { policy: {}, defaults: { actionPolicy: 'approval-required', providerAllowlist: null }, actionKinds: ['email.send'] };
interface MediaBudgetResponse {
  date: string;
  budgets: { ttsChars: number; sttBytes: number; images: number; video: number };
  envDefaults: { ttsChars: number; sttBytes: number; images: number; video: number };
  override: { ttsChars?: number; sttBytes?: number; images?: number; videoJobs?: number } | null;
  usage: { ttsChars: number; sttBytes: number; images: number; video: number };
}
// Full current shape (ADR 0411 P2 added the governance VIDEO budget; the image
// budget arrived with ADR 0401) — the fixture mirrors the panel type.
const MEDIA: MediaBudgetResponse = {
  date: '2026-06-22',
  budgets: { ttsChars: 1000, sttBytes: 0, images: 3, video: 0 },
  envDefaults: { ttsChars: 5000, sttBytes: 0, images: 3, video: 0 },
  override: { ttsChars: 1234, images: 7 },
  usage: { ttsChars: 0, sttBytes: 0, images: 0, video: 0 },
};

interface Put { url: string; method: string; body: unknown }
let puts: Put[] = [];

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(): void {
  puts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (u === `${GOV}/media-budget`) {
      if (method === 'PUT') {
        const body: unknown = JSON.parse(String(init?.body ?? '{}'));
        puts.push({ url: u, method, body });
        return jsonRes({ override: body, budgets: MEDIA.budgets });
      }
      return jsonRes(MEDIA);
    }
    if (u === `${GOV}/policy`) return jsonRes(POLICY);
    // byok-chat-budget, egress-rules, anything else: genuinely not permitted → silent.
    return jsonRes({ error: 'forbidden' }, 403);
  }));
}

beforeEach(stubFetch);
afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

const input = (label: string): HTMLInputElement => screen.getByLabelText(label);
const TTS = 'Text-to-speech budget (characters/day)';
const STT = 'Transcription budget (bytes/day)';

describe('GovernancePanel media-budget override (ADR 0106)', () => {
  it('loads the override into the editable inputs', async () => {
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText('Media generation budgets')).toBeTruthy());
    expect(input(TTS).value).toBe('1234'); // override.ttsChars, not budgets (1000) or env (5000)
    expect(input(STT).value).toBe(''); // no override for stt ⇒ blank, never the effective 0
    expect(document.body.textContent).not.toMatch(/governance readout\(s\) could not be loaded/i);
  });

  it('saves an edited override via PUT (parsed to numbers)', async () => {
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText('Media generation budgets')).toBeTruthy());
    fireEvent.change(input(TTS), { target: { value: '500' } });
    fireEvent.change(input(STT), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save media budgets' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    // images keeps its seeded override (7); 0 stays 0 (uncapped), distinct from null.
    expect(puts[0]).toEqual({ url: `${GOV}/media-budget`, method: 'PUT', body: { ttsChars: 500, sttBytes: 0, images: 7, videoJobs: null } });
  });

  it('a blank field CLEARS that override (null ⇒ falls back to env)', async () => {
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText('Media generation budgets')).toBeTruthy());
    fireEvent.change(input(TTS), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save media budgets' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ url: `${GOV}/media-budget`, method: 'PUT', body: { ttsChars: null, sttBytes: null, images: 7, videoJobs: null } });
  });
});
