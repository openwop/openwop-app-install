/**
 * ADR 0945 × 0942 — a creative publish review reads as what it is in BOTH inboxes:
 * its own group label, the server's proposal, a plain Approve (never "Approve &
 * run": approving starts nothing), and an approve toast that says the version can
 * now be published.
 * What turns it red: the kind falling into the run catch-all in either inbox, or the
 * approve toast claiming a run.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PendingApproval } from '../../agents/approvalsClient.js';
import type { AssetProvenance, MediaAsset } from '../../features/media/mediaClient.js';

const { listApprovals, listApprovalsByKind, claimApproval, rejectApproval } = vi.hoisted(() => ({
  listApprovals: vi.fn(), listApprovalsByKind: vi.fn(), claimApproval: vi.fn(), rejectApproval: vi.fn(),
}));
vi.mock('../../agents/approvalsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/approvalsClient.js')>()),
  listApprovals, listApprovalsByKind, claimApproval, rejectApproval,
}));
const { loadAgentViews } = vi.hoisted(() => ({ loadAgentViews: vi.fn() }));
vi.mock('../../agents/agentViewModel.js', async (orig) => ({ ...(await orig<typeof import('../../agents/agentViewModel.js')>()), loadAgentViews }));
const { toastSuccess, toastError, toastInfo } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn(), toastInfo: vi.fn() }));
vi.mock('../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: toastError, info: toastInfo } }));

const { getMediaAsset, getAssetProvenance } = vi.hoisted(() => ({ getMediaAsset: vi.fn(), getAssetProvenance: vi.fn() }));
vi.mock('../../features/media/mediaClient.js', async (orig) => ({
  ...(await orig<typeof import('../../features/media/mediaClient.js')>()), getMediaAsset, getAssetProvenance,
}));

import { ApprovalsInbox } from '../ApprovalsInbox.js';
import { NeedsYouInbox } from '../NeedsYouInbox.js';
import { t } from 'i18next';

const ROW: PendingApproval = {
  approvalId: 'cr1', rosterId: '', persona: '', workflowId: '',
  kind: 'creative-publish-review', orgId: 'org:client', assetId: 'asset:creative', verdictId: 'fvd:review',
  proposal: 'Publish "mug.png" although its brand-accuracy check asked for a person to review it.',
  status: 'pending', createdAt: '2026-10-20T00:00:00Z',
};

const ASSET: MediaAsset = {
  assetId: 'asset:creative', orgId: 'org:client', name: 'mug.png', contentType: 'image/png',
  contentHash: 'a'.repeat(64), sizeBytes: 10, tags: [], usageCount: 0, altText: 'Blue mug product creative',
  serveUrl: '/host/openwop-app/media/serve/result', createdAt: ROW.createdAt, updatedAt: ROW.createdAt,
};
const EVIDENCE: AssetProvenance = {
  assetId: ASSET.assetId, generatedBy: 'ai',
  grounding: { mode: 'edit', productId: 'prod:mug', sources: [{ assetId: 'asset:photo', sha256: 'b'.repeat(64) }],
    provider: 'test', model: 'test', op: 'image.edit', fidelity: { verdictId: 'fvd:review', outcome: 'needs_review', rulesetVersion: '1' } },
  sources: [{ assetId: 'asset:photo', sha256: 'b'.repeat(64), present: true, name: 'Mug product photo', contentType: 'image/png', serveUrl: '/host/openwop-app/media/serve/source' }],
  verdict: { verdictId: 'fvd:review', assetSha256: 'a'.repeat(64), outcome: 'needs_review', mode: 'edit',
    checks: [{ id: 'judge', status: 'not_applicable', detail: 'Needs human review' }], rulesetVersion: '1', checkedAt: ROW.createdAt,
    judge: { provider: 'test', model: 'test', repaired: false, results: [{ attribute: 'logo', answer: 'not_visible', evidence: 'The logo is hidden behind the handle.' }] } },
};
async function openEvidence(): Promise<void> {
  const approve = await screen.findByRole('button', { name: /^approve$/i });
  expect(approve).toBeDisabled();
  expect(getMediaAsset).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: t('media:provenanceLabel') }));
  expect(await screen.findByText('The logo is hidden behind the handle.')).toBeTruthy();
  expect(screen.getByAltText('Blue mug product creative')).toHaveAttribute('src', expect.stringContaining('/media/serve/result'));
  expect(screen.getByText(t('media:provenanceSource', { name: 'Mug product photo' }))).toBeTruthy();
  await waitFor(() => expect(approve).not.toBeDisabled());
}

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  listApprovals.mockResolvedValue([ROW]);
  listApprovalsByKind.mockResolvedValue([]);
  loadAgentViews.mockResolvedValue([]);
  claimApproval.mockResolvedValue({});
  getMediaAsset.mockResolvedValue(ASSET);
  getAssetProvenance.mockResolvedValue(EVIDENCE);
});

describe('creative-publish-review in the inboxes', () => {
  it('the full inbox shows its own group, no run copy, and an honest approve toast', async () => {
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    expect(await screen.findByText(t('notifications:approvalsCreativeReviewGroup'))).toBeTruthy();
    expect(screen.getByText(ROW.proposal)).toBeTruthy();
    expect(screen.queryByText(/Approve & run/)).toBeNull();
    await openEvidence();
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(claimApproval).toHaveBeenCalled());
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(t('notifications:toastApprovedCreativeReview')));
  });

  it('the needs-you inbox labels it and never offers "Approve & run"', async () => {
    render(<MemoryRouter><NeedsYouInbox /></MemoryRouter>);
    expect(await screen.findByText(t('notifications:approvalsCreativeReviewGroup'))).toBeTruthy();
    expect(screen.queryByText(/Approve & run/)).toBeNull();
    await openEvidence();
  });

  it('changed asset bytes leave Approve disabled while rejection remains available', async () => {
    getMediaAsset.mockResolvedValue({ ...ASSET, contentHash: 'c'.repeat(64) });
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    const approve = await screen.findByRole('button', { name: /^approve$/i });
    fireEvent.click(screen.getByRole('button', { name: t('media:provenanceLabel') }));
    expect(await screen.findByText(t('notifications:approvalsCreativeReviewUnavailable'))).toBeTruthy();
    expect(approve).toBeDisabled();
    expect(screen.getByRole('button', { name: /^reject$/i })).not.toBeDisabled();
    fireEvent.click(approve);
    expect(claimApproval).not.toHaveBeenCalled();
  });

  it('a failed evidence read can retry but cannot authorize an approval', async () => {
    getAssetProvenance.mockRejectedValueOnce(new Error('offline'));
    render(<MemoryRouter><NeedsYouInbox /></MemoryRouter>);
    const approve = await screen.findByRole('button', { name: /^approve$/i });
    fireEvent.click(screen.getByRole('button', { name: t('media:provenanceLabel') }));
    expect(await screen.findByText(t('notifications:approvalsCreativeReviewUnavailable'))).toBeTruthy();
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText('The logo is hidden behind the handle.')).toBeTruthy();
    await waitFor(() => expect(approve).not.toBeDisabled());
    expect(claimApproval).not.toHaveBeenCalled();
  });
});
