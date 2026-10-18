/**
 * The org-edge instance that broke the pattern — and the reason a grep for
 * `if (orgId)` would have missed it entirely.
 *
 * On every other page in this seam, `orgs` gated a dependent fetch, so a failed
 * read hung the page. Here `listAccounts()` is UNGATED: the accounts load fine
 * and the page looks completely healthy. `orgs` feeds only the CRM-link
 * dropdown and its default, so the whole symptom is a picker with nothing in it
 * — a form that cannot be submitted, with nothing saying why.
 *
 * That makes the seam two shapes, not one: a failed read either blocks a read
 * (a hang) or blocks a WRITE (an inert control). The second is quieter and the
 * page keeps working around it.
 *
 * ADR 0212 §4 (the CRM-link org picker) + HG-4 (`ui/OrgSelectionState`, inline
 * variant). Sabotage-witnessed (w7 grade-tests): `orgsFailed={false}` reds the
 * failure-copy and retry legs; gating `load()` on `orgs` reds the first leg;
 * `retry={() => undefined}` reds the retry leg.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as C from '../csmClient.js';
import type { Account } from '../csmClient.js';

// EVERY fetching export is replaced. `listCrmCompanies` used to fall through
// to the real module via the spread — the editor defaults to the first org and
// fetches its companies — which is why this file sat on the live-fetch
// allowlist (ADR 0661).
const api = vi.hoisted(() => ({
  listOrgs: vi.fn<typeof C.listOrgs>(),
  listAccounts: vi.fn<typeof C.listAccounts>(),
  listCrmCompanies: vi.fn<typeof C.listCrmCompanies>(),
  createAccount: vi.fn<typeof C.createAccount>(),
  updateAccount: vi.fn<typeof C.updateAccount>(),
  deleteAccount: vi.fn<typeof C.deleteAccount>(),
  // ADR 0882 D3 — the owner picker's people list.
  listAssignees: vi.fn<typeof C.listAssignees>(async () => ({ assignees: [{ subject: 'user:me', displayName: 'Mia Me' }, { subject: 'user:dana', displayName: 'Dana Diaz' }], me: ['user:me'] })),
}));
const { listOrgs, listAccounts } = api;
// BOTH come from `csmClient` — `listOrgs` is re-exported there (ADR 0212), NOT
// from `client/accessClient` like most features. Mocking accessClient here did
// nothing at all: the real `listOrgs` ran, `orgsFailed` stayed false, and the
// test failed as though the fix were missing.
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../csmClient.js', async (orig) => ({
  ...(await orig<typeof import('../csmClient.js')>()),
  ...api,
}));
// ADR 0882 (CSM2UX-4) — write controls follow `workspace:write`; `writeAccess.value`
// lets a case render as a Viewer.
const writeAccess = vi.hoisted(() => ({ value: true }));
vi.mock('../../../lib/writeAccess.js', async (orig) => ({
  ...(await orig<typeof import('../../../lib/writeAccess.js')>()),
  useScopeWriteAccess: () => writeAccess.value,
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

import { CsmPage } from '../CsmPage.js';

const ORG = { orgId: 'o1', name: 'Acme' };
// COMPLETE against the real `Account` — `healthScore` (not `health`),
// `renewalDate` (not `renewalAt`), and the required `tenantId`/`createdAt`. A
// thin fixture renders no row, so the link editor never opens and every
// assertion fails for a reason unrelated to the defect. Typed, so a missing
// required field (it lacked `updatedAt`) is a compile error, not a comment.
const ACCOUNT: Account = {
  accountId: 'a1', tenantId: 't1', name: 'Globex', healthScore: 82,
  arr: 1000, renewalDate: '2027-01-01T00:00:00Z', owner: 'u1',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

/** The picker lives INSIDE the link editor, which opens per-account — so the
 *  disclosure is only reachable there. That is the right place for it (a
 *  field-level failure said at the field), but it means the test has to open the
 *  editor rather than just mount the page. */
const openLinkEditor = async (): Promise<void> => {
  // Matched on aria-label OR text, and on "link" broadly: the trigger's label is
  // `linkCompany` for an UNLINKED account and `editLink` for a linked one, so
  // matching only "Edit link" silently found nothing on a fresh fixture.
  // whose label rides on `aria-label` ("Edit CRM company link for X"), so a
  // textContent match finds nothing and looks like a missing fixture.
  const btn = screen.queryAllByRole('button')
    .find((b) => /link/i.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`));
  if (!btn) throw new Error('link editor trigger not rendered — fixture too thin');
  await act(async () => { fireEvent.click(btn); });
};

const mount = async (): Promise<void> => {
  render(<MemoryRouter><CsmPage /></MemoryRouter>);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  listOrgs.mockResolvedValue([ORG]);
  listAccounts.mockResolvedValue([ACCOUNT]);
  api.listCrmCompanies.mockResolvedValue([{ companyId: 'c1', name: 'Initech' }]);
});

describe('a failed workspace read does not leave a silently unusable picker', () => {
  it('the accounts still load — this page does NOT hang, which is what hid it', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    // The distinguishing fact: the dependent read is ungated, so it ran —
    // and the account ROW is on screen, not merely requested.
    expect(listAccounts).toHaveBeenCalled();
    expect(await screen.findByText('Globex')).toBeTruthy();
  });

  it('says the organization list failed, instead of just showing an empty dropdown', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    await openLinkEditor();
    // HG-4 — the SHARED copy (`ui/OrgSelectionState`, inline variant: this is a
    // field inside a form). Asserted in full, both halves.
    expect(document.body.textContent).toContain('Could not load your organizations');
    expect(document.body.textContent).toContain(
      'The company list was never requested. This is a failed read, not an empty organization list.',
    );
    // …and never as the empty answer, which is the claim the failure must not
    // borrow.
    expect(document.body.textContent).not.toContain('No organizations');
  });

  it('read SUCCEEDS with []: the zero-organization state — the OTHER silently unusable picker', async () => {
    // The quiet half this migration added. With no organizations the picker held
    // only its "Select an organization" placeholder, the Save button could never
    // enable, and nothing on screen said why.
    listOrgs.mockResolvedValue([]);
    await mount();
    await openLinkEditor();
    expect(document.body.textContent).toContain('No organizations');
    expect(document.body.textContent).toContain(
      'No organizations. CRM links belong to an organization.',
    );
    // Nothing failed, so nothing claims it did.
    expect(document.body.textContent).not.toContain('Could not load your organizations');
  });

  it('offers a retry for the read that actually failed', async () => {
    listOrgs.mockRejectedValueOnce(new Error('503'));
    await mount();
    await openLinkEditor();
    // The retry is WIRED, not merely present: it re-runs the read, and the
    // picker it was replacing comes back with the organization in it.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('Could not load your organizations');
    expect(screen.getByRole('option', { name: 'Acme' })).toBeTruthy();
  });

  it('a healthy read says nothing', async () => {
    // The failure mode of this fix: a warning on every ordinary visit.
    await mount();
    await openLinkEditor();
    // Positive control: the picker rendered, so the absence below is not a
    // blank editor's.
    expect(screen.getByRole('option', { name: 'Acme' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('Could not load your organizations');
  });
});
