/**
 * ADR 0657 D7 — CONS-UX-24 / CONS-UX-26: the audited door back for an erased
 * subject.
 *
 * Erasure tombstones every resolved key and the tombstone out-ranks every
 * public re-subscribe path, so a person who asked to be forgotten and later
 * asks to return had NO route back — not through a form, not through the
 * preference page, not through the console. This pins the console's control:
 * where it appears (a completed erasure; a lookup that found no record — the
 * wire cannot distinguish "never seen" from "tombstoned"), what it demands (a
 * ≥ 20-char attestation AND the typed subject key), what it sends, and how each
 * of the three answers is rendered: re-admitted (durable, announced),
 * `not_erased` (information, never an error), refused (inside the dialog).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import type { ReadmitResult, SubjectErasureResult } from '../consentClient.js';
import { currentAnnouncements } from '../../../ui/announce.js';

let eraseResult: SubjectErasureResult;
let readmitAnswer: ReadmitResult | Error;
const readmitSubject = vi.fn();
const getSubject = vi.fn();
const toastInfo = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('../consentClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  getPolicy: vi.fn(async () => ({ policy: { tenantId: 't', regulatedRegions: [], defaultMode: 'opt-in' }, legalHold: null })),
  listRecords: vi.fn(async () => []),
  getSubject: (...a: unknown[]) => getSubject(...a),
  deleteSubject: vi.fn(async () => eraseResult),
  readmitSubject: (...a: unknown[]) => readmitSubject(...a),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m), info: (m: string) => toastInfo(m), warning: vi.fn() } }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));
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

const ATTESTATION = 'Asked by email on 11 Sep to receive the newsletter again; ticket 4821.';

/** Open the dialog from the "no record" lookup path. */
async function openFromLookup(key = 'erased-1'): Promise<void> {
  const input = await mount();
  type(input, key);
  click(/look up/i);
  await screen.findByText(/no consent record for that subject/i);
  click(/re-admit subject/i);
  await screen.findByRole('dialog');
}

/** Fill both gates and submit. */
function fillAndSubmit(key = 'erased-1', attestation = ATTESTATION): void {
  type(screen.getByLabelText(/your statement that this person asked to return/i), attestation);
  type(screen.getByLabelText(new RegExp(`type ${key} to confirm`, 'i')), key);
  click(/^re-admit$/i);
}

beforeEach(() => {
  eraseResult = { ok: true, consentRecord: true, erasure: { total: 4, failed: 0, keysResolved: 2 } };
  readmitAnswer = { readmitted: true, subjectKey: 'erased-1' };
  getSubject.mockImplementation(async () => null);
  readmitSubject.mockReset();
  readmitSubject.mockImplementation(async () => { if (readmitAnswer instanceof Error) throw readmitAnswer; return readmitAnswer; });
  toastInfo.mockClear(); toastSuccess.mockClear(); toastError.mockClear();
});
afterEach(cleanup);

describe('where the door back is offered', () => {
  it('a lookup that found NO record offers Re-admit (the wire cannot tell tombstoned from never-seen)', async () => {
    const input = await mount();
    type(input, 'erased-1');
    click(/look up/i);
    await screen.findByText(/no consent record for that subject/i);
    expect(screen.getByRole('button', { name: /re-admit subject/i })).toBeTruthy();
    // …and the hint says what it does NOT do.
    expect(screen.getByText(/no consent is granted until they opt in again/i)).toBeTruthy();
  });

  it('a completed erasure receipt offers Re-admit — including the zero-row one (the tombstone is written either way)', async () => {
    eraseResult = { ok: true, consentRecord: false, erasure: { total: 4, failed: 0, keysResolved: 1, foundNothing: true, rowsTouched: 0 } };
    const input = await mount();
    type(input, 'erased-2');
    click(/^erase$/i);
    await screen.findByText(/found NOTHING to erase/i);
    expect(screen.getByRole('button', { name: /re-admit subject/i })).toBeTruthy();
  });

  it('a PARTIAL erasure does not offer Re-admit — the operator\'s job is to finish the erasure', async () => {
    eraseResult = { ok: false, consentRecord: true, erasure: { total: 4, failed: 1, keysResolved: 1, failedFeatures: ['x'] } };
    const input = await mount();
    type(input, 'erased-3');
    click(/^erase$/i);
    await screen.findByRole('button', { name: /retry erasure/i });
    expect(screen.queryByRole('button', { name: /re-admit subject/i })).toBeNull();
  });

  it('a lookup that FOUND a record offers no Re-admit (a live record is not a tombstone)', async () => {
    getSubject.mockImplementation(async () => ({ subjectKey: 'alive', categories: { necessary: true, analytics: true, marketing: false }, ts: '2026-08-01T00:00:00.000Z' }));
    const input = await mount();
    type(input, 'alive');
    click(/look up/i);
    await screen.findByText(/consent for/i);
    expect(screen.queryByRole('button', { name: /re-admit subject/i })).toBeNull();
  });
});

