/**
 * ADR 0106 editable override — the GovernancePanel media-budget section is now
 * editable. `fetch` is stubbed (routed by URL); `listProviders` + `toast` mocked.
 * Covers: the section loads the override into the inputs, an edit + Save PUTs the
 * parsed override, and a blank field clears the override (null).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../connectionsClient.js', () => ({ listProviders: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { GovernancePanel } from '../GovernancePanel.js';

const POLICY = { policy: {}, defaults: { actionPolicy: 'approval-required', providerAllowlist: null }, actionKinds: ['email.send'] };
const MEDIA = {
  date: '2026-06-22',
  budgets: { ttsChars: 1000, sttBytes: 0 },
  envDefaults: { ttsChars: 1000, sttBytes: 0 },
  override: { ttsChars: 1000 },
  usage: { ttsChars: 0, sttBytes: 0 },
};

let putBody: unknown = null;

function stubFetch() {
  putBody = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (u.includes('/governance/media-budget')) {
      if (method === 'PUT') { putBody = JSON.parse(String(init?.body ?? '{}')); return jsonRes({ override: putBody, budgets: MEDIA.budgets }); }
      return jsonRes(MEDIA);
    }
    if (u.includes('/governance/policy')) return jsonRes(POLICY);
    return jsonRes({});
  }));
}
const jsonRes = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body } as unknown as Response);

beforeEach(stubFetch);
afterEach(() => { vi.unstubAllGlobals(); cleanup(); });

describe('GovernancePanel media-budget override (ADR 0106)', () => {
  it('loads the override into the editable inputs', async () => {
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText('Media generation budgets')).toBeTruthy());
    const tts = screen.getByLabelText('Text-to-speech budget (characters/day)') as HTMLInputElement;
    expect(tts.value).toBe('1000'); // seeded from override.ttsChars
  });

  it('saves an edited override via PUT (parsed to numbers)', async () => {
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText('Media generation budgets')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Text-to-speech budget (characters/day)'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Transcription budget (bytes/day)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save media budgets' }));
    await waitFor(() => expect(putBody).toEqual({ ttsChars: 500, sttBytes: 0 }));
  });

  it('a blank field CLEARS that override (null ⇒ falls back to env)', async () => {
    render(<GovernancePanel />);
    await waitFor(() => expect(screen.getByText('Media generation budgets')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Text-to-speech budget (characters/day)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save media budgets' }));
    await waitFor(() => expect(putBody).toEqual({ ttsChars: null, sttBytes: null }));
  });
});
