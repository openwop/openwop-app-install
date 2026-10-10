/**
 * ADR 0850 — the operator side of the forms capture boundary:
 *  D3  a held row offers Release (before Discard); releasing replaces the row
 *      with the delivered one and moves the held count; an erased row says so;
 *  D5  a burst-held row names its reason;
 *  D2  a REQUIRED checkbox is not offered as the email opt-in, and a stored
 *      conflict is named with both fixes, which clear the save blocker;
 *  D7  conditional visibility is authorable: the controller list is the EARLIER
 *      fields, a checkbox controller offers only ticked / not ticked, and a
 *      condition that can never be met blocks the save by name.
 *
 * Sabotages that redden it (grade-tests wave 8): a mistargeted release, not
 * replacing the row, not moving the held count, the wrong toast, Discard before
 * Release, a Discard not disabled while a release is in flight, the erased /
 * contended reason split, the burst reason key, `createTicket` default or save,
 * the required-checkbox opt-in filter, the stored-conflict exemption, either
 * opt-in fix, the opt-in blocker, later fields offered as controllers, extra
 * checkbox operators, the clear path, effective-key controllers, FRM2CD-4
 * ownership, and each `whenProblem` verdict.
 *
 * HONEST CEILING: the in-flight case cannot witness the `rowBusy` guard inside
 * the action callbacks on its own — the buttons are also `disabled`, so React
 * never dispatches the click (probe w8g3-a5-busy-guard stays green). The
 * `disabled` half is the one this case pins.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { FormsRequestError, type FormDef, type Submission } from '../formsClient.js';
import { whenProblem } from '../FieldWhenEditor.js';

/**
 * The ONE typed formsClient double (grade-tests wave 8): the REAL module is
 * spread in — so `FormsRequestError`, `FIELD_TYPES` and the URL helpers are the
 * shipped ones, not hand-kept copies that had drifted (no `number` type, no
 * `reason` on the error) — and every network function is replaced by a
 * `vi.fn` typed against the real signature, so a fixture that contradicts the
 * client type is a compile error rather than a silent green.
 */
