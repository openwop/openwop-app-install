/**
 * `PRJWF-1` — a legal hold must stop the project delete cascade.
 *
 * BORN RED. `deleteProject` destroys NINE kinds of durable state — the kanban board and its
 * cards, every cron job the project subject owns, every durable curated note, the in-memory
 * recall set, the `boundSubject` stamps on each bound collection, the knowledge binding, the
 * row, and (at the route) the whole group conversation and a notebook's entire ingested corpus
 * — and it ran under a hold without a word.
 *
 * It is the `AGKM-11` class on a lane with a WIDER destruction set than the roster cascade that
 * class is named for, and one rung worse: the roster cascade at least appears in the
 * destructive-lane census as a named GAP, while this lane appeared NOWHERE. The census derives
 * from storage-level deletes plus seam runners, and a `DurableCollection.delete()` is neither,
 * so no instrument could see it. `PKWF-9` had already named `deleteProject` as one of the two
 * bulk lanes.
 *
 * The legs assert SURVIVAL, not just the throw: a gate that refuses and destroys anyway is the
 * failure this exists to prevent, and a throw-only assertion cannot tell the two apart.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setRetentionHold, clearRetentionHold, RetentionHoldError } from '../src/host/retentionHold.js';
import { createProject, deleteProject, getProject, projectSubject } from '../src/features/projects/projectsService.js';
import { addSubjectNote, countSubjectNotes } from '../src/host/subjectMemory.js';
import { getBoard, subjectBoardId } from '../src/host/kanbanService.js';

const T = 'tPrjHold';

beforeEach(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-prjhold-')) });
  initHostExtPersistence(await openStorage('memory://'));
  await clearRetentionHold(T).catch(() => undefined);
});

describe('PRJWF-1 — the legal hold gates the project delete cascade', () => {
  it('BORN RED — a held tenant REFUSES the delete, and the project and its notes SURVIVE', async () => {
    const p = await createProject(T, 'org-1', { name: 'Held project' });
    await addSubjectNote(T, projectSubject(p.id), 'a fact the hold must preserve');
    expect(await countSubjectNotes(T, projectSubject(p.id)), 'precondition').toBe(1);

    await setRetentionHold(T, 'litigation: Acme v. Foo');

    await expect(deleteProject(T, p.id), 'the cascade must refuse').rejects.toBeInstanceOf(RetentionHoldError);

    // Survival is the real assertion. A gate that throws AFTER destroying is the exact failure
    // this guards, and `rejects` alone cannot distinguish it.
    //
    // CORRECTED — my first version of this leg asserted only the project row and the notes, and
    // a sabotage moving the assertion to AFTER `deleteBoard` left all three legs GREEN. The
    // comment above claimed a property the test did not check. The BOARD is the first thing the
    // cascade destroys, so it is the assertion that actually pins "before the first destructive
    // step"; without it the leg proves only that the gate exists somewhere in the function.
    expect(await getBoard(subjectBoardId(T, projectSubject(p.id))), 'the board — the FIRST thing the cascade destroys — must survive').toBeTruthy();
    expect(await getProject(T, p.id), 'the project row must survive').toBeTruthy();
    expect(await countSubjectNotes(T, projectSubject(p.id)), 'and its notes with it').toBe(1);
  });

  it('positive control — with the hold LIFTED the same delete succeeds and does clear the notes', async () => {
    // Without this, the leg above would pass against a cascade that is simply broken.
    const p = await createProject(T, 'org-1', { name: 'Free project' });
    await addSubjectNote(T, projectSubject(p.id), 'a fact that should go');
    await setRetentionHold(T, 'temporary');
    await clearRetentionHold(T);

    const out = await deleteProject(T, p.id);
    expect(out.deleted).toBe(true);
    expect(await getProject(T, p.id)).toBeNull();
    expect(await countSubjectNotes(T, projectSubject(p.id))).toBe(0);
  });

  it('the hold is asserted BEFORE the first destructive step, not midway', async () => {
    // Ordering matters: a hold checked after the board delete would leave a half-destroyed
    // project behind a refusal. Asserted by destroying nothing on a held tenant, above — this
    // leg pins the *reason* by checking a non-existent project is still a clean no-op under a
    // hold rather than a throw, i.e. the guard sits after the existence check.
    await setRetentionHold(T, 'litigation');
    await expect(deleteProject(T, 'project-does-not-exist')).resolves.toMatchObject({ deleted: false });
  });
});
