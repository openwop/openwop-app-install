/**
 * UX_UPGRADE-consent ROUND 2 — XCN-1/2/3 (frontend).
 *
 *  - CN-SP-3: a successful save ADOPTS the server response — no lingering
 *    "Unsaved changes" chip, no discard prompt over saved edits.
 *  - CN-SP-4: per-channel specifics render — a whatsapp-true record must
 *    never display as "necessary only".
 *  - CN-SP-5/6: the receipt clears on org switch, and failed systems are
 *    NAMED.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ConsentPolicy, ConsentRecord } from '../consentClient.js';

const getPolicy = vi.fn();
const setPolicy = vi.fn();
const listRecords = vi.fn(async (..._a: unknown[]): Promise<ConsentRecord[]> => []);
const deleteSubject = vi.fn();
const getSubject = vi.fn();

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../consentClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPolicy: (...a: unknown[]) => getPolicy(...a),
  setPolicy: (...a: unknown[]) => setPolicy(...a),
  listRecords: (...a: unknown[]) => listRecords(...a),
  deleteSubject: (...a: unknown[]) => deleteSubject(...a),
  getSubject: (...a: unknown[]) => getSubject(...a),
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }, { orgId: 'org:2', name: 'Beta' }],
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { ConsentPage } = await import('../ConsentPage.js');

const policy = (over: Partial<ConsentPolicy> = {}): ConsentPolicy => ({
  tenantId: 't1', regulatedRegions: ['EU'], defaultMode: 'opt-in', ...over,
});
/** CONS-4 — `getPolicy` now returns the policy PLUS any active legal hold, so
 *  the console can say erasure is blocked before the operator commits to it. */
const policyEnvelope = (over: Partial<ConsentPolicy> = {}) => ({ policy: policy(over), legalHold: null });

const renderPage = () => render(<MemoryRouter><ConsentPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  getPolicy.mockResolvedValue(policyEnvelope());
  listRecords.mockResolvedValue([]);
});
afterEach(cleanup);

describe('CN-SP-3 — save adopts the server response', () => {
  it('after a successful save the dirty chip clears', async () => {
    setPolicy.mockResolvedValue(policy({ defaultMode: 'opt-out' }));
    renderPage();
    const mode = await screen.findByLabelText(/default mode/i, { selector: 'select' });
    fireEvent.change(mode, { target: { value: 'opt-out' } });
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(setPolicy).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/unsaved changes/i)).toBeNull());
  });
});

