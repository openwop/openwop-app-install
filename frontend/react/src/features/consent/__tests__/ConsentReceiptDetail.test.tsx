/**
 * ADR 0657 D9 — the erasure receipt and the refused state, in detail.
 *
 *  - CONS-UX-27  `missing[]` (erasers expected but never registered) renders on
 *                its own line under its own label — never inside the
 *                failed-systems sentence, which would claim a store ran and broke.
 *  - CONS-UX-28  `rowsTouched` renders.
 *  - CONS-UX-30  the receipt ANNOUNCES, politely, and the `foundNothing`
 *                variant's home-workspace instruction is part of what is spoken.
 *  - CONS-UX-29  the receipt's Retry keeps the receipt MOUNTED while the retry
 *                is in flight (busy), and hands focus back afterwards.
 *  - CONS-UX-5   Erase is busy while the fan-out runs, and a second click
 *                mid-flight does not re-open the confirm.
 *  - CONS-UX-32  the erase confirm demands the subject key be TYPED.
 *  - CONS-UX-33  a 409 `legal_hold` refusal is a durable state on the page that
 *                survives the policy re-read FAILING.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import type { SubjectErasureResult } from '../consentClient.js';
import { currentAnnouncements } from '../../../ui/announce.js';

let eraseResult: SubjectErasureResult;
const deleteSubject = vi.fn();
const getPolicy = vi.fn();
const confirmFn = vi.fn();
const toastError = vi.fn();

vi.mock('../consentClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  getPolicy: (...a: unknown[]) => getPolicy(...a),
  listRecords: vi.fn(async () => []),
  getSubject: vi.fn(async () => null),
  deleteSubject: (...a: unknown[]) => deleteSubject(...a),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: (m: string) => toastError(m), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: (opts: unknown) => confirmFn(opts) }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { ConsentPage } from '../ConsentPage.js';

async function mount(): Promise<HTMLInputElement> {
  render(<ConsentPage />);
  await act(async () => {});
  await waitFor(() => expect(screen.getByLabelText(/subject key/i)).toBeTruthy());
  return screen.getByLabelText(/subject key/i) as HTMLInputElement;
}
const type = (el: HTMLElement, v: string): void => { fireEvent.change(el, { target: { value: v } }); };
const click = (name: RegExp): void => { fireEvent.click(screen.getByRole('button', { name })); };
const erase = async (key: string): Promise<void> => { const input = await mount(); type(input, key); click(/^erase$/i); };

beforeEach(() => {
  eraseResult = { ok: true, consentRecord: true, erasure: { total: 4, failed: 0, keysResolved: 2 } };
  deleteSubject.mockReset();
  deleteSubject.mockImplementation(async () => eraseResult);
  getPolicy.mockReset();
  getPolicy.mockImplementation(async () => ({ policy: { tenantId: 't', regulatedRegions: [], defaultMode: 'opt-in' }, legalHold: null }));
  confirmFn.mockReset();
  confirmFn.mockImplementation(async () => true);
  toastError.mockClear();
});
afterEach(cleanup);

describe('CONS-UX-27 / CONS-UX-28 — missing erasers and rows touched', () => {
  it('renders missing[] under its own label, NOT inside the failed-systems sentence', async () => {
    eraseResult = { ok: false, consentRecord: true, erasure: { total: 5, failed: 1, keysResolved: 1, failedFeatures: ['eraseCrmSubject'], missing: ['eraseSalesMapSubject', 'eraseKickbotSubject'], rowsTouched: 3 } };
    await erase('subj-42');
    const missing = await screen.findByText(/expected but not registered on this host/i);
    // Its OWN element, carrying exactly the missing ones under the label.
    expect(missing.textContent).toBe('Expected but not registered on this host: eraseSalesMapSubject, eraseKickbotSubject.');
    // The failed-systems SENTENCE names ONLY the failed ones. (The fragment
    // shares its parent span with the rest of the receipt, so the sentence is
    // extracted from the text rather than matched as an element.)
    const receipt = missing.closest('.alert');
    const failedSentence = /Failed systems: ([^.]*)\./.exec(receipt?.textContent ?? '')?.[1] ?? '';
    expect(failedSentence).toBe('eraseCrmSubject');
    expect(receipt?.textContent).toMatch(/3 row\(s\) deleted or scrubbed/i);
  });

  it('renders missing[] on a CLEAN receipt too (nothing failed, but not everything ran)', async () => {
    eraseResult = { ok: true, consentRecord: true, erasure: { total: 4, failed: 0, keysResolved: 2, missing: ['eraseSalesMapSubject'] } };
    await erase('subj-42');
    await screen.findByText(/reported success/i);
    expect(screen.getByText(/expected but not registered on this host/i).textContent).toMatch(/eraseSalesMapSubject/);
    expect(screen.queryByText(/failed systems:/i)).toBeNull();
  });

  it('renders rowsTouched when the erasers reported it, and nothing when they did not', async () => {
    eraseResult = { ok: true, consentRecord: true, erasure: { total: 4, failed: 0, keysResolved: 2, rowsTouched: 7 } };
    await erase('subj-42');
    expect(await screen.findByText(/7 row\(s\) deleted or scrubbed/i)).toBeTruthy();
    cleanup();

    eraseResult = { ok: true, consentRecord: true, erasure: { total: 4, failed: 0, keysResolved: 2 } };
    await erase('subj-43');
    await screen.findByText(/reported success/i);
    expect(screen.queryByText(/row\(s\) deleted or scrubbed/i)).toBeNull();
  });
});

describe('CONS-UX-30 — the receipt announces', () => {
  it('a clean receipt is spoken politely, and says the subject is now blocked until re-admitted', async () => {
    await erase('subj-42');
    await screen.findByText(/reported success/i);
    const { polite, assertive } = currentAnnouncements();
    expect(polite).toMatch(/erasure completed for "subj-42"/i);
    expect(polite).toMatch(/blocked until an administrator re-admits them/i);
    expect(assertive).not.toMatch(/subj-42/);
  });

  it('the foundNothing variant speaks the home-workspace instruction', async () => {
    eraseResult = { ok: true, consentRecord: false, erasure: { total: 4, failed: 0, keysResolved: 1, foundNothing: true, rowsTouched: 0 } };
    await erase('subj-42');
    await screen.findByText(/found NOTHING to erase/i);
    expect(currentAnnouncements().polite).toMatch(/home workspace/i);
    expect(currentAnnouncements().polite).toMatch(/run the erasure there too/i);
  });

  it('CONS-UX-23 — the confirm says erasure also blocks sends and re-subscription until re-admitted', async () => {
    await erase('subj-42');
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    const opts = confirmFn.mock.calls[0]![0] as { body?: unknown; typeToConfirm?: string };
    expect(String(opts.body)).toMatch(/blocks marketing sends and every public re-subscription/i);
    expect(String(opts.body)).toMatch(/until an administrator re-admits them/i);
    // CONS-UX-32 — and it demands the key be typed.
    expect(opts.typeToConfirm).toBe('subj-42');
  });
});

describe('CONS-UX-29 / CONS-UX-5 — busy states, and the receipt outlives its own retry', () => {
  it('Erase is busy while the fan-out runs; a second click does not re-open the confirm', async () => {
    let resolve!: (r: SubjectErasureResult) => void;
    deleteSubject.mockImplementation(() => new Promise<SubjectErasureResult>((r) => { resolve = r; }));
    await erase('subj-42');
    const eraseBtn = await screen.findByRole('button', { name: /^erase$/i });
    await waitFor(() => expect(eraseBtn.getAttribute('aria-busy')).toBe('true'));
    expect(confirmFn).toHaveBeenCalledTimes(1);
    fireEvent.click(eraseBtn);
    expect(confirmFn, 'a busy control must not re-open the confirm').toHaveBeenCalledTimes(1);
    await act(async () => { resolve(eraseResult); });
    await waitFor(() => expect(eraseBtn.getAttribute('aria-busy')).toBeNull());
  });

  it('Retry keeps the partial receipt MOUNTED (busy) until the new receipt replaces it, then returns focus', async () => {
    eraseResult = { ok: false, consentRecord: true, erasure: { total: 4, failed: 1, keysResolved: 1, failedFeatures: ['eraseCrmSubject'] } };
    await erase('subj-42');
    const retry = await screen.findByRole('button', { name: /retry erasure/i });

    let resolve!: (r: SubjectErasureResult) => void;
    deleteSubject.mockImplementation(() => new Promise<SubjectErasureResult>((r) => { resolve = r; }));
    retry.focus();
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(retry.getAttribute('aria-busy')).toBe('true'));

    // MID-FLIGHT: the evidence is still on screen — not blanked while we wait.
    expect(screen.getByText(/partial erasure of "subj-42"/i)).toBeTruthy();
    expect(screen.getByText(/failed systems:/i).textContent).toMatch(/eraseCrmSubject/);

    // The retry lands the SAME partial outcome (the CRM eraser is still down).
    await act(async () => { resolve({ ok: false, consentRecord: false, erasure: { total: 4, failed: 1, keysResolved: 1, failedFeatures: ['eraseCrmSubject'] } }); });
    const retryAfter = await screen.findByRole('button', { name: /retry erasure/i });
    await waitFor(() => expect(retryAfter.getAttribute('aria-busy')).toBeNull());
    // Focus is back on the control the operator was using.
    await waitFor(() => expect(document.activeElement).toBe(retryAfter));
    // …and the replacement receipt was spoken even though its text is identical.
    expect(currentAnnouncements().polite).toMatch(/partial erasure of "subj-42"/i);
  });
});

describe('CONS-UX-33 — a legal-hold refusal is a durable state', () => {
  it('a 409 legal_hold renders a refused Notice that survives the policy re-read failing', async () => {
    const { ConsentApiError } = await import('../consentClient.js');
    // First policy read succeeds (no hold known); the re-read after the refusal FAILS.
    getPolicy
      .mockImplementationOnce(async () => ({ policy: { tenantId: 't', regulatedRegions: [], defaultMode: 'opt-in' }, legalHold: null }))
      .mockImplementation(async () => { throw new Error('policy read down'); });
    deleteSubject.mockRejectedValueOnce(new ConsentApiError(409, 'legal_hold', 'held', { held: true }));

    await erase('subj-42');
    const refused = await screen.findByText(/erasure refused/i);
    const notice = refused.closest('.alert');
    expect(notice?.textContent).toMatch(/subj-42/);
    expect(notice?.textContent).toMatch(/nothing was deleted/i);
    expect(notice?.textContent).toMatch(/superadmin must lift the hold/i);
    // The policy re-read ran and FAILED — so the policy-borne hold Notice
    // (the pre-fix page's only durable signal) never appears — and the
    // refusal is STILL here.
    await waitFor(() => expect(getPolicy).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByText('This workspace is under legal hold')).toBeNull();
    expect(screen.getByText(/erasure refused/i)).toBeTruthy();
    // Announced (assertively — a failed action), by the Notice, not a toast.
    expect(currentAnnouncements().assertive).toMatch(/under legal hold/i);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('a later successful erasure for the org clears the refusal', async () => {
    const { ConsentApiError } = await import('../consentClient.js');
    deleteSubject.mockRejectedValueOnce(new ConsentApiError(409, 'legal_hold', 'held', {}));
    const input = await mount();
    type(input, 'subj-42');
    click(/^erase$/i);
    await screen.findByText(/erasure refused/i);

    type(input, 'subj-42');
    click(/^erase$/i);
    await screen.findByText(/reported success/i);
    expect(screen.queryByText(/erasure refused/i)).toBeNull();
  });
});
