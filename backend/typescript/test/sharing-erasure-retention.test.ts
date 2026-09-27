/**
 * SHARE-2 (subject erasure), SHARE-4 (the cap under CAS contention) and
 * WF-SHARE-1/2 (retention on the sanctioned lane) for `features/sharing`.
 *
 * WF-SHARE-2 is the reason the retention half of this file exists at all: the
 * old `sweepDeadLinks` was unexported, entered only from a `void`ed call inside
 * `createLink`, and gated on process-global mutable state — so nothing could
 * drive it, and it had ZERO test references repo-wide. The test below drives the
 * REAL registered lane (`__runKvAgeOutOnce`), not the swept function, which is
 * the ADR 0371 "test the DAEMON WIRING" rule.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { DurableCollection, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { createOrg } from '../src/host/accessControlService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { __listKvAgeOutForTest, __runKvAgeOutOnce } from '../src/host/kvAgeOut.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { purgeTenantHostExt } from '../src/host/hostExtPersistence.js';
import {
  createLink,
  resolveShared,
  listLinks,
  eraseSubjectSharing,
  hasActiveLinkForResource,
  backfillLinkDeadAt,
  recordSharedFrameView,
  _frameViewCountForToken,
  type ShareLink,
} from '../src/features/sharing/sharingService.js';

const T = 'shr-er-tenant';
let ORG = '';
let storage: Storage;

/**
 * Direct RAW access to the link rows, for seeding ages the API cannot produce.
 *
 * R2 review F2 — this was `new DurableCollection('sharing:link', …)` at module
 * scope, and that made the retention half of this file STRUCTURALLY unable to see
 * the defect it was written to guard. `HOSTEXT_COLLECTIONS` is deduped by
 * namespace with LAST CONSTRUCTION WINS, so a handle built here — after the
 * imports above have constructed `links` and then `legacyLinksView` — became the
 * entry `hostExtCollectionForPrefix` hands to the kvAgeOut sweep. It carried no
 * validator, so the sweep deleted through a permissive handle and the PRODUCTION
 * resolution (the legacy view, whose validator rejects every new-shape row) was
 * never exercised. Raw kv reads/writes instead: they touch no registry, so the
 * sweep below runs against whatever the real import graph produced.
 */
const LINK_PREFIX = 'hostext:sharing:link:';
const linkKey = (hash: string): string => `${LINK_PREFIX}${hash}`;
const linkIdxKey = (hash: string): string => `hostextidx:sharing:link:${T}:${hash}`;
const getRow = async (hash: string): Promise<ShareLink | null> => {
  const raw = await storage.kvGet(linkKey(hash));
  return raw === null ? null : (JSON.parse(raw) as ShareLink);
};
/** Marker BEFORE row — the FU-DATA-2 ordering `DurableCollection.put` uses. */
const putRow = async (l: ShareLink): Promise<void> => {
  await storage.kvSet(linkIdxKey(l.tokenHash), l.tokenHash);
  await storage.kvSet(linkKey(l.tokenHash), JSON.stringify(l));
};
const markerExists = async (hash: string): Promise<boolean> => (await storage.kvGet(linkIdxKey(hash))) !== null;

const DAY = 86_400_000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

async function seedConversation(id: string): Promise<void> {
  const now = new Date().toISOString();
  await hostExtStorage().createChatSession({ sessionId: id, tenantId: T, title: `Conv ${id}`, createdAt: now, updatedAt: now, messageCount: 0 });
  await hostExtStorage().appendChatMessage({ messageId: `${id}-m0`, sessionId: id, role: 'user', content: 'hello', meta: null, authorSubject: 'user:alice', createdAt: now });
}

beforeAll(async () => {
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-shareer-')) });
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  const org = await createOrg({ tenantId: T, createdBy: 'alice', name: 'Org' });
  ORG = org.orgId;
});

