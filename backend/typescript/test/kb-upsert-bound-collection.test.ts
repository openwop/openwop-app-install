/**
 * #5756 — `upsertDocument` on a SUBJECT-BOUND collection.
 *
 * The defect: the upsert gated the collection WITH its caller, removed the prior
 * row, then called `ingestDocument` WITHOUT the caller. The inner gate refused
 * every bound collection, so an authorized replace threw AFTER the old version was
 * gone. These legs pin the three outcomes the issue names:
 *   (a) an authorized caller replaces the document on a bound collection;
 *   (b) a replace that fails after the gate leaves the prior row present and
 *       readable at its old revision, both for a refusal (an unresolvable source)
 *       and for a durable write fault after the prior row was removed;
 *   (c) an unauthorized or absent caller is refused and the prior row is intact.
 *
 * The resolver is a stub for `kind:'project'` so the legs exercise the KB gate
 * alone, not the projects feature's membership model.
 *
 * SABOTAGE-WITNESSED: passing `undefined` instead of `caller` to `prepareIngest`
 * reds all four legs ("Collection not found." — the fixture's first-time upsert is
 * refused too, so (a) can never replace); moving `prepareIngest` back after
 * `removeDocumentRow` (the old delete-first order) reds the unresolvable-source
 * leg (prior text undefined); dropping the `restoreDocumentRow` call reds the
 * write-fault leg.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { registerSubjectAccessResolver } from '../src/host/subjectAccess.js';
import {
  createCollection, getCollection, getDocument, listDocumentRevisions, upsertDocument,
  _kbUpsertsInFlightForTest,
} from '../src/features/kb/kbService.js';

const T = 'kb5756-tenant';
const ORG = 'o1';
const MEMBER = { subject: 'alice' };
const OUTSIDER = { subject: 'mallory' };
const V1 = 'v1 — the original corpus text';
const V2 = 'v2 — the replacement corpus text';
const FAULT_MARK = 'FAULT-ON-DURABLE-PUT';

/** Arms one failure of the durable write whose value carries `FAULT_MARK`. */
let faultArmed = false;

beforeAll(() => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kb5756-')) });
  registerSubjectAccessResolver('project', async (_t, subject, caller) =>
    subject.id === 'p1' && caller === 'alice' ? 'write' : 'none');
});
beforeEach(() => {
  faultArmed = false;
  const storage = openSqliteStorage(':memory:');
  initHostExtPersistence(new Proxy(storage, {
    get(target, prop, receiver) {
      const v: unknown = Reflect.get(target, prop, receiver);
      if (prop === 'kvSet' && typeof v === 'function') {
        return async (key: string, value: string, ...rest: unknown[]) => {
          if (faultArmed && value.includes(FAULT_MARK)) { faultArmed = false; throw new Error('simulated durable write fault'); }
          return (v as (...a: unknown[]) => Promise<unknown>).call(target, key, value, ...rest);
        };
      }
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }));
});

async function boundCollectionWithV1(): Promise<string> {
  const col = await createCollection(T, ORG, 'alice', { name: 'Project corpus' }, { boundSubject: { kind: 'project', id: 'p1' } });
  // First-time upsert: no prior row, so this is a create through the same path.
  await upsertDocument(T, ORG, col.collectionId, 'doc-1', 'alice', { title: 'Plan', text: V1 }, MEMBER);
  return col.collectionId;
}

async function expectPriorIntact(collectionId: string): Promise<void> {
  const doc = await getDocument(T, ORG, collectionId, 'doc-1', MEMBER);
  expect(doc?.text).toBe(V1);
  expect(doc?.revision ?? 1).toBe(1); // no revision burnt by the failed replace
  expect((await getCollection(T, ORG, collectionId, MEMBER))?.documentCount).toBe(1);
  expect(_kbUpsertsInFlightForTest()).toEqual([]); // KB-8 marker cleared on the failure path
}

describe('#5756 — upsertDocument on a subject-bound collection', () => {
  it('(a) an authorized caller replaces the document', async () => {
    const collectionId = await boundCollectionWithV1();
    expect((await getDocument(T, ORG, collectionId, 'doc-1', MEMBER))?.text).toBe(V1);

    const out = await upsertDocument(T, ORG, collectionId, 'doc-1', 'alice', { title: 'Plan', text: V2 }, MEMBER);
    expect(out.revision).toBe(2);
    const doc = await getDocument(T, ORG, collectionId, 'doc-1', MEMBER);
    expect(doc?.text).toBe(V2);
    expect((await listDocumentRevisions(T, ORG, collectionId, 'doc-1', MEMBER)).map((r) => r.revision)).toEqual([2, 1]);
    expect((await getCollection(T, ORG, collectionId, MEMBER))?.documentCount).toBe(1);
  });

  it('(b) a source that fails to resolve after the gate leaves the prior row intact', async () => {
    const collectionId = await boundCollectionWithV1();
    await expect(upsertDocument(T, ORG, collectionId, 'doc-1', 'alice', { title: 'Plan', url: 'ftp://not-http.example' }, MEMBER))
      .rejects.toThrow(/http\(s\) URL/);
    await expectPriorIntact(collectionId);
    expect((await listDocumentRevisions(T, ORG, collectionId, 'doc-1', MEMBER)).map((r) => r.revision)).toEqual([1]);
  });

  it('(b) a durable write fault after the prior row was removed restores it', async () => {
    const collectionId = await boundCollectionWithV1();
    faultArmed = true;
    await expect(upsertDocument(T, ORG, collectionId, 'doc-1', 'alice', { title: 'Plan', text: `${V2} ${FAULT_MARK}` }, MEMBER))
      .rejects.toThrow(/simulated durable write fault/);
    expect(faultArmed).toBe(false); // the fault actually fired on the new row's put
    await expectPriorIntact(collectionId);
    // The restored row is a real row: the next replace goes through normally.
    const out = await upsertDocument(T, ORG, collectionId, 'doc-1', 'alice', { title: 'Plan', text: V2 }, MEMBER);
    expect(out.revision).toBe(2);
  });

  it('(c) an unauthorized or absent caller is refused and the prior row is intact', async () => {
    const collectionId = await boundCollectionWithV1();
    await expect(upsertDocument(T, ORG, collectionId, 'doc-1', 'mallory', { title: 'Plan', text: V2 }, OUTSIDER)).rejects.toThrow(/not found/i);
    await expect(upsertDocument(T, ORG, collectionId, 'doc-1', 'system', { title: 'Plan', text: V2 })).rejects.toThrow(/not found/i);
    await expectPriorIntact(collectionId);
  });
});
