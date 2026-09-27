/**
 * UX_UPGRADE-crm-console ROUND 2 — CC-SP-1: contact email.
 *
 * `Contact.email` was on the model, accepted by the create route AND the
 * PATCH route, keyed on by campaigns (`skipped 'no_email'`), suppression,
 * consent, and Gmail sync — and the console could neither SHOW nor SET it.
 * An agent-set email was invisible; a human-created contact could never be
 * emailed. The exact round-1 CRM-G1 shape, on the CRM's most important field.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Contact } from '../crmClient.js';

const listContacts = vi.fn();
const createContact = vi.fn();
const updateContactFields = vi.fn();
vi.mock('../crmClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listContacts: (...a: unknown[]) => listContacts(...a),
  createContact: (...a: unknown[]) => createContact(...a),
  updateContactFields: (...a: unknown[]) => updateContactFields(...a),
  listSegments: vi.fn(async () => []),
  // CRM-UX-7 — stubbed because this factory SPREADS the original: an unstubbed
  // export is a REAL fetch from a jsdom test.
  listContactFields: vi.fn(async () => []),
}));

const { ContactsTab } = await import('../ContactsTab.js');

const contact = (id: string, name: string, over: Partial<Contact> = {}): Contact =>
  ({ contactId: id, name, stage: 'lead', ...over } as Contact);

const renderTab = () => render(<MemoryRouter><ContactsTab /></MemoryRouter>);

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('CRM contacts — the email a human could not see or set (CC-SP-1)', () => {
  it('shows an AGENT-set email as a mailto link in the list', async () => {
    listContacts.mockResolvedValue([contact('c1', 'Ada Devine', { email: 'ada@example.com' })]);
    renderTab();
    const link = await screen.findByRole('link', { name: 'ada@example.com' });
    expect(link.getAttribute('href')).toContain('mailto:');
  });

  it('create sends the typed email on the wire; the absent key is the honest shape when blank', async () => {
    listContacts.mockResolvedValue([]);
    createContact.mockResolvedValue(contact('c9', 'New person'));
    renderTab();
    await screen.findByText(/no contacts/i);
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'New person' } });
    fireEvent.change(screen.getByLabelText(/^email$/i), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /add contact/i }));
    await waitFor(() => expect(createContact).toHaveBeenCalled());
    expect(createContact.mock.calls[0]![0]).toMatchObject({ name: 'New person', email: 'new@example.com' });

    vi.clearAllMocks();
    listContacts.mockResolvedValue([]);
    createContact.mockResolvedValue(contact('c10', 'No mail'));
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'No mail' } });
    fireEvent.click(screen.getByRole('button', { name: /add contact/i }));
    await waitFor(() => expect(createContact).toHaveBeenCalled());
    expect('email' in (createContact.mock.calls[0]![0] as Record<string, unknown>)).toBe(false);
  });

  it('the modal edit PATCHes the email — a real email input, not window.prompt (review F5)', async () => {
    listContacts.mockResolvedValue([contact('c1', 'Ada Devine')]);
    updateContactFields.mockResolvedValue(contact('c1', 'Ada Devine', { email: 'ada@new.com' }));
    renderTab();
    await screen.findByText('Ada Devine');
    fireEvent.click(screen.getByRole('button', { name: /edit email for .*Ada Devine/i }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText(/email/i, { selector: 'input[type="email"]' });
    fireEvent.change(input, { target: { value: 'ada@new.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateContactFields).toHaveBeenCalledWith('c1', { email: 'ada@new.com' }));
  });

  it('clearing sends null, not the empty string (the PATCH route distinguishes them)', async () => {
    listContacts.mockResolvedValue([contact('c1', 'Ada Devine', { email: 'old@example.com' })]);
    updateContactFields.mockResolvedValue(contact('c1', 'Ada Devine'));
    renderTab();
    await screen.findByText('Ada Devine');
    fireEvent.click(screen.getByRole('button', { name: /edit email for .*Ada Devine/i }));
    const input = await screen.findByDisplayValue('old@example.com');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateContactFields).toHaveBeenCalledWith('c1', { email: null }));
  });

  it('Cancel PATCHes nothing and closes the modal', async () => {
    listContacts.mockResolvedValue([contact('c1', 'Ada Devine', { email: 'old@example.com' })]);
    renderTab();
    await screen.findByText('Ada Devine');
    fireEvent.click(screen.getByRole('button', { name: /edit email for .*Ada Devine/i }));
    await screen.findByDisplayValue('old@example.com');
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByDisplayValue('old@example.com')).toBeNull());
    expect(updateContactFields).not.toHaveBeenCalled();
  });

  it('leadSource is finally READABLE (write-only in round 1) and searchable', async () => {
    listContacts.mockResolvedValue([
      contact('c1', 'Ada', { leadSource: 'webinar' }),
      contact('c2', 'Grace', { leadSource: 'referral' }),
      contact('c3', 'Lin', {}),
      contact('c4', 'Max', {}),
    ]);
    renderTab();
    await screen.findByText('Ada');
    expect(screen.getByText('webinar')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/search contacts/i), { target: { value: 'referral' } });
    await waitFor(() => expect(screen.queryByText('Ada')).toBeNull());
    expect(screen.getByText('Grace')).toBeTruthy();
  });
});
