/**
 * ADR 0697 — a workspace-root membership is a RELATIONSHIP, and removing it must
 * remove the relationship rather than one row that happens to represent it.
 *
 * WHAT MADE THIS INVISIBLE. ADR 0684 shipped with green tests for declaration,
 * claiming, the point-read index, and enterability. None of them could see this,
 * because every layer does exactly what it was written to do: `createMember`
 * minted a random id, so two concurrent auto-joins each found nothing and each
 * wrote a row; the phase-5 index (keyed `(tenantId, subject)`) had the second
 * overwrite the first; `deleteMember` removed the row the operator could see;
 * and `isWorkspaceMember`'s deliberately-authoritative fallback re-granted
 * membership from the orphan. Nothing was in an error state. Nothing logged.
 *
 * The load-bearing case here is `removal holds against a LEGACY twin`, and it is
 * written to fail against the code as it was. It plants the twin by writing the
 * row DIRECTLY to storage, because that is what the race did and because a twin
 * planted through the fixed `createMember` is unrepresentable — the test would
 * pass vacuously, which is the ADR 0684 failure one layer over.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  createMember, deleteMember, listMembers, isWorkspaceMember, createOrg, getMember,
} from '../src/host/accessControlService.js';
import { initHostExtPersistence, __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

const WS = 'host-adr0697';          // a workspace root: orgId === tenantId
const SUB = 'user:dup-subject';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

beforeEach(async () => {
  for (const m of await listMembers(WS, WS)) {
    try { await deleteMember(m.memberId); } catch { /* owner invariant — fine */ }
  }
});

/** Write a member row straight into the store, bypassing `createMember`.
 *  This reproduces a row the RACE wrote: present in the collection, absent from
 *  the point-read index (the winning write owned that key). */
async function plantLegacyTwin(memberId: string, roles: string[] = ['viewer']): Promise<void> {
  const storage = __hostExtStorage();
  if (!storage) throw new Error('storage not initialised');
  const now = new Date().toISOString();
  await storage.kvSet(`hostext:access-members:${memberId}`, JSON.stringify({
    memberId, orgId: WS, tenantId: WS, subject: SUB,
    displayName: 'Twin', roles, teamIds: [], createdAt: now, updatedAt: now,
  }));
}

describe('ADR 0697 D1 — the relationship is the key', () => {
  it('two concurrent createMember calls for one subject converge on ONE row', async () => {
    await Promise.all([
      createMember({ orgId: WS, tenantId: WS, displayName: 'A', subject: SUB }),
      createMember({ orgId: WS, tenantId: WS, displayName: 'A', subject: SUB }),
    ]);
    const rows = (await listMembers(WS, WS)).filter((m) => m.subject === SUB);
    // Before D1 this was 2 — and the SECOND one is the row an operator sees.
    expect(rows).toHaveLength(1);
  });

  it('THE LIVE ROUTE: an operator re-adding an existing member makes no twin', async () => {
    // This needs no race. `POST /orgs/:orgId/members` calls `createMember` with
    // no existence check (`routes/accessControl.ts:458`), so adding a participant
    // who was already auto-joined wrote a second row for the CANONICAL subject —
    // deterministically, as the ordinary result of the most ordinary operator
    // action there is. The double-fire race got noticed; this is what was
    // actually reachable after it was closed.
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Auto', subject: SUB });
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Added by operator', subject: SUB });
    expect((await listMembers(WS, WS)).filter((m) => m.subject === SUB)).toHaveLength(1);
  });

  it('an existing membership is RETURNED, not overwritten with defaults', async () => {
    await createMember({ orgId: WS, tenantId: WS, displayName: 'A', subject: SUB, roles: ['admin'] });
    const again = await createMember({ orgId: WS, tenantId: WS, displayName: 'Replaced', subject: SUB });
    // A racing auto-join must not demote an operator's role edit to `viewer`,
    // which a plain upsert on the derived id would do.
    expect(again.roles).toEqual(['admin']);
    expect(again.displayName).toBe('A');
  });

  it('a SUB-ORG membership is untouched — the narrowing is real, not global', async () => {
    // `isWorkspaceMember` never reads this shape, and derived ids here would
    // change ids already in use for no gain. Two calls still make two rows.
    await createOrg({ orgId: 'org-child', tenantId: WS, createdBy: SUB, name: 'Child' });
    await createMember({ orgId: 'org-child', tenantId: WS, displayName: 'B', subject: SUB });
    await createMember({ orgId: 'org-child', tenantId: WS, displayName: 'B', subject: SUB });
    const rows = (await listMembers(WS, 'org-child')).filter((m) => m.subject === SUB);
    expect(rows).toHaveLength(2);
    expect(rows.every((m) => /^mbr-[0-9a-f]{8}$/.test(m.memberId))).toBe(true);
  });
});

describe('ADR 0697 D2 — removal holds against a LEGACY twin', () => {
  it('THE case: deleting the visible row removes the relationship, not one row', async () => {
    const visible = await createMember({ orgId: WS, tenantId: WS, displayName: 'A', subject: SUB });
    await plantLegacyTwin('mbr-legacy01');       // what the race left behind

    expect(await isWorkspaceMember(SUB, WS)).toBe(true);
    await deleteMember(visible.memberId);

    // Before D2: TRUE. The operator removed the member, the console and the
    // index agreed, and the very next authenticated request said they were
    // still in — which for the default participant workspace is a banned
    // account walking back in.
    expect(await isWorkspaceMember(SUB, WS), 'the removal must hold').toBe(false);
    expect(await getMember('mbr-legacy01'), 'the orphan must be gone too').toBeNull();
    expect((await listMembers(WS, WS)).filter((m) => m.subject === SUB)).toHaveLength(0);
  });

  it('deleting the TWIN first also removes the relationship', async () => {
    // Direction matters: an operator may act on either row, and the index points
    // at only one of them.
    const visible = await createMember({ orgId: WS, tenantId: WS, displayName: 'A', subject: SUB });
    await plantLegacyTwin('mbr-legacy02');
    await deleteMember('mbr-legacy02');
    expect(await isWorkspaceMember(SUB, WS)).toBe(false);
    expect(await getMember(visible.memberId)).toBeNull();
  });

  it('a duplicated OWNER still cannot be removed into an ownerless workspace', async () => {
    // The invariant is counted over EVERYTHING removed. Counting per row would
    // pass on the first delete and strand the workspace on the second.
    const owner = await createMember({ orgId: WS, tenantId: WS, displayName: 'O', subject: SUB, roles: ['owner'] });
    await plantLegacyTwin('mbr-legacy03', ['owner']);
    await expect(deleteMember(owner.memberId)).rejects.toThrow(/owner/i);
    // ...and the compensating restore put BOTH rows back, so the workspace is
    // exactly as it was rather than half-deleted.
    expect(await isWorkspaceMember(SUB, WS)).toBe(true);
    expect(await getMember('mbr-legacy03')).not.toBeNull();
  });
});