type FC = typeof import('../formsClient.js');
const client = vi.hoisted(() => ({
  listOrgs: vi.fn<FC['listOrgs']>(), listForms: vi.fn<FC['listForms']>(), getForm: vi.fn<FC['getForm']>(),
  createForm: vi.fn<FC['createForm']>(), updateForm: vi.fn<FC['updateForm']>(), deleteForm: vi.fn<FC['deleteForm']>(),
  setFormStatus: vi.fn<FC['setFormStatus']>(), listIntakeLists: vi.fn<FC['listIntakeLists']>(),
  listSubmissionsPage: vi.fn<FC['listSubmissionsPage']>(), listSubmissions: vi.fn<FC['listSubmissions']>(),
  deleteSubmission: vi.fn<FC['deleteSubmission']>(), releaseSubmission: vi.fn<FC['releaseSubmission']>(),
  listFormTemplates: vi.fn<FC['listFormTemplates']>(), createFormFromTemplate: vi.fn<FC['createFormFromTemplate']>(),
}));
vi.mock('../formsClient.js', async (orig) => ({ ...(await orig<FC>()), ...client }));
const ui = vi.hoisted(() => ({ confirm: vi.fn<(typeof import('../../../ui/confirm.js'))['confirm']>() }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../../../ui/confirm.js', () => ({ confirm: ui.confirm }));
vi.mock('../../../ui/toast.js', () => ({ toast: toasts }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { FormDetailPage } = await import('../FormDetailPage.js');

const form = (over: Partial<FormDef> = {}): FormDef => ({
  formId: 'f1', orgId: 'o1', title: 'Contact Us', status: 'draft',
  fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
  createToContact: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  ...over,
});
const sub = (over: Partial<Submission> = {}): Submission => ({ submissionId: 's1', formId: 'f1', values: { name: 'Ada' }, createdAt: '2026-01-03T00:00:00.000Z', ...over });

const renderDetail = () => render(
  <MemoryRouter initialEntries={['/forms/f1?org=o1']}>
    <Routes><Route path="/forms/:formId" element={<FormDetailPage />} /></Routes>
  </MemoryRouter>);

beforeEach(() => {
  vi.resetAllMocks();
  ui.confirm.mockResolvedValue(true);
  localStorage.clear();
  client.listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Personal workspace' }]);
  client.getForm.mockResolvedValue(form());
  client.listIntakeLists.mockResolvedValue([]);
  client.listSubmissionsPage.mockResolvedValue({ submissions: [], nextCursor: null, flaggedCount: 0, droppedCount: 0 });
});

describe('ADR 0850 D3/D5 — held rows', () => {
  it('Release delivers the row, replaces it in place, and moves the held count', async () => {
    client.listSubmissionsPage.mockResolvedValue({ submissions: [sub({ flagged: 'honeypot', values: { name: 'Real Person' } })], nextCursor: null, flaggedCount: 1, droppedCount: 0 });
    client.releaseSubmission.mockResolvedValue({ released: true, submission: sub({ values: { name: 'Real Person' }, contactId: 'crm:1', releasedAt: '2026-01-04T00:00:00.000Z' }) });
    renderDetail();
    const release = await screen.findByRole('button', { name: /^release$/i });
    const discard = screen.getByRole('button', { name: /^discard$/i });
    // The server's held count, before…
    expect(screen.getAllByText(/1 held for review/).length).toBeGreaterThan(0);
    // Recovery is offered first — it is the point of the quarantine.
    expect(release.compareDocumentPosition(discard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(release);
    await waitFor(() => expect(client.releaseSubmission).toHaveBeenCalledWith('o1', 'f1', 's1'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^release$/i })).toBeNull());
    expect(screen.getAllByText(/^Released$/).length).toBeGreaterThan(0);
    expect(toasts.success).toHaveBeenCalledWith(expect.stringMatching(/released and delivered/i));
    // …and after: 1 → 0 held, 0 dropped, so the abuse notice unmounts.
    await waitFor(() => expect(screen.queryAllByText(/held for review/)).toHaveLength(0));
  });

  it('a second click while a release is in flight sends nothing (FRM2UX-3)', async () => {
    client.listSubmissionsPage.mockResolvedValue({ submissions: [sub({ flagged: 'honeypot' })], nextCursor: null, flaggedCount: 1, droppedCount: 0 });
    let settle: (v: Awaited<ReturnType<FC['releaseSubmission']>>) => void = () => undefined;
    client.releaseSubmission.mockReturnValue(new Promise((r) => { settle = r; }));
    renderDetail();
    const release = await screen.findByRole('button', { name: /^release$/i });
    fireEvent.click(release);
    await waitFor(() => expect(client.releaseSubmission).toHaveBeenCalledTimes(1));
    await waitFor(() => expect((screen.getByRole('button', { name: /^discard$/i }) as HTMLButtonElement).disabled).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /^discard$/i }));
    fireEvent.click(release); // the literal second click (see the header ceiling)
    expect(client.deleteSubmission).not.toHaveBeenCalled();
    settle({ released: true, submission: sub({ releasedAt: '2026-01-04T00:00:00.000Z' }) });
    await waitFor(() => expect(screen.queryByRole('button', { name: /^release$/i })).toBeNull());
    expect(client.releaseSubmission).toHaveBeenCalledTimes(1);
  });

  it('an erased row is named as erased, not as a generic failure', async () => {
    client.listSubmissionsPage.mockResolvedValue({ submissions: [sub({ flagged: 'guard' })], nextCursor: null, flaggedCount: 1, droppedCount: 0 });
    client.releaseSubmission.mockRejectedValueOnce(new FormsRequestError('releaseSubmission', 409, 'erased', 'submission_erased'));
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: /^release$/i }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/erased on request/i)));
  });

  it('a 409 that is a contended row is NOT reported as an erasure (FRM2CD-5)', async () => {
    client.listSubmissionsPage.mockResolvedValue({ submissions: [sub({ flagged: 'guard' })], nextCursor: null, flaggedCount: 1, droppedCount: 0 });
    client.releaseSubmission.mockRejectedValueOnce(new FormsRequestError('releaseSubmission', 409, 'kept changing', 'contended'));
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: /^release$/i }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(toasts.error).not.toHaveBeenCalledWith(expect.stringMatching(/erased on request/i));
  });

  it('a burst-held row names its reason', async () => {
    client.listSubmissionsPage.mockResolvedValue({ submissions: [sub({ flagged: 'burst' })], nextCursor: null, flaggedCount: 1, droppedCount: 0 });
    renderDetail();
    const chip = await screen.findByText(/^Held$/, { selector: '.chip' });
    expect(chip.getAttribute('title')).toMatch(/burst/i);
  });
});

