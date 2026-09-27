/**
 * ADR 0666 D1 — the auto-extraction consent grant must be readable by the lane it gates.
 *
 * BORN RED. The grant was written at `${tenant}:${callerSubject}` = `${tenant}:user:<hash>`
 * and read at `${tenant}:user:${actingUserId}` = `${tenant}:user:user:<hash>`, because
 * `User.userId` is itself `user:<sha256>` and the read added a second prefix. The getter is an
 * exact point-get, so the lookup could never recover: ADR 0120's lane had never written in
 * production.
 *
 * WHY THIS FILE EXISTS ALONGSIDE `memory-extraction-binding.test.ts`: that suite is green over a
 * BARE subject id (`'alice'`), for which the two keys coincide. No production caller can produce
 * a bare id — every one passes a `User.userId`. So the existing suite could not see this defect
 * by construction. These legs use the REAL id shape, minted by the real `userIdFor`.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setExtractionGrant, getExtractionGrant } from '../src/features/memory-auto-extract/grantService.js';
import { extractConversationMemory } from '../src/features/memory-auto-extract/extractionBinding.js';
import { countSubjectNotes, listSubjectNotes } from '../src/host/subjectMemory.js';
import { personSubject } from '../src/host/subject.js';
import { userIdFor } from '../src/features/users/usersService.js';

const T = 'tGrantKey';
// The REAL production id shape — `user:<32 hex>`, minted by the same helper `createUser` uses.
const REAL_USER_ID = userIdFor(T, 'oidc:sub-abc');
const LIST_USER_ID = userIdFor(T, 'oidc:sub-list');
const CLOSED_USER_ID = userIdFor(T, 'oidc:sub-closed');
const OTHER_TARGET_ID = userIdFor(T, 'oidc:sub-target');

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0666-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('ADR 0666 D1 — the grant the consent route files is the grant the lane reads', () => {
  it('the id shape this test depends on is the real one (anti-vacuity)', () => {
    // If `userIdFor` ever stopped prefixing, every leg below would pass for the wrong reason.
    expect(REAL_USER_ID.startsWith('user:'), REAL_USER_ID).toBe(true);
    expect(REAL_USER_ID.slice('user:'.length)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('BORN RED — a grant filed the way the route files it authorizes extraction', async () => {
    // Exactly what `PUT /profiles/me/memory-extraction` does: the subject is `callerSubject(req)`,
    // which for a signed-in user IS `User.userId`. No hand-built prefix anywhere.
    await setExtractionGrant(T, REAL_USER_ID, true, REAL_USER_ID);
    expect(await getExtractionGrant(T, REAL_USER_ID), 'precondition: the row is filed').toBeTruthy();

    const r = await extractConversationMemory(
      T, REAL_USER_ID, 'I work in Berlin and I keep bees',
      async () => ['lives in Berlin', 'keeps bees'],
    );

    expect(r.extracted, 'the consent gate must SEE the grant the route filed').toBe(2);
    expect(await countSubjectNotes(T, personSubject(REAL_USER_ID))).toBe(2);
  });

  it('the notes land where the person can LIST them — the scope the profile route reads', async () => {
    // Guards the other half of D1: fixing the grant key must not move the note scope. The
    // person's own route lists `selfSubject(user.userId)`, i.e. `personSubject(User.userId)`.
    await setExtractionGrant(T, LIST_USER_ID, true, LIST_USER_ID);
    await extractConversationMemory(T, LIST_USER_ID, 'transcript', async () => ['likes cycling']);
    const notes = await listSubjectNotes(T, personSubject(LIST_USER_ID));
    expect(notes.map((n) => n.content)).toContain('likes cycling');
  });

  it('still FAIL-CLOSED with no grant, and with a revoked one', async () => {
    // The property that made the defect harmless must survive the fix.
    const r1 = await extractConversationMemory(T, CLOSED_USER_ID, 'x', async () => ['should not land']);
    expect(r1.extracted).toBe(0);
    expect(await countSubjectNotes(T, personSubject(CLOSED_USER_ID))).toBe(0);

    await setExtractionGrant(T, CLOSED_USER_ID, false, CLOSED_USER_ID);
    const r2 = await extractConversationMemory(T, CLOSED_USER_ID, 'x', async () => ['should not land']);
    expect(r2.extracted).toBe(0);
    expect(await countSubjectNotes(T, personSubject(CLOSED_USER_ID))).toBe(0);
  });

  it('a grant for ANOTHER person does not authorize this one', async () => {
    // The read is exact, not form-tolerant; this pins that it is also not subject-tolerant.
    const other = userIdFor(T, 'oidc:sub-xyz');
    await setExtractionGrant(T, other, true, other);
    const r = await extractConversationMemory(T, OTHER_TARGET_ID, 'x', async () => ['should not land']);
    expect(r.extracted).toBe(0);
    expect(await countSubjectNotes(T, personSubject(OTHER_TARGET_ID))).toBe(0);
  });
});
