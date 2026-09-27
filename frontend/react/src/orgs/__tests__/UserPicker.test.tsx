/**
 * UserPicker (ADR 0261) — the name-resolving people picker. Covers the three
 * behaviours the raw-id inputs it replaces never had: names for options,
 * emitting the member subject on change, and preserving an existing value that
 * resolves to no current member (so a save can't silently drop it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

const loadOrgMembers = vi.hoisted(() => vi.fn());
vi.mock('../orgMembers.js', () => ({ loadOrgMembers, invalidateOrgMembers: vi.fn() }));

import { UserPicker } from '../UserPicker.js';

const member = (subject: string, displayName: string, email?: string) => ({
  memberId: subject, orgId: 'o1', tenantId: 't1', subject, displayName,
  ...(email ? { email } : {}), roles: [], teamIds: [], createdAt: '', updatedAt: '',
});

beforeEach(() => { loadOrgMembers.mockReset(); });
afterEach(cleanup);

describe('UserPicker', () => {
  it('resolves members to names and emits the subject on change', async () => {
    loadOrgMembers.mockResolvedValue([member('user:alice', 'Alice Ng', 'alice@x.io'), member('user:bob', 'Bob Lee')]);
    const onChange = vi.fn();
    render(<UserPicker label="Owner" value="" onChange={onChange} orgId="o1" />);

    const select = await screen.findByRole('combobox', { name: 'Owner' });
    // Options read as names, not ids.
    await waitFor(() => expect(screen.getByText('Alice Ng · alice@x.io')).toBeTruthy());
    expect(screen.getByText('Bob Lee')).toBeTruthy();

    fireEvent.change(select, { target: { value: 'user:bob' } });
    expect(onChange).toHaveBeenCalledWith('user:bob');
  });

  it('preserves an existing value that resolves to no current member', async () => {
    loadOrgMembers.mockResolvedValue([member('user:alice', 'Alice Ng')]);
    render(<UserPicker label="Owner" value="legacy-freetext" onChange={vi.fn()} orgId="o1" />);
    const select = await screen.findByRole('combobox', { name: 'Owner' });
    // The unresolved value stays selected rather than snapping to empty.
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('legacy-freetext'));
  });

  it('uses pre-loaded members without fetching (inline aria-label mode)', () => {
    render(
      <UserPicker
        members={[member('user:alice', 'Alice Ng')]}
        value=""
        onChange={vi.fn()}
        ariaLabel="Grantee"
        emptyLabel="Choose a member…"
      />,
    );
    expect(loadOrgMembers).not.toHaveBeenCalled();
    const select = screen.getByRole('combobox', { name: 'Grantee' });
    expect(select).toBeTruthy();
    expect(screen.getByText('Choose a member…')).toBeTruthy();
    expect(screen.getByText('Alice Ng')).toBeTruthy();
  });
});
