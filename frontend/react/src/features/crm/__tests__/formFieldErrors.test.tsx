/**
 * CRM-UX-15 — a validation failure on a core form ATTACHES to its field.
 *
 * Before: `DealsTab` / `DealDetailPage` / `ContactsTab` raised `toast.error`
 * and left the field unmarked — a screen-reader user heard "Amount must be a
 * number" with no way to find which control, and a sighted one had to map the
 * toast back to a box. `ui/Field` already wires `aria-invalid` +
 * `aria-describedby` → the message (`PipelinesPage` used it in this same
 * feature); these tests pin that the core forms do too, and that focus MOVES
 * to the failed field. No request goes out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ContactFieldDef } from '../crmClient.js';

const org = vi.hoisted(() => ({
  listCompanies: vi.fn(),
  listDeals: vi.fn(),
  listPipelines: vi.fn(),
  createDeal: vi.fn(),
  getDeal: vi.fn(),
  getCompany: vi.fn(),
  updateDeal: vi.fn(),
  listActivities: vi.fn(async () => []),
  listTasks: vi.fn(async () => []),
}));
vi.mock('../crmOrgClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...org };
});
const crm = vi.hoisted(() => ({
  listContacts: vi.fn(),
  listSegments: vi.fn(async () => []),
  listContactFields: vi.fn(),
  createContact: vi.fn(),
  updateContactFields: vi.fn(),
}));
vi.mock('../crmClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...crm };
});
vi.mock('../../../featureToggles/FeatureAccessContext.js', async () => {
  const { makeFeatureAccess } = await import('../../../featureToggles/__testing__/makeFeatureAccess.js');
  return {
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
  };
});
vi.mock('../../../orgs/orgMembers.js', () => ({
  loadOrgMembers: vi.fn(async () => []),
  invalidateOrgMembers: vi.fn(),
}));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../../ui/toast.js', async (orig) => {
  const actual = await orig<{ toast: Record<string, unknown> }>();
  return { ...actual, toast: { ...actual.toast, error: toastError } };
});

import { DealsTab } from '../DealsTab.js';
import { DealDetailPage } from '../DealDetailPage.js';
import { ContactsTab } from '../ContactsTab.js';

const PIPELINE = { pipelineId: 'p1', name: 'Sales', stages: [{ stageId: 's1', name: 'New', probability: 10 }] };
const DEAL = { dealId: 'd1', title: 'Globex expansion', pipelineId: 'p1', stageId: 's1', amount: 5000, currency: 'USD', status: 'open' as const };

/** The field's `aria-describedby` must resolve to an element carrying the message. */
function expectAttached(input: HTMLElement, message: RegExp): void {
  expect(input.getAttribute('aria-invalid')).toBe('true');
  const ids = (input.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  const texts = ids.map((id) => document.getElementById(id)?.textContent ?? '');
  expect(texts.some((tx) => message.test(tx))).toBe(true);
  expect(document.activeElement).toBe(input);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  org.listPipelines.mockResolvedValue([PIPELINE]);
  org.listDeals.mockResolvedValue([]);
  org.listCompanies.mockResolvedValue([]);
  org.getDeal.mockResolvedValue(DEAL);
  org.getCompany.mockResolvedValue(null);
  crm.listContacts.mockResolvedValue([]);
  crm.listContactFields.mockResolvedValue([]);
});
afterEach(cleanup);

