/**
 * ADR 0458 P0 — kicktodo-community data-subject erasure. A creator profile and a challenge
 * review are the subject's OWN authored content (approval-gated public), so a DSAR DELETES
 * them (unlike a third-party crm record): the profile row, its handle-index claim, and the
 * subject's reviews. Other subjects and other tenants are untouched.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import {
  eraseCommunitySubject, __test,
} from '../src/features/kicktodo-community/communityService.js';

const T = 'tenant-A';
const T2 = 'tenant-B';
const A = 'user:alice';
const B = 'user:bob';

async function seedProfile(tenantId: string, subject: string, handle: string): Promise<void> {
  await __test.profiles.put({
    tenantId, creatorSubject: subject, handle, displayName: `Name ${handle}`, bio: 'b', links: [],
    state: 'approved', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await __test.handleIndex.put({ tenantId, handleLower: handle, creatorSubject: subject });
}
async function seedReview(tenantId: string, subject: string, challengeId: string): Promise<void> {
  await __test.reviews.put({
    tenantId, challengeId, challengeVersion: 1, reviewerSubject: subject, rating: 5,
    state: 'visible', provenance: 'entitlement', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await seedProfile(T, A, 'alice');
  await seedProfile(T, B, 'bob');
  await seedProfile(T2, A, 'alice2');
  await seedReview(T, A, 'c1');
  await seedReview(T, B, 'c1');
  await seedReview(T2, A, 'c9');
});

describe('ADR 0458 P0 — community subject erasure', () => {
  it('deletes the subject profile + handle claim + their reviews; others intact', async () => {
    await eraseCommunitySubject(T, A);
    expect(await __test.profiles.get(`${T}::${A}`)).toBeNull();
    expect(await __test.handleIndex.get(`${T}::alice`)).toBeNull(); // handle freed
    expect(await __test.reviews.get(`${T}::c1::${A}`)).toBeNull();

    // Other subject in-tenant untouched.
    expect(await __test.profiles.get(`${T}::${B}`)).not.toBeNull();
    expect(await __test.handleIndex.get(`${T}::bob`)).not.toBeNull();
    expect(await __test.reviews.get(`${T}::c1::${B}`)).not.toBeNull();
    // Same subject id in another tenant untouched.
    expect(await __test.profiles.get(`${T2}::${A}`)).not.toBeNull();
    expect(await __test.reviews.get(`${T2}::c9::${A}`)).not.toBeNull();
  });

  it('is idempotent and no-ops on a falsy subject', async () => {
    await eraseCommunitySubject(T, A);
    await eraseCommunitySubject(T, A);
    expect(await __test.profiles.get(`${T}::${A}`)).toBeNull();
    await eraseCommunitySubject(T, '');
    expect(await __test.profiles.get(`${T}::${B}`)).not.toBeNull();
  });

  it('runs from the host fan-out (registered at module load)', async () => {
    await eraseSubject(T, A);
    expect(await __test.profiles.get(`${T}::${A}`)).toBeNull();
    expect(await __test.profiles.get(`${T}::${B}`)).not.toBeNull();
  });
});
