/**
 * `PROBE-KT2`, migrated from a prose census to an executable assertion.
 *
 * The probe read: "handle-index bijection: every `kicktodo-creator-profiles`
 * row's handle has exactly one index row pointing back at its subject". It had
 * no coverage — the only test touching `handleIndex` seeds it directly and
 * exercises erasure, never the RENAME path, which is the one place a bijection
 * can actually break: `upsertProfile` CLAIMS the new handle before releasing the
 * old one (deliberately, so a mid-way failure fails CLOSED — `communityService.ts:194`).
 *
 * A bijection has TWO failure directions and a census of one number sees
 * neither cleanly:
 *   - a LEAK — the old handle's index row survives a rename, so a freed handle
 *     stays unclaimable and points at a profile that no longer bears it;
 *   - a STEAL — the release runs against the wrong key and frees a handle the
 *     profile still holds, letting another subject claim a live handle.
 * Both are asserted below, in both directions.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { upsertProfile, __test } from '../src/features/kicktodo-community/communityService.js';

const T = 'tenant-A';
const ALICE = 'user:alice';
const BOB = 'user:bob';

/** The bijection, computed from the two stores — the probe's actual claim. */
async function bijectionErrors(tenantId: string): Promise<string[]> {
  const profs = (await __test.profiles.list()).filter((p) => p.tenantId === tenantId);
  const idx = (await __test.handleIndex.list()).filter((h) => h.tenantId === tenantId);
  const errs: string[] = [];
  for (const p of profs) {
    const hits = idx.filter((h) => h.handleLower === p.handle);
    if (hits.length !== 1) errs.push(`profile ${p.creatorSubject} handle "${p.handle}" has ${hits.length} index rows (want 1)`);
    else if (hits[0].creatorSubject !== p.creatorSubject) errs.push(`index "${p.handle}" points at ${hits[0].creatorSubject}, not ${p.creatorSubject}`);
  }
  for (const h of idx) {
    if (!profs.some((p) => p.handle === h.handleLower && p.creatorSubject === h.creatorSubject)) {
      errs.push(`ORPHAN index row "${h.handleLower}" → ${h.creatorSubject} with no matching profile`);
    }
  }
  return errs;
}

const mk = (subject: string, handle: string) =>
  upsertProfile(T, subject, { handle, displayName: `Name ${handle}` });

beforeEach(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kt2-')) });
  initHostExtPersistence(await openStorage('memory://'));
});

describe('PROBE-KT2 (executable) — creator-handle index is a bijection', () => {
  it('holds after a create', async () => {
    await mk(ALICE, 'alice-one');
    // PRECONDITION: the stores are non-empty, so an empty-set bijection cannot pass vacuously.
    expect((await __test.profiles.list()).length, 'no profile written — the check below would be vacuous').toBe(1);
    expect((await __test.handleIndex.list()).length).toBe(1);
    expect(await bijectionErrors(T)).toEqual([]);
  });

  it('holds across a RENAME — the old handle is released, not leaked', async () => {
    await mk(ALICE, 'alice-one');
    await mk(ALICE, 'alice-two');

    expect(await bijectionErrors(T)).toEqual([]);
    const idx = (await __test.handleIndex.list()).filter((h) => h.tenantId === T);
    expect(idx.map((h) => h.handleLower), 'the renamed-from handle leaked an index row').toEqual(['alice-two']);
  });

  it('frees the old handle for another subject after a rename', async () => {
    await mk(ALICE, 'alice-one');
    await mk(ALICE, 'alice-two');
    await mk(BOB, 'alice-one'); // must succeed — alice released it
    expect(await bijectionErrors(T)).toEqual([]);
    expect((await __test.profiles.list()).length).toBe(2);
  });

  it('refuses to STEAL a live handle — the other failure direction', async () => {
    await mk(ALICE, 'alice-one');
    await expect(mk(BOB, 'alice-one'), 'a second subject claimed a LIVE handle').rejects.toThrow();
    expect(await bijectionErrors(T)).toEqual([]);
  });
});
