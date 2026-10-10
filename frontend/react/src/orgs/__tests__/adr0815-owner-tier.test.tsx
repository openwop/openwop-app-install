/**
 * ADR 0815 (grade-ux ORGUX-1/2) — the orgs admin UI never offers an owner-tier
 * control to someone the server will refuse, and a typed refusal is rendered as
 * localized copy, never the server's English or "deleteMember returned 409".
 * Decision: docs/adr/0815-orgs-residual-subject-owner-tier-and-removal.md (D2, D6).
 *
 * Sabotage that turns it red: dropping `(ownerTier || !isOwner(m))` from
 * MembersPanel's `canTouch` reds ORGUX-1 case 1; showing the lock note to an
 * owner reds case 2; deleting a `refusalKeyOf` branch reds its it.each row; and
 * dropping `body` from accessClient `expectOk`'s ApiError reds the end-to-end case.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../InvitesSection.js', () => ({ InvitesSection: () => null }));

import { MembersPanel } from '../MembersPanel.js';
import { refusalKeyOf } from '../orgsHelpers.js';
import { deleteMember, type OrgMember } from '../../client/accessClient.js';
import { ApiError } from '../../client/requestJson.js';

afterEach(() => { cleanup(); });

const member = (id: string, name: string, roles: string[]): OrgMember => ({
  memberId: id, orgId: 'ws:1', tenantId: 'ws:1', displayName: name, roles, teamIds: [],
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
});

function renderPanel(scopes: string[]): void {
  const can = (s: string): boolean => scopes.includes(s);
  render(
    <MembersPanel
      orgId="ws:1"
      members={[member('m-owner', 'Olga Owner', ['owner']), member('m-ed', 'Eddie Editor', ['editor'])]}
      memberName="" setMemberName={() => {}} memberEmail="" setMemberEmail={() => {}}
      memberRoles={new Set()} setMemberRoles={() => {}}
      assignableRoleIds={['viewer', 'editor', 'admin']}
      editingId={null} setEditingId={() => {}} draftRoles={new Set()} setDraftRoles={() => {}}
      accessFor={null} access={null}
      onCreateMember={() => {}} onShowAccess={() => {}} startEdit={() => {}} onDeleteMember={() => {}} onSaveRoles={() => {}}
      can={can} roleLabel={(id) => id} toggleStr={(s) => s}
    />,
  );
}

const ADMIN = ['host:members:manage', 'host:groups:manage', 'workspace:read'];
const OWNER = [...ADMIN, 'host:org:manage'];

describe('ORGUX-1 — an admin is not offered owner-tier controls', () => {
  it("an admin can manage the editor but NOT the owner, and is told why (visibly, not only in a tooltip)", () => {
    renderPanel(ADMIN);
    const ownerRemove = screen.getByRole('button', { name: /Remove.*Olga Owner/i });
    const editorRemove = screen.getByRole('button', { name: /Remove.*Eddie Editor/i });
    expect((ownerRemove as HTMLButtonElement).disabled).toBe(true);
    expect(ownerRemove.getAttribute('title')).toMatch(/Only an owner/);
    expect((editorRemove as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Owners can only be changed or removed by another owner/)).toBeTruthy();
  });

  it('an owner can manage both, and sees no lock note', () => {
    renderPanel(OWNER);
    expect((screen.getByRole('button', { name: /Remove.*Olga Owner/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Owners can only be changed or removed by another owner/)).toBeNull();
  });
});

describe('ORGUX-2 — typed refusals map to localized keys', () => {
  const err = (body: unknown) => Object.assign(new Error('x'), { body });
  it.each([
    [{ error: 'forbidden', details: { code: 'owner_required' } }, 'errorOwnerTier'],
    [{ error: 'forbidden', details: { reason: 'owner_required' } }, 'errorOwnerTier'],
    [{ error: 'conflict', details: { reason: 'transfer_to_self' } }, 'errorTransferToSelf'],
    [{ error: 'conflict', details: { reason: 'last_owner' } }, 'errorLastOwner'],
    [{ error: 'conflict', details: { reason: 'identity_locked', field: 'subject' } }, 'errorIdentityLocked'],
    [{ error: 'conflict', details: { reason: 'identity_taken', field: 'subject' } }, 'errorIdentityTaken'],
    [{ error: 'forbidden_scope', details: { requiredScope: 'host:teams:manage' } }, 'errorForbiddenScope'],
  ])('%j → %s', (body, key) => {
    expect(refusalKeyOf(err(body))).toBe(key);
  });
  it('anything else is left to the transport copy', () => {
    expect(refusalKeyOf(err({ error: 'internal_error' }))).toBeNull();
    expect(refusalKeyOf(new Error('offline'))).toBeNull();
  });
});

describe('ORGUX-2 — the client carries the envelope, end to end', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('a 403 owner_required from deleteMember reaches refusalKeyOf through ApiError.body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'forbidden', message: 'Only an owner can remove an owner.', details: { code: 'owner_required' } }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )));
    const err = await deleteMember('ws:1', 'm-owner').then(() => null, (e: unknown) => e);
    if (!(err instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(err)}`);
    expect(err.status).toBe(403);
    expect(refusalKeyOf(err)).toBe('errorOwnerTier');
  });
});
