/**
 * CONS-4 / CONS-UX-2 — what the operator is told about a LEGAL HOLD, and what
 * the confirm and the receipt claim about the erasure's reach.
 *
 * Two findings, one surface:
 *
 *  - a hold did not gate erasure at all, and there was no human surface for one
 *    anywhere in the product. The operator could erase a subject under
 *    litigation hold with no warning. Now the console reads the hold with the
 *    policy, states it as a blocking `Notice` with the exit named (a
 *    superadmin lifts it), and disables the irreversible control;
 *  - the confirm promised "every registered feature store" was deleted, and the
 *    success receipt said "all N feature store(s) reported success", while the
 *    shipped semantics are delete-OR-anonymize-in-place with legally-retained
 *    financial records surviving (`host/subjectErasureRedaction.ts`,
 *    `test/priv1-order-erasure.test.ts`). Nothing named what is KEPT.
 *
 * NON-VACUITY: each case is sabotage-probed — see the commit message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import type { LegalHold } from '../consentClient.js';

let legalHold: LegalHold | null = null;
const toastError = vi.fn();
const confirmFn = vi.fn(async () => true);
let confirmBody: unknown = null;

vi.mock('../consentClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  getPolicy: vi.fn(async () => ({ policy: { tenantId: 't', regulatedRegions: [], defaultMode: 'opt-in' }, legalHold })),
  listRecords: vi.fn(async () => []),
  getSubject: vi.fn(async () => null),
  deleteSubject: vi.fn(async () => ({ ok: true, consentRecord: true, erasure: { total: 4, failed: 0, keysResolved: 2 } })),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: (m: string) => toastError(m), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../../ui/confirm.js', () => ({
  confirm: (opts: { body?: unknown }) => { confirmBody = opts.body; return confirmFn(); },
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: true, locked: false, loading: false, status: 'on' as const, isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { ConsentPage } from '../ConsentPage.js';

async function mount(): Promise<void> {
  render(<ConsentPage />);
  await act(async () => {});
  await waitFor(() => expect(screen.getByLabelText(/subject key/i)).toBeTruthy());
}

beforeEach(() => {
  legalHold = null;
  toastError.mockClear();
  confirmFn.mockClear();
  confirmBody = null;
});
afterEach(cleanup);

describe('CONS-4 — legal hold on the DSAR console', () => {
  it('states the hold, names the exit, and DISABLES the irreversible control', async () => {
    legalHold = { reason: 'litigation: Acme v. Foo', since: '2026-08-01T00:00:00.000Z' };
    await mount();

    expect(await screen.findByText(/under legal hold/i)).toBeTruthy();
    // The REASON must reach the operator — "blocked" without why is not a
    // statement they can act on.
    expect(screen.getByText(/Acme v\. Foo/)).toBeTruthy();
    // …and the exit is named. A gate with no exit is a defect.
    expect(screen.getByText(/superadmin must lift the hold/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/subject key/i), { target: { value: 'subj-42' } });
    const erase = screen.getByRole('button', { name: /erase/i });
    expect((erase as HTMLButtonElement).disabled, 'Erase must be disabled under a hold').toBe(true);
    // Look up is NOT blocked — a hold forbids deletion, not reading.
    expect((screen.getByRole('button', { name: /look up/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('with no hold, Erase is live and no hold notice is rendered', async () => {
    await mount();
    expect(screen.queryByText(/under legal hold/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/subject key/i), { target: { value: 'subj-42' } });
    expect((screen.getByRole('button', { name: /erase/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('CONS-UX-2 — the confirm and the receipt name what is KEPT', () => {
  it('the confirm distinguishes deleted / anonymized-in-place / legally retained', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText(/subject key/i), { target: { value: 'subj-42' } });
    fireEvent.click(screen.getByRole('button', { name: /erase/i }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());

    const body = String(confirmBody);
    // All three outcomes, because the operator repeats this claim to a regulator.
    expect(body, 'the DELETED class').toMatch(/deleted/i);
    expect(body, 'the ANONYMIZED-IN-PLACE class').toMatch(/anonymized in place/i);
    expect(body, 'the LEGALLY-RETAINED class').toMatch(/retained/i);
    expect(body, 'and it names a retained example the operator can recognise').toMatch(/orders|invoices/i);
    // The old copy's claim must be GONE — it is the false one.
    expect(body).not.toMatch(/every registered feature store holding data/i);
  });

  it('the success receipt does not claim everything was destroyed', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText(/subject key/i), { target: { value: 'subj-42' } });
    fireEvent.click(screen.getByRole('button', { name: /erase/i }));
    const receipt = await screen.findByText(/subj-42/);
    const text = receipt.textContent ?? '';
    expect(text).toMatch(/anonymized in place/i);
    expect(text).toMatch(/legally-retained/i);
  });
});

describe('CONS-UX-4 — the irreversible control is visually distinguishable', () => {
  it('Erase uses the design system\'s danger variant, not quiet+utility-class', async () => {
    await mount();
    fireEvent.change(screen.getByLabelText(/subject key/i), { target: { value: 'subj-42' } });
    const erase = screen.getByRole('button', { name: /erase/i });
    // `variant="danger"` compiles to `secondary u-text-danger` (ui/Button.tsx).
    // The broken combination was `btn-ghost u-text-danger`, where
    // `button.btn-ghost` (0,1,1) beats `.u-text-danger` (0,1,0) and the danger
    // colour is dead at rest AND on hover — global.css documents that exact
    // defect and pins it for `.secondary` only.
    expect(erase.className).toContain('u-text-danger');
    expect(erase.className, 'btn-ghost would kill the danger colour by specificity').not.toContain('btn-ghost');
    // The neighbouring non-destructive control must NOT look the same.
    expect(screen.getByRole('button', { name: /look up/i }).className).not.toContain('u-text-danger');
  });
});

/**
 * Review F10 — the mid-flight hold refusal must be recognised by CODE, not by
 * an English substring.
 *
 * `doErase`'s catch branched on `/legal hold/i.test(msg)`. Two defects in one
 * line, and the second is the fatal one:
 *
 *  - it is an English substring test in a 4-locale app (en / es / fr / pt-BR);
 *  - `deleteSubject` never parsed the response body, throwing the literal
 *    `` `deleteSubject returned ${res.status}` ``. So the pattern could NEVER
 *    match — in ANY locale, INCLUDING English. The hold branch was unreachable
 *    and the operator was shown a raw status string instead of the cause.
 *
 * The server has always sent `{ error: 'legal_hold', message, details }`; the
 * client discarded it. `ConsentApiError` carries the stable code through.
 */