describe('CN-RACE-1 — an edit during load cannot be silently reverted', () => {
  it('the policy form is not editable until the policy is known', async () => {
    // THE DEFECT. `mode` starts at an INVENTED 'opt-in' (:56) while `policy` is
    // null, and the form used to render anyway. A user who picked 'opt-out' in
    // that window got: no "Unsaved changes" chip (dirty requires policy != null),
    // Save disabled — and then the load called setMode(p.defaultMode) and
    // silently reverted them. On a consent surface.
    //
    // Held on a DEFERRED promise so the load window is open for the whole
    // assertion, instead of racing a real one — which is exactly why the
    // existing suite could only see this as an intermittent flake.
    let release!: (p: { policy: ConsentPolicy; legalHold: null }) => void;
    getPolicy.mockReturnValue(new Promise<{ policy: ConsentPolicy; legalHold: null }>((res) => { release = res; }));
    renderPage();

    // ANCHOR on a panel that lives OUTSIDE the gate. This is not incidental:
    // it proves the gate is scoped to the POLICY FORM and did not blank the
    // whole page — and it makes the absence assertion below non-vacuous, since
    // a null select would otherwise also be explained by nothing having
    // rendered at all.
    expect(await screen.findByText(/data subject/i)).toBeTruthy();

    // While the policy is in flight there is NO editable default-mode control —
    // the page does not assert a value it does not have.
    expect(
      screen.queryByLabelText(/default mode/i, { selector: 'select' }),
      'the form was editable before the policy was known',
    ).toBeNull();

    // ...and the wait is ANNOUNCED. The first draft used the bare `<Skeleton />`,
    // which is `aria-hidden` — a screen-reader user got silence where the form
    // had been, which for that user is worse than the fiction it replaced.
    expect(
      screen.getByRole('status'),
      'the loading state is invisible to assistive tech',
    ).toBeTruthy();

    release(policyEnvelope({ defaultMode: 'opt-out' }));

    // Once known, the control appears showing the REAL policy — never the
    // invented 'opt-in'.
    const mode = await screen.findByLabelText(/default mode/i, { selector: 'select' });
    expect((mode as HTMLSelectElement).value).toBe('opt-out');
  });

  it('a FAILED policy load shows the error and NO editable form', async () => {
    // Three states, and the first draft of this test could not tell them apart:
    // it asserted only that the error TEXT appears — but the error Notice
    // renders ABOVE the gate, so it appeared either way. A sabotage probe
    // (drop the error arm) left it green, which is how I found that my own
    // error arm was both unproven AND wrong: it fell through to the FORM,
    // re-rendering the invented 'opt-in' this gate exists to prevent.
    //
    // Correct behaviour on failure: say why, and do NOT offer an editable
    // control asserting a policy we could not load.
    getPolicy.mockRejectedValue(new Error('policy boom'));
    renderPage();
    expect(await screen.findByText(/policy boom/i)).toBeTruthy();
    expect(
      screen.queryByLabelText(/default mode/i, { selector: 'select' }),
      'a failed policy load still offered an editable default-mode control',
    ).toBeNull();
    // AND no perpetual loading indicator. This assertion is the one that
    // distinguishes "gate on presence only" from the correct three-state gate:
    // without it, stranding the form behind a skeleton that will never resolve
    // passes — which is the permanent-skeleton defect (PR 2978) verbatim. Found by sabotage: the version
    // of this test without this line stayed green against exactly that bug.
    expect(
      document.querySelectorAll('.skeleton-rows, .skeleton').length,
      'a failed policy load left a loading skeleton that can never resolve',
    ).toBe(0);
  });

  it('CN-RACE-5: a failed load offers a RETRY that re-runs the read', async () => {
    // Previously the failed state rendered nothing, so a full page reload was
    // the only way forward.
    getPolicy.mockRejectedValueOnce(new Error('policy boom'));
    getPolicy.mockResolvedValue(policyEnvelope({ defaultMode: 'opt-out' }));
    renderPage();

    const retry = await screen.findByRole('button', { name: /retry/i });
    expect(getPolicy).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);

    // The retry re-runs the FULL load (inside `loadSeq`), so the form appears
    // with the REAL policy — not the invented 'opt-in'.
    const mode = await screen.findByLabelText(/default mode/i, { selector: 'select' });
    expect((mode as HTMLSelectElement).value).toBe('opt-out');
    expect(getPolicy).toHaveBeenCalledTimes(2);
  });

  it('CN-RACE-5: the failure is ANNOUNCED — StateCard has no live region', async () => {
    // The <Notice variant="error"> this replaced carried role="alert" +
    // aria-live="assertive" (Notice.tsx:90). StateCard deliberately has no live
    // region, so swapping one for the other without an explicit announce would
    // SILENTLY drop the announcement — the same class as the aria-hidden
    // skeleton fixed in CN-RACE-3.
    // `announce()` publishes into `GlobalLiveRegion`, which the real app mounts
    // ONCE at the shell — so an isolated render has no live region at all and
    // the assertion below would be unfalsifiable. Mount the real host rather
    // than spying on the module: that exercises the actual path, and a spy
    // would pass even if the message never reached a region.
    const { GlobalLiveRegion } = await import('../../../ui/announce.js');
    getPolicy.mockRejectedValue(new Error('policy boom'));
    render(<MemoryRouter><><GlobalLiveRegion /><ConsentPage /></></MemoryRouter>);
    await screen.findByRole('button', { name: /retry/i });
    await waitFor(() => {
      const live = [...document.querySelectorAll('[aria-live], [role="alert"], [role="status"]')]
        .map((e) => e.textContent ?? '').join(' ');
      // StateCard's `announce` publishes its TITLE (StateCard.tsx:77), not the
      // body — so the title is what must carry the meaning.
      expect(live, 'the load failure was never announced to assistive tech').toMatch(/could not load/i);
    });
  });
});

describe('CN-SP-4 — per-channel truth', () => {
  it('a whatsapp-true record renders the WhatsApp chip, never "necessary only"', async () => {
    listRecords.mockResolvedValue([{
      subjectKey: 'user:w', ts: '2026-08-09T00:00:00Z', source: 'api',
      categories: { necessary: true, analytics: false, marketing: false, 'marketing.whatsapp': true },
    } as ConsentRecord]);
    renderPage();
    await screen.findByText('WhatsApp');
    expect(screen.queryByText(/necessary only/i)).toBeNull();
  });

  it('the true necessary-only record still says so (positive case)', async () => {
    listRecords.mockResolvedValue([{
      subjectKey: 'user:n', ts: '2026-08-09T00:00:00Z', source: 'api',
      categories: { necessary: true, analytics: false, marketing: false },
    } as ConsentRecord]);
    renderPage();
    await screen.findByText(/necessary only/i);
  });
});

describe('CN-SP-5/6 — receipt lifecycle + named failures', () => {
  it('a partial erasure names the failed systems; the receipt clears on org switch', async () => {
    listRecords.mockResolvedValue([]);
    getSubject.mockResolvedValue(null);
    deleteSubject.mockResolvedValue({
      ok: false, consentRecord: true,
      erasure: { total: 5, failed: 2, keysResolved: 1, resolverFailures: 1, failedFeatures: ['eraseSubjectKanban', 'identity-link-resolution'] },
    });
    renderPage();
    await screen.findByLabelText(/subject key/i);
    fireEvent.change(screen.getByLabelText(/subject key/i), { target: { value: 'user:x' } });
    fireEvent.click(screen.getByRole('button', { name: /erase/i }));
    await waitFor(() => expect(deleteSubject).toHaveBeenCalled());
    await screen.findByText(/eraseSubjectKanban, identity-link-resolution/);
    // Switch orgs — org A's receipt must not survive.
    fireEvent.change(screen.getByLabelText(/organization|workspace/i), { target: { value: 'org:2' } });
    await waitFor(() => expect(screen.queryByText(/eraseSubjectKanban/)).toBeNull());
  });
});
