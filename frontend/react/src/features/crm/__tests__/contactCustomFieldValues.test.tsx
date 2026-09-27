/**
 * CRM-UX-7, the half that actually closes the finding: a human can EDIT the
 * values, not merely define the fields.
 *
 * "An AI agent can write a field a human can neither define nor edit" was the
 * complaint. `ContactFieldsPage` answers "define"; this answers "edit" — the
 * contact create form carries the tenant's fields, and an existing contact's
 * values are reachable through a modal. A definitions editor alone would have
 * left agent-written values permanently unreachable to the person they describe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  listContacts: vi.fn(),
  listSegments: vi.fn(),
  listSegmentMembers: vi.fn(),
  listContactFields: vi.fn(),
  createContact: vi.fn(),
  updateContactFields: vi.fn(),
}));
vi.mock('../crmClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...api };
});

import { ContactsTab } from '../ContactsTab.js';
import type { ContactFieldDef } from '../crmClient.js';

const DEFS: ContactFieldDef[] = [
  { defId: 'f1', key: 'tier', label: 'Tier', type: 'enum', required: false, options: ['Bronze', 'Gold'], createdAt: '2026-01-01T00:00:00Z' },
  { defId: 'f2', key: 'seats', label: 'Seats', type: 'number', required: true, createdAt: '2026-01-01T00:00:00Z' },
];
const ADA = {
  contactId: 'c1', tenantId: 't1', name: 'Ada Lovelace', stage: 'lead' as const,
  customFields: { tier: 'Gold', seats: 12 },
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listContacts.mockResolvedValue([ADA]);
  api.listSegments.mockResolvedValue([]);
  api.listSegmentMembers.mockResolvedValue([]);
  api.listContactFields.mockResolvedValue(DEFS);
  api.createContact.mockResolvedValue(ADA);
  api.updateContactFields.mockResolvedValue(ADA);
});
afterEach(cleanup);

const view = (): void => { render(<MemoryRouter><ContactsTab /></MemoryRouter>); };

describe('CRM-UX-7 — custom-field values on the contact form', () => {
  it('renders one control per tenant-defined field and sends the typed values', async () => {
    view();
    await screen.findByLabelText('Tier');
    fireEvent.change(screen.getByPlaceholderText('Jane Doe'), { target: { value: 'Grace Hopper' } });
    fireEvent.change(screen.getByLabelText('Tier'), { target: { value: 'Bronze' } });
    fireEvent.change(screen.getByLabelText('Seats (required)'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));
    await waitFor(() => expect(api.createContact).toHaveBeenCalled());
    expect(api.createContact.mock.calls[0]![0].customFields).toEqual({ tier: 'Bronze', seats: 9 });
  });

  it('a REQUIRED field is marked as such and blocks the submit before the server 400s', async () => {
    // MEASURED: the control's own `required` attribute stops the submit, so the
    // JS `missingRequired` guard never runs on this path — it is defence for a
    // caller that renders a control without it, and is unit-tested as such in
    // `contactCustomFields.test.tsx`. Asserting the toast here would have been
    // a test of unreachable code (the probability-clamp lesson, again).
    view();
    const seats = await screen.findByLabelText('Seats (required)') as HTMLInputElement;
    expect(seats.required).toBe(true);
    expect((screen.getByLabelText('Tier') as HTMLSelectElement).required).toBe(false);
    fireEvent.change(screen.getByPlaceholderText('Jane Doe'), { target: { value: 'Grace Hopper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add contact' }));
    await waitFor(() => expect(seats.required).toBe(true));
    expect(api.createContact).not.toHaveBeenCalled();
  });

  it('edits an EXISTING contact’s values, sending the WHOLE map (the server replaces)', async () => {
    view();
    fireEvent.click(await screen.findByLabelText('Edit Ada Lovelace’s custom fields'));
    // Scoped to the DIALOG: the create form carries a 'Tier' control too, and an
    // unscoped query would have asserted against the wrong one.
    const dialog = await screen.findByRole('dialog');
    const tier = within(dialog).getByLabelText('Tier') as HTMLSelectElement;
    // Seeded from the stored values, so a save never drops a field this form
    // did not touch.
    expect(tier.value).toBe('Gold');
    fireEvent.change(tier, { target: { value: 'Bronze' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateContactFields).toHaveBeenCalledWith('c1', { customFields: { tier: 'Bronze', seats: 12 } }));
  });

  it('a FAILED definitions read is named, not silence', async () => {
    // Silence would render as "this tenant has no custom fields" — and a
    // REQUIRED one would then 400 on submit with no explanation on screen.
    api.listContactFields.mockRejectedValue(new Error('fields_500'));
    view();
    expect(await screen.findByText('Contact fields didn’t load')).toBeTruthy();
    expect(screen.queryByLabelText('Tier')).toBeNull();
    const before = api.listContactFields.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.listContactFields.mock.calls.length).toBeGreaterThan(before));
  });

  it('offers no "Fields" action when the tenant has defined none', async () => {
    api.listContactFields.mockResolvedValue([]);
    view();
    await screen.findByText('Ada Lovelace');
    expect(screen.queryByLabelText('Edit Ada Lovelace’s custom fields')).toBeNull();
    // …and the route to define one is still offered.
    expect(screen.getByRole('link', { name: 'Define contact fields' })).toBeTruthy();
  });
});
