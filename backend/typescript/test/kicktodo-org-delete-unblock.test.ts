/**
 * Grade-data 2026-10-14 KTORG-D1 (KickTodo distribution, DATA-ASSESSMENT.md) — an org
 * that ran a KickTodo programme must become deletable again once the programme is
 * wound down.
 *
 * `deleteOrg` refuses while any org-scoped business row exists (RI-7). Before this
 * fix, kicktodo-organizations kept an EMPTY library row after the last entry was
 * removed, and offered no way at all to remove a brand reference, so the first
 * curation of either blocked deleting the org forever.
 *
 * Sabotage that turns it red:
 *  - `setLibraryEntry` puts the empty library instead of deleting it → still blocked
 *  - `clearBrandRef` removed / not deleting                          → still blocked
 *  - removal requires the challenge to exist                         → dangling entry throws
 *
 * TST-DJF-1 (grade-tests wave 71): the dangling entry is seeded INTO the library
 * row (a version that never resolves), so its removal is real and asserted gone;
 * the blocked-row count is exact (library + brand ref = 2).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createOrg, deleteOrg, listOrgs } from '../src/host/accessControlService.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import {
  clearBrandRef, getBrandRef, getLibrary, setBrandRef, setLibraryEntry, type OrgChallengeLibrary,
} from '../src/features/kicktodo-organizations/orgProgramService.js';

const T = 'tenant-kt-org-unblock';
/** The library's real namespace, to seed an entry whose version no longer resolves. */
const libraries = new DurableCollection<OrgChallengeLibrary>('kicktodo-org-libraries', (l) => `${l.tenantId}::${l.orgId}`);

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

async function published(title: string): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title, summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  return draft.id;
}

describe('KTORG-D1 — a wound-down KickTodo org is deletable', () => {
  it('blocks while the library and brand ref exist, deletes once both are cleared', async () => {
    const org = await createOrg({ tenantId: T, createdBy: 'test', name: 'Programme Org' });
    const challengeId = await published('Org Course');

    await setLibraryEntry(T, org.orgId, 'user:curator', { challengeId, version: 1, present: true });
    await setBrandRef(T, org.orgId, 'brand-profile-1');
    expect((await deleteOrg(org.orgId)).blocked?.rows).toBe(2); // the library row + the brand ref

    // Removing the last entry leaves NO library row (not an empty one).
    const emptied = await setLibraryEntry(T, org.orgId, 'user:curator', { challengeId, version: 1, present: false });
    expect(emptied.entries).toHaveLength(0);
    expect(await getLibrary(T, org.orgId)).toBeNull();
    expect((await deleteOrg(org.orgId)).blocked?.rows).toBe(1); // only the brand ref is left

    expect(await clearBrandRef(T, org.orgId)).toBe(true);
    expect(await getBrandRef(T, org.orgId)).toBeNull();
    expect(await clearBrandRef(T, org.orgId)).toBe(false); // idempotent

    const ok = await deleteOrg(org.orgId);
    expect(ok.org).toBe(true);
    expect(ok.blocked).toBeUndefined();
    expect((await listOrgs(T)).some((o) => o.orgId === org.orgId)).toBe(false);
  });

  it('a library entry for a version that no longer resolves can still be removed', async () => {
    const org = await createOrg({ tenantId: T, createdBy: 'test', name: 'Dangling Org' });
    const challengeId = await published('Kept Course');
    // The library holds the kept entry AND a dangling one (its version never resolves).
    await libraries.put({
      tenantId: T, orgId: org.orgId, updatedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        { challengeId, version: 1, addedBy: 'user:curator', addedAt: '2026-01-01T00:00:00.000Z' },
        { challengeId: 'chal:missing', version: 9, addedBy: 'user:curator', addedAt: '2026-01-01T00:00:00.000Z' },
      ],
    });

    // An add of a missing version is still refused …
    await expect(setLibraryEntry(T, org.orgId, 'user:curator', { challengeId: 'chal:missing', version: 9, present: true }))
      .rejects.toThrow('Not found.');
    // … but a removal never needs the version to exist, and it really removes it.
    const after = await setLibraryEntry(T, org.orgId, 'user:curator', { challengeId: 'chal:missing', version: 9, present: false });
    expect(after.entries.map((e) => `${e.challengeId}@v${e.version}`)).toEqual([`${challengeId}@v1`]);
    expect((await getLibrary(T, org.orgId))?.entries.map((e) => e.challengeId)).toEqual([challengeId]);
  });
});
