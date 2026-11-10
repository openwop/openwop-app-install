/**
 * ADR 0945 × 0942 — a creative publish review reads as what it is in BOTH inboxes:
 * its own group label, the server's proposal, and a plain Approve (never "Approve &
 * run": approving starts nothing). The full inbox's toast says the version can now be
 * published; neither inbox's toast claims a run. Approve opens only on evidence bound
 * to this exact asset and verdict: changed, missing or unreadable evidence leaves it
 * disabled and Reject usable.
 *
 * The needs-you inbox toasts the generic "Approved." (NYI-TOAST-1, BLOCKED-ON-PRODUCT),
 * so its specific copy is not asserted here.
 *
 * What turns it red: the kind falling into the run catch-all in either inbox, the
 * approve toast claiming a run, a read before the card is opened, any one bind check
 * removed, or Approve left enabled.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PendingApproval } from '../../agents/approvalsClient.js';
import type { AssetProvenance, MediaAsset } from '../../features/media/mediaClient.js';

const { listApprovals, listApprovalsByKind, claimApproval, rejectApproval } = vi.hoisted(() => ({
  listApprovals: vi.fn<typeof import('../../agents/approvalsClient.js').listApprovals>(),
  listApprovalsByKind: vi.fn<typeof import('../../agents/approvalsClient.js').listApprovalsByKind>(),
  claimApproval: vi.fn<typeof import('../../agents/approvalsClient.js').claimApproval>(),
  rejectApproval: vi.fn<typeof import('../../agents/approvalsClient.js').rejectApproval>(),
}));
vi.mock('../../agents/approvalsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/approvalsClient.js')>()),
  listApprovals, listApprovalsByKind, claimApproval, rejectApproval,
}));
const { loadAgentViews } = vi.hoisted(() => ({ loadAgentViews: vi.fn<typeof import('../../agents/agentViewModel.js').loadAgentViews>() }));
vi.mock('../../agents/agentViewModel.js', async (orig) => ({ ...(await orig<typeof import('../../agents/agentViewModel.js')>()), loadAgentViews }));
const { toastSuccess, toastError, toastInfo } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn(), toastInfo: vi.fn() }));
vi.mock('../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: toastError, info: toastInfo } }));

const { getMediaAsset, getAssetProvenance } = vi.hoisted(() => ({
  getMediaAsset: vi.fn<typeof import('../../features/media/mediaClient.js').getMediaAsset>(),
  getAssetProvenance: vi.fn<typeof import('../../features/media/mediaClient.js').getAssetProvenance>(),
}));
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
const GROUNDING: NonNullable<AssetProvenance['grounding']> = {
  mode: 'edit', productId: 'prod:mug', sources: [{ assetId: 'asset:photo', sha256: 'b'.repeat(64) }],
  provider: 'test', model: 'test', op: 'image.edit', fidelity: { verdictId: 'fvd:review', outcome: 'needs_review', rulesetVersion: '1' },
};
const VERDICT: NonNullable<AssetProvenance['verdict']> = {
  verdictId: 'fvd:review', assetSha256: 'a'.repeat(64), outcome: 'needs_review', mode: 'edit',
  checks: [{ id: 'judge', status: 'not_applicable', detail: 'Needs human review' }], rulesetVersion: '1', checkedAt: ROW.createdAt,
  judge: { provider: 'test', model: 'test', repaired: false, results: [{ attribute: 'logo', answer: 'not_visible', evidence: 'The logo is hidden behind the handle.' }] },
};
const SOURCE: AssetProvenance['sources'][number] = { assetId: 'asset:photo', sha256: 'b'.repeat(64), present: true, name: 'Mug product photo', contentType: 'image/png', serveUrl: '/host/openwop-app/media/serve/source' };
const EVIDENCE: AssetProvenance = { assetId: ASSET.assetId, generatedBy: 'ai', grounding: GROUNDING, sources: [SOURCE], verdict: VERDICT };

async function openEvidence(): Promise<HTMLElement> {
  const approve = await screen.findByRole('button', { name: /^approve$/i });
  expect(approve).toBeDisabled();
  expect(getMediaAsset).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: t('media:provenanceLabel') }));
  expect(await screen.findByText('The logo is hidden behind the handle.')).toBeTruthy();
  expect(getMediaAsset).toHaveBeenCalledWith('org:client', 'asset:creative');
  expect(getAssetProvenance).toHaveBeenCalledWith('org:client', 'asset:creative');
  expect(screen.getByAltText('Blue mug product creative')).toHaveAttribute('src', expect.stringContaining('/media/serve/result'));
  expect(screen.getByText(t('media:provenanceSource', { name: 'Mug product photo' }))).toBeTruthy();
  await waitFor(() => expect(approve).not.toBeDisabled());
  return approve;
}

/** Open the card over evidence that must not pass the bind check. */
async function expectRefused(): Promise<void> {
  render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
  const approve = await screen.findByRole('button', { name: /^approve$/i });
  fireEvent.click(screen.getByRole('button', { name: t('media:provenanceLabel') }));
  expect(await screen.findByText(t('notifications:approvalsCreativeReviewUnavailable'))).toBeTruthy();
  expect(approve).toBeDisabled();
  expect(screen.getByRole('button', { name: /^reject$/i })).not.toBeDisabled();
  fireEvent.click(approve);
  expect(claimApproval).not.toHaveBeenCalled();
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
    const approve = await openEvidence();
    fireEvent.click(approve);
    await waitFor(() => expect(claimApproval).toHaveBeenCalledWith('cr1', undefined, undefined));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(t('notifications:toastApprovedCreativeReview')));
  });

  it('the needs-you inbox labels it and never offers "Approve & run"', async () => {
    render(<MemoryRouter><NeedsYouInbox /></MemoryRouter>);
    expect(await screen.findByText(t('notifications:approvalsCreativeReviewGroup'))).toBeTruthy();
    expect(screen.getByText(ROW.proposal)).toBeTruthy();
    expect(screen.queryByText(/Approve & run/)).toBeNull();
    const approve = await openEvidence();
    fireEvent.click(approve);
    await waitFor(() => expect(claimApproval).toHaveBeenCalledWith('cr1', undefined, undefined));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    expect(toastSuccess).not.toHaveBeenCalledWith(t('notifications:toastApprovedRunning', { persona: '' }));
  });

  it('changed asset bytes leave Approve disabled while rejection remains available', async () => {
    getMediaAsset.mockResolvedValue({ ...ASSET, contentHash: 'c'.repeat(64) });
    await expectRefused();
  });

  it.each<[string, () => void]>([
    ['the verdict moved on', () => getAssetProvenance.mockResolvedValue({ ...EVIDENCE, verdict: { ...VERDICT, verdictId: 'fvd:newer' } })],
    ['the outcome no longer needs review', () => getAssetProvenance.mockResolvedValue({ ...EVIDENCE, verdict: { ...VERDICT, outcome: 'pass' } })],
    ['the stamp names another verdict', () => getAssetProvenance.mockResolvedValue({ ...EVIDENCE, grounding: { ...GROUNDING, fidelity: { verdictId: 'fvd:newer', outcome: 'needs_review', rulesetVersion: '1' } } })],
    ['a source is gone', () => getAssetProvenance.mockResolvedValue({ ...EVIDENCE, sources: [{ ...SOURCE, present: false }] })],
    ['the asset belongs to another org', () => getMediaAsset.mockResolvedValue({ ...ASSET, orgId: 'org:other' })],
  ])('changed evidence leaves Approve disabled: %s', async (_name, arrange) => {
    arrange();
    await expectRefused();
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
