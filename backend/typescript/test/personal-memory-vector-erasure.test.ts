/**
 * ADR 0666 D2 — a DSAR on a person must leave nothing a later recall can serve.
 *
 * BORN RED. `eraseSubjectMemory` deleted vector rows BY ID, and the ids came only from the
 * durable note store. Dispatch turn-summaries are indexed with no durable note row, so none of
 * their ids were reachable — and the `if (ids.length)` guard meant a person with ONLY turn
 * summaries got no vector deletion at all. `subjectMemory.read` prefers the vector path over
 * recency, so the erased content was exactly what a later recall would return.
 *
 * This mirrors the agent lane's witness (`roster-lifecycle.test.ts`, ADR 0664 D1). The
 * reachability that makes it matter for people: `userIdFor` is deterministic, so re-provisioning
 * the same principal in the same tenant lands on the SAME memory namespace.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  addSubjectNote, eraseSubjectMemory, createSubjectMemoryPort, subjectMemoryScope, countSubjectNotes,
} from '../src/host/subjectMemory.js';
import { personSubject } from '../src/host/subject.js';
import { userIdFor } from '../src/features/users/usersService.js';

const T = 'tVecErase';
const SECRET = 'bluebird-personal-fact';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0666-vec-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('ADR 0666 D2 — erasure reaches the recall index', () => {
  it('anti-vacuity: the id is deterministic, so a re-provision really does reuse the namespace', () => {
    // If this stopped holding, the leg below would pass for the wrong reason (a fresh namespace).
    expect(userIdFor(T, 'oidc:p-1')).toBe(userIdFor(T, 'oidc:p-1'));
    expect(userIdFor(T, 'oidc:p-1')).not.toBe(userIdFor(T, 'oidc:p-2'));
  });

  it('BORN RED — a turn summary with NO curated note is gone after a DSAR', async () => {
    // The case the old `if (ids.length)` guard skipped ENTIRELY: nothing durable to collect ids
    // from, so the vector delete never even ran.
    const userId = userIdFor(T, 'oidc:p-summary-only');
    const subject = personSubject(userId);
    const scope = subjectMemoryScope(subject);
    const port = createSubjectMemoryPort(T);

    // A dispatch turn summary — written through the recall port, no durable note row.
    await port.write(scope, { content: SECRET });
    expect(await countSubjectNotes(T, subject), 'precondition: NO curated notes').toBe(0);
    const before = await port.read(scope, SECRET);
    expect(JSON.stringify(before), 'precondition: it is recallable').toContain(SECRET);

    await eraseSubjectMemory(T, userId);

    // The same principal re-provisions onto the SAME namespace (deterministic id).
    expect(userIdFor(T, 'oidc:p-summary-only')).toBe(userId);
    const after = await port.read(scope, SECRET);
    expect(JSON.stringify(after), 'the erased turn summary must not be recallable').not.toContain(SECRET);
  });

  it('a curated note is still erased too — the old path must not regress', async () => {
    const userId = userIdFor(T, 'oidc:p-with-note');
    const subject = personSubject(userId);
    const scope = subjectMemoryScope(subject);
    const port = createSubjectMemoryPort(T);

    await addSubjectNote(T, subject, 'I keep bees');
    expect(await countSubjectNotes(T, subject)).toBe(1);

    await eraseSubjectMemory(T, userId);

    expect(await countSubjectNotes(T, subject)).toBe(0);
    expect(JSON.stringify(await port.read(scope, 'bees'))).not.toContain('I keep bees');
  });

  it('erasing one person leaves ANOTHER person’s memory intact (the purge is scoped)', async () => {
    // The namespace purge is unbounded where the id-delete was bounded, so this is the leg that
    // would catch the over-set reaching a scope it must not.
    const victim = userIdFor(T, 'oidc:p-victim');
    const bystander = userIdFor(T, 'oidc:p-bystander');
    const bScope = subjectMemoryScope(personSubject(bystander));
    const port = createSubjectMemoryPort(T);

    await port.write(subjectMemoryScope(personSubject(victim)), { content: 'victim-fact' });
    await port.write(bScope, { content: 'bystander-fact' });
    await addSubjectNote(T, personSubject(bystander), 'bystander note');

    await eraseSubjectMemory(T, victim);

    expect(JSON.stringify(await port.read(bScope, 'bystander')), 'the bystander survives').toContain('bystander-fact');
    expect(await countSubjectNotes(T, personSubject(bystander))).toBe(1);
  });
});
