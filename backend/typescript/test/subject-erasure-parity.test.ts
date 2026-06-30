/**
 * Subject-erasure parity (ADR 0081 P5 follow-up) — closes the retention-vs-erasure
 * asymmetry: profiles + comments now participate in GDPR data-subject erasure via the
 * `registerSubjectEraser` seam, driven by `consentService.deleteSubject` (the DSAR path).
 *
 * - profiles: erase by `userId` (the subject's own descriptive PII).
 * - comments: erase by `authorId` (the subject's free-text bodies); a non-subject reply
 *   survives (orphan trade-off, intentional, matches the retention purger).
 * - crm: DELIBERATELY OUT — a contact is a third-party business record, not the
 *   principal subject; deleteSubject must NOT delete it. This test pins that decision.
 *
 * Importing each service triggers its module-load eraser registration; seeding goes
 * through a DurableCollection over the same backend (comments) or the real API (profiles,
 * crm), then `deleteSubject` fans out through the real seam.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import type { Storage } from '../src/storage/storage.js';
import { deleteSubject } from '../src/features/consent/consentService.js';
import { getOrCreateProfile, getProfile, __resetProfiles } from '../src/features/profiles/profilesService.js';
import { __resetCommentsStore } from '../src/features/comments/commentsService.js';
import { createContact, getContact, __resetCrmStore } from '../src/features/crm/contactsService.js';

const commentCol = () => new DurableCollection<{ commentId: string; tenantId: string; authorId: string; parentId?: string }>('comments:thread', (c) => c.commentId);

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
    await col.put({ commentId: 'c1', tenantId: 'tA', authorId: 'subjX' });
    await col.put({ commentId: 'c2', tenantId: 'tA', authorId: 'subjX' });
    await col.put({ commentId: 'c3', tenantId: 'tA', authorId: 'subjY' }); // a reply by another author
    await col.put({ commentId: 'c4', tenantId: 'tB', authorId: 'subjX' }); // other tenant
    await deleteSubject('tA', 'subjX');
    expect(await col.get('c1')).toBeNull();
    expect(await col.get('c2')).toBeNull();
    expect(await col.get('c3')).not.toBeNull(); // non-subject reply survives (orphan, intentional)
    expect(await col.get('c4')).not.toBeNull(); // tenant isolation
  });

  it('comments: a reply AUTHORED BY the subject is erased too (matched on authorId, parentId-agnostic)', async () => {
    const col = commentCol();
    await col.put({ commentId: 'root', tenantId: 'tA', authorId: 'subjY' });
    await col.put({ commentId: 'reply', tenantId: 'tA', authorId: 'subjX', parentId: 'root' }); // subject's reply
    await deleteSubject('tA', 'subjX');
    expect(await col.get('reply')).toBeNull(); // erased regardless of being a reply
    expect(await col.get('root')).not.toBeNull(); // another author's root survives
  });

  it('idempotent: re-running deleteSubject for the same subject is a clean no-op', async () => {
    await getOrCreateProfile('tA', 'subjX');
    await commentCol().put({ commentId: 'c1', tenantId: 'tA', authorId: 'subjX' });
    await deleteSubject('tA', 'subjX');
    await deleteSubject('tA', 'subjX'); // second pass must not throw
    expect(await getProfile('tA', 'subjX')).toBeNull();
    expect(await commentCol().get('c1')).toBeNull();
  });

  it('crm: deleteSubject does NOT delete a contact (third-party record, retention-only)', async () => {
    const c = await createContact({ tenantId: 'tA', name: 'Acme Buyer', email: 'buyer@acme.test', stage: 'lead' });
    await deleteSubject('tA', c.contactId);
    expect(await getContact(c.contactId)).not.toBeNull(); // crm intentionally not a subject-eraser consumer
  });

  it('fail-closed: a blank subjectKey deletes nothing', async () => {
    await getOrCreateProfile('tA', 'subjX');
    await deleteSubject('tA', '');
    expect(await getProfile('tA', 'subjX')).not.toBeNull();
  });
});
