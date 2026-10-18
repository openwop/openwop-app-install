/**
 * KTORG-2 (KTO-2) — the org challenge library update is a CAS, not
 * read-modify-write: concurrent edits never lose one another.
 *
 * Before: `setLibraryEntry` was get → filter → put (or delete when empty). Two
 * concurrent adds both read the same library and the later `put` dropped the
 * other's entry; a remove-the-last-entry racing an add either deleted the add
 * or resurrected the removed entry.
 *
 * The removal-to-empty half matters because KTORG-D1 requires an empty library
 * to be NO row and `Storage` has no compare-and-delete. The service claims an
 * EMPTYING row by CAS, then deletes; a writer never builds on an empty row, and a
 * stale one (crashed claimant) is retired rather than wedging the library.
 *
 * Sabotage that turns this red (witnessed): restoring get → put / delete
 * (cases 1 and 2 red); a bare delete without the emptying
 * CAS claim (case 5 red); dropping the stale-retire branch (case 3 red); letting a
 * writer build on a fresh emptying row (case 4 red).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createDraft, publishChallenge } from '../src/features/kicktodo-core/challengeService.js';
import {
  getLibrary, OrgLibraryConflictError, setLibraryEntry, type OrgChallengeLibrary,
} from '../src/features/kicktodo-organizations/orgProgramService.js';

const T = 'tenant-kt-org-cas';
const libraries = () => new DurableCollection<OrgChallengeLibrary>('kicktodo-org-libraries', (l) => `${l.tenantId}::${l.orgId}`);

/** A read barrier on ONE key: the first `n` reads of it are held until all `n`
 *  have arrived, so every racer reads the same library before any of them writes.
 *  Without it the add's extra `getChallenge` await let the removal finish first
 *  and the "race" ran sequentially (measured: case 2 passed on the old code). */
let barrier: { key: string; n: number; waiting: Array<() => void> } | null = null;

beforeAll(async () => {
  const real = await openStorage('memory://');
  const kvGet = real.kvGet.bind(real);
  real.kvGet = async (key: string) => {
    const b = barrier;
    if (b && key.endsWith(b.key)) {
      await new Promise<void>((resolve) => {
        b.waiting.push(resolve);
        if (b.waiting.length === b.n) { barrier = null; for (const r of b.waiting) r(); }
      });
    }
    return kvGet(key);
  };
  // Delete gate: hold a delete of ONE key until a compare-and-swap on that key has
  // settled — forces a concurrent writer's CAS into the gap between the remover's
  // decision and its delete (the window a bare delete-after-read loses data in).
  const kvDelete = real.kvDelete.bind(real);
  const kvCas = real.kvCompareAndSwap.bind(real);
  real.kvDelete = async (key: string) => {
    const g = deleteGate;
    if (g && key.endsWith(g.key)) {
      deleteGate = null;
      // Bounded: code with no CAS at all never releases the gate — red, not a hang.
      await Promise.race([g.casSettled, new Promise<void>((r) => setTimeout(r, 1_000))]);
    }
    return kvDelete(key);
  };
  real.kvCompareAndSwap = async (key: string, expected: string | null, next: string) => {
    const out = await kvCas(key, expected, next);
    if (gateRelease && key.endsWith(gateRelease.key) && expected !== null && !next.includes('"entries":[]')) {
      const r = gateRelease; gateRelease = null; r.release();
    }
    return out;
  };
  initHostExtPersistence(real);
});

let deleteGate: { key: string; casSettled: Promise<void> } | null = null;
let gateRelease: { key: string; release: () => void } | null = null;
function armDeleteGate(key: string): void {
  let release!: () => void;
  const casSettled = new Promise<void>((r) => { release = r; });
  deleteGate = { key, casSettled };
  gateRelease = { key, release };
}

async function published(title: string): Promise<string> {
  const draft = await createDraft({
    tenantId: T, title, summary: 's', outcome: 'o', durationDays: 3,
    activities: [{ stableActivityId: 'a1', day: 1, title: 'Act', instructions: '', evidencePolicy: 'attestation' }],
  });
  await publishChallenge(T, draft.id, 1);
  return draft.id;
}

const ids = (lib: OrgChallengeLibrary | null): string[] => (lib?.entries ?? []).map((e) => e.challengeId).sort();

describe('KTORG-2 — concurrent org library edits', () => {
  it('two concurrent adds both land', async () => {
    const [a, b] = [await published('A'), await published('B')];
    barrier = { key: `${T}::org-1`, n: 2, waiting: [] };
    await Promise.all([
      setLibraryEntry(T, 'org-1', 'user:c1', { challengeId: a, version: 1, present: true }),
      setLibraryEntry(T, 'org-1', 'user:c2', { challengeId: b, version: 1, present: true }),
    ]);
    expect(ids(await getLibrary(T, 'org-1')), 'one concurrent add was lost').toEqual([a, b].sort());
  });

  it('removing the last entry while another is added keeps exactly the added one', async () => {
    const [x, y] = [await published('X'), await published('Y')];
    await setLibraryEntry(T, 'org-2', 'user:c1', { challengeId: x, version: 1, present: true });
    barrier = { key: `${T}::org-2`, n: 2, waiting: [] };
    await Promise.all([
      setLibraryEntry(T, 'org-2', 'user:c1', { challengeId: x, version: 1, present: false }),
      setLibraryEntry(T, 'org-2', 'user:c2', { challengeId: y, version: 1, present: true }),
    ]);
    expect(ids(await getLibrary(T, 'org-2')), 'the add was deleted, or the removal was undone').toEqual([y]);
  });

  it('a STALE emptying row (crashed claimant) is retired, not a wedge', async () => {
    const z = await published('Z');
    await libraries().put({ tenantId: T, orgId: 'org-3', entries: [], updatedAt: new Date(Date.now() - 120_000).toISOString() });
    await setLibraryEntry(T, 'org-3', 'user:c1', { challengeId: z, version: 1, present: true });
    expect(ids(await getLibrary(T, 'org-3'))).toEqual([z]);
  });

  it('a FRESH emptying row is never built on — the writer backs off and reports a conflict', async () => {
    const w = await published('W');
    await libraries().put({ tenantId: T, orgId: 'org-4', entries: [], updatedAt: new Date().toISOString() });
    await expect(setLibraryEntry(T, 'org-4', 'user:c1', { challengeId: w, version: 1, present: true }))
      .rejects.toBeInstanceOf(OrgLibraryConflictError);
    expect((await getLibrary(T, 'org-4'))?.entries, 'a write landed on a row about to be deleted').toEqual([]);
  });

  it('an add landing between the remover\'s read and its delete is not erased', async () => {
    // The emptying claim is what this pins: with a bare `delete` after the read,
    // the adder's CAS (from the same [x]) lands first and the delete erases it.
    const [x, y] = [await published('X5'), await published('Y5')];
    await setLibraryEntry(T, 'org-5', 'user:c1', { challengeId: x, version: 1, present: true });
    barrier = { key: `${T}::org-5`, n: 2, waiting: [] };
    armDeleteGate(`${T}::org-5`);
    await Promise.all([
      setLibraryEntry(T, 'org-5', 'user:c1', { challengeId: x, version: 1, present: false }),
      setLibraryEntry(T, 'org-5', 'user:c2', { challengeId: y, version: 1, present: true }),
    ]);
    expect(ids(await getLibrary(T, 'org-5')), 'the delete erased a concurrent add').toEqual([y]);
  });
});

