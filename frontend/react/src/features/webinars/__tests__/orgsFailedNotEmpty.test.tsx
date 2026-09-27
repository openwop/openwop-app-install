/**
 * HG-4 — webinars was one of the three surfaces still shipping the FALSE CLAIM
 * after the shared card landed everywhere else.
 *
 * Its org read was hand-rolled and its catch wrote BOTH halves of the defect:
 *
 *     .catch((e) => { setOrgs([]); setError(...); })
 *
 * `[]` then selected the page's own zero-org early return, which rendered
 * "No workspace yet — create a workspace to register and track webinar events."
 * over a read that had FAILED. Two lies in one card: the account was not known
 * to be empty, and "workspace" is a DIFFERENT server collection from the one
 * that failed (`listOrgs`; `listMyWorkspaces` synthesizes a Personal sandbox and
 * is never empty for an anonymous caller). The picker beside it was labelled
 * "Workspace" for the third sighting on one screen.
 *
 * The page is now an `ui/useOrgSelection` + `ui/OrgSelectionState` adopter, so
 * the assertions below are the SHARED strings: a page that re-grows its own copy
 * — or the old noun — goes red here, and so does a regression in the shared
 * frame itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listOrgs = vi.fn();
const listWebinarEvents = vi.fn();

vi.mock('../webinarsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: () => listOrgs(),
  listWebinarEvents: () => listWebinarEvents(),
  createWebinarEvent: vi.fn(async () => ({})),
  syncWebinarEvent: vi.fn(async () => ({ outcome: 'synced' })),
  bindWebinarForm: vi.fn(async () => ({})),
}));
vi.mock('../../forms/formsClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listForms: vi.fn(async () => []),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { WebinarsPage } from '../WebinarsPage.js';

const FAILED = 'The webinar event list was never requested. This is a failed read, not an empty organization list.';
const EMPTY = 'Webinar events belong to an organization.';

const mount = async (): Promise<void> => {
  render(<MemoryRouter><WebinarsPage /></MemoryRouter>);
  await act(async () => {});
};

beforeEach(() => {
  listOrgs.mockReset(); listWebinarEvents.mockReset();
  listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
  listWebinarEvents.mockResolvedValue([]);
});
afterEach(cleanup);

describe('webinars — a failed organization read is not an empty account', () => {
  it('read FAILS: the honest, retryable card — and NEVER the workspace claim', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('Could not load your organizations');
    expect(document.body.textContent).toContain(FAILED);
    // The three sightings of the wrong collection, pinned as absences.
    expect(document.body.textContent).not.toContain('No workspace yet');
    expect(document.body.textContent).not.toContain('Workspace');
    // …and never the zero-org claim, which is a different fact entirely.
    expect(document.body.textContent).not.toContain('No organizations');
    expect(listWebinarEvents).not.toHaveBeenCalled();
  });

  it('the retry re-runs the organization read', async () => {
    listOrgs.mockRejectedValueOnce(new Error('503')).mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
    await mount();
    expect(listOrgs).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(FAILED);
  });

  it('read SUCCEEDS with []: the real zero-organization state, and it does not INSTRUCT', async () => {
    listOrgs.mockResolvedValue([]);
    await mount();
    expect(document.body.textContent).toContain('No organizations');
    expect(document.body.textContent).toContain(EMPTY);
    expect(document.body.textContent).not.toContain(FAILED);
    // §4.6 rule 7 — the CTA offers the recovery; the body must not narrate it.
    expect(document.body.textContent).not.toContain('Create an organization first');
    // The register form is inside the guard: with no organization there is
    // nothing `createWebinarEvent(orgId, …)` could write to.
    expect(screen.queryByRole('button', { name: 'Track webinar' })).toBeNull();
  });

  it('an organization with genuinely no webinars still reads as its own empty state', async () => {
    // The failure mode of this fix: a real empty state replaced by an org claim.
    await mount();
    expect(document.body.textContent).not.toContain(FAILED);
    expect(document.body.textContent).not.toContain('No organizations');
    expect(screen.getByRole('button', { name: 'Track webinar' })).toBeTruthy();
  });
});
