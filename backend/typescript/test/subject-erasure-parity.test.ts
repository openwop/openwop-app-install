/**
 * Subject-erasure parity (ADR 0081 P5 follow-up) — closes the retention-vs-erasure
 * asymmetry: profiles + comments now participate in GDPR data-subject erasure via the
 * `registerSubjectEraser` seam, driven by `consentService.deleteSubject` (the DSAR path).
 *
 * - profiles: erase by `userId` (the subject's own descriptive PII).
 * - comments: erase by `authorId` (the subject's free-text bodies); a non-subject reply
 *   survives (orphan trade-off, intentional, matches the retention purger).
 * - crm: the contact row is not DELETED (a third-party business record anchors the
 *   org's own deals/tasks/timeline), but as of CRM-2 its identifying FIELDS are
 *   erased. The old version of this file pinned "crm is DELIBERATELY OUT" and
 *   asserted only that the row survived — which is why a DSAR could report success
 *   while leaving the subject's email in six CRM stores, one of them in the KEY.
 *   Surviving-but-anonymized is the property; surviving-with-the-email was the bug.
 *
 * Importing each service triggers its module-load eraser registration; seeding goes
 * through a DurableCollection over the same backend (comments — production-shaped
 * `Comment` rows on the service's own tenant-indexed collection signature) or the real
 * API (profiles, crm), then `deleteSubject` fans out through the real seam.
 *
 * Sabotage-witnessed (/grade-tests wave 9, `w9g4-pa-*`): the profile eraser's tenant
 * check, the comments eraser's author match (and a parentId-aware variant of it), and
 * the crm eraser's registration each turn their case red.
 *
 * DOUBLE GUARD, recorded: the blank-subjectKey case cannot be turned red by removing an
 * eraser's `!subjectKey` guard (probe `w9g4-pa-blank-VACUOUS`) — no production-shaped
 * row is keyed `''` in any store these erasers read, so the guard is unreachable here.
 * It stays as a smoke that a blank DSAR neither throws nor deletes; the per-eraser
 * guard is pinned directly by `crm-subject-erasure.test.ts` ("a blank tenant or
 * subject erases nothing").
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';
import { deleteSubject } from '../src/features/consent/consentService.js';
import { getOrCreateProfile, getProfile, __resetProfiles } from '../src/features/profiles/profilesService.js';
import { __resetCommentsStore, type Comment } from '../src/features/comments/commentsService.js';
import { createContact, getContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { registerCrmErasure, ERASED_VALUE } from '../src/features/crm/erasure.js';

// The service's own collection signature (id + tenant index), so the eraser's indexed
// `listForTenantIndexed` read sees these rows exactly as it sees real ones.
const commentCol = () => new DurableCollection<Comment>('comments:thread', (c) => c.commentId, undefined, (c) => c.tenantId);
const comment = (commentId: string, tenantId: string, authorId: string, parentId?: string): Comment => ({
  commentId, tenantId, orgId: 'org1', resourceType: 'cms_page', resourceId: 'page1',
  ...(parentId ? { parentId } : {}),
  body: `body of ${commentId}`, authorId, status: 'open',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetProfiles();
  await __resetCommentsStore();
  await __resetCrmStore();
});

describe('subject-erasure parity (ADR 0081 P5 follow-up)', () => {
  it('profiles: deleteSubject erases the subject’s profile, leaves others; wrong-tenant erase is a no-op', async () => {
    await getOrCreateProfile('tA', 'subjX');
    await getOrCreateProfile('tA', 'subjY');
    // Tenant guard: erasing the same (globally-unique) userId from a different tenant
    // must NOT delete it — the eraser checks the row's tenant.
    await deleteSubject('tWrong', 'subjX');
    expect(await getProfile('tA', 'subjX')).not.toBeNull();
    // Erase from the owning tenant.
    await deleteSubject('tA', 'subjX');
    expect(await getProfile('tA', 'subjX')).toBeNull();
    expect(await getProfile('tA', 'subjY')).not.toBeNull();
  });

  it('comments: deleteSubject erases the subject’s comments; another author’s reply survives', async () => {
    const col = commentCol();
    await col.put(comment('c1', 'tA', 'subjX'));
    await col.put(comment('c2', 'tA', 'subjX'));
    await col.put(comment('c3', 'tA', 'subjY')); // a reply by another author
    await col.put(comment('c4', 'tB', 'subjX')); // other tenant
    await deleteSubject('tA', 'subjX');
    expect(await col.get('c1')).toBeNull();
    expect(await col.get('c2')).toBeNull();
    expect(await col.get('c3')).not.toBeNull(); // non-subject reply survives (orphan, intentional)
    expect(await col.get('c4')).not.toBeNull(); // tenant isolation
  });

  it('comments: a reply AUTHORED BY the subject is erased too (matched on authorId, parentId-agnostic)', async () => {
    const col = commentCol();
    await col.put(comment('root', 'tA', 'subjY'));
    await col.put(comment('reply', 'tA', 'subjX', 'root')); // subject's reply
    await deleteSubject('tA', 'subjX');
    expect(await col.get('reply')).toBeNull(); // erased regardless of being a reply
    expect(await col.get('root')).not.toBeNull(); // another author's root survives
  });

  it('idempotent: re-running deleteSubject for the same subject is a clean no-op', async () => {
    await getOrCreateProfile('tA', 'subjX');
    await commentCol().put(comment('c1', 'tA', 'subjX'));
    const first = await deleteSubject('tA', 'subjX');
    expect(first.erasure.rowsTouched, 'the first pass really erased (the profile eraser reports)').toBeGreaterThan(0);
    // "A clean no-op" is the claim: the second pass fails nothing and TOUCHES nothing —
    // reported as `foundNothing`, not as a second successful erasure.
    const second = await deleteSubject('tA', 'subjX');
    // `failed` is NOT 0 here, and that is the environment, not the claim: this file
    // registers only the erasers its imports load, so every ADR 0464 manifest eraser
    // that never registered counts as failed ("<name> (never registered)") on BOTH
    // passes. The claim is that the RE-RUN adds no failure of its own.
    expect(second.erasure.failedFeatures).toEqual(first.erasure.failedFeatures);
    expect(second.erasure.rowsTouched).toBe(0);
    expect(second.erasure.foundNothing).toBe(true);
    expect(await getProfile('tA', 'subjX')).toBeNull();
    expect(await commentCol().get('c1')).toBeNull();
  });

  it('crm: deleteSubject does NOT delete a contact, but DOES erase its identifying fields', async () => {
    registerCrmErasure(); // idempotent by reference; feature.ts does this at boot
    const c = await createContact({ tenantId: 'tA', name: 'Acme Buyer', email: 'buyer@acme.test', stage: 'lead' });
    await deleteSubject('tA', c.contactId);

    const after = await getContact(c.contactId);
    expect(after, 'the row anchors the org\'s deals/tasks/timeline — it is not deleted').not.toBeNull();
    // ...and the half the old assertion missed entirely.
    expect(after!.name).toBe(ERASED_VALUE);
    expect(after!.email, 'the subject\'s address must not survive a "successful" erasure').toBeUndefined();
    expect(after!.stage, 'business attributes of the relationship survive').toBe('lead');
  });

  // Double guard — see the header: unreachable blank path, kept as a no-throw/no-delete smoke.
  it('fail-closed: a blank subjectKey deletes nothing', async () => {
    await getOrCreateProfile('tA', 'subjX');
    await deleteSubject('tA', '');
    expect(await getProfile('tA', 'subjX')).not.toBeNull();
  });
});
