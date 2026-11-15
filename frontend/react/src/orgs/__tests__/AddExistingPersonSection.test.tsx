/**
 * ADR 1123 — the "Add existing person" control and "Link to account".
 *
 * The properties pinned: the add sends the server's `candidateId`, never a
 * subject; the filter narrows only the list the server offered; the email
 * lookup is offered to a superadmin alone; and the link sends the candidate
 * for the row it is on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type * as Client from '../addExistingClient.js';
import { messages as orgsEn } from '../i18n/en.js';

const listMemberCandidates = vi.fn<typeof Client.listMemberCandidates>();
const lookupMemberByEmail = vi.fn<typeof Client.lookupMemberByEmail>();
const addExistingMember = vi.fn<typeof Client.addExistingMember>();
const linkMember = vi.fn<typeof Client.linkMember>();
vi.mock('../addExistingClient.js', () => ({
  listMemberCandidates: (...a: Parameters<typeof Client.listMemberCandidates>) => listMemberCandidates(...a),
  lookupMemberByEmail: (...a: Parameters<typeof Client.lookupMemberByEmail>) => lookupMemberByEmail(...a),
  addExistingMember: (...a: Parameters<typeof Client.addExistingMember>) => addExistingMember(...a),
  linkMember: (...a: Parameters<typeof Client.linkMember>) => linkMember(...a),
}));

const { AddExistingPersonSection, LinkAccountControl } = await import('../AddExistingPersonSection.js');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const pool = [
  { candidateId: 'm:1', displayName: 'Ada Lovelace', email: 'ada@acme.test' },
  { candidateId: 'm:2', displayName: 'Grace Hopper', email: 'grace@acme.test' },
];
const member = { memberId: 'mem-new', orgId: 'org-a', tenantId: 'ws:x', displayName: 'Ada Lovelace', subject: 'user:ada', roles: ['viewer'], teamIds: [], createdAt: '', updatedAt: '' };

describe('ADR 1123 — AddExistingPersonSection', () => {
  it('adds the picked candidate by its id, with the chosen roles, and refreshes', async () => {
    listMemberCandidates.mockResolvedValue(pool);
    addExistingMember.mockResolvedValue(member as never);
    const onChanged = vi.fn();
    render(<AddExistingPersonSection orgId="org-a" canManage isSuperadmin={false} assignableRoleIds={['viewer', 'editor']} roleLabel={(r) => r} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(orgsEn.addExistingButton) }));
    await waitFor(() => expect(listMemberCandidates).toHaveBeenCalledWith('org-a', 'add'));
    const select = await screen.findByLabelText(orgsEn.addExistingPersonLabel);
    fireEvent.change(screen.getByLabelText(orgsEn.addExistingFilterLabel), { target: { value: 'grace' } });
    expect(screen.queryByRole('option', { name: /Ada Lovelace/ }), 'the filter narrows the offered list').toBeNull();
    fireEvent.change(select, { target: { value: 'm:2' } });
    fireEvent.click(screen.getByLabelText('editor'));
    fireEvent.click(screen.getByRole('button', { name: orgsEn.addExistingSubmit }));
    await waitFor(() => expect(addExistingMember).toHaveBeenCalledWith('org-a', { candidateId: 'm:2' }, ['viewer', 'editor']));
    expect(onChanged).toHaveBeenCalled();
    expect(await screen.findByText(orgsEn.addExistingAdded)).toBeTruthy();
  });

  it('offers the email lookup to a superadmin only, and says the same thing on a miss', async () => {
    listMemberCandidates.mockResolvedValue([]);
    const { rerender } = render(<AddExistingPersonSection orgId="org-a" canManage isSuperadmin={false} assignableRoleIds={['viewer']} roleLabel={(r) => r} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(orgsEn.addExistingButton) }));
    await screen.findByText(orgsEn.addExistingNoneOffered);
    expect(screen.queryByLabelText(new RegExp(orgsEn.addExistingLookupLabel.replace(/[()]/g, '.')))).toBeNull();

    rerender(<AddExistingPersonSection orgId="org-a" canManage isSuperadmin assignableRoleIds={['viewer']} roleLabel={(r) => r} onChanged={vi.fn()} />);
    lookupMemberByEmail.mockResolvedValue(null);
    fireEvent.change(screen.getByLabelText(new RegExp(orgsEn.addExistingLookupLabel.replace(/[()]/g, '.'))), { target: { value: 'nobody@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: orgsEn.addExistingLookupButton }));
    expect(await screen.findByText(orgsEn.addExistingLookupMiss)).toBeTruthy();
    expect((screen.getByRole('button', { name: orgsEn.addExistingSubmit }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders nothing for a caller who cannot manage members', () => {
    const { container } = render(<AddExistingPersonSection orgId="org-a" canManage={false} isSuperadmin assignableRoleIds={['viewer']} roleLabel={(r) => r} onChanged={vi.fn()} />);
    expect(container.textContent).toBe('');
  });
});

describe('ADR 1123 — LinkAccountControl', () => {
  it('links the row to the picked candidate, from the link pool', async () => {
    listMemberCandidates.mockResolvedValue(pool);
    linkMember.mockResolvedValue(member as never);
    const onChanged = vi.fn();
    render(<LinkAccountControl orgId="org-a" memberId="ph-1" name="Ada (placeholder)" isSuperadmin={false} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Link Ada (placeholder) to an account' }));
    await waitFor(() => expect(listMemberCandidates).toHaveBeenCalledWith('org-a', 'link'));
    fireEvent.change(await screen.findByLabelText(orgsEn.addExistingPersonLabel), { target: { value: 'm:1' } });
    fireEvent.click(screen.getByRole('button', { name: orgsEn.linkAccountSubmit }));
    await waitFor(() => expect(linkMember).toHaveBeenCalledWith('org-a', 'ph-1', { candidateId: 'm:1' }));
    expect(onChanged).toHaveBeenCalled();
  });
});
