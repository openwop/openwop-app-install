/**
 * ADR 0593 D3/D4 — the CMS editorial review card, on BOTH deciding surfaces.
 *
 * These are the first tests for the content-publish card. Each covers one gap
 * from the feature-24 UX pass:
 *
 *  - `CMSAU-1` (Blocker) — the reviewer could not see what they were approving.
 *    The row carried `orgId`/`pageId`/`pageTitle` and the deep-link route
 *    existed; no card read either.
 *  - `CMSAU-2` (Blocker) — the stale-review 409 rendered as the raw dev string
 *    `claimApproval returned 409`, because the client discarded body/code/
 *    details on every non-2xx. The one safeguard that makes review meaningful
 *    was invisible exactly where reviews are decided.
 *  - `CMSAU-4` (Blocker) — the durable `aiDrafted` stamps reached no approval
 *    surface, so machine drafts were reviewed as if a person had written them.
 *  - `CMSAU-5` (Blocker) — reject collected no reason; the wire supported one
 *    and no surface wrote it.
 *  - `CMSAU-13` — reject's toast was kind-blind ("Proposal dismissed.") for a
 *    decision that returns a page to draft.
 *
 * `approvalErrorInfo` is deliberately NOT mocked — it is the seam under test,
 * and a witness that mocked it would prove nothing about what a reviewer sees.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { listApprovals, claimApproval, rejectApproval } = vi.hoisted(() => ({
  listApprovals: vi.fn(), claimApproval: vi.fn(), rejectApproval: vi.fn(),
}));
vi.mock('../../agents/approvalsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/approvalsClient.js')>()),
  listApprovals, claimApproval, rejectApproval,
}));
const { toastSuccess, toastError, toastInfo } = vi.hoisted(() => ({
  toastSuccess: vi.fn(), toastError: vi.fn(), toastInfo: vi.fn(),
}));
vi.mock('../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: toastError, info: toastInfo } }));

import { ApprovalApiError } from '../../agents/approvalsClient.js';
import { ApprovalsInbox } from '../ApprovalsInbox.js';
import { NeedsYouInbox } from '../NeedsYouInbox.js';

const ROW = {
  approvalId: 'a1',
  rosterId: '', persona: '', workflowId: '',
  kind: 'content-publish' as const,
  orgId: 'org-7', pageId: 'page-42', pageTitle: 'Pricing 2026', pageVersion: 14,
  proposal: 'Publish CMS page "Pricing 2026"',
  status: 'pending' as const,
  createdAt: '2026-08-20T00:00:00Z',
};

afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); });

describe('CMSAU-1 — the reviewer can open the page they are deciding', () => {
  for (const [name, Surface] of [['ApprovalsInbox', ApprovalsInbox], ['NeedsYouInbox', NeedsYouInbox]] as const) {
    it(`${name} links the card to the page's editor`, async () => {
      listApprovals.mockResolvedValue([ROW]);
      render(<MemoryRouter><Surface /></MemoryRouter>);
      const link = await screen.findByRole('link', { name: /Pricing 2026/ });
      expect(link.getAttribute('href')).toBe('/cms/p/org-7/page-42');
    });
  }

  it('renders the pinned version, so "approve what you saw" is legible', async () => {
    listApprovals.mockResolvedValue([ROW]);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    expect(await screen.findByText(/v14/)).toBeTruthy();
  });

  it('renders no link when the row carries no page reference (the negative control)', async () => {
    // Without this, the assertions above would be satisfied by a hard-coded
    // href that ignores the row.
    listApprovals.mockResolvedValue([{ ...ROW, orgId: undefined, pageId: undefined, pageVersion: undefined }]);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    await screen.findByText(/Publish CMS page/);
    expect(screen.queryByRole('link', { name: /Pricing 2026/ })).toBeNull();
  });
});

describe('CMSAU-4 — machine-drafted overlays are disclosed on the card', () => {
  it('renders the model-provenance chip with the locales', async () => {
    listApprovals.mockResolvedValue([{ ...ROW, aiDraftedLocales: ['es', 'pt-BR'] }]);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    const chip = await screen.findByText(/es, pt-BR/);
    expect(chip.closest('.chip--ai'), 'DESIGN.md §5.3 model-provenance token').toBeTruthy();
  });

  it('renders no provenance chip when the page carries no machine drafts', async () => {
    listApprovals.mockResolvedValue([ROW]);
    const { container } = render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    await screen.findByText(/Publish CMS page/);
    expect(container.querySelector('.chip--ai')).toBeNull();
  });
});

describe('CMSAU-2 — a decide failure speaks, instead of leaking a status code', () => {
  it('renders the localized stale-review explanation, never `claimApproval returned 409`', async () => {
    listApprovals.mockResolvedValue([ROW]);
    claimApproval.mockRejectedValue(new ApprovalApiError(
      'This page changed after it was submitted for review.',
      'conflict',
      409,
      { reason: 'stale_review', approvedVersion: 14, currentVersion: 15 },
    ));
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const msg = String(toastError.mock.calls[0]?.[0] ?? '');
    expect(msg).not.toMatch(/returned 409/);
    expect(msg, 'the remedy must be stated, not just the failure').toMatch(/submit it for review again/i);
  });

  it('explains a review the system closed because its page vanished', async () => {
    listApprovals.mockResolvedValue([ROW]);
    claimApproval.mockRejectedValue(new ApprovalApiError(
      'closed', 'conflict', 409, { reason: 'review_closed', subject: 'deleted' },
    ));
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0]?.[0])).toMatch(/no longer exists/i);
  });

  it('keeps the backend message for an UNMAPPED failure (the conservative arm)', async () => {
    // The mapper must not swallow specificity it cannot improve on — the same
    // rule `cmsErrorInfo` follows.
    listApprovals.mockResolvedValue([ROW]);
    claimApproval.mockRejectedValue(new ApprovalApiError('Storage is unavailable right now.', 'internal_error', 500, {}));
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0]?.[0])).toMatch(/Storage is unavailable/);
  });
});

describe('CMSAU-5 / CMSAU-13 — rejection carries a reason and says what it did', () => {
  it('collects the reason before rejecting, and sends it', async () => {
    listApprovals.mockResolvedValue([ROW]);
    rejectApproval.mockResolvedValue(undefined);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);

    // The first click ASKS — a reject is no longer a single unconfirmed click.
    fireEvent.click(await screen.findByRole('button', { name: /^reject$/i }));
    expect(rejectApproval).not.toHaveBeenCalled();

    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'Pricing table is out of date.' } });
    fireEvent.click(screen.getByRole('button', { name: /send back to draft/i }));

    await waitFor(() => expect(rejectApproval).toHaveBeenCalledWith('a1', 'Pricing table is out of date.'));
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith(expect.stringMatching(/back in draft/i)));
  });

  it('cancelling the reason does not reject', async () => {
    listApprovals.mockResolvedValue([ROW]);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^reject$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^cancel$/i }));
    await screen.findByRole('button', { name: /^reject$/i });
    expect(rejectApproval).not.toHaveBeenCalled();
  });

  it('an empty reason still rejects — the reason is encouraged, not compulsory', async () => {
    listApprovals.mockResolvedValue([ROW]);
    rejectApproval.mockResolvedValue(undefined);
    render(<MemoryRouter><NeedsYouInbox /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^reject$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /send back to draft/i }));
    await waitFor(() => expect(rejectApproval).toHaveBeenCalledWith('a1', undefined));
  });
});

// ── Adversarial-review fold-in (PR #3426) ──────────────────────────────────

describe('F7 — the disclosure and the reason step are usable without a mouse', () => {
  it('puts the machine-draft warning in the accessibility tree, not only in `title`', async () => {
    // The Blocker cure's load-bearing sentence lived in a tooltip: invisible to
    // keyboard users, touch users and most screen readers.
    listApprovals.mockResolvedValue([{ ...ROW, aiDraftedLocales: ['es'] }]);
    const { container } = render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    await screen.findByText(/es/);
    const sr = container.querySelector('.chip--ai .sr-only');
    expect(sr, 'the explanation must be real text, not a title attribute').toBeTruthy();
    expect(sr?.textContent).toMatch(/not been reviewed by a person/i);
  });

  it('a FAILED reject keeps the reason step open with the typed text', async () => {
    // It used to unmount before the request resolved, so the UI vanished from
    // under its own error toast and the reason had to be retyped.
    listApprovals.mockResolvedValue([ROW]);
    rejectApproval.mockRejectedValue(new ApprovalApiError('Storage is unavailable.', 'internal_error', 500, {}));
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^reject$/i }));
    const box = await screen.findByRole('textbox');
    fireEvent.change(box, { target: { value: 'Typed reason' } });
    fireEvent.click(screen.getByRole('button', { name: /send back to draft/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    const still = await screen.findByRole('textbox');
    expect((still as HTMLTextAreaElement).value, 'the typed reason survives the failure').toBe('Typed reason');
  });

  it('a SUCCESSFUL reject closes the reason step and returns focus to Reject', async () => {
    listApprovals.mockResolvedValue([ROW]);
    rejectApproval.mockResolvedValue(undefined);
    render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /^reject$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /send back to draft/i }));
    const back = await screen.findByRole('button', { name: /^reject$/i });
    await waitFor(() => expect(document.activeElement, 'focus must not drop to <body> (WCAG 2.4.3)').toBe(back));
  });
});