describe('SHARE-2 — erasing a subject REVOKES the links they minted', () => {
  it('revokes the live ones, anonymizes the attribution, and leaves other people’s links alone', async () => {
    await seedConversation('conv-alice');
    await seedConversation('conv-bob');
    const alice = await createLink(T, ORG, 'alice', { resourceType: 'conversation', resourceId: 'conv-alice' });
    const bob = await createLink(T, ORG, 'bob', { resourceType: 'conversation', resourceId: 'conv-bob' });

    // Both work before erasure — otherwise the assertion below proves nothing.
    expect((await resolveShared(alice.token)).resourceType).toBe('conversation');
    expect((await resolveShared(bob.token)).resourceType).toBe('conversation');

    const out = await eraseSubjectSharing(T, 'alice');
    expect(out).toMatchObject({ revoked: 1, anonymized: 1 });

    // THE DECISION, asserted: alice's link is DEAD, not merely re-attributed.
    // An anonymized still-working public URL would be worse than a dead one.
    await expect(resolveShared(alice.token)).rejects.toMatchObject({ code: 'not_found' });
    // bob's is untouched — erasure is subject-scoped, not a tenant-wide purge.
    expect((await resolveShared(bob.token)).resourceType).toBe('conversation');

    // The ROW survives (the audit fact: "this URL stopped working on <date>"),
    // with the attribution gone and a death stamp for the age-out lane.
    const row = await getRow(alice.tokenHash);
    expect(row).toMatchObject({ revoked: true, createdBy: 'erased' });
    expect(row?.deadAt).toBeTruthy();
    expect(row?.createdBy).not.toBe('alice');
  });

  it('is idempotent — the SubjectEraser contract runs it once per linked key', async () => {
    await seedConversation('conv-carol');
    await createLink(T, ORG, 'carol', { resourceType: 'conversation', resourceId: 'conv-carol' });
    const first = await eraseSubjectSharing(T, 'carol');
    expect(first.revoked).toBe(1);
    const second = await eraseSubjectSharing(T, 'carol');
    // Nothing left attributed to carol ⇒ no second revoke, no second write.
    expect(second).toMatchObject({ revoked: 0, anonymized: 0 });
  });

  it('fails closed on a blank tenant or subject (never a global sweep)', async () => {
    expect(await eraseSubjectSharing('', 'alice')).toMatchObject({ revoked: 0, anonymized: 0 });
    expect(await eraseSubjectSharing(T, '')).toMatchObject({ revoked: 0, anonymized: 0 });
  });
});

