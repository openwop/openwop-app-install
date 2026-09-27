/**
 * CONS-G1 / CONS-G2 (docs/steward/UX_UPGRADE-consent.md) — what the operator is TOLD after a
 * GDPR erasure.
 *
 * The page used to call `toast.success('Subject data erased')` unconditionally,
 * so a fan-out in which N feature stores failed — and therefore still hold the
 * person's data — looked exactly like a clean erasure. These cases pin that a
 * partial erasure reads as a partial erasure, and that the outcome PERSISTS on
 * the page: a toast is not evidence, and this is the one action an operator may
 * later have to demonstrate they performed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import type { SubjectErasureResult } from '../consentClient.js';
import { currentAnnouncements } from '../../../ui/announce.js';

let eraseResult: SubjectErasureResult = { ok: true, consentRecord: true, erasure: { total: 4, failed: 0, keysResolved: 2 } };
const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastWarning = vi.fn();
let confirmBody: unknown = null;

vi.mock('../consentClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  getPolicy: vi.fn(async () => ({ policy: { tenantId: 't', regulatedRegions: ['EU'], defaultMode: 'opt-in' }, legalHold: null })),
  listRecords: vi.fn(async () => []),
  getSubject: vi.fn(async () => null),
  deleteSubject: vi.fn(async () => eraseResult),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m), warning: (m: string) => toastWarning(m), info: vi.fn() } }));
vi.mock('../../../ui/confirm.js', () => ({
  confirm: vi.fn(async (opts: { body?: unknown }) => { confirmBody = opts.body; return true; }),
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { ConsentPage } from '../ConsentPage.js';

async function erase(): Promise<void> {
  render(<ConsentPage />);
  // Flush the mount effects before dispatching — a change fired ahead of them
  // is DROPPED, not merely late.
  await act(async () => {});
  await waitFor(() => expect(screen.getByLabelText(/subject key/i)).toBeTruthy());
  fireEvent.change(screen.getByLabelText(/subject key/i), { target: { value: 'subj-42' } });
  fireEvent.click(screen.getByRole('button', { name: /erase/i }));
}

beforeEach(() => {
  eraseResult = { ok: true, consentRecord: true, erasure: { total: 4, failed: 0, keysResolved: 2 } };
  toastSuccess.mockClear(); toastError.mockClear(); toastWarning.mockClear(); confirmBody = null;
});
afterEach(cleanup);

/**
 * ADR 0657 D9 (CONS-UX-30) — the RECEIPT announces the outcome now; the three
 * outcome toasts that used to be the announcement are gone (toast + an
 * announced Notice speak through the same live region — the DS-8 double). So
 * these cases assert what is SPOKEN via the live-region seam, and that no
 * toast doubles it. The failure path (a thrown request) still toasts.
 */
describe('consent erasure — what the operator is told', () => {
  it('a clean erasure leaves a receipt naming the subject and the scope', async () => {
    await erase();
    // Persistent, not just a toast.
    const receipt = await screen.findByText(/subj-42/);
    expect(receipt).toBeTruthy();
    expect(screen.getByText(/all 4 feature store/i)).toBeTruthy();
    // Spoken once, by the receipt.
    expect(currentAnnouncements().polite).toMatch(/erasure completed for "subj-42"/i);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it('a PARTIAL erasure is reported as a partial erasure, not a success', async () => {
    eraseResult = { ok: false, consentRecord: true, erasure: { total: 4, failed: 2, keysResolved: 1 } };
    await erase();
    // And the receipt says what is still out there, in as many words.
    expect(await screen.findByText(/2 erasure step\(s\) failed/i)).toBeTruthy();
    expect(screen.getByText(/MAY still be held/i)).toBeTruthy();
    // The green success path must NOT fire — that was the whole defect. What
    // is spoken is the partial sentence, never the completed one.
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(currentAnnouncements().polite).toMatch(/partial erasure of "subj-42"/i);
    expect(currentAnnouncements().polite).not.toMatch(/erasure completed/i);
  });

  it('a partial erasure tells the operator what to do instead of leaving them stuck', async () => {
    eraseResult = { ok: false, consentRecord: false, erasure: { total: 4, failed: 1, keysResolved: 1 } };
    await erase();
    expect(await screen.findByText(/run it again/i)).toBeTruthy();
    expect(screen.getByText(/escalate before reporting the request complete/i)).toBeTruthy();
  });

  // HIGH-2 — `failed === 0` alone must not earn the green receipt. A zero-row
  // fan-out (`foundNothing`) either found a subject with no data here, or a
  // subject whose data lives in their HOME workspace — erasure is tenant-scoped
  // by design, so the receipt must say "nothing found here", never "erased".
  it('a ZERO-ROW fan-out is a distinct non-green state, not the green receipt', async () => {
    eraseResult = { ok: true, consentRecord: false, erasure: { total: 4, failed: 0, keysResolved: 1, foundNothing: true, rowsTouched: 0 } };
    await erase();
    expect(await screen.findByText(/found NOTHING to erase in this workspace/i)).toBeTruthy();
    expect(screen.getByText(/home workspace/i)).toBeTruthy();
    // The green path must NOT fire — that is the lie this branch removes.
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(currentAnnouncements().polite).toMatch(/found NOTHING to erase/i);
    expect(currentAnnouncements().polite).not.toMatch(/erasure completed/i);
    // And never the "all N feature store(s) reported success" sentence.
    expect(screen.queryByText(/reported success/i)).toBeNull();
  });

  it('a clean erasure with rows touched still reads green (the branch did not eat the receipt)', async () => {
    eraseResult = { ok: true, consentRecord: true, erasure: { total: 4, failed: 0, keysResolved: 2, foundNothing: false, rowsTouched: 7 } };
    await erase();
    expect(await screen.findByText(/reported success/i)).toBeTruthy();
    expect(toastWarning).not.toHaveBeenCalled();
    expect(currentAnnouncements().polite).toMatch(/erasure completed/i);
  });

  it('CONS-G2: the confirm discloses the cascade and that it cannot be undone', async () => {
    await erase();
    await screen.findByText(/subj-42/);
    const body = String(confirmBody ?? '');
    expect(body).toMatch(/linked identity keys/i);
    expect(body).toMatch(/cannot be undone/i);
  });
});
