/**
 * ADR 0891 grade-ux follow-ups (row 46).
 *
 *  - BR2UX-1: a partial lock's `allowedEditors` was API-only. The editor now lists
 *    the org's members to pick from, saves the pick, keeps ids it cannot show,
 *    and says when it cannot list members instead of showing "none".
 *  - BR2UX-2: a failed save is SPOKEN (the Modal's `errorAnnounce`), not only drawn.
 *
 * The fixture is deliberately ASYMMETRIC: one listed editor is a member (bob) and
 * TWO are not (gone, gone-2), so an inverted "is no longer a member" predicate
 * reads 1, not 2 (w52: the old 1-vs-1 fixture let that inversion pass).
 *
 * Sabotage-witnessed (w52): admitting subject-less members; `checked={false}`;
 * inverting the unlisted predicate; dropping the add in `toggleEditor`; a member
 * read failure becoming `setMembers([])`; `errorAnnounce={undefined}`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import type { Brand } from '../brandClient.js';
import type { OrgMember } from '../../../client/accessClient.js';
import type * as OrgMembers from '../../../orgs/orgMembers.js';

const listBrands = vi.fn();
const updateBrand = vi.fn();
const loadOrgMembers = vi.fn<typeof OrgMembers.loadOrgMembers>();
const announce = vi.fn();

vi.mock('../brandClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listBrands: () => listBrands(),
    updateBrand: (id: string, input: unknown) => updateBrand(id, input),
    createBrand: vi.fn(async () => ({})),
    deleteBrand: vi.fn(async () => {}),
    listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
    listBrandFonts: vi.fn(async () => []),
  };
});
vi.mock('../../../orgs/orgMembers.js', () => ({ loadOrgMembers: (id: string) => loadOrgMembers(id) }));
vi.mock('../../../ui/announce.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), announce: (m: string) => announce(m) }));

import { BrandPage } from '../BrandPage.js';

function brand(over: Partial<Brand> = {}): Brand {
  return {
    id: 'brand-1', tenantId: 't', orgId: 'org-1', name: 'Acme Brand', description: '', status: 'active',
    voiceProfile: { voice: 'warm', formalityLevel: 3, guidelines: '', samplePhrases: [], avoidPhrases: [], toneRegisters: [] },
    keyPhrases: { approvedTaglines: [], bannedPhrases: [], valuePropositions: [], productDescriptors: [] },
    positioning: { tagline: '', elevatorPitch: '', differentiators: [], competitiveFrame: '' },
    channelVoiceRules: [],
    governance: { lockLevel: 'partial', allowedEditors: ['user:bob', 'user:gone', 'user:gone-2'], requireApproval: false },
    createdBy: 'user:someone', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const T0 = '2026-01-01T00:00:00.000Z';
const MEMBERS: OrgMember[] = [
  { memberId: 'm1', orgId: 'org-1', tenantId: 't', subject: 'user:bob', displayName: 'Bob', roles: ['editor'], teamIds: [], createdAt: T0, updatedAt: T0 },
  { memberId: 'm2', orgId: 'org-1', tenantId: 't', subject: 'user:cara', displayName: 'Cara', roles: ['editor'], teamIds: [], createdAt: T0, updatedAt: T0 },
  // No `subject`: nothing to save into allowedEditors, so it must not be offered.
  { memberId: 'm3', orgId: 'org-1', tenantId: 't', displayName: 'Unbound', roles: [], teamIds: [], createdAt: T0, updatedAt: T0 },
];

async function openEditor(): Promise<void> {
  render(<BrandPage />);
  await act(async () => {});
  fireEvent.click(await screen.findByRole('button', { name: /acme brand/i }));
  await screen.findByRole('dialog');
}

beforeEach(() => {
  listBrands.mockReset().mockResolvedValue([brand()]);
  updateBrand.mockReset().mockResolvedValue({});
  announce.mockReset();
  loadOrgMembers.mockReset().mockResolvedValue(MEMBERS);
});
afterEach(cleanup);

describe('BR2UX-1 — allowed editors are visible and editable', () => {
  it('lists bound members, saves the pick, and keeps an id it cannot show', async () => {
    await openEditor();
    const bob = await screen.findByRole('checkbox', { name: 'Bob' });
    expect((bob as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('checkbox', { name: 'Unbound' })).toBeNull();
    expect(screen.getByText('2 listed editors are no longer members of this organization.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cara' }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateBrand).toHaveBeenCalled());
    const payload = updateBrand.mock.calls[0]![1] as { governance: { allowedEditors: string[] } };
    expect(payload.governance.allowedEditors.sort()).toEqual(['user:bob', 'user:cara', 'user:gone', 'user:gone-2']);
  });

  it('says it cannot list members, never "none", when the member read fails', async () => {
    loadOrgMembers.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    await openEditor();
    expect(await screen.findByText(/lists 3 editors\. Only an org admin can see or change the list/i)).toBeTruthy();
    expect(screen.queryByText(/no members who can be listed/i)).toBeNull();
  });
});

describe('BR2UX-2 — a failed save is spoken', () => {
  it('announces the error text', async () => {
    updateBrand.mockRejectedValue(new Error('This brand restricts editing.'));
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(announce).toHaveBeenCalledWith(expect.stringMatching(/restricts editing/)));
  });
});
