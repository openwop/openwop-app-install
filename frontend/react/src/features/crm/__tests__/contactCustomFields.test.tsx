/**
 * CRM-UX-7 — the contact custom-field editor, both halves.
 *
 * Before this, `GET/POST /crm/fields` had zero frontend consumers and
 * `crmClient.ts` admitted the gap in a COMMENT: an AI agent could write a field
 * a human could neither define nor edit, and segments could filter on
 * `customFields.<key>` for keys no operator could create.
 *
 * The draft→wire conversion carries the real risk, so it is unit-tested apart
 * from the DOM: an empty box must be OMITTED (the server reads a missing key as
 * unset and `''` as a real empty value), and an unparseable number must be
 * omitted too rather than sent as NaN — which JSON-serializes to `null` and
 * would silently ERASE a stored value on a typo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { toDraft, toWire, missingRequired } from '../ContactCustomFields.js';
import type { ContactFieldDef } from '../crmClient.js';

const DEFS: ContactFieldDef[] = [
  { defId: 'f1', key: 'tier', label: 'Tier', type: 'enum', required: false, options: ['Bronze', 'Gold'], createdAt: '2026-01-01T00:00:00Z' },
  { defId: 'f2', key: 'seats', label: 'Seats', type: 'number', required: false, createdAt: '2026-01-01T00:00:00Z' },
  { defId: 'f3', key: 'vip', label: 'VIP', type: 'boolean', required: false, createdAt: '2026-01-01T00:00:00Z' },
  { defId: 'f4', key: 'owner_note', label: 'Owner note', type: 'string', required: true, createdAt: '2026-01-01T00:00:00Z' },
];

describe('CRM-UX-7 — draft ⇄ wire', () => {
  it('seeds a draft from stored values, and a boolean from its real unset (false)', () => {
    const draft = toDraft(DEFS, { tier: 'Gold', seats: 12, vip: true });
    expect(draft).toEqual({ tier: 'Gold', seats: '12', vip: 'true', owner_note: '' });
    expect(toDraft(DEFS).vip).toBe('false');
  });

  it('OMITS an empty box rather than sending an empty string', () => {
    const wire = toWire(DEFS, { tier: '', seats: '', vip: 'false', owner_note: 'hi' });
    expect(wire).toEqual({ vip: false, owner_note: 'hi' });
    expect('tier' in wire).toBe(false);
    expect('seats' in wire).toBe(false);
  });

  it('OMITS an unparseable number instead of sending NaN', () => {
    // LOW-1 — the reason is NOT "so a typo cannot erase a stored value": the
    // PATCH replaces `customFields` wholesale, so omission erases exactly as a
    // `null` would. It is that `NaN` serializes to `null`, which fails the
    // server's `isFieldMap` guard and makes it substitute `{}` — wiping EVERY
    // custom field on the contact rather than the one mistyped box.
    //
    // Note this DRAFT is not reachable through the rendered control: the input
    // is `<input type="number">`, whose `.value` is '' for unparseable text.
    // The unit is still worth pinning — `toWire` is exported and an agent- or
    // import-seeded draft is not typed through a number input.
    const wire = toWire(DEFS, { tier: 'Gold', seats: 'twelve', vip: 'false', owner_note: 'hi' });
    expect('seats' in wire).toBe(false);
    expect(wire.tier).toBe('Gold');
  });

  it('types the value the way the field declares, not the way the input stores it', () => {
    const wire = toWire(DEFS, { tier: 'Bronze', seats: '7', vip: 'true', owner_note: 'x' });
    expect(wire).toEqual({ tier: 'Bronze', seats: 7, vip: true, owner_note: 'x' });
  });

  it('names the required fields that are still empty (the server would answer 400)', () => {
    expect(missingRequired(DEFS, toDraft(DEFS)).map((d) => d.key)).toEqual(['owner_note']);
    expect(missingRequired(DEFS, { ...toDraft(DEFS), owner_note: 'done' })).toEqual([]);
  });
});

// ── The definitions page ────────────────────────────────────────────────────
const api = vi.hoisted(() => ({
  listContactFields: vi.fn(),
  createContactField: vi.fn(),
  deleteContactField: vi.fn(),
}));
vi.mock('../crmClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...api };
});

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: access.useFeatureAccess,
}));

import { ContactFieldsPage } from '../ContactFieldsPage.js';

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.listContactFields.mockResolvedValue(DEFS);
});
afterEach(cleanup);

function viewFields(): void {
  render(
    <MemoryRouter initialEntries={['/crm/fields']}>
      <Routes><Route path="/crm/fields" element={<ContactFieldsPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('CRM-UX-7 — the definitions page', () => {
  it('lists each field with its type as a LABELED chip, and marks the required one', async () => {
    viewFields();
    expect(await screen.findByText('Tier')).toBeTruthy();
    // Scoped to the TABLE: 'Choice' is also an <option> in the create form's
    // type picker, and an unscoped match would pass on that alone.
    const table = screen.getByRole('table');
    expect(within(table).getByText('Choice')).toBeTruthy();
    expect(within(table).getByText('Yes / no')).toBeTruthy();
    expect(within(table).getByText('Required')).toBeTruthy();
    expect(within(table).getByText('Bronze, Gold')).toBeTruthy();
  });

  it('a failed read is the announced card + Retry, never "no custom fields yet"', async () => {
    api.listContactFields.mockRejectedValue(new Error('fields_500'));
    viewFields();
    expect(await screen.findByText('Could not load this')).toBeTruthy();
    // Claiming "none" here would invite an operator to re-create a field that
    // already exists and collect a duplicate-key 409 for it.
    expect(screen.queryByText('No custom fields yet')).toBeNull();
    const before = api.listContactFields.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.listContactFields.mock.calls.length).toBeGreaterThan(before));
  });

  it('HIGH-1 — DURING the retry it shows the loading state, never "No custom fields yet"', async () => {
    // The defect this file's own docblock argues against, reintroduced by the
    // Retry it added: `load()` cleared `failed` synchronously while the `[]`
    // written by the failed read stayed in state, so for the whole retry
    // request the page said "No custom fields yet" — with the create form
    // live beside it, inviting exactly the duplicate-key 409 the docblock
    // warns about. `await waitFor(calls > before)` above cannot see this
    // window; a promise the TEST settles can.
    let resolveRead!: (v: ContactFieldDef[]) => void;
    api.listContactFields.mockRejectedValueOnce(new Error('fields_500'));
    viewFields();
    await screen.findByText('Could not load this');

    api.listContactFields.mockReturnValueOnce(new Promise<ContactFieldDef[]>((res) => { resolveRead = res; }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(api.listContactFields.mock.calls.length).toBe(2));
    expect(screen.queryByText('No custom fields yet')).toBeNull();
    expect(screen.queryByText('Could not load this')).toBeNull();

    resolveRead(DEFS);
    expect(await screen.findByText('Tier')).toBeTruthy();
  });

  it('a TRUTHFUL empty still shows the empty card', async () => {
    api.listContactFields.mockResolvedValue([]);
    viewFields();
    expect(await screen.findByText('No custom fields yet')).toBeTruthy();
    expect(screen.queryByText('Could not load this')).toBeNull();
  });

  it('creates a plain field', async () => {
    viewFields();
    await screen.findByText('Tier');
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Renewal date' } });
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'renewal_date' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'date' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    await waitFor(() => expect(api.createContactField).toHaveBeenCalledWith({
      key: 'renewal_date', label: 'Renewal date', type: 'date', required: false,
    }));
  });

  it('refuses a CHOICE field with no options — a control with nothing to pick', async () => {
    viewFields();
    await screen.findByText('Tier');
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Plan' } });
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'plan' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'enum' } });
    expect(await screen.findByText(/needs at least one option/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add field' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Options'), { target: { value: 'Free, Pro' } });
    expect((screen.getByRole('button', { name: 'Add field' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    await waitFor(() => expect(api.createContactField).toHaveBeenCalledWith({
      key: 'plan', label: 'Plan', type: 'enum', required: false, options: ['Free', 'Pro'],
    }));
  });

  it('a REFERENCE field carries the entity it points at', async () => {
    viewFields();
    await screen.findByText('Tier');
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Parent' } });
    fireEvent.change(screen.getByLabelText('Key'), { target: { value: 'parent' } });
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'reference' } });
    fireEvent.change(screen.getByLabelText('Refers to'), { target: { value: 'deal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }));
    await waitFor(() => expect(api.createContactField).toHaveBeenCalledWith({
      key: 'parent', label: 'Parent', type: 'reference', required: false, refEntityType: 'deal',
    }));
  });

  it('a delete is confirmed, and the confirm names what stops matching', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    viewFields();
    fireEvent.click(await screen.findByLabelText('Delete the Tier field'));
    await waitFor(() => expect(api.deleteContactField).toHaveBeenCalledWith('f1'));
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('a declined confirm deletes nothing', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    viewFields();
    fireEvent.click(await screen.findByLabelText('Delete the Tier field'));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(api.deleteContactField).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
