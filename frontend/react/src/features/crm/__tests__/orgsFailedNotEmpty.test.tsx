/**
 * The CRM instance of the dependency-edge defect, rendered rather than scanned.
 *
 * `listOrgs().catch(() => setOrgs([]))` made a failed read render **"No
 * organizations — create an organization first — companies, deals, and tasks
 * belong to an org."** On the CRM that is the worst available reading of a
 * network error: an operator is told their workspace has no organizations, which
 * implies the companies, deals and tasks inside them are gone too.
 *
 * HG-4 — the three states now come from `ui/OrgSelectionState`, so the copy
 * asserted here is the SHARED sentence plus this feature's own clause. The page
 * had the branch order INVERTED before the migration (the skeleton was checked
 * ABOVE the zero-org branch), so the zero-org case pins that a successful "none"
 * renders the card and never a `role="status"` "Loading…" region: the companies
 * read is gated on `orgId`, so it never starts to terminate one.
 *
 * The wrapper sits INSIDE `needsOrg`. Contacts is tenant-wide and has no
 * org-gated read at all, so on that tab there is nothing about organizations to
 * say — a card there would be a claim about a dependency the tab does not have.
 *
 * Sabotage-witnessed (wave-4 /grade-tests, w4g5-of-*): CrmPage dropping the
 * `failedBody` clause, wrapping the Contacts tab in the org gate
 * (`needsOrg = true`), wiring the card's retry to nothing, and
 * `OrgSelectionState` skipping its zero-org branch each turn a case red. The
 * Contacts case now proves the tab RENDERED (it passed on a blank page before)
 * and its reads are stubbed (they were live fetches, ADR 0661).
 * Re-witnessed w52 (w52g2-crm-*): the retry case now also proves the retried
 * read reached the org-gated companies read for `o1`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

type OrgApi = typeof import('../crmOrgClient.js');
type CrmApi = typeof import('../crmClient.js');
const { listOrgs, listCompanies } = vi.hoisted(() => ({
  listOrgs: vi.fn<OrgApi['listOrgs']>(),
  listCompanies: vi.fn<OrgApi['listCompanies']>(),
}));
const crm = vi.hoisted(() => ({
  listContacts: vi.fn<CrmApi['listContacts']>(),
  listSegments: vi.fn<CrmApi['listSegments']>(),
  listContactFields: vi.fn<CrmApi['listContactFields']>(),
}));
vi.mock('../crmClient.js', async (orig) => ({ ...(await orig<CrmApi>()), ...crm }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../crmOrgClient.js', async (orig) => ({
  ...(await orig<typeof import('../crmOrgClient.js')>()),
  listOrgs,
  listCompanies,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => makeFeatureAccess({ enabled: true }),
}));

import { CrmPage } from '../CrmPage.js';

const ORG = { orgId: 'o1', name: 'Acme' };

const mount = async (): Promise<void> => {
  render(<MemoryRouter initialEntries={['/crm?tab=companies']}><CrmPage /></MemoryRouter>);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  listOrgs.mockResolvedValue([ORG]);
  listCompanies.mockResolvedValue([]);
  crm.listContacts.mockResolvedValue([]);
  crm.listSegments.mockResolvedValue([]);
  crm.listContactFields.mockResolvedValue([]);
});

describe('a failed org read is not "no organizations"', () => {
  it('says the read failed instead of implying the CRM is empty', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    expect(screen.getByText('Could not load your organizations')).toBeTruthy();
    // EXACT: a fragment regex would match the old per-feature sentence too.
    expect(screen.getByText(
      'The companies, deals, and tasks were never requested. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.queryByText('Companies, deals, and tasks belong to an organization.')).toBeNull();
    // Never a fall-through to loading: `CompaniesTab`'s `SkeletonRows` is a
    // `role="status"` "Loading…" live region over a read that already failed.
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(listCompanies).not.toHaveBeenCalled();
  });

  it('the retry re-runs the org read', async () => {
    // The hook's effect is the only place the read happens.
    listOrgs.mockRejectedValueOnce(new Error('503')).mockResolvedValue([ORG]);
    await mount();
    expect(listOrgs).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('Could not load your organizations');
    // The positive half: the retried read reached the org-gated content — the
    // companies read started for the org the retry loaded (a blank page fails).
    await waitFor(() => expect(listCompanies).toHaveBeenCalled());
    expect(listCompanies.mock.calls[0]?.[0]).toBe('o1');
  });

  it('a tenant that genuinely has no organizations gets the zero-organization card', async () => {
    // The failure mode of this fix: a real new tenant never told how to start.
    listOrgs.mockResolvedValue([]);
    await mount();
    expect(screen.getByText('No organizations')).toBeTruthy();
    expect(screen.getByText('Companies, deals, and tasks belong to an organization.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Could not load your organizations');
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(listCompanies).not.toHaveBeenCalled();
  });

  it('positive control: with an organization the tab renders AND reads', async () => {
    // Without this, both absences above would hold on a page that rendered
    // nothing at all and never read anything.
    await mount();
    await waitFor(() => expect(listCompanies).toHaveBeenCalled());
    expect(listCompanies.mock.calls[0]?.[0]).toBe('o1');
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(screen.queryByText('No organizations')).toBeNull();
  });

  it('the Contacts tab is tenant-wide, so it says nothing about organizations', async () => {
    // `needsOrg` stays OUTSIDE the wrapper on purpose: with no org-gated read on
    // this tab, a failure card here would report a dependency it does not have.
    listOrgs.mockRejectedValue(new Error('503'));
    render(<MemoryRouter initialEntries={['/crm?tab=contacts']}><CrmPage /></MemoryRouter>);
    await act(async () => {});
    // Positive control: the Contacts tab really rendered and read — without it
    // both absences below hold on a page that rendered nothing at all.
    expect(await screen.findByText('No contacts yet')).toBeTruthy();
    expect(crm.listContacts).toHaveBeenCalled();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(screen.queryByText('No organizations')).toBeNull();
  });
});