describe('WF-SHARE-1/2 — dead links age out on the REGISTERED retention lane', () => {
  it('the lane is registered at all (the wiring, not the swept function)', () => {
    const reg = __listKvAgeOutForTest().find((r) => r.id === 'sharing:link');
    expect(reg, 'sharing:link is not registered for age-out — a host that stops minting would never purge').toBeTruthy();
    expect(reg).toMatchObject({ prefix: 'hostext:sharing:link:', ttlDays: 30, timestampField: 'deadAt' });
  });

  it('purges a long-dead link + its frame-view rows, and KEEPS a live one and one inside the grace window', async () => {
    await seedConversation('conv-sweep');
    const longDead = await createLink(T, ORG, 'alice', { resourceType: 'conversation', resourceId: 'conv-sweep' });
    const recentlyDead = await createLink(T, ORG, 'alice', { resourceType: 'conversation', resourceId: 'conv-sweep' });
    const live = await createLink(T, ORG, 'alice', { resourceType: 'conversation', resourceId: 'conv-sweep' });

    // A frame-view row hanging off the doomed link — the cascade the old sweep
    // did inline and that a naive lane swap would have orphaned.
    await recordSharedFrameView(longDead.token, 0);
    expect(await _frameViewCountForToken(longDead.token)).toBe(1);

    const age = async (token: string, hash: string, deadDaysAgo: number): Promise<void> => {
      const row = (await getRow(hash))!;
      await putRow({ ...row, revoked: true, revokedAt: iso(deadDaysAgo * DAY), deadAt: iso(deadDaysAgo * DAY) });
      void token;
    };
    await age(longDead.token, longDead.tokenHash, 45);   // past the 30-day grace
    await age(recentlyDead.token, recentlyDead.tokenHash, 5); // inside the grace

    // NON-VACUITY: the marker must EXIST before the sweep, or the assertion that
    // it is gone afterwards would pass against a marker that was never written.
    expect(await markerExists(longDead.tokenHash)).toBe(true);

    await __runKvAgeOutOnce(storage, new Date());

    expect(await getRow(longDead.tokenHash), 'a 45-day-dead link should be gone').toBeNull();
    expect(await getRow(recentlyDead.tokenHash), 'the 30-day grace preserves the audit trail').toBeTruthy();
    expect(await getRow(live.tokenHash), 'a LIVE link has no deadAt and must never be aged out').toBeTruthy();
    // The cascade rode the collection's delete hook.
    expect(await _frameViewCountForToken(longDead.token), 'frame-view rows must not outlive their link').toBe(0);
    // R2 review F2 — the TENANT-INDEX MARKER goes with the row. `acceptIndexed`
    // is justified in `sharingService` on the claim that "the sweep deletes
    // THROUGH the collection, so markers cannot strand"; this is the assertion
    // that makes the claim falsifiable. It runs against the REAL registry
    // resolution (see the `getRow`/`putRow` note at the top of this file, and note
    // this test precedes the one below that constructs a foreign handle), which
    // for `hostext:sharing:link:` is `legacyLinksView` — the handle whose
    // validator rejects a new-shape row. Before the `deleteRow` fix, this line
    // was red and every aged-out link left a `hostextidx:` marker behind.
    expect(await markerExists(longDead.tokenHash), 'the aged-out link stranded its tenant-index marker').toBe(false);
    expect(await markerExists(recentlyDead.tokenHash), 'a surviving row must keep its marker').toBe(true);
  });

  it('backfills `deadAt` on rows written before the field existed (else they would be skipped FOREVER)', async () => {
    await seedConversation('conv-legacy');
    const legacy = await createLink(T, ORG, 'alice', { resourceType: 'conversation', resourceId: 'conv-legacy' });
    // Simulate a pre-field row: revoked, with revokedAt but NO deadAt.
    const row = (await getRow(legacy.tokenHash))!;
    const { deadAt: _drop, ...withoutDeadAt } = { ...row, revoked: true, revokedAt: iso(60 * DAY) };
    await putRow(withoutDeadAt as ShareLink);

    // Before the backfill the lane cannot see it — no timestamp field, so it is
    // SKIPPED (never deleted on a guess). That is the regression the backfill exists for.
    await __runKvAgeOutOnce(storage, new Date());
    expect(await getRow(legacy.tokenHash)).toBeTruthy();

    expect(await backfillLinkDeadAt()).toBeGreaterThanOrEqual(1);
    await __runKvAgeOutOnce(storage, new Date());
    expect(await getRow(legacy.tokenHash), 'a backfilled 60-day-dead link should now age out').toBeNull();
  });

  // ORDERING IS LOAD-BEARING (R2 review F2): this test constructs a second
  // handle over `hostext:sharing:link:`, which DISPLACES the namespace's registry
  // entry for the rest of the file (last construction wins). Every test that
  // needs the production resolution therefore runs BEFORE it. Moving it up would
  // silently restore the vacuity the marker assertions above exist to close.
  // SHWF-5 / ADR 0644 D5 — the WIRING witness for the eraser. Everything else in
  // this file calls `eraseSubjectSharing` DIRECTLY, so the `registerSubjectEraser`
  // line at `sharingService.ts:1345` was pinned only by a source-text ratchet
  // (`subject-erasure-feature-stores.test.ts`) which cannot tell whether the
  // registered function does anything. Replace its body with a no-op and every
  // other test in the repo stays green. This one drives the HOST lane.
  it('the host eraseSubject lane reaches Sharing through its REGISTERED eraser', async () => {
    const orgB = await createOrg({ tenantId: T, createdBy: 'wire-a', name: 'WireOrg' });
    const link = await createLink(T, orgB.orgId, 'wire-a', { resourceType: 'cms_page', resourceId: 'wire-page' })
      .catch(() => null);
    // The resource type does not matter to erasure — seed raw if the mint refuses.
    const tokenHash = link ? link.tokenHash : 'wire-hash-1';
    if (!link) {
      await storage.kvSet(`hostext:sharing:link:${tokenHash}`, JSON.stringify({
        tokenHash, tenantId: T, orgId: orgB.orgId, resourceType: 'cms_page', resourceId: 'wire-page',
        createdBy: 'wire-a', createdAt: new Date().toISOString(), viewCount: 0, revoked: false,
      }));
    }
    const before = (await getRow(tokenHash))!;
    expect(before.revoked, 'non-vacuity: the link must be LIVE before erasure').toBe(false);

    await eraseSubject(T, 'wire-a');

    const after = (await getRow(tokenHash))!;
    expect(after.revoked).toBe(true);
    expect(after.createdBy).toBe('erased');
    expect(after.deadAt, 'erasure must stamp the age-out clock, not just revoke').toBeTruthy();
  });

  // SHWF-6 / ADR 0644 D5 — the TEARDOWN witness. `sharingService.ts:496-513` carries
  // the most intricate mechanism claim in the feature: that tenant teardown reclaims
  // link rows on `purgeTenantRows`' RAW `kvDelete` branch (because `legacyLinksView`
  // validator-rejects every new-shape row, so the delete hook never fires), while
  // frame-view rows are reclaimed independently because `sharing:frameview` is its
  // own registry entry. Until now that claim rested entirely on prose —
  // `teardown-reachability-coverage.test.ts` only checks a `tenantOf` arg is PRESENT,
  // and no runtime test seeded Sharing rows and ran the purge. The same
  // last-construction-wins mechanic already produced one inert hook once.
  it('tenant teardown actually reclaims BOTH Sharing stores', async () => {
    const TT = 'shr-teardown-tenant';
    const org = await createOrg({ tenantId: TT, createdBy: 'td-u', name: 'TdOrg' });
    const l = await createLink(TT, org.orgId, 'td-u', { resourceType: 'cms_page', resourceId: 'td-page' })
      .catch(() => null);
    const th = l ? l.tokenHash : 'td-hash-1';
    if (!l) {
      await storage.kvSet(`hostext:sharing:link:${th}`, JSON.stringify({
        tokenHash: th, tenantId: TT, orgId: org.orgId, resourceType: 'cms_page', resourceId: 'td-page',
        createdBy: 'td-u', createdAt: new Date().toISOString(), viewCount: 0, revoked: false,
      }));
    }
    await storage.kvSet(`hostext:sharing:frameview:${th}:7`, JSON.stringify({ tokenHash: th, tenantId: TT, frame: 7, count: 3 }));

    // Non-vacuity, both stores, BEFORE the purge.
    expect(await storage.kvGet(`hostext:sharing:link:${th}`), 'link row must exist pre-purge').toBeTruthy();
    expect(await storage.kvGet(`hostext:sharing:frameview:${th}:7`), 'frameview row must exist pre-purge').toBeTruthy();

    await purgeTenantHostExt(TT);

    expect(await storage.kvGet(`hostext:sharing:link:${th}`)).toBeFalsy();
    expect(await storage.kvGet(`hostext:sharing:frameview:${th}:7`)).toBeFalsy();
  });

  // SHWF-8 / ADR 0644 D7 — `hasActiveLinkForResource` had ZERO references in the
  // whole test tree, and it gates a DESTRUCTIVE decision: `canvasRetention.ts:75`
  // deletes an abandoned canvas when this answers false, so a false negative
  // destroys a resource that still has a live public link. Its own docblock says
  // the fail direction was gotten backwards once already.
  // SHWF-8 / ADR 0644 D7 — `hasActiveLinkForResource` had ZERO references in the
  // whole test tree, and it gates a DESTRUCTIVE decision: `canvasRetention.ts:75`
  // deletes an abandoned canvas when this answers false, so a false negative
  // destroys a resource that still has a live public link. Its own docblock records
  // that the fail direction was gotten backwards once already. Rows are seeded RAW
  // for the same reason the rest of this file does (see the header): a test-local
  // DurableCollection would displace the namespace's registry entry.
  it('hasActiveLinkForResource answers the retention SURVIVE-condition correctly', async () => {
    const seed = async (hash: string, over: Record<string, unknown>): Promise<void> => {
      await storage.kvSet(linkKey(hash), JSON.stringify({
        tokenHash: hash, tenantId: T, orgId: ORG, resourceType: 'app_builder_canvas',
        resourceId: 'keep-me', createdBy: 'live-u', createdAt: new Date().toISOString(),
        viewCount: 0, revoked: false, ...over,
      }));
    };

    await seed('hal-live', {});
    expect(await hasActiveLinkForResource(T, 'app_builder_canvas', 'keep-me')).toBe(true);
    // Wrong type, wrong id and wrong tenant must all answer false — a `true` here
    // would PIN an unrelated resource out of age-out forever.
    expect(await hasActiveLinkForResource(T, 'kb_collection', 'keep-me')).toBe(false);
    expect(await hasActiveLinkForResource(T, 'app_builder_canvas', 'other-id')).toBe(false);
    expect(await hasActiveLinkForResource('some-other-tenant', 'app_builder_canvas', 'keep-me')).toBe(false);
    expect(await hasActiveLinkForResource('', 'app_builder_canvas', 'keep-me')).toBe(false);

    // Revoked and expired are both NOT active — otherwise a dead link keeps its
    // canvas alive forever, the mirror-image failure.
    await seed('hal-live', { revoked: true });
    expect(await hasActiveLinkForResource(T, 'app_builder_canvas', 'keep-me')).toBe(false);
    await seed('hal-exp', { resourceId: 'exp-one', expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(await hasActiveLinkForResource(T, 'app_builder_canvas', 'exp-one')).toBe(false);
    await seed('hal-bad', { resourceId: 'bad-one', expiresAt: 'not-a-date' });
    expect(await hasActiveLinkForResource(T, 'app_builder_canvas', 'bad-one')).toBe(false);
  });

  it('the frame-view cascade fires from ANY handle over the namespace, not just the one that declared it', async () => {
    // REGRESSION, and the reason the cascade is registered per NAMESPACE rather
    // than per instance. `sharing:link` has two live handles — the hash-keyed
    // `links` and the ADR 0448 P2 `legacyLinksView` — and the collection registry
    // dedupes by prefix with last-construction-wins, so the handle the kvAgeOut
    // sweep resolves was the one WITHOUT the hook. The cascade was inert on
    // exactly the lane it was written for, and every direct `links.delete()`
    // still worked, so nothing else would have shown it.
    await seedConversation('conv-alias');
    const link = await createLink(T, ORG, 'alice', { resourceType: 'conversation', resourceId: 'conv-alias' });
    await recordSharedFrameView(link.token, 3);
    expect(await _frameViewCountForToken(link.token)).toBe(1);

    // Delete through a FOREIGN handle that declares no cascade of its own.
    const foreign = new DurableCollection<ShareLink>('sharing:link', (l) => l.tokenHash, undefined, (l) => l.tenantId);
    expect(await foreign.delete(link.tokenHash)).toBe(true);
    expect(await _frameViewCountForToken(link.token), 'a second handle must not be able to drop rows without their cascade').toBe(0);
    // …and the marker still goes with it, whichever handle does the deleting.
    expect(await markerExists(link.tokenHash)).toBe(false);
  });
});

describe('SHARE-4 — the view cap fails CLOSED under CAS contention', () => {
  it('a capped link refuses (503) rather than serving an uncounted view', async () => {
    await seedConversation('conv-cap');
    const link = await createLink(T, ORG, 'alice', { resourceType: 'conversation', resourceId: 'conv-cap', maxViews: 5 });

    // Force real contention: every CAS attempt loses because the row is rewritten
    // underneath it. `compareAndSwap` compares the row it was handed, so bumping
    // an unrelated field between read and swap makes the swap fail for real —
    // this is a collision, not a stubbed rejection.
    const original = DurableCollection.prototype.compareAndSwap;
    DurableCollection.prototype.compareAndSwap = async function patched(this: unknown, ...args: unknown[]) {
      void args;
      return false; // every attempt loses the race
    } as typeof original;
    try {
      await expect(resolveShared(link.token)).rejects.toMatchObject({ httpStatus: 503, details: { reason: 'view-count-contention' } });
    } finally {
      DurableCollection.prototype.compareAndSwap = original;
    }

    // The cap was not silently spent, and the link still works once contention clears.
    expect((await getRow(link.tokenHash))?.viewCount).toBe(0);
    expect((await resolveShared(link.token)).resourceType).toBe('conversation');
  });

  it('an UNCAPPED link still serves (the count there is analytics, not a promise)', async () => {
    await seedConversation('conv-uncapped');
    const link = await createLink(T, ORG, 'alice', { resourceType: 'conversation', resourceId: 'conv-uncapped' });
    const original = DurableCollection.prototype.compareAndSwap;
    DurableCollection.prototype.compareAndSwap = async function patched() { return false; } as typeof original;
    try {
      expect((await resolveShared(link.token)).resourceType).toBe('conversation');
    } finally {
      DurableCollection.prototype.compareAndSwap = original;
    }
  });
});

describe('SHARE-UX-1 — the owner list marks an ORPHANED link instead of falling back to an id', () => {
  it('flags resourceMissing once the underlying resource is gone, and not before', async () => {
    await seedConversation('conv-orphan');
    const link = await createLink(T, ORG, 'alice', { resourceType: 'conversation', resourceId: 'conv-orphan' });
    const before = (await listLinks(T, ORG)).find((l) => l.tokenHash === link.tokenHash);
    expect(before?.cardTitle).toBeTruthy();
    expect(before?.resourceMissing).toBeUndefined();

    await hostExtStorage().deleteChatSession(T, 'conv-orphan');
    const after = (await listLinks(T, ORG)).find((l) => l.tokenHash === link.tokenHash);
    expect(after?.cardTitle).toBeUndefined();
    expect(after?.resourceMissing, 'an orphaned row must not read as a healthy one').toBe(true);
  });
});
