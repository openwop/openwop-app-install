/**
 * UserPicker (ADR 0261) — the name-resolving people picker. Covers the three
 * behaviours the raw-id inputs it replaces never had: names for options,
 * emitting the member subject on change, and preserving an existing value that
 * resolves to no current member (so a save can't silently drop it).
 *
 * Sabotage that turns it red: rendering `m.displayName` without the email reds
 * case 1; dropping the `rows.unshift` preservation — or preserving only while
 * the member list is still empty/loading — reds case 2; removing the
 * `membersProp` early return reds case 3.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

import type * as OrgMembers from '../orgMembers.js';
import type { OrgMember } from '../../client/accessClient.js';

const loadOrgMembers = vi.hoisted(() => vi.fn<typeof OrgMembers.loadOrgMembers>());
vi.mock('../orgMembers.js', () => ({ loadOrgMembers, invalidateOrgMembers: vi.fn() }));

import { UserPicker } from '../UserPicker.js';

const member = (subject: string, displayName: string, email?: string): OrgMember => ({
  memberId: subject, orgId: 'o1', tenantId: 't1', subject, displayName,
  ...(email ? { email } : {}), roles: [], teamIds: [],
  createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
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
    // Wait for the members to LOAD first — the preserved option also exists
    // while the list is still empty, so asserting before the load proves
    // nothing about "resolves to no CURRENT member".
    await screen.findByText('Alice Ng');
    // The unresolved value stays selected rather than snapping to empty.
    expect((select as HTMLSelectElement).value).toBe('legacy-freetext');
    expect(screen.getByRole('option', { name: 'legacy-freetext' })).toBeTruthy();
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
    screen.getByRole('combobox', { name: 'Grantee' }); // throws if the aria-label mode lost its name
    expect(screen.getByText('Choose a member…')).toBeTruthy();
    expect(screen.getByText('Alice Ng')).toBeTruthy();
  });
});
