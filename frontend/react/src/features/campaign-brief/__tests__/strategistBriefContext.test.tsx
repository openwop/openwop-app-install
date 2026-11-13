/**
 * CC-UX-2 — "Generate with the Brief Strategist" used to open the chat with an
 * empty composer, so the marketer had to tell the agent which brief they meant.
 * It now stages a one-shot composer draft (ADR 0334 5b, the creative-briefs
 * precedent) naming the brief by name, id and organization, then deep-links the
 * agent. Red before the fix: nothing was staged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { CampaignBrief } from '../campaignBriefClient.js';
import { takeStagedComposerDraft } from '../../../chat/composerSeed.js';

const listBriefs = vi.fn();
const updateBrief = vi.fn();
const validateBriefById = vi.fn();
const listPersonas = vi.fn();
const listOrgs = vi.fn();
const findCampaignForBrief = vi.fn();
const getPendingKernelRun = vi.fn();

// The collection selector reads the current client's KB through its own client.
vi.mock('../../kb/kbClient.js', () => ({ listCollections: vi.fn(async () => []) }));

vi.mock('../campaignBriefClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listBriefs: (..._a: unknown[]) => listBriefs(),
    updateBrief: (...a: unknown[]) => updateBrief(...a),
    validateBriefById: (...a: unknown[]) => validateBriefById(...a),
    listPersonas: (..._a: unknown[]) => listPersonas(),
    listOrgs: (..._a: unknown[]) => listOrgs(),
    listBrands: vi.fn(async () => []),
    deleteBrief: vi.fn(async () => {}),
    findCampaignForBrief: (...a: unknown[]) => findCampaignForBrief(...a),
    getPendingKernelRun: (...a: unknown[]) => getPendingKernelRun(...a),
  };
});
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CampaignBriefPage } from '../CampaignBriefPage.js';

const BRIEF: CampaignBrief = {
  id: 'brief-1', tenantId: 't', orgId: 'org-1', name: 'Spring launch', objective: 'Grow trials',
  personaIds: [], productName: 'Widget', productDescription: '', industryVertical: '',
  channels: [{ type: 'email_sequence', enabled: false, config: {} }],
  messaging: { primaryValueProp: '', toneOverride: '', proofPoints: [], ctaStrategy: '' },
  status: 'draft', kernelStale: false, createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

function ChatProbe(): JSX.Element {
  const loc = useLocation();
  return <p data-testid="chat-probe">{loc.pathname + loc.search}</p>;
}

async function openDetail(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/campaign-briefs']}>
      <Routes>
        <Route path="/campaign-briefs" element={<CampaignBriefPage />} />
        <Route path="/" element={<ChatProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  fireEvent.click(await screen.findByRole('button', { name: /spring launch/i }));
  await screen.findByRole('button', { name: /^Save$/ });
}

beforeEach(() => {
  listBriefs.mockReset().mockResolvedValue([BRIEF]);
  updateBrief.mockReset().mockResolvedValue(BRIEF);
  validateBriefById.mockReset().mockResolvedValue({ valid: true, issues: [], enabledChannels: [] });
  listPersonas.mockReset().mockResolvedValue([]);
  listOrgs.mockReset().mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
  findCampaignForBrief.mockReset().mockResolvedValue(null);
  getPendingKernelRun.mockReset().mockResolvedValue(null);
});
afterEach(cleanup);

describe('CC-UX-2 — the Strategist opens with this brief named', () => {
  it('Generate with the Brief Strategist stages a draft carrying the brief id and org, then opens the agent', async () => {
    takeStagedComposerDraft(); // drain residue from other tests
    await openDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Generate with the Brief Strategist' }));
    const probe = await screen.findByTestId('chat-probe');
    expect(probe.textContent).toBe('/?agent=vendor.openwop-app.campaign-brief.agents.brief-strategist');
    const draft = takeStagedComposerDraft();
    expect(draft).toContain('“Spring launch”');
    expect(draft).toContain('brief-1');
    expect(draft).toContain('org-1');
    expect(draft).toMatch(/generate its messaging kernel/);
    // One-shot: a second composer mount gets nothing.
    expect(takeStagedComposerDraft()).toBeNull();
  });

  it('with unsaved edits it saves first, says so, and opens only after the save lands', async () => {
    takeStagedComposerDraft();
    await openDetail();
    fireEvent.change(screen.getByLabelText(/Objective/i), { target: { value: 'Changed objective' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save and generate with the Brief Strategist' }));
    await screen.findByTestId('chat-probe');
    expect(updateBrief).toHaveBeenCalledTimes(1);
    expect(takeStagedComposerDraft()).toContain('brief-1');
  });

  it('a failed save keeps the marketer on the brief and stages nothing', async () => {
    takeStagedComposerDraft();
    updateBrief.mockReset().mockRejectedValue(new Error('save failed'));
    await openDetail();
    fireEvent.change(screen.getByLabelText(/Objective/i), { target: { value: 'Changed objective' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save and generate with the Brief Strategist' }));
    await act(async () => {});
    expect(updateBrief).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('chat-probe')).toBeNull();
    expect(takeStagedComposerDraft()).toBeNull();
  });
});