describe('review F10 — a hold placed MID-FLIGHT is recognised by code, not English', () => {
  it('renders the localized hold message for a 409 legal_hold, whatever the message says', async () => {
    const { ConsentApiError } = await import('../consentClient.js');
    const client = await import('../consentClient.js');
    // A NON-English message body — the exact case the substring test could not
    // survive even if it had ever been reachable.
    vi.mocked(client.deleteSubject).mockRejectedValueOnce(
      new ConsentApiError(409, 'legal_hold', 'Conservation légale : effacement refusé.', { held: true, reason: 'litige' }),
    );
    await mount();
    fireEvent.change(screen.getByLabelText(/subject key/i), { target: { value: 'subj-42' } });
    fireEvent.click(screen.getByRole('button', { name: /erase/i }));

    // ADR 0657 D9 (CONS-UX-33) — the refusal is a DURABLE Notice on the page
    // now, not a toast: the i18n copy for the hold, not the server's raw
    // message, and it names the subject and the exit.
    const refused = await screen.findByText(/erasure refused/i);
    const notice = refused.closest('.alert');
    expect(notice?.textContent).toMatch(/under legal hold/i);
    expect(notice?.textContent).toMatch(/subj-42/);
    expect(notice?.textContent).not.toMatch(/Conservation légale/);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('THE REGRESSION: the pre-fix error shape would have fallen through', async () => {
    // A bare `Error('deleteSubject returned 409')` — what the client actually
    // threw before this fix — must NOT be reported as a hold. This pins that
    // the branch reads the CODE and has not merely been widened to catch
    // anything 409-ish, which would misreport an unrelated conflict as a hold.
    const client = await import('../consentClient.js');
    vi.mocked(client.deleteSubject).mockRejectedValueOnce(new Error('deleteSubject returned 409'));
    await mount();
    fireEvent.change(screen.getByLabelText(/subject key/i), { target: { value: 'subj-42' } });
    fireEvent.click(screen.getByRole('button', { name: /erase/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls.at(-1)?.[0]).not.toMatch(/under legal hold/i);
    expect(screen.queryByText(/erasure refused/i)).toBeNull();
  });

  it('a NON-hold failure still surfaces its own message', async () => {
    const { ConsentApiError } = await import('../consentClient.js');
    const client = await import('../consentClient.js');
    vi.mocked(client.deleteSubject).mockRejectedValueOnce(
      new ConsentApiError(500, 'internal', 'Storage unavailable.', {}),
    );
    await mount();
    fireEvent.change(screen.getByLabelText(/subject key/i), { target: { value: 'subj-42' } });
    fireEvent.click(screen.getByRole('button', { name: /erase/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls.at(-1)?.[0]).toBe('Storage unavailable.');
  });
});