describe('ADR 0850 D1 — the support-ticket opt-in (user decision: per form, default off)', () => {
  it('starts unticked on a form without the flag, and saves `createTicket: true` once ticked', async () => {
    client.updateForm.mockResolvedValue(form({ createTicket: true }));
    renderDetail();
    const box = await screen.findByRole('checkbox', { name: /create a support ticket/i });
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(client.updateForm).toHaveBeenCalled());
    expect(client.updateForm.mock.calls[0]![2]).toMatchObject({ createTicket: true });
  });
});

describe('ADR 0850 D2 — consent is never a condition of submitting', () => {
  const fields: FormDef['fields'] = [
    { key: 'email', label: 'Email', type: 'email', required: true },
    { key: 'agree', label: 'I agree', type: 'checkbox', required: true },
    { key: 'news', label: 'News please', type: 'checkbox', required: false },
  ];

  it('a required checkbox is not offered as the opt-in', async () => {
    client.getForm.mockResolvedValue(form({ fields }));
    renderDetail();
    const picker = await screen.findByLabelText(/email opt-in field/i);
    const options = within(picker).getAllByRole('option').map((o) => o.textContent);
    expect(options.some((o) => /News please/.test(o ?? ''))).toBe(true);
    expect(options.some((o) => /I agree/.test(o ?? ''))).toBe(false);
  });

  it('a stored conflict is named with both fixes; making it optional clears it', async () => {
    client.getForm.mockResolvedValue(form({ fields, emailOptInField: 'agree' }));
    renderDetail();
    expect(await screen.findByText(/consent has to be optional/i)).toBeTruthy();
    // BOTH fixes are offered in place.
    expect(screen.getByRole('button', { name: /stop using it as the opt-in/i })).toBeTruthy();
    // The stored conflict alone does not block the save (FRM2-1): only a move INTO it does.
    expect(screen.queryByText(/fix these before saving:.*opt-in checkbox is required/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /make it optional/i }));
    await waitFor(() => expect(screen.queryByText(/consent has to be optional/i)).toBeNull());
  });

  it('designating a required checkbox is a named save blocker', async () => {
    client.getForm.mockResolvedValue(form({ fields, emailOptInField: 'news' }));
    renderDetail();
    const required = await screen.findAllByRole('checkbox', { name: /required/i });
    // The third field (`news`, the designated opt-in) made required.
    fireEvent.click(required[2]!);
    // The SAVE BLOCKER, not just the notice (whose copy also says "set as required").
    expect((await screen.findAllByText(/fix these before saving:.*opt-in checkbox is required/i)).length).toBeGreaterThan(0);
  });
});

