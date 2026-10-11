/**
 * ADR 0859 — the editor's half of the review lifecycle.
 *
 *  - D4: the submitter of a pending review, while another manager can approve, is not
 *    OFFERED an Approve the server would refuse (`separation-of-duties`). The notice says
 *    who decides, and Reject (a withdrawal) stays. A manager who did not submit keeps
 *    Approve — the positive control.
 *  - D5: the pending notice says how many sections show live data.
 *  - The `forbidden` + `separation-of-duties` refusal maps to its own sentence.
 *
 * Sabotage-witnessed (/grade-tests w17): dropping the Approve filter, the
 * withdraw label, the awaiting-approver line or the live-data count turns the
 * matching case red; filtering Approve unconditionally reds the positive
 * control; mapping every `forbidden` to `errSelfApproval` reds the copy case;
 * dropping the inbox card's live-data line reds the last case.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactNode } from 'react';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

vi.mock('../PublicPreviewFrame.js', () => ({
  PublicPreviewFrame: ({ children }: { children: ReactNode }) => <div data-testid="public-preview">{children}</div>,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));
const ui = vi.hoisted(() => ({
  page: {
    pageId: 'p1', title: 'Launch post', slug: 'p', status: 'in_review', version: 3, updatedAt: '2026-01-01T00:00:00Z',
    sections: [{ sectionId: 'sec:a', type: 'richText', data: { heading: 'Story', text: 'Body' } }],
  },
  review: {
    approvalId: 'appr:cms:x', status: 'pending', createdAt: '2026-01-01T00:00:00Z', pageVersion: 3,
    liveReferenceSections: [{ sectionId: 'sec:t', type: 'entityList' }, { sectionId: 'sec:u', type: 'entityDetail' }],
    awaitingAnotherApprover: true as boolean | undefined,
  },
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../cmsClient.js', async (orig) => {
  const real = await orig<typeof import('../cmsClient.js')>();
  return {
    SECTION_TYPES: ['hero'],
    PAGE_STATUSES: ['draft', 'in_review', 'published', 'archived'],
    SYSTEM_SITE_ORG: 'host-site',
    assetUrl: (token: string) => `/asset/${token}`,
    cmsErrorInfo: real.cmsErrorInfo,
    CmsApiError: real.CmsApiError,
    listOrgs: vi.fn(async () => [{ orgId: 'o1', name: 'Org One' }]),
    listPages: vi.fn(async () => [ui.page]),
    getLanguageSettings: vi.fn(async () => ({ baseLocale: 'en', supportedLocales: [], autoTranslateOnPublish: false })),
    putLanguageSettings: vi.fn(), getPageReview: vi.fn(async () => ui.review), getPage: vi.fn(async () => ui.page),
    createPage: vi.fn(), deletePage: vi.fn(), savePage: vi.fn(), transition: vi.fn(), translateSection: vi.fn(),
    listVersions: vi.fn(async () => []), restoreVersion: vi.fn(), rewriteSection: vi.fn(),
    schedulePublish: vi.fn(), cancelSchedule: vi.fn(),
    listSharedSections: vi.fn(async () => []), createSharedSection: vi.fn(), updateSharedSection: vi.fn(),
    deleteSharedSection: vi.fn(), listSharedSectionPages: vi.fn(async () => []),
    listLocaleGrants: vi.fn(async () => []), putLocaleGrant: vi.fn(), setLocalePublish: vi.fn(), getTranslationStatus: vi.fn(async () => ({ locales: [], sections: {}, counts: {} })), confirmTranslationSource: vi.fn(),
  };
});
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listMembers: vi.fn(async () => []),
  getEffectiveAccess: vi.fn(async () => ({ roles: ['admin'], scopes: ['workspace:read', 'workspace:write', 'host:members:manage'], basis: 'member' })),
}));
vi.mock('../../media/mediaClient.js', () => ({ listAssets: vi.fn(async () => []), uploadAsset: vi.fn(), absoluteServeUrl: (u: string) => u }));
vi.mock('../../sharing/sharingClient.js', () => ({ createLink: vi.fn(), listLinks: vi.fn(async () => []), revokeLink: vi.fn(), sharedPageUrl: (t: string) => `/shared/${t}` }));
vi.mock('../../publishing/publishingClient.js', () => ({ getSeo: vi.fn(async () => null), putSeo: vi.fn() }));
vi.mock('../../site/siteConfigClient.js', () => ({ getSiteConfig: vi.fn(async () => { throw new Error('forbidden'); }), putSiteConfig: vi.fn(), invalidateFrontPage: vi.fn() }));

import { CmsPage } from '../CmsPage.js';
import { CmsApiError, cmsErrorInfo } from '../cmsClient.js';
import { ContentReviewContext } from '../../../notifications/ContentReviewContext.js';

afterEach(() => { cleanup(); ui.review.awaitingAnotherApprover = true; });

function renderDetail(): void {
  render(
    <MemoryRouter initialEntries={['/cms/p/o1/p1']}>
      <Routes><Route path="/cms/p/:routeOrgId/:routePageId" element={<CmsPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('ADR 0859 D4 — the submitter is not offered their own Approve', () => {
  it('hides Approve, offers Reject as a withdrawal, and says another approver decides', async () => {
    renderDetail();
    expect(await screen.findByText(/another approver in this organization has to approve it/, {}, { timeout: 3000 })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Withdraw from review' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
  });

  it('a manager who did not submit keeps Approve (positive control)', async () => {
    ui.review.awaitingAnotherApprover = undefined;
    renderDetail();
    expect(await screen.findByRole('button', { name: 'Approve' }, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText(/another approver in this organization has to approve it/)).toBeNull();
  });
});

describe('ADR 0859 D5 — the pending notice discloses live-data sections', () => {
  it('counts them', async () => {
    renderDetail();
    expect(await screen.findByText('2 sections show live data. Approving does not freeze what they show.', {}, { timeout: 3000 })).toBeTruthy();
  });
});

describe('ADR 0859 D4 — the refusal has its own sentence', () => {
  it('maps forbidden + separation-of-duties, and nothing else under `forbidden`', () => {
    expect(cmsErrorInfo(new CmsApiError('x', 'forbidden', 403, { reason: 'separation-of-duties' }))).toEqual({ key: 'errSelfApproval' });
    expect(cmsErrorInfo(new CmsApiError('x', 'forbidden', 403, {}))).toBeNull();
  });
});

describe('ADR 0859 D5 — the inbox card discloses live-data sections (ADR 0594 D1)', () => {
  it('renders the count as visible text, and nothing when there are none', () => {
    const row = {
      approvalId: 'a1', rosterId: '', persona: '', workflowId: '', kind: 'content-publish' as const,
      orgId: 'o1', pageId: 'p1', pageTitle: 'Team', pageVersion: 2, proposal: 'Publish', status: 'pending' as const, createdAt: '2026-01-01T00:00:00Z',
    };
    const { unmount } = render(<MemoryRouter><ContentReviewContext a={{ ...row, liveReferenceSections: [{ sectionId: 's', type: 'entityList' }, { sectionId: 't', type: 'entityList' }] }} /></MemoryRouter>);
    expect(screen.getByText(/2 live-data sections, not frozen by approval/)).toBeTruthy();
    unmount();
    render(<MemoryRouter><ContentReviewContext a={row} /></MemoryRouter>);
    expect(screen.queryByText(/live-data/)).toBeNull();
  });
});
