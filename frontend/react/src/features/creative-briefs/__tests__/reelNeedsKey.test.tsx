/**
 * ADR 1039 D2 (CB82WF-2) — the reel's two honest outcomes on the page.
 *
 *  - The server refuses a reel BEFORE starting a run when the workspace has no
 *    Replicate key (`credential_required`). The page shows a persistent state
 *    that says nothing was started or charged and links to the Secrets Vault,
 *    instead of a transient generic "failed".
 *  - A reel run that fails says WHY, from its error code (grade-ux M1: the raw
 *    message is provider text and is never shown).
 *
 * Red when the needs-key state is replaced by a toast, loses its vault link, is
 * not spoken (grade-ux H1), or a failed run toasts raw provider text or the bare
 * "Reel generation failed." for a code that has a reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { CreativeBrief } from '../creativeBriefsClient.js';
import { toast } from '../../../ui/toast.js';
import { announce } from '../../../ui/announce.js';

const generateReel = vi.fn();
const getRun = vi.fn();

vi.mock('../creativeBriefsClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  const brief: CreativeBrief = {
    briefId: 'cb-1', orgId: 'org-1', title: 'Spring hero', assetType: 'video',
    sceneDescription: 'A field at dawn', directions: [], moodBoard: [],
    status: 'review', version: 3, updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    ...actual,
    getGroundingSettings: vi.fn(async () => ({ editModeEnabled: false })),
    listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
    listBriefs: vi.fn(async () => [brief]),
    getBrief: vi.fn(async () => brief),
    updateBrief: vi.fn(async () => brief),
    transitionBrief: vi.fn(async () => ({})),
    listVersions: vi.fn(async () => []),
    deleteBrief: vi.fn(async () => {}),
    listRenders: vi.fn(async () => []),
    listRenderTemplates: vi.fn(async () => [{ templateId: 'tp-1', version: 1, platform: 'meta', format: 'feed', width: 1080, height: 1080, safeZones: [], layers: [] }]),
    createRenders: vi.fn(async () => ({ renders: [], failures: [] })),
    generateReel: (...a: unknown[]) => generateReel(...a),
  };
});
vi.mock('../../../client/runsClient.js', () => ({ getRun: (...a: unknown[]) => getRun(...a) }));
vi.mock('../../media/mediaClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listAssets: vi.fn(async () => []),
  absoluteServeUrl: (s: string) => s,
}));
// ADR 1039 D8 — with "Ask the Creative Director" (#5535) the brief page asks the agent catalog; mocked so this page test makes no live fetch.
vi.mock('../../../chat/lib/agentMentions.js', () => ({ useAgentMentions: () => ({ entries: [], isLoading: false, error: null }) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../ui/announce.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), announce: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { CreativeBriefsPage } from '../CreativeBriefsPage.js';

function mount(): void {
  render(
    <MemoryRouter initialEntries={['/creative-briefs/cb-1']}>
      <Routes>
        <Route path="/creative-briefs/:briefId" element={<CreativeBriefsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  generateReel.mockReset();
  getRun.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.mocked(announce).mockReset();
  try { sessionStorage.clear(); } catch { /* jsdom */ }
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ADR 1039 D2 — reel outcomes on the briefs page', () => {
  it('no Replicate key: a persistent needs-key state with a vault link, no toast', async () => {
    generateReel.mockRejectedValue(Object.assign(new Error('Reels need a Replicate key.'), { code: 'credential_required' }));
    mount();
    await screen.findByDisplayValue('Spring hero');
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /generate reel/i })); });
    expect(await screen.findByText(/nothing was started or charged/i)).toBeTruthy();
    const link = screen.getByRole('link', { name: /open the secrets vault/i });
    expect(link.getAttribute('href')).toBe('/access?tab=connections');
    expect(toast.error).not.toHaveBeenCalled();
    // Grade-ux H1 — a notice mounted with its text already inside is silent, so it is spoken.
    expect(vi.mocked(announce).mock.calls.some(([m]) => /nothing was started or charged/i.test(String(m)))).toBe(true);
  });

  it('a failed reel run toasts a translated reason from its error code, never the raw provider text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    generateReel.mockResolvedValue({ runId: 'run-1', statusUrl: '/runs/run-1' });
    getRun.mockResolvedValue({ status: 'failed', error: { code: 'provider_unavailable', message: 'replicate_predictions_402: {"detail":"Insufficient credit"}' } });
    mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /generate reel/i })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(toast.error).toHaveBeenCalledWith('Reel generation failed: Replicate did not produce the video');
    expect(String(vi.mocked(toast.error).mock.calls[0]?.[0])).not.toMatch(/402|detail/);
  });
});