describe('the dialog demands an attestation AND the typed key', () => {
  it('stays disarmed until the statement is ≥ 20 chars and the key is typed; then calls the route with both', async () => {
    await openFromLookup();
    const submit = screen.getByRole('button', { name: /^re-admit$/i }) as HTMLButtonElement;
    expect(submit.disabled, 'disarmed at open').toBe(true);

    // A long statement alone is not enough.
    type(screen.getByLabelText(/your statement that this person asked to return/i), ATTESTATION);
    expect(submit.disabled, 'statement without the typed key').toBe(true);

    // The typed key with a SHORT statement is not enough either.
    type(screen.getByLabelText(/your statement that this person asked to return/i), 'too short');
    type(screen.getByLabelText(/type erased-1 to confirm/i), 'erased-1');
    expect(submit.disabled, 'typed key with a 9-char statement').toBe(true);
    expect(screen.getByText(/9 of at least 20 characters/i)).toBeTruthy();

    type(screen.getByLabelText(/your statement that this person asked to return/i), ATTESTATION);
    expect(submit.disabled, 'both gates met').toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(readmitSubject).toHaveBeenCalledTimes(1));
    expect(readmitSubject.mock.calls[0]).toEqual(['org-1', 'erased-1', ATTESTATION]);
  });

  it('the dialog says it grants nothing by itself and is audited', async () => {
    await openFromLookup();
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/grants nothing by itself/i);
    expect(dialog.textContent).toMatch(/audit log/i);
    expect(dialog.textContent).toMatch(/asked to return/i);
  });
});

describe('the three answers', () => {
  it('re-admitted: the dialog closes and a DURABLE, announced statement says no consent was granted', async () => {
    await openFromLookup();
    fillAndSubmit();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const done = await screen.findByText(/re-admitted .*erased-1/i);
    expect(done.textContent).toMatch(/no consent was granted/i);
    // Spoken, not just shown — the outcome of an action the operator took.
    expect(currentAnnouncements().polite).toMatch(/re-admitted/i);
    expect(currentAnnouncements().polite).toMatch(/no consent was granted/i);
    // No toast doubles it (same live region — DS-8).
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('not_erased: information, not an error — no alert role, no error toast', async () => {
    readmitAnswer = { readmitted: false, reason: 'not_erased' };
    await openFromLookup();
    fillAndSubmit();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const info = await screen.findByText(/is not erased on this host/i);
    expect(info.closest('[role="alert"]'), 'must not be an alert').toBeNull();
    expect(info.closest('.inline-state--failed'), 'must not wear the failed treatment').toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    // It IS spoken (the InlineState empty kind has no live region of its own).
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo.mock.calls[0]![0]).toMatch(/not erased/i);
  });

  it('403: the refusal renders INSIDE the dialog, which stays open with the statement intact', async () => {
    const { ConsentApiError } = await import('../consentClient.js');
    readmitAnswer = new ConsentApiError(403, 'forbidden', 'nope', {});
    await openFromLookup();
    fillAndSubmit();
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toMatch(/only a workspace administrator/i));
    // The attestation the operator wrote is NOT lost.
    expect((screen.getByLabelText(/your statement that this person asked to return/i) as HTMLTextAreaElement).value).toBe(ATTESTATION);
    expect(screen.queryByText(/re-admitted .*erased-1/i)).toBeNull();
  });

  it('400 validation_error names the floor; any other failure shows its message', async () => {
    const { ConsentApiError } = await import('../consentClient.js');
    readmitAnswer = new ConsentApiError(400, 'validation_error', 'attestation too short', {});
    await openFromLookup();
    fillAndSubmit();
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toMatch(/at least 20 characters/i));
    cleanup();

    readmitAnswer = new ConsentApiError(500, 'internal', 'Storage unavailable.', {});
    await openFromLookup();
    fillAndSubmit();
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toMatch(/Storage unavailable\./));
  });
});
