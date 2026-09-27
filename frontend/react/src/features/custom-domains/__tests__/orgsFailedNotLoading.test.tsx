/**
 * Third instance of the same shape, and the one that made a CLAIM as well as
 * hanging: with `orgs === []` the selector rendered "No workspaces", which is an
 * answer, not a failure — while `orgId` stayed empty so the domain rows never
 * loaded and the skeleton never resolved.
 *
 * HG-4 moved this page onto `ui/useOrgSelection` + `ui/OrgSelectionState`, which
 * is the substantive half of the fix and not merely a noun change: the page was
 * hand-rolling `listOrgs().catch(() => setOrgs([]))`, so it sat OUTSIDE the
 * `ui/__tests__/orgSelectionEdgeRatchet` scan that protects every other adopter.
 * The strings below are now the SHARED ones, so a page that quietly re-grew its
 * own copy would go red here.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { listOrgs, listDomains, useFeatureAccess } = vi.hoisted(() => ({
  listOrgs: vi.fn(), listDomains: vi.fn(),
  useFeatureAccess: vi.fn(() => makeFeatureAccess({ enabled: true, loading: false })),
}));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../domainsClient.js', async (orig) => ({
  ...(await orig<typeof import('../domainsClient.js')>()),
  listOrgs, listDomains,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  // The real hook returns an OBJECT. Mocking it as `true` is what hid a live
  // bug: the page did `const enabled = useFeatureAccess(...)` then `if (!enabled)`,
  // which is always falsy for an object, so the toggle-off branch was dead in
  // production and this mock made the page render anyway. Mirror the real shape.
  useFeatureAccess,
}));

import { DomainsPage } from '../DomainsPage.js';

const ORG = { orgId: 'o1', name: 'Acme' };
const DOMAIN = { hostname: 'app.example.com', status: 'verified' as const, target: 'x.run.app', verifiedAt: null };

const mount = async (): Promise<void> => {
  render(<DomainsPage />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([ORG]);
  listDomains.mockResolvedValue([DOMAIN]);
});

describe('a failed ORGANIZATION read is neither "no organizations" nor loading', () => {
  it('does not present the failure as an answer', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('Could not load your organizations');
    expect(document.body.textContent).toContain(
      'The domain list could not be read. This is a failed read, not an empty organization list.',
    );
    expect(document.body.textContent).not.toContain('No domains yet');
    // The zero-org state is a DIFFERENT claim and must not be borrowed here.
    expect(document.body.textContent).not.toContain('No organizations');
    // Nor may the failure hide behind the skeleton the failed read left hanging.
    expect(document.querySelector('.skeleton')).toBeNull();
    // The add-domain form is inside the org-state chain: with no org id there is
    // nothing for a submit to write to, so the affordance must not be offered.
    expect(screen.queryByRole('button', { name: 'Add domain' })).toBeNull();
    expect(listDomains).not.toHaveBeenCalled();
  });

  it('the retry re-runs the organization read', async () => {
    listOrgs.mockRejectedValueOnce(new Error('503')).mockResolvedValue([ORG]);
    await mount();
    expect(listOrgs).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('Could not load your organizations');
    expect(screen.getByRole('button', { name: 'Add domain' })).toBeTruthy();
  });

  it('read SUCCEEDS with []: the real zero-organization state, not a failure and not a skeleton', async () => {
    // The other polarity. Before HG-4 this landed on the same dead end as the
    // failure — the selector answered "No workspaces" and the rows below waited
    // forever on a read `orgId` never let start.
    listOrgs.mockResolvedValue([]);
    await mount();
    expect(document.body.textContent).toContain('No organizations');
    expect(document.body.textContent).toContain('A custom domain belongs to an organization.');
    expect(document.body.textContent).not.toContain('Could not load your organizations');
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(listDomains).not.toHaveBeenCalled();
  });

  it('an organization with genuinely no domains still reads as empty', async () => {
    // The failure mode of this fix: a real empty state replaced by an error.
    listDomains.mockResolvedValue([]);
    await mount();
    expect(document.body.textContent).toContain('No domains yet');
    expect(document.body.textContent).not.toContain('Could not load your organizations');
    expect(document.body.textContent).not.toContain('No organizations');
  });
});

/**
 * The toggle actually gates now. It did not before: the page assigned the whole
 * `useFeatureAccess` OBJECT and tested `if (!enabled)`, which is never true, so
 * the "not enabled" card was unreachable and the feature rendered regardless of
 * its toggle. The old mock (`() => true`) made the test agree with the bug.
 */
describe('custom domains — the feature toggle gates the page', () => {
  it('toggle OFF renders the not-enabled card and reads nothing', async () => {
    useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: false }));
    render(<DomainsPage />);
    expect(await screen.findByText(/not enabled/i)).toBeTruthy();
    expect(listOrgs).not.toHaveBeenCalled();
    useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  });

  it('toggle UNRESOLVED is a skeleton under the real header — not a terminal card', async () => {
    // This branch used to render `<StateCard title={t('title')} loading />`,
    // whose only text is the page title: it reads as a terminal ANSWER ("Custom
    // domains." — about what?) and it unmounts `PageHeader` on the way in and out,
    // so the page's identity flickers. Corpus majority instead — keep the header,
    // and use the SAME row shape the table below shows while its own read is in
    // flight, so the layout does not jump when the toggle resolves.
    useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: false, loading: true }));
    render(<DomainsPage />);
    expect(await screen.findByRole('status', { name: 'Loading…' })).toBeTruthy();
    // The header survives — the whole point of not using a title-only card.
    expect(screen.getByRole('heading', { name: 'Custom domains' })).toBeTruthy();
    expect(screen.queryByText(/not enabled/i)).toBeNull();
    expect(listOrgs).not.toHaveBeenCalled();
    useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  });
});
