/**
 * Subject memory (ADR 0041) — unit-level invariants of the shared seam:
 *   - scope convention is principal-agnostic + agent specialization byte-identical
 *   - curated notes are DURABLE: they survive the in-memory recall store being
 *     wiped (the "twin corpus persists across restart" guarantee, Phase 2)
 *   - per-subject + per-tenant isolation (CTI-1)
 *   - delete is consistent and fail-closed
 *
 * @see docs/adr/0041-subject-memory.md
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  subjectMemoryScope,
  addSubjectNote,
  listSubjectNotes,
  countSubjectNotes,
  removeSubjectNote,
  clearSubjectNotes,
  type MemorySubject,
} from '../src/host/subjectMemory.js';
import { agentMemoryScope } from '../src/host/agentMemoryAdapter.js';
import { initInMemorySurfaces, clearMemoryScope } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-subjmem-')) });
  // Curated notes are durable — wire the host-ext storage the DurableCollection
  // reads/writes (an in-memory sqlite, the same backend route tests boot).
  initHostExtPersistence(await openStorage('memory://'));
});

const T = 'tenant-sm';
const user = (id: string): MemorySubject => ({ kind: 'user', id });

describe('subjectMemoryScope', () => {
  it('is principal-keyed and the agent specialization is byte-identical', () => {
    expect(subjectMemoryScope({ kind: 'agent', id: 'core.x' })).toBe('agent:core.x');
    expect(subjectMemoryScope({ kind: 'user', id: 'u1' })).toBe('user:u1');
    expect(agentMemoryScope('core.x')).toBe(subjectMemoryScope({ kind: 'agent', id: 'core.x' }));
  });
});

describe('curated notes are durable', () => {
  it('survive the in-memory recall store being wiped (restart simulation)', async () => {
    const u = user('durable-1');
    await addSubjectNote(T, u, 'I prefer concise briefings.');
    await addSubjectNote(T, u, 'My timezone is US/Pacific.');
    expect(await countSubjectNotes(T, u)).toBe(2);

    // Simulate a process restart: the in-memory recall index is gone, but the
    // DurableCollection (source of truth) persists.
    clearMemoryScope(T, subjectMemoryScope(u));

    const notes = await listSubjectNotes(T, u);
    expect(notes.length).toBe(2);
    expect(notes.map((n) => n.content)).toContain('My timezone is US/Pacific.');
  });
});

describe('isolation + delete', () => {
  it('a tenant/subject never sees another\'s notes, and delete is consistent + fail-closed', async () => {
    const a = user('iso-a');
    const b = user('iso-b');
    await addSubjectNote(T, a, 'A-only fact');
    expect(await listSubjectNotes(T, b)).toEqual([]);
    expect(await listSubjectNotes('tenant-other', a)).toEqual([]); // CTI-1

    const id = (await listSubjectNotes(T, a))[0].id;
    // Wrong subject id → no-op, fail-closed.
    expect(await removeSubjectNote(T, b, id)).toBe(false);
    expect((await listSubjectNotes(T, a)).length).toBe(1);
    // Correct subject → removed.
    expect(await removeSubjectNote(T, a, id)).toBe(true);
    expect(await listSubjectNotes(T, a)).toEqual([]);
    // Deleting again → false (already gone).
    expect(await removeSubjectNote(T, a, id)).toBe(false);
  });
});

describe('clearSubjectNotes (delete-subject cascade)', () => {
  it('drops all of a subject\'s durable notes and is tenant/subject-scoped', async () => {
    const a = { kind: 'agent', id: 'cascade-1' } as const;
    await addSubjectNote(T, a, 'fact one');
    await addSubjectNote(T, a, 'fact two');
    const other = user('cascade-keep');
    await addSubjectNote(T, other, 'keep me');

    expect(await clearSubjectNotes(T, a)).toBe(2);
    expect(await listSubjectNotes(T, a)).toEqual([]);
    // A different subject is untouched.
    expect((await listSubjectNotes(T, other)).length).toBe(1);
  });
});

describe('validation', () => {
  it('rejects empty + over-long notes', async () => {
    const u = user('val-1');
    await expect(addSubjectNote(T, u, '   ')).rejects.toThrow();
    await expect(addSubjectNote(T, u, 'x'.repeat(4001))).rejects.toThrow();
  });
});
