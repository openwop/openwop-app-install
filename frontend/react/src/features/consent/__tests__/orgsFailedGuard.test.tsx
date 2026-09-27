/**
 * Consent — a FAILED workspace read must not be rendered as "No organizations".
 *
 * `ConsentPage` consumes the shared `ui/useOrgSelection` seam correctly, but
 * nothing failed when the seam itself was sabotaged: replacing the hook's
 * `setOrgsFailed(true)` with `setOrgs([])` — the exact idiom the hook exists to
 * kill — left the consent suite green while the page told an operator whose read
 * 500'd to "Create an organization first". This is the GDPR-accountability
 * surface: `orgId` stays `''`, the policy + records reads never start, and the
 * page asserts an absence it never checked. The sibling CONS-G4 test hardened the
 * RECORDS read for exactly this reason; the ORG read is the one it does not see.
 * This file drives the REAL page through the REAL `consentClient.listOrgs`.
 *
 * Both polarities, because an "absent" assertion alone is vacuous — a page that
 * rendered nothing at all would satisfy it:
 *   - read FAILS   → the honest, retryable failure card; NEVER "No organizations"
 *   - read SUCCEEDS but is genuinely empty → the real "No organizations" survives
 *     and no failure card appears
 *   - positive control → with an organization the page renders AND reads
 *
 * HG-4 — the three states now come from `ui/OrgSelectionState`, so the copy
 * asserted here is the SHARED sentence plus this feature's own clause. The page
 * had the branch order INVERTED before the migration (the skeleton was checked
 * ABOVE the zero-org branch), so the zero-org case pins that a successful "none"
 * renders the card and never a skeleton with no terminal condition.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  listOrgs: vi.fn(),
  getPolicy: vi.fn(),
  listRecords: vi.fn(),
  getSubject: vi.fn(),
}));
vi.mock('../consentClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, ...api };
});
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ConsentPage } from '../ConsentPage.js';

beforeEach(() => {
  vi.clearAllMocks();
  api.getPolicy.mockResolvedValue({ policy: { tenantId: 't', regulatedRegions: ['EU'], defaultMode: 'opt-in' }, legalHold: null });
  api.listRecords.mockResolvedValue([]);
  api.getSubject.mockResolvedValue(null);
});
afterEach(cleanup);

describe('consent — a failed workspace read is not an empty account', () => {
  it('read FAILS: the honest retryable card — and NEVER "No organizations"', async () => {
    api.listOrgs.mockRejectedValue(new Error('orgs_500'));
    render(<ConsentPage />);
    expect(await screen.findByText('Could not load your organizations')).toBeTruthy();
    // EXACT: a fragment regex would match the old per-feature sentence too.
    expect(screen.getByText(
      'The consent policy was never requested. This is a failed read, not an empty organization list.',
    )).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('No organizations')).toBeNull();
    expect(screen.queryByText('The consent policy belongs to an organization.')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(document.querySelector('.skeleton')).toBeNull();
    // The GDPR-accountability half: the records read never ran, so the page must
    // not be able to reach any statement about which records exist.
    expect(api.getPolicy).not.toHaveBeenCalled();
    expect(api.listRecords).not.toHaveBeenCalled();
    expect(screen.queryByText('No consent records')).toBeNull();
  });

  it('read SUCCEEDS with []: the zero-organization card, never an endless skeleton', async () => {
    api.listOrgs.mockResolvedValue([]);
    render(<ConsentPage />);
    expect(await screen.findByText('No organizations')).toBeTruthy();
    expect(screen.getByText('The consent policy belongs to an organization.')).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(api.getPolicy).not.toHaveBeenCalled();
    expect(api.listRecords).not.toHaveBeenCalled();
  });

  it('positive control: with an organization the page renders AND reads', async () => {
    // Without this, both absences above would hold on a page that rendered
    // nothing at all and never read anything.
    api.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
    render(<ConsentPage />);
    await waitFor(() => expect(api.listRecords).toHaveBeenCalledWith('o1'));
    expect(api.getPolicy).toHaveBeenCalledWith('o1');
    // H76 — `findByText`, not `getByText`. The `waitFor` above resolves when the
    // CALL is recorded; rendering that call's result is at least a microtask and
    // a render pass later. Under a 659-file parallel fleet that gap widened past
    // the assertion and this leg failed while the page was perfectly healthy —
    // the DOM dump showed the header and the org select populated, with only the
    // records region yet to paint.
    //
    // Fixed by awaiting the render, NOT by weakening or skipping the assertion:
    // this is the POSITIVE CONTROL, and its own comment above says why. Retire
    // it and the three absence-assertions below hold on a page that rendered
    // nothing — which is the failure this file exists to prevent.
    expect(await screen.findByText('No consent records yet')).toBeTruthy();
    expect(screen.queryByText('Could not load your organizations')).toBeNull();
    expect(screen.queryByText('No organizations')).toBeNull();
  });
});