describe('ADR 0850 D7 — conditional visibility is authorable', () => {
  it('offers only EARLIER fields, and a checkbox controller only ticked / not ticked', async () => {
    client.getForm.mockResolvedValue(form({ fields: [
      { key: 'agree', label: 'Agree', type: 'checkbox', required: false },
      { key: 'details', label: 'Details', type: 'text', required: false },
      { key: 'later', label: 'Later', type: 'text', required: false },
    ] }));
    renderDetail();
    const controller = await screen.findByLabelText(/show this field .*Details/i);
    // Judged AFTER load (it used to run before the page rendered anything, so it
    // could not fail): the first field has nothing earlier, so no editor…
    expect(screen.queryByLabelText(/show this field .*Agree/i)).toBeNull();
    // …and Details offers "always" plus the EARLIER field only — never `later`.
    expect(within(controller).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['', 'agree']);
    fireEvent.change(controller, { target: { value: 'agree' } });
    const op = await screen.findByLabelText(/rule for showing .Details/i);
    const ops = within(op).getAllByRole('option').map((o) => o.textContent);
    expect(ops).toEqual(['is ticked', 'is not ticked']);
    expect(screen.queryByLabelText(/value that shows .Details/i)).toBeNull();
  });

  it('a stored condition with nothing earlier keeps a clearable control (FRM2UX-1)', async () => {
    client.getForm.mockResolvedValue(form({ fields: [
      { key: 'details', label: 'Details', type: 'text', required: false, when: { type: 'truthy', left: 'fields.gone' } },
    ] }));
    renderDetail();
    const controller = await screen.findByLabelText(/show this field .*Details/i);
    expect((await screen.findAllByText(/depends on a field that is missing/i)).length).toBeGreaterThan(0);
    fireEvent.change(controller, { target: { value: '' } });
    await waitFor(() => expect(screen.queryByText(/depends on a field that is missing/i)).toBeNull());
  });

  it('an auto-keyed earlier field is still a controller, under the key it will be saved with (FRM2UX-4)', async () => {
    client.getForm.mockResolvedValue(form({ fields: [
      { key: 'plan', label: 'Plan', type: 'text', required: false },
      { key: 'notes', label: 'Notes', type: 'text', required: false },
    ] }));
    renderDetail();
    // Clear the first field's key: it saves as slug("Plan") = "plan" either way.
    const keys = await screen.findAllByLabelText(/^field key/i);
    fireEvent.change(keys[0]!, { target: { value: '' } });
    const controller = await screen.findByLabelText(/show this field .*Notes/i);
    expect(within(controller).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toContain('plan');
  });

  it('typing through ANOTHER field\'s key does not retarget that field\'s dependents (FRM2CD-4)', async () => {
    client.getForm.mockResolvedValue(form({ fields: [
      { key: 'x', label: 'X', type: 'text', required: false },
      { key: 'email', label: 'Email', type: 'text', required: false },
      { key: 'notes', label: 'Notes', type: 'text', required: false, when: { type: 'truthy', left: 'fields.email' } },
    ] }));
    renderDetail();
    const keys = await screen.findAllByLabelText(/^field key/i);
    fireEvent.change(keys[0]!, { target: { value: 'email' } });
    fireEvent.change(keys[0]!, { target: { value: 'email2' } });
    const controller = await screen.findByLabelText(/show this field .*Notes/i);
    expect((controller as HTMLSelectElement).value).toBe('email');
  });

  it('whenProblem names a condition that can never be met, and spares one that works', () => {
    const base = [
      { key: 'kind', type: 'select' as const, options: ['a', 'b'] },
      { key: 'ok', type: 'checkbox' as const },
    ];
    expect(whenProblem([...base, { key: 'x', type: 'text', when: { type: 'equals', left: 'fields.kind', right: 'a' } }], 2)).toBeNull();
    expect(whenProblem([...base, { key: 'x', type: 'text', when: { type: 'equals', left: 'fields.kind', right: 'gone' } }], 2)).toBe('option');
    expect(whenProblem([...base, { key: 'x', type: 'text', when: { type: 'equals', left: 'fields.ok', right: 'yes' } }], 2)).toBe('operator');
    // A pack template's checkbox `equals true` matches the boolean a checkbox submits.
    expect(whenProblem([...base, { key: 'x', type: 'text', when: { type: 'equals', left: 'fields.ok', right: true } }], 2)).toBeNull();
    expect(whenProblem([{ key: 'x', type: 'text', when: { type: 'truthy', left: 'fields.later' } }, { key: 'later', type: 'text' }], 0)).toBe('controller');
  });
});