describe('DealsTab create form (CRM-UX-15)', () => {
  it('amount "abc": the AMOUNT field is aria-invalid, described by the message, focused; no createDeal', async () => {
    render(<MemoryRouter><DealsTab orgId="org:1" /></MemoryRouter>);
    await waitFor(() => expect(org.listPipelines).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Big one' } });
    const amount = screen.getByLabelText('Amount');
    fireEvent.change(amount, { target: { value: 'abc' } });
    fireEvent.submit(amount.closest('form')!);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expectAttached(amount, /must be a number/i);
    expect(org.createDeal).not.toHaveBeenCalled();
    // Typing again clears the mark.
    fireEvent.change(amount, { target: { value: '12' } });
    expect(amount.getAttribute('aria-invalid')).toBeNull();
  });

  it('currency with no amount attaches "needs an amount" to the AMOUNT field (where the fix goes)', async () => {
    render(<MemoryRouter><DealsTab orgId="org:1" /></MemoryRouter>);
    await waitFor(() => expect(org.listPipelines).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Big one' } });
    fireEvent.change(screen.getByLabelText('Currency'), { target: { value: 'EUR' } });
    fireEvent.submit(screen.getByLabelText('Amount').closest('form')!);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expectAttached(screen.getByLabelText('Amount'), /needs an amount/i);
    expect(org.createDeal).not.toHaveBeenCalled();
  });
});

describe('DealDetailPage edit form (CRM-UX-15)', () => {
  it('amount "abc" on Save: the field is marked + focused; no updateDeal', async () => {
    render(
      <MemoryRouter initialEntries={['/crm/deals/d1?org=o1']}>
        <Routes><Route path="/crm/deals/:dealId" element={<DealDetailPage />} /></Routes>
      </MemoryRouter>,
    );
    const amount = await screen.findByLabelText('Amount');
    fireEvent.change(amount, { target: { value: 'abc' } });
    fireEvent.submit(amount.closest('form')!);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expectAttached(amount, /must be a number/i);
    expect(org.updateDeal).not.toHaveBeenCalled();
  });
});

describe('ContactsTab email (CRM-UX-15)', () => {
  it('email "not-an-address": the EMAIL field is aria-invalid, described by the message, focused; no createContact', async () => {
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    await waitFor(() => expect(crm.listContactFields).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Ada' } });
    const email = screen.getByLabelText('Email');
    fireEvent.change(email, { target: { value: 'not-an-address' } });
    fireEvent.click(screen.getByRole('button', { name: /add contact/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expectAttached(email, /valid email/i);
    expect(crm.createContact).not.toHaveBeenCalled();
    // Typing again clears the mark.
    fireEvent.change(email, { target: { value: 'ada@example.com' } });
    expect(email.getAttribute('aria-invalid')).toBeNull();
  });
});

describe('ContactsTab required custom fields (CRM-UX-15)', () => {
  const DEFS: ContactFieldDef[] = [
    { defId: 'f1', key: 'tier', label: 'Tier', type: 'enum', required: false, options: ['Bronze', 'Gold'], createdAt: '2026-01-01T00:00:00Z' },
    { defId: 'f2', key: 'seats', label: 'Seats', type: 'number', required: true, createdAt: '2026-01-01T00:00:00Z' },
  ] as ContactFieldDef[];

  it('Add contact with a required field empty: THAT input is aria-invalid + focused; no createContact', async () => {
    crm.listContactFields.mockResolvedValue(DEFS);
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    const seats = await screen.findByLabelText(/Seats/);
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: /add contact/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expectAttached(seats, /required/i);
    expect(crm.createContact).not.toHaveBeenCalled();
    // The optional field is NOT marked.
    expect(screen.getByLabelText(/Tier/).getAttribute('aria-invalid')).toBeNull();
  });

  it('the edit modal: saving with the required field cleared marks + focuses it inside the modal; no PATCH', async () => {
    crm.listContactFields.mockResolvedValue(DEFS);
    crm.listContacts.mockResolvedValue([{ contactId: 'c1', name: 'Ada Devine', stage: 'lead', customFields: { seats: 4 } }]);
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Ada Devine’s custom fields' }));
    const dialog = await screen.findByRole('dialog');
    const seats = dialog.querySelector<HTMLInputElement>('#crm-fields-c1-f2')!;
    expect(seats.value).toBe('4');
    fireEvent.change(seats, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expectAttached(seats, /required/i);
    expect(crm.updateContactFields).not.toHaveBeenCalled();
  });
});
