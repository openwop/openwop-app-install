/**
 * CONS-UX-1 — the retry the partial-erasure receipt prescribes had no affordance.
 * CONS-UX-3 — the lookup result was never labelled, never invalidated, and a
 *             failed read rendered as "no consent record".
 *
 * CONS-UX-1. `doErase` ran `setLookup(null); setLookupKey(''); load(orgId);`
 * INSIDE the `try`, before the `failed > 0` branch. So on a PARTIAL erasure the
 * subject-key field was empty, `disabled={!lookupKey.trim()}` disabled both Look
 * up and Erase, and the receipt said "Erasure is idempotent — run it again". The
 * only way to obey was to re-read the key out of the receipt sentence and retype
 * it. A gate with no exit, on the one irreversible action.
 *
 * CONS-UX-3. `setLookup` was called only on success and reset only by `load()`
 * or a completed erase, while the input's `onChange` moved the key alone. Three
 * reachable failures: (a) look up alice, type bob — alice's state stands,
 * unlabelled, under bob's key; (b) look up alice (no record), then look up bob
 * and have the read FAIL — "No consent record for that subject" persists as a
 * confident claim about bob after a transient toast; (c) the stale panel sits
 * above an Erase button enabled by the KEY FIELD, not by the lookup.
 *
 * Every case below is sabotage-probed — see the commit message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import type { ConsentRecord, SubjectErasureResult } from '../consentClient.js';

let eraseResult: SubjectErasureResult;
let subjectResult: { record: ConsentRecord | null } | Error;
const deleteSubject = vi.fn();
const getSubject = vi.fn();
const listRecords = vi.fn();

vi.mock('../consentClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
  getPolicy: vi.fn(async () => ({ policy: { tenantId: 't', regulatedRegions: [], defaultMode: 'opt-in' }, legalHold: null })),
  listRecords: (...a: unknown[]) => listRecords(...a),
  getSubject: (...a: unknown[]) => getSubject(...a),
  deleteSubject: (...a: unknown[]) => deleteSubject(...a),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));
let regimeEnabled = true;
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => ({ enabled: regimeEnabled, locked: false, loading: false, status: (regimeEnabled ? 'on' : 'off') as 'on' | 'off', isBeta: false, variant: null, entitled: true, resolutionFailed: false }),
}));

import { ConsentPage } from '../ConsentPage.js';

const rec = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
  subjectKey: 'x', categories: { necessary: true, analytics: true, marketing: false },
  ts: '2026-08-01T00:00:00.000Z', source: 'public', ...over,
} as ConsentRecord);

async function mount(): Promise<HTMLInputElement> {
  render(<ConsentPage />);
  await act(async () => {});
  await waitFor(() => expect(screen.getByLabelText(/subject key/i)).toBeTruthy());
  return screen.getByLabelText(/subject key/i) as HTMLInputElement;
}
const type = (input: HTMLInputElement, v: string): void => { fireEvent.change(input, { target: { value: v } }); };
const click = (name: RegExp): void => { fireEvent.click(screen.getByRole('button', { name })); };

beforeEach(() => {
  regimeEnabled = true;
  eraseResult = { ok: true, consentRecord: true, erasure: { total: 4, failed: 0, keysResolved: 2 } };
  subjectResult = { record: null };
  deleteSubject.mockImplementation(async () => eraseResult);
  listRecords.mockImplementation(async () => []);
  getSubject.mockImplementation(async () => {
    if (subjectResult instanceof Error) throw subjectResult;
    return subjectResult.record;
  });
});
afterEach(cleanup);

describe('CONS-UX-1 — the prescribed retry has an affordance', () => {
  it('a PARTIAL erasure keeps the subject key, so Erase stays usable', async () => {
    eraseResult = { ok: false, consentRecord: true, erasure: { total: 4, failed: 2, keysResolved: 2, failedFeatures: ['eraseCrmSubject'] } } as SubjectErasureResult;
    const input = await mount();
    type(input, 'subj-42');
    click(/^erase$/i);
    await waitFor(() => expect(screen.getByText(/subj-42/)).toBeTruthy());

    // The field is NOT wiped, so the control the receipt tells you to use works.
    expect(input.value).toBe('subj-42');
    expect((screen.getByRole('button', { name: /^erase$/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('the partial receipt renders a Retry-erasure control bound to its own subject key', async () => {
    eraseResult = { ok: false, consentRecord: true, erasure: { total: 4, failed: 1, keysResolved: 1, failedFeatures: ['eraseCrmSubject'] } } as SubjectErasureResult;
    const input = await mount();
    type(input, 'subj-42');
    click(/^erase$/i);
    await waitFor(() => expect(screen.getByRole('button', { name: /retry erasure/i })).toBeTruthy());

    // Bound to the RECEIPT's key, not the field — so it still targets the right
    // person after the operator has typed something else.
    type(input, 'someone-else');
    deleteSubject.mockClear();
    click(/retry erasure/i);
    await waitFor(() => expect(deleteSubject).toHaveBeenCalled());
    expect(deleteSubject.mock.calls[0]![1]).toBe('subj-42');
  });

  it('a CLEAN erasure still clears the field (the old behaviour, where it was right)', async () => {
    const input = await mount();
    type(input, 'subj-ok');
    click(/^erase$/i);
    await waitFor(() => expect(screen.getByText(/subj-ok/)).toBeTruthy());
    expect(input.value).toBe('');
    expect(screen.queryByRole('button', { name: /retry erasure/i })).toBeNull();
  });

  it('clicking the RECORDS-LIST Retry no longer destroys the erasure receipt', async () => {
    // `load()` opened with `setReceipt(null)` and BOTH retry buttons call it, so
    // retrying an unrelated read wiped the Art. 5(2) evidence.
    //
    // NOTE ON WHAT THIS HAD TO BECOME. The first version of this case only
    // re-ran the ERASE handler's own `load()` and asserted the receipt survived
    // — and it passed even with `setReceipt(null)` put back, because that call
    // is followed synchronously by `setReceipt(...)` in the same handler, so
    // React batches and the last write wins. The sabotage probe came back green,
    // which is a finding about the TEST. It now drives the real records-list
    // Retry, which is the caller that actually reaches `load()` on its own.
    eraseResult = { ok: false, consentRecord: true, erasure: { total: 4, failed: 1, keysResolved: 1, failedFeatures: ['x'] } } as SubjectErasureResult;
    listRecords.mockRejectedValue(new Error('records read down'));
    const input = await mount();
    type(input, 'subj-42');
    click(/^erase$/i);
    await waitFor(() => expect(screen.getByText(/subj-42/)).toBeTruthy());

    // The records read failed, so its designed failure state offers a Retry.
    const retry = await screen.findByRole('button', { name: /^retry$/i });
    fireEvent.click(retry);
    await act(async () => {});

    // The receipt — the one thing an operator may later have to show a regulator
    // — must still be on screen.
    expect(screen.getByText(/subj-42/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry erasure/i })).toBeTruthy();
  });
});

describe('CONS-UX-3 — the lookup result is labelled, invalidated, and honest on failure', () => {
  it('names the subject it describes', async () => {
    subjectResult = { record: rec({ subjectKey: 'alice' }) };
    const input = await mount();
    type(input, 'alice');
    click(/look up/i);
    await waitFor(() => expect(screen.getByText(/consent for/i)).toBeTruthy());
    expect(screen.getByText(/alice/)).toBeTruthy();
  });

  it('editing the key INVALIDATES the previous result (no misattribution)', async () => {
    subjectResult = { record: rec({ subjectKey: 'alice' }) };
    const input = await mount();
    type(input, 'alice');
    click(/look up/i);
    await waitFor(() => expect(screen.getByText(/consent for/i)).toBeTruthy());

    type(input, 'bob');
    // alice's panel must be GONE — not relabelled, not left standing.
    expect(screen.queryByText(/consent for/i)).toBeNull();
  });

  it('a FAILED read renders its own state, never "no consent record"', async () => {
    subjectResult = new Error('network down');
    const input = await mount();
    type(input, 'bob');
    click(/look up/i);
    await waitFor(() => expect(screen.getByText(/could not read/i)).toBeTruthy());

    // The false-empty must not appear: "nothing is known" is a different fact
    // from "there is no consent record", and only one of them is true here.
    expect(screen.queryByText(/no consent record for that subject/i)).toBeNull();
    expect(screen.getByText(/bob/)).toBeTruthy();
    // …and it offers the exit.
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('a genuine "no record" still says so, labelled with the subject', async () => {
    subjectResult = { record: null };
    const input = await mount();
    type(input, 'nobody');
    click(/look up/i);
    await waitFor(() => expect(screen.getByText(/no consent record for that subject/i)).toBeTruthy());
    expect(screen.getByText(/nobody/)).toBeTruthy();
    expect(screen.queryByText(/could not read/i)).toBeNull();
  });
});

describe('CONS-5 — the DSAR console survives the `consent` toggle being off', () => {
  it('with the regime OFF the data-subject panel is still usable; the regime sections are not', async () => {
    // The page used to return the locked StateCard for the WHOLE page, so with
    // `consent` off — its DEFAULT — the only DSAR erasure surface the product
    // ships was unreachable, and ungating the backend routes alone would have
    // left the obligation reachable only by curl.
    regimeEnabled = false;
    const input = await mount();

    // The obligation: look up + erase.
    expect(input).toBeTruthy();
    expect(screen.getByRole('button', { name: /look up/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^erase$/i })).toBeTruthy();

    // The product the toggle buys: the policy editor and the records list.
    expect(screen.getByText(/consent is not enabled/i)).toBeTruthy();
    expect(screen.queryByLabelText(/default mode/i, { selector: 'select' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /consent records/i })).toBeNull();
  });

  it('with the regime ON, the policy editor and records list are back', async () => {
    await mount();
    expect(screen.queryByText(/consent is not enabled/i)).toBeNull();
    await waitFor(() => expect(screen.getByLabelText(/default mode/i, { selector: 'select' })).toBeTruthy());
    expect(screen.getByRole('heading', { name: /consent records/i })).toBeTruthy();
  });
});
