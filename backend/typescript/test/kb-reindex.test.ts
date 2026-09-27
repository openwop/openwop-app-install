/**
 * ADR 0398 Phase 3 — versioned reindex machinery.
 *
 * Pins the data-integrity invariants: a reindex builds a NEW embedding space in a STAGING
 * namespace while the OLD space keeps serving; drain is resumable (resumes from
 * embeddedChunks); the daily embed budget PAUSES the job (never half-embeds-and-lies); the
 * cutover flips the serving namespace atomically; and search still works post-cutover under
 * the new (pinned) model. Uses the headless-embedder test seam (no real credentials).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initInMemorySurfaces, buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { initHostExtPersistence, __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { __setHeadlessEmbedderForTest } from '../src/host/headlessAi.js';
import { checkEmbedBudget } from '../src/features/kb/embedBudget.js';
import { collectionNamespace, createCollection, ingestDocument, deleteDocument, eraseSubjectKb, getDocument, search, setRetrievalConfig, startReindex, drainReindex, getReindexJob, cancelReindex, getCollection, _setCollectionCasInterferenceForTest } from '../src/features/kb/kbService.js';
import { initHostEventDispatcher, __resetHostEventDispatcher, type HostEventEnvelope } from '../src/host/hostEventDispatcher.js';

const tenantId = 'tenant-reindex';
const orgId = 'org-reindex';

// A deterministic fake provider embedder (256-dim, first token hashed) — no real API.
function fakeEmbedder(): void {
  __setHeadlessEmbedderForTest(async () => ({
    provider: 'openai', model: 'text-embedding-3-small',
    embed: async (texts) => texts.map((t) => { const v = new Array(256).fill(0); v[Math.abs(hash(t)) % 256] = 1; return v; }),
  }));
}
function hash(s: string): number { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

async function newColWithDocs(name: string, n: number): Promise<string> {
  const col = await createCollection(tenantId, orgId, 'actor', { name });
  for (let i = 0; i < n; i++) await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: `Doc ${i}`, text: `# Section ${i}\nThis is the body of document number ${i} with some searchable content.` });
  return col.collectionId;
}

describe('reindex machinery (ADR 0398 P3)', () => {
  beforeAll(async () => {
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbreindex-')) });
    initHostExtPersistence(await openStorage('memory://'));
    fakeEmbedder();
  });
  afterEach(() => { delete process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY; });

  it('starts, drains to cutover, and search works under the pinned provider spec', async () => {
    const cid = await newColWithDocs('Reindex-1', 3);
    const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
    expect(started.status).toBe('running');
    expect(started.totalChunks).toBeGreaterThan(0);
    // Before cutover the collection still has no activeSignature (old space serves).
    expect((await getCollection(tenantId, orgId, cid))!.activeSignature).toBeUndefined();

    const done = await drainReindex(tenantId, orgId, cid);
    expect(done!.status).toBe('done');
    expect(done!.embeddedChunks).toBe(done!.totalChunks);
    const col = await getCollection(tenantId, orgId, cid);
    expect(col!.activeSignature).toBe(started.toSig); // cutover flipped the serving namespace
    expect(col!.embeddingSpec?.provider).toBe('openai');
    expect(col!.pendingSignature).toBeUndefined();

    const hits = await search(tenantId, orgId, cid, 'searchable content document', 5);
    expect(hits.length).toBeGreaterThan(0); // serves the staged (now active) vectors
  });

  it('is resumable — a bounded drain leaves the job partial, a second drain finishes it', async () => {
    const cid = await newColWithDocs('Reindex-2', 4);
    const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
    const partial = await drainReindex(tenantId, orgId, cid, 1); // one batch worth
    expect(partial!.status).toBe('running');
    expect(partial!.embeddedChunks).toBeLessThan(started.totalChunks);
    const rest = await drainReindex(tenantId, orgId, cid);
    expect(rest!.status).toBe('done');
    expect(rest!.embeddedChunks).toBe(started.totalChunks);
  });

  it('PAUSES (does not fail or half-lie) when the daily embed budget is exceeded', async () => {
    process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = '1'; // impossibly low ⇒ first batch pauses
    const cid = await newColWithDocs('Reindex-3', 2);
    await startReindex(tenantId, orgId, cid, { provider: 'openai' });
    const drained = await drainReindex(tenantId, orgId, cid);
    expect(drained!.status).toBe('paused');
    expect(drained!.error).toMatch(/budget/i);
    // The collection is NOT cut over — the old space still serves (no partial-coverage lie).
    expect((await getCollection(tenantId, orgId, cid))!.activeSignature).toBeUndefined();
  });

  it('cancel drops the job + staging; the active space is untouched', async () => {
    const cid = await newColWithDocs('Reindex-4', 2);
    await startReindex(tenantId, orgId, cid, { provider: 'openai' });
    await drainReindex(tenantId, orgId, cid, 1); // build a bit of staging
    const cancelled = await cancelReindex(tenantId, orgId, cid);
    expect(cancelled!.status).toBe('cancelled');
    expect((await getCollection(tenantId, orgId, cid))!.activeSignature).toBeUndefined();
    expect((await getCollection(tenantId, orgId, cid))!.pendingSignature).toBeUndefined();
  });

  it('rejects starting a reindex to the spec already active', async () => {
    const cid = await newColWithDocs('Reindex-5', 1);
    await drainReindex(tenantId, orgId, cid, undefined); // no job yet
    await startReindex(tenantId, orgId, cid, { provider: 'openai' });
    await drainReindex(tenantId, orgId, cid);
    await expect(startReindex(tenantId, orgId, cid, { provider: 'openai' })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('enforces the hard chunk ceiling', async () => {
    process.env.OPENWOP_KB_REINDEX_MAX_CHUNKS = '1';
    const cid = await newColWithDocs('Reindex-6', 3);
    await expect(startReindex(tenantId, orgId, cid, { provider: 'openai' })).rejects.toMatchObject({ httpStatus: 400 });
    delete process.env.OPENWOP_KB_REINDEX_MAX_CHUNKS;
  });

  // review fix — no concurrent document mutation while a reindex is building (would corrupt
  // the post-cutover index: resurrect a delete, miss an add, or skew the resume cursor).
  it('rejects ingest + delete while a reindex is live (409), and allows them once done', async () => {
    const cid = await newColWithDocs('Reindex-8', 2);
    await startReindex(tenantId, orgId, cid, { provider: 'openai' });
    await expect(ingestDocument(tenantId, orgId, 'actor', cid, { title: 'X', text: 'blocked' })).rejects.toMatchObject({ httpStatus: 409 });
    const docs = (await search(tenantId, orgId, cid, 'document', 5)).map((h) => h.documentId);
    if (docs[0]) await expect(deleteDocument(tenantId, orgId, cid, docs[0])).rejects.toMatchObject({ httpStatus: 409 });
    await drainReindex(tenantId, orgId, cid); // finish → job done
    await ingestDocument(tenantId, orgId, 'actor', cid, { title: 'Y', text: 'now allowed' }); // no throw
  });

  it('getReindexJob reports progress + a null when none', async () => {
    const cid = await newColWithDocs('Reindex-7', 2);
    expect(await getReindexJob(tenantId, orgId, cid)).toBeNull();
    await startReindex(tenantId, orgId, cid, { provider: 'openai' });
    const job = await getReindexJob(tenantId, orgId, cid);
    expect(job?.status).toBe('running');
    expect(job?.embeddedChunks).toBe(0);
  });

  // ─── ADR 0643 D1a — the reindex LEASE: status-aware expiry, and expiry means CANCEL ───
  //
  // The Blocker these pin: `assertNoLiveReindex` used to 409 forever for a `running`
  // or `paused` job, with no lease — so an abandoned browser tab (the only drain
  // driver) or the ordinary DAILY embed-budget pause left the collection
  // write-frozen for all three guarded lanes (`ingestDocument`, `deleteDocument`,
  // `upsertDocument`) and their eight production callers.
  //
  // TWO ceilings, because one clock cannot serve both states: `running` is a
  // drain-liveness lease (30 min), `paused` is bounded by a DAILY budget rollover
  // (48 h). Expiry CANCELS (drops staging, clears `pendingSignature`) — ignoring a
  // stale job would resurrect deletes and skew the staging cursor.
  describe('ADR 0643 D1a — reindex lease expiry', () => {
    const probe = (): number[] => new Array(256).fill(0.01);
    const stagingCount = async (cid: string, sig: string): Promise<number> => {
      const col = (await getCollection(tenantId, orgId, cid))!;
      const ns = collectionNamespace(col, sig);
      const res = await buildHostSurfaceBundle({ tenantId }).db.vector.query({ namespace: ns, vector: probe(), topK: 500 });
      return (res.matches as unknown[]).length;
    };
    /** Rewrite the persisted job's `updatedAt` to `ms` in the past. Reaches the durable
     *  row directly (the job store is module-private) rather than mocking the clock, so
     *  the production expiry arithmetic is the thing under test. */
    const ageJob = async (cid: string, ms: number, only?: 'updatedAt' | 'progressAt'): Promise<void> => {
      const storage = __hostExtStorage()!;
      const key = `hostext:kb:reindex:${tenantId}:${orgId}:${cid}`;
      const raw = await storage.kvGet(key);
      expect(raw, 'no persisted reindex job to age — the witness would be vacuous').not.toBeNull();
      const row = JSON.parse(raw!) as Record<string, unknown>;
      const then = new Date(Date.now() - ms).toISOString();
      if (only !== 'progressAt') row.updatedAt = then;
      if (only !== 'updatedAt') { row.progressAt = then; row.startedAt = then; }
      await storage.kvSet(key, JSON.stringify(row));
    };

    const MIN = 60_000;
    const HOUR = 60 * MIN;

    it('a 31-min-stale `running` job unblocks ingest AND leaves no staging vectors behind', async () => {
      const cid = await newColWithDocs('D1a-lease-running', 2);
      const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      await drainReindex(tenantId, orgId, cid, 1); // build some staging so the GC assertion is non-vacuous
      expect(await stagingCount(cid, started.toSig), 'staging must actually hold vectors first').toBeGreaterThan(0);

      await ageJob(cid, 31 * MIN);
      // The write proceeds — no 409.
      await ingestDocument(tenantId, orgId, 'actor', cid, { title: 'After lease', text: 'written once the stale job was cancelled' });

      const job = await getReindexJob(tenantId, orgId, cid);
      expect(job!.status, 'expiry must CANCEL, never merely ignore').toBe('cancelled');
      expect(await stagingCount(cid, started.toSig), 'the cancelled job\'s staging vectors must be GC\'d').toBe(0);
      // `pendingSignature` is the discriminating one — the cancel clears it. (An
      // `activeSignature` assertion here would be trivially true: no cutover is reachable in
      // this fixture, so it would pass with the cancel removed. Dropped rather than kept as
      // decoration; the cutover-vs-cancel witnesses below carry that weight.)
      expect((await getCollection(tenantId, orgId, cid))!.pendingSignature).toBeUndefined();
    });

    it('a 29-min-stale `running` job still 409s (the lease is a ceiling, not a switch)', async () => {
      const cid = await newColWithDocs('D1a-lease-fresh', 2);
      await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      await ageJob(cid, 29 * MIN);
      await expect(ingestDocument(tenantId, orgId, 'actor', cid, { title: 'X', text: 'blocked' })).rejects.toMatchObject({ httpStatus: 409 });
      expect((await getReindexJob(tenantId, orgId, cid))!.status).toBe('running');
    });

    it('a `paused` job 31 minutes stale still 409s, and SURVIVES a budget rollover', async () => {
      process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = '1'; // ⇒ the first batch pauses
      const cid = await newColWithDocs('D1a-pause-survives', 2);
      const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      expect((await drainReindex(tenantId, orgId, cid))!.status).toBe('paused');

      // 31 minutes is far past the `running` lease and must NOT touch a budget-paused job:
      // the pause is bounded by a DAILY rollover, not by a batch duration.
      await ageJob(cid, 31 * MIN);
      await expect(ingestDocument(tenantId, orgId, 'actor', cid, { title: 'X', text: 'blocked' })).rejects.toMatchObject({ httpStatus: 409 });
      expect((await getReindexJob(tenantId, orgId, cid))!.status, 'a 30-min clock must not destroy legitimate budget-paused work').toBe('paused');

      // Simulated budget rollover (the cap is per UTC day) — the surviving job resumes and completes.
      delete process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY;
      const resumed = await drainReindex(tenantId, orgId, cid);
      expect(resumed!.status).toBe('done');
      expect((await getCollection(tenantId, orgId, cid))!.activeSignature).toBe(started.toSig);
    });

    it('a `paused` job beyond REINDEX_PAUSE_MAX_MS (48 h) IS cancelled', async () => {
      process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = '1';
      const cid = await newColWithDocs('D1a-pause-expired', 2);
      const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      expect((await drainReindex(tenantId, orgId, cid))!.status).toBe('paused');
      delete process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY;

      await ageJob(cid, 49 * HOUR); // two budget rollovers came and went and nothing moved
      await ingestDocument(tenantId, orgId, 'actor', cid, { title: 'After pause ceiling', text: 'written' });
      expect((await getReindexJob(tenantId, orgId, cid))!.status).toBe('cancelled');
      expect(await stagingCount(cid, started.toSig)).toBe(0);
    });

    it('both ceilings are env-overridable', async () => {
      process.env.OPENWOP_KB_REINDEX_LEASE_MS = String(5 * MIN);
      process.env.OPENWOP_KB_REINDEX_PAUSE_MAX_MS = String(10 * MIN);
      try {
        const cid = await newColWithDocs('D1a-env', 1);
        await startReindex(tenantId, orgId, cid, { provider: 'openai' });
        await ageJob(cid, 6 * MIN); // past the overridden lease, well inside the 30-min default
        await ingestDocument(tenantId, orgId, 'actor', cid, { title: 'Z', text: 'allowed' });
        expect((await getReindexJob(tenantId, orgId, cid))!.status).toBe('cancelled');

        // The PAUSED arm — without this the test named two ceilings and exercised one.
        process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = '1';
        const paused = await newColWithDocs('D1a-env-paused', 1);
        await startReindex(tenantId, orgId, paused, { provider: 'openai' });
        expect((await drainReindex(tenantId, orgId, paused))!.status).toBe('paused');
        await ageJob(paused, 11 * MIN); // past the overridden 10-min pause ceiling, far inside 48 h
        await ingestDocument(tenantId, orgId, 'actor', paused, { title: 'Z', text: 'allowed' });
        expect((await getReindexJob(tenantId, orgId, paused))!.status).toBe('cancelled');
      } finally {
        delete process.env.OPENWOP_KB_REINDEX_LEASE_MS;
        delete process.env.OPENWOP_KB_REINDEX_PAUSE_MAX_MS;
      }
    });

    // ADR 0643 D1a (review #8) — a DECISION, not a side effect: erasure outranks a rebuild.
    it('an erasure lane (deleteDocument) can cancel a stale reindex', async () => {
      const cid = await newColWithDocs('D1a-erasure', 2);
      await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      const docId = (await search(tenantId, orgId, cid, 'document', 5)).map((h) => h.documentId)[0]!;
      await expect(deleteDocument(tenantId, orgId, cid, docId)).rejects.toMatchObject({ httpStatus: 409 });
      await ageJob(cid, 31 * MIN);
      await deleteDocument(tenantId, orgId, cid, docId); // no throw — the rebuild yields
      expect((await getReindexJob(tenantId, orgId, cid))!.status).toBe('cancelled');
    });

    // THE CONCURRENCY WITNESS. `drainReindex` reads the job, then suspends across a
    // provider `embed()` call, then writes back. A blind `put` there lost-updates a
    // concurrent expiry-cancel back to `running` — and the job then resumed into a
    // namespace whose vectors had just been deleted, with a cursor that skips them, and
    // cut over onto the truncated result. The interleave here is REAL: the fake embedder
    // parks inside the batch until the cancel has fully landed.
    it('a drain suspended mid-batch loses to a concurrent expiry-cancel: no write-back, no cursor advance, no cutover, no resurrected staging', async () => {
      const cid = await newColWithDocs('D1a-race', 3);
      const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      await drainReindex(tenantId, orgId, cid, 1); // one batch of real staging
      const before = await getReindexJob(tenantId, orgId, cid);
      expect(before!.status).toBe('running');
      expect(before!.embeddedChunks).toBeGreaterThan(0);
      expect(await stagingCount(cid, started.toSig)).toBeGreaterThan(0);

      // Meter the tenant so the ABORT itself is observable: `recordEmbedUsage` runs BETWEEN
      // the staging upsert and the job commit, so a drain that does not abort bills the
      // tenant's DURABLE daily budget for a batch it is about to throw away.
      process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = '1000000';
      const usedBefore = (await checkEmbedBudget(tenantId, 0)).used;

      let entered!: () => void;
      let release!: () => void;
      const insideEmbed = new Promise<void>((r) => { entered = r; });
      const embedGate = new Promise<void>((r) => { release = r; });
      __setHeadlessEmbedderForTest(async () => ({
        provider: 'openai', model: 'text-embedding-3-small',
        embed: async (texts) => { entered(); await embedGate; return texts.map((t) => { const v = new Array(256).fill(0); v[Math.abs(hash(t)) % 256] = 1; return v; }); },
      }));
      try {
        const drain = drainReindex(tenantId, orgId, cid, 1);
        await insideEmbed; // the drain now holds a job row read BEFORE the cancel

        // The cancel lands WHILE the drain is parked — through the real production door.
        await ageJob(cid, 31 * MIN);
        await ingestDocument(tenantId, orgId, 'actor', cid, { title: 'Raced', text: 'landed during the drain' });
        const cancelled = await getReindexJob(tenantId, orgId, cid);
        expect(cancelled!.status, 'the cancel must have landed while the drain was parked').toBe('cancelled');
        expect(await stagingCount(cid, started.toSig), 'the canceller GC\'d staging').toBe(0);

        release();
        await drain;

        const after = await getReindexJob(tenantId, orgId, cid);
        expect(after!.status, 'the drain MUST NOT write `running` back over the cancel').toBe('cancelled');
        expect(after!.embeddedChunks, 'the drain MUST NOT advance the cursor').toBe(cancelled!.embeddedChunks);
        const col = (await getCollection(tenantId, orgId, cid))!;
        expect(col.activeSignature, 'the drain MUST NOT cut over').toBeUndefined();
        expect(col.pendingSignature).toBeUndefined();
        expect(await stagingCount(cid, started.toSig), 'the drain MUST NOT resurrect vectors in the namespace it no longer owns').toBe(0);
        expect((await checkEmbedBudget(tenantId, 0)).used, 'an aborted batch must not bill the tenant\'s daily embed budget').toBe(usedBefore);
      } finally {
        fakeEmbedder();
      }
    });

    // THE NARROW WINDOW, made real with the storage-proxy shape. The witness above proves the
    // re-read across the provider call; this one proves the CAS underneath it, by forcing the
    // interleave the re-read CANNOT see: the cancel lands AFTER the drain's re-read has already
    // returned `running`. An in-process store resolves both instantly and would never produce
    // that ordering, so `kvGet` for the job row is delayed ONCE — the read observes the live
    // row, then parks while the cancel commits. Without the CAS the drain would then blind-put
    // `running` back over a cancelled job whose staging namespace had just been GC'd.
    it('a cancel landing AFTER the drain re-read still cannot be lost-updated (the CAS layer)', async () => {
      const cid = await newColWithDocs('D1a-cas', 3);
      const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      await drainReindex(tenantId, orgId, cid, 1);
      const before = await getReindexJob(tenantId, orgId, cid);
      expect(before!.status).toBe('running');
      expect(await stagingCount(cid, started.toSig)).toBeGreaterThan(0);

      const jobKvKey = `hostext:kb:reindex:${tenantId}:${orgId}:${cid}`;
      const real = __hostExtStorage()!;
      let armed = false;
      let parkedRead!: () => void;
      let readParked!: () => void;
      const readIsParked = new Promise<void>((r) => { readParked = r; });
      const readGate = new Promise<void>((r) => { parkedRead = r; });
      const proxied = new Proxy(real, {
        get(t: never, prop: string) {
          const v = (t as Record<string, unknown>)[prop];
          if (typeof v !== 'function') return v;
          if (prop === 'kvGet') {
            return async (key: string) => {
              const out = await (v as (k: string) => Promise<string | null>).call(t, key);
              if (armed && key === jobKvKey) { armed = false; readParked(); await readGate; } // observe live, resolve late
              return out;
            };
          }
          return (v as (...a: unknown[]) => unknown).bind(t);
        },
      }) as unknown as Parameters<typeof initHostExtPersistence>[0];

      let entered!: () => void;
      let release!: () => void;
      const insideEmbed = new Promise<void>((r) => { entered = r; });
      const embedGate = new Promise<void>((r) => { release = r; });
      __setHeadlessEmbedderForTest(async () => ({
        provider: 'openai', model: 'text-embedding-3-small',
        embed: async (texts) => { entered(); await embedGate; return texts.map((t) => { const v = new Array(256).fill(0); v[Math.abs(hash(t)) % 256] = 1; return v; }); },
      }));
      try {
        initHostExtPersistence(proxied);
        const drain = drainReindex(tenantId, orgId, cid, 1);
        await insideEmbed;
        armed = true;   // the NEXT read of the job row (the drain's post-embed re-read) parks
        release();
        await readIsParked; // the drain has now read `running` and is holding it

        await ageJob(cid, 31 * MIN);
        await ingestDocument(tenantId, orgId, 'actor', cid, { title: 'Raced late', text: 'after the re-read' });
        expect((await getReindexJob(tenantId, orgId, cid))!.status).toBe('cancelled');
        expect(await stagingCount(cid, started.toSig)).toBe(0);

        parkedRead(); // the drain resumes with a STALE `running` in hand
        await drain;

        const after = await getReindexJob(tenantId, orgId, cid);
        expect(after!.status, 'the CAS must refuse the stale write-back').toBe('cancelled');
        expect(after!.embeddedChunks).toBe(before!.embeddedChunks);
        expect((await getCollection(tenantId, orgId, cid))!.activeSignature).toBeUndefined();
        expect(await stagingCount(cid, started.toSig), 'the refused batch must not be left orphaned in the namespace').toBe(0);
      } finally {
        initHostExtPersistence(real);
        fakeEmbedder();
      }
    });

    // THE OTHER DIRECTION. Cutover and cancel are the two destructive owners of the staging
    // namespace, so D1a makes both CLAIM the job row before they touch vectors. Here the
    // cancel arrives while the cutover is mid-flight — the job is already `done` and the
    // collection is one `kvSet` away from serving that namespace. A cancel that flips status
    // LAST (the pre-D1a order) would GC the namespace the collection is about to point at,
    // with no error and no log: an emptied live index.
    it('a cancel arriving mid-cutover cannot GC the namespace that is about to be ACTIVE', async () => {
      const cid = await newColWithDocs('D1a-cutover-race', 2);
      const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      const colKvKey = `hostext:kb:collection:${tenantId}:${orgId}:${cid}`;
      const real = __hostExtStorage()!;
      // Parks the collection-row write (a CAS since R2 — the helper catches both shapes).
      const { proxied, parked, waitForParks } = makeParkingStorage(real, colKvKey, 1);
      const writeIsParked = waitForParks(1);
      const flushWrite = (): void => parked[0]!.release();

      let entered!: () => void;
      let release!: () => void;
      const insideEmbed = new Promise<void>((r) => { entered = r; });
      const embedGate = new Promise<void>((r) => { release = r; });
      __setHeadlessEmbedderForTest(async () => ({
        provider: 'openai', model: 'text-embedding-3-small',
        embed: async (texts) => { entered(); await embedGate; return texts.map((t) => { const v = new Array(256).fill(0); v[Math.abs(hash(t)) % 256] = 1; return v; }); },
      }));
      try {
        initHostExtPersistence(proxied);
        const drain = drainReindex(tenantId, orgId, cid);
        await insideEmbed;
        release();
        await writeIsParked; // the job is `cutting-over` (R4 Should 1); the collection has NOT flipped yet

        const raced = await cancelReindex(tenantId, orgId, cid);
        // R4 Should 1 — the claim is `cutting-over`, not `done`, so the row can still say
        // `failed` if the flip loses; a FRESH `cutting-over` row refuses a cancel exactly
        // as a `done` one did, which is the arbitration this witness exists for.
        expect(raced!.status, 'a cancel must lose to a cutover that already claimed the row').toBe('cutting-over');

        flushWrite();
        const finished = await drain;
        expect(finished!.status).toBe('done');
        expect((await getCollection(tenantId, orgId, cid))!.activeSignature).toBe(started.toSig);
        expect(await stagingCount(cid, started.toSig), 'the now-ACTIVE namespace must still hold its vectors').toBeGreaterThan(0);
      } finally {
        initHostExtPersistence(real);
        fakeEmbedder();
      }
    });

    // ── ADR 0643 D1a R2 — a deterministic storage park, shared by the review's two
    // Blocker proofs. Parks the FIRST `budget` writes to `targetKey` (both `kvSet` and
    // `kvCompareAndSwap`, so it catches a blind put and a CAS alike) BEFORE they reach the
    // store, and hands the test the gates. Parking before the write is what makes the
    // interleave real: a racing reader still sees the pre-write row.
    interface ParkedWrite { op: 'set' | 'cas'; release: () => void }
    const makeParkingStorage = (real: NonNullable<ReturnType<typeof __hostExtStorage>>, targetKey: string, budget: number) => {
      const parked: ParkedWrite[] = [];
      let notify: (() => void) | null = null;
      let left = budget;
      const park = async (key: string, op: 'set' | 'cas'): Promise<void> => {
        if (left <= 0 || key !== targetKey) return;
        left -= 1;
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        parked.push({ op, release });
        const n = notify; notify = null; n?.();
        await gate;
      };
      const proxied = new Proxy(real, {
        get(t: never, prop: string) {
          const v = (t as Record<string, unknown>)[prop];
          if (typeof v !== 'function') return v;
          if (prop === 'kvSet') {
            return async (key: string, value: string) => { await park(key, 'set'); return (v as (k: string, x: string) => Promise<unknown>).call(t, key, value); };
          }
          if (prop === 'kvCompareAndSwap') {
            return async (key: string, expected: string | null, next: string) => { await park(key, 'cas'); return (v as (k: string, e: string | null, n: string) => Promise<unknown>).call(t, key, expected, next); };
          }
          return (v as (...a: unknown[]) => unknown).bind(t);
        },
      }) as unknown as Parameters<typeof initHostExtPersistence>[0];
      const waitForParks = async (n: number): Promise<void> => {
        while (parked.length < n) await new Promise<void>((r) => { notify = r; });
      };
      return { proxied, parked, waitForParks };
    };

    // BLOCKER 1 (review of f75c65a5e). The collection row has NO CAS and the cutover is a
    // read-modify-write spanning MINUTES of provider calls: `drainReindex` reads `col`
    // before the first batch and writes that same object at the flip. Meanwhile the traded
    // window this ADR documented lets an ingest through the moment the job turns `done` —
    // and that ingest ALSO read the collection before the flip and blind-puts it at the end.
    // Whenever the ingest's write lands second (the ordinary case if anything in its body is
    // slower than the flip) it does not cost "one document's vectors": it REVERTS THE WHOLE
    // CUTOVER — `activeSignature` gone, `embeddingSpec` rolled back, `pendingSignature`
    // restored as a phantom build — and points serving back at the namespace the cutover has
    // already GC'd. Unrecoverable in place: the job is `done`, so every later cancel/drain is
    // refused. This is the ingest-side lost update D1a fixed, one function away.
    //
    // ADR 0643 R4 review (Should 1) CORRECTION — the "traded window" this test used to
    // exercise is CLOSED. The cutover now claims `cutting-over`, which `assertNoLiveReindex`
    // treats as LIVE, so an ingest arriving while the flip is in flight is REFUSED (409
    // `reindex_in_progress`) instead of being let through to race it. The witness is now
    // two-sided: refused DURING the flip, landing cleanly AFTER it, and reverting nothing.
    it('a racing ingest is REFUSED while the flip is in flight, and an ingest after it cannot revert the cutover', async () => {
      const cid = await newColWithDocs('D1a-cutover-revert', 2);
      const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      const colKvKey = `hostext:kb:collection:${tenantId}:${orgId}:${cid}`;
      const real = __hostExtStorage()!;
      const { proxied, waitForParks, parked } = makeParkingStorage(real, colKvKey, 1);

      let entered!: () => void;
      let release!: () => void;
      const insideEmbed = new Promise<void>((r) => { entered = r; });
      const embedGate = new Promise<void>((r) => { release = r; });
      __setHeadlessEmbedderForTest(async () => ({
        provider: 'openai', model: 'text-embedding-3-small',
        embed: async (texts) => { entered(); await embedGate; return texts.map((t) => { const v = new Array(256).fill(0); v[Math.abs(hash(t)) % 256] = 1; return v; }); },
      }));
      try {
        initHostExtPersistence(proxied);
        const drain = drainReindex(tenantId, orgId, cid);
        await insideEmbed;
        release();
        await waitForParks(1); // the drain has claimed `cutting-over` and is holding the flip write

        // The guard REFUSES the write while the flip is in flight (R4 Should 1).
        await expect(ingestDocument(tenantId, orgId, 'actor', cid, { title: 'Raced ingest', text: 'refused across the cutover' }))
          .rejects.toMatchObject({ httpStatus: 409, details: expect.objectContaining({ reason: 'reindex_in_progress', reindexStatus: 'cutting-over' }) });

        parked[0]!.release();  // the cutover flip lands
        const finished = await drain;
        expect(finished!.status).toBe('done');
        initHostExtPersistence(real);
        // …and an ingest AFTER the flip lands on the flipped row (a delta under CAS).
        await ingestDocument(tenantId, orgId, 'actor', cid, { title: 'After ingest', text: 'landed after the cutover' });

        const col = (await getCollection(tenantId, orgId, cid))!;
        expect(col.activeSignature, 'a racing ingest MUST NOT revert the cutover').toBe(started.toSig);
        expect(col.embeddingSpec?.provider, 'the flipped embedding spec MUST survive').toBe('openai');
        expect(col.pendingSignature, 'a reverted cutover leaves a phantom build nothing is doing').toBeUndefined();
        expect(col.documentCount, 'the racing ingest\'s own count must not be lost either').toBe(3);
      } finally {
        initHostExtPersistence(real);
        fakeEmbedder();
      }
    });

    // BLOCKER 2 (review of f75c65a5e). `startReindex` is a blind `put` that RESETS `gen` to 0
    // and has no live-job check, so the ordinary cancel-then-retry flow recreates a DIFFERENT
    // job at the same key at the same generation. A drain that read job #1 at gen 0 and is
    // asleep in a provider call then finds gen 0 on wake, believes nothing moved, and commits
    // job #1's whole row — cursor, `startedAt`, `totalChunks` — over job #2. A monotonic
    // counter cannot survive a row recreated at the same key; the drift check needs identity.
    it('a drain cannot commit its cursor onto a DIFFERENT job recreated at the same key', async () => {
      const cid = await newColWithDocs('D1a-identity', 2);
      const job1 = await startReindex(tenantId, orgId, cid, { provider: 'openai' });

      let entered!: () => void;
      let release!: () => void;
      const insideEmbed = new Promise<void>((r) => { entered = r; });
      const embedGate = new Promise<void>((r) => { release = r; });
      __setHeadlessEmbedderForTest(async () => ({
        provider: 'openai', model: 'text-embedding-3-small',
        embed: async (texts) => { entered(); await embedGate; return texts.map((t) => { const v = new Array(256).fill(0); v[Math.abs(hash(t)) % 256] = 1; return v; }); },
      }));
      try {
        const drain = drainReindex(tenantId, orgId, cid, 1); // reads job #1 at gen 0
        await insideEmbed;

        // Everything below is an ordinary operator flow through production doors.
        await cancelReindex(tenantId, orgId, cid);
        await ingestDocument(tenantId, orgId, 'actor', cid, { title: 'Zebra', text: 'aardvark unique marker QQZZ for the new corpus' });
        await new Promise((r) => setTimeout(r, 2)); // `startedAt` is ms-resolution — see the sub-ms sibling below
        const job2 = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
        expect(job2.startedAt).not.toBe(job1.startedAt);
        expect(job2.embeddedChunks).toBe(0);

        release();
        await drain;

        const after = await getReindexJob(tenantId, orgId, cid)!;
        expect(after!.startedAt, 'job #2\'s identity must survive a stale drain of job #1').toBe(job2.startedAt);
        expect(after!.embeddedChunks, 'job #2 has embedded nothing; a stale cursor here skips chunks at the next drain').toBe(0);
        expect(after!.totalChunks, 'job #2 counted a larger corpus').toBe(job2.totalChunks);
      } finally {
        fakeEmbedder();
      }
    });

    // The sub-millisecond arm of the same Blocker, found by the sibling above failing on a
    // `startedAt` COLLISION. `startedAt` is ms-resolution, so two jobs really can share it —
    // which means identity cannot rest on it alone. It rests on `gen` too, and specifically
    // on `gen` CONTINUING across the recreate (`priorRow.gen + 1`) rather than resetting: the
    // reset was the half of Blocker 2 that made the stale drain's CAS actually SUCCEED, as
    // opposed to merely going undetected.
    it('identity survives even when the recreated job shares a millisecond with the old one', async () => {
      const cid = await newColWithDocs('D1a-identity-subms', 2);
      const job1 = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      let entered!: () => void;
      let release!: () => void;
      const insideEmbed = new Promise<void>((r) => { entered = r; });
      const embedGate = new Promise<void>((r) => { release = r; });
      __setHeadlessEmbedderForTest(async () => ({
        provider: 'openai', model: 'text-embedding-3-small',
        embed: async (texts) => { entered(); await embedGate; return texts.map((t) => { const v = new Array(256).fill(0); v[Math.abs(hash(t)) % 256] = 1; return v; }); },
      }));
      try {
        const drain = drainReindex(tenantId, orgId, cid, 1);
        await insideEmbed;
        await cancelReindex(tenantId, orgId, cid);
        const job2 = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
        // Force the hostile case rather than hoping for it: make the two jobs share every
        // identity field EXCEPT the generation.
        const storage = __hostExtStorage()!;
        const key = `hostext:kb:reindex:${tenantId}:${orgId}:${cid}`;
        const row = JSON.parse((await storage.kvGet(key))!) as Record<string, unknown>;
        row.startedAt = job1.startedAt;
        await storage.kvSet(key, JSON.stringify(row));
        expect(job2.toSig, 'same target ⇒ same toSig; only `gen` can tell them apart').toBe(job1.toSig);

        release();
        await drain;
        const after = await getReindexJob(tenantId, orgId, cid);
        expect(after!.embeddedChunks, 'a stale drain must not advance the cursor of a job it never read').toBe(0);
        expect(after!.status).toBe('running');
      } finally {
        fakeEmbedder();
      }
    });

    // The cutover's OWN half of Blocker 1, in the opposite order. The witness above has the
    // flip land FIRST, so it only proves the INGEST side merges; sabotaging the cutover back
    // to a whole-row put left it green. The cutover is the writer with the widest window of
    // all — it holds `col` across every provider batch — so it needs its own proof: another
    // writer lands DURING the embed, and the flip must not roll it back.
    it('the cutover cannot revert a write that landed while it was embedding', async () => {
      const cid = await newColWithDocs('D1a-cutover-clobbers', 2);
      const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      let entered!: () => void;
      let release!: () => void;
      const insideEmbed = new Promise<void>((r) => { entered = r; });
      const embedGate = new Promise<void>((r) => { release = r; });
      __setHeadlessEmbedderForTest(async () => ({
        provider: 'openai', model: 'text-embedding-3-small',
        embed: async (texts) => { entered(); await embedGate; return texts.map((t) => { const v = new Array(256).fill(0); v[Math.abs(hash(t)) % 256] = 1; return v; }); },
      }));
      try {
        const drain = drainReindex(tenantId, orgId, cid);
        await insideEmbed; // the drain is holding the `col` it read before the first batch

        // An ordinary settings change, on a path with no reindex guard, lands mid-embed.
        await setRetrievalConfig(tenantId, orgId, cid, 'settings-actor', { mode: 'hybrid' });

        release();
        await drain;

        const col = (await getCollection(tenantId, orgId, cid))!;
        expect(col.activeSignature, 'the cutover must still happen').toBe(started.toSig);
        expect(col.retrievalConfig?.mode, 'the cutover MUST NOT roll back a write it never saw').toBe('hybrid');
        expect(col.updatedBy).toBe('settings-actor');
      } finally {
        fakeEmbedder();
      }
    });

    // The identity half of Blocker 2 that a monotonic counter genuinely cannot cover: a job
    // row that is DELETED and recreated. `gen` continues across a REPLACE (`priorRow.gen + 1`),
    // which is why sabotaging the drift check to generation-only leaves the siblings above
    // green — but a deleted row takes the counter with it, and the next start legitimately
    // mints gen 1. ADR 0643 D1b is being built to delete this row on terminal status, so this
    // is the shape that lane will produce, not a hypothetical.
    it('a drain cannot commit onto a job recreated after the row was DELETED (gen cannot see it)', async () => {
      const cid = await newColWithDocs('D1a-identity-deleted', 2);
      await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      let entered!: () => void;
      let release!: () => void;
      const insideEmbed = new Promise<void>((r) => { entered = r; });
      const embedGate = new Promise<void>((r) => { release = r; });
      __setHeadlessEmbedderForTest(async () => ({
        provider: 'openai', model: 'text-embedding-3-small',
        embed: async (texts) => { entered(); await embedGate; return texts.map((t) => { const v = new Array(256).fill(0); v[Math.abs(hash(t)) % 256] = 1; return v; }); },
      }));
      try {
        const drain = drainReindex(tenantId, orgId, cid, 1); // reads job #1 at gen 1
        await insideEmbed;

        // The teardown D1b performs: the job row is removed outright, generation and all.
        const storage = __hostExtStorage()!;
        await storage.kvDelete(`hostext:kb:reindex:${tenantId}:${orgId}:${cid}`);
        await new Promise((r) => setTimeout(r, 2));
        const job2 = await startReindex(tenantId, orgId, cid, { provider: 'openai' }); // mints gen 1 again

        release();
        await drain;

        const after = await getReindexJob(tenantId, orgId, cid);
        expect(after!.startedAt, 'a recreated job must not inherit a dead drain\'s identity').toBe(job2.startedAt);
        expect(after!.embeddedChunks, 'nor its cursor').toBe(0);
      } finally {
        fakeEmbedder();
      }
    });

    // REVIEW SHOULD 4, followed to the end of the call graph rather than to the sites the
    // review's own witnesses reached. `createCollection`'s "never CLOBBER a live row" guard
    // is a get-then-put, and under concurrency it reproduces the very clobber its comment
    // claims to fix: a re-provision whose read saw "absent" writes a fresh row over one that
    // has since taken ingests AND been reindexed — counts to zero, `activeSignature` gone,
    // which moves the namespace off its `#<sig>` suffix and empties the collection while its
    // vectors sit intact.
    it('a re-provision of a deterministic collection id cannot clobber a live, reindexed row', async () => {
      const detId = `mgd-race-${Date.now()}`;
      const colKvKey = `hostext:kb:collection:${tenantId}:${orgId}:${detId}`;
      const real = __hostExtStorage()!;
      const { proxied, parked, waitForParks } = makeParkingStorage(real, colKvKey, 1);
      try {
        initHostExtPersistence(proxied);
        // A managed indexer provisions the collection; its write is held at the door.
        const provisioning = createCollection(tenantId, orgId, 'indexer', { name: 'Managed' }, { collectionId: detId });
        await waitForParks(1);

        // Meanwhile the collection is created for real and put to work.
        initHostExtPersistence(real);
        await createCollection(tenantId, orgId, 'operator', { name: 'Managed' }, { collectionId: detId });
        await ingestDocument(tenantId, orgId, 'operator', detId, { title: 'Live', text: 'real content that must survive a re-provision' });
        const started = await startReindex(tenantId, orgId, detId, { provider: 'openai' });
        await drainReindex(tenantId, orgId, detId);
        expect((await getCollection(tenantId, orgId, detId))!.activeSignature).toBe(started.toSig);

        // The held provision finally lands.
        initHostExtPersistence(proxied);
        parked[0]!.release();
        await provisioning;
        initHostExtPersistence(real);

        const col = (await getCollection(tenantId, orgId, detId))!;
        expect(col.activeSignature, 'a stale re-provision MUST NOT drop the reindexed signature').toBe(started.toSig);
        expect(col.documentCount, 'nor reset the counts').toBe(1);
      } finally {
        initHostExtPersistence(real);
      }
    });

    // REVIEW SHOULD 3 — the `paused` ceiling must clock PROGRESS, not attempts. `updatedAt`
    // is refreshed by the budget branch on every re-pause, and the SPA drive loop re-pauses
    // on every iteration, so a job whose daily cap is smaller than one batch renews its own
    // 48-hour clock forever while embedding nothing: the unbounded write-freeze D1a exists
    // to remove, restored through a different door. A gate with no exit is a defect.
    it('a `paused` job that keeps re-pausing without progressing still expires', async () => {
      process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = '1'; // smaller than one batch ⇒ zero progress, ever
      const cid = await newColWithDocs('D1a-pause-nonprogress', 2);
      await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      expect((await drainReindex(tenantId, orgId, cid))!.status).toBe('paused');

      // Two days of the SPA loop: the job has NEVER advanced, but every re-pause refreshed
      // `updatedAt`. Age only the progress clock; leave `updatedAt` at "just now".
      await ageJob(cid, 49 * HOUR, 'progressAt');
      expect((await drainReindex(tenantId, orgId, cid))!.status).toBe('paused'); // re-pauses, refreshing updatedAt again
      expect((await getReindexJob(tenantId, orgId, cid))!.embeddedChunks, 'zero progress is the premise').toBe(0);

      await ingestDocument(tenantId, orgId, 'actor', cid, { title: 'Unfrozen', text: 'the ceiling clocks progress' });
      expect((await getReindexJob(tenantId, orgId, cid))!.status, 'a job that never progresses must not renew its own ceiling').toBe('cancelled');
    });

    it('a `paused` job that DID progress recently is still protected, however old its start', async () => {
      process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = '100000';
      const cid = await newColWithDocs('D1a-pause-progressed', 3);
      await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      await drainReindex(tenantId, orgId, cid, 1); // real progress, just now
      const storage = __hostExtStorage()!;
      const key = `hostext:kb:reindex:${tenantId}:${orgId}:${cid}`;
      const row = JSON.parse((await storage.kvGet(key))!) as Record<string, unknown>;
      row.startedAt = new Date(Date.now() - 72 * HOUR).toISOString(); // started three days ago
      row.status = 'paused';
      await storage.kvSet(key, JSON.stringify(row));
      await expect(ingestDocument(tenantId, orgId, 'actor', cid, { title: 'X', text: 'blocked' })).rejects.toMatchObject({ httpStatus: 409 });
      expect((await getReindexJob(tenantId, orgId, cid))!.status).toBe('paused');
    });

    // REVIEW BLOCKER 2, second half — a start is a WRITE, so it cannot silently replace a
    // live job. (The stale case still self-heals: the next test is the exit.)
    it('a second `startReindex` over a LIVE job 409s instead of overwriting it', async () => {
      const cid = await newColWithDocs('D1a-double-start', 2);
      const first = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      await drainReindex(tenantId, orgId, cid, 1);
      await expect(startReindex(tenantId, orgId, cid, { provider: 'openai' })).rejects.toMatchObject({ httpStatus: 409 });
      const still = await getReindexJob(tenantId, orgId, cid);
      expect(still!.startedAt, 'the live job must survive the second start').toBe(first.startedAt);
      expect(still!.embeddedChunks, 'and keep its cursor').toBeGreaterThan(0);
    });

    it('a start over a STALE job cancels it and proceeds (the 409 above is not a new freeze)', async () => {
      const cid = await newColWithDocs('D1a-stale-restart', 2);
      const first = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      await ageJob(cid, 31 * MIN);
      await new Promise((r) => setTimeout(r, 2)); // `startedAt` is ms-resolution; this test is faster
      const second = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      expect(second.startedAt).not.toBe(first.startedAt);
      expect(second.status).toBe('running');
      expect(second.embeddedChunks).toBe(0);
    });

    // REVIEW SHOULD 4 — the same "read col, do something long, put col back" shape lives on
    // paths with NO reindex guard at all. `search` → `hydrate` is the most reachable of them:
    // any read, from anyone, can be in flight across a cutover.
    it('a hydrate racing a cutover cannot revert it (the unguarded read path)', async () => {
      const cid = await newColWithDocs('D1a-hydrate-race', 2);
      // Move the enrichment so the next `search` recomputes a DIFFERENT local signature and
      // therefore actually hydrates (and writes the row) instead of hitting its early return.
      await setRetrievalConfig(tenantId, orgId, cid, 'actor', { enrichment: 'heading-path' });
      const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      const colKvKey = `hostext:kb:collection:${tenantId}:${orgId}:${cid}`;
      const real = __hostExtStorage()!;
      const { proxied, parked, waitForParks } = makeParkingStorage(real, colKvKey, 2);
      let entered!: () => void;
      let release!: () => void;
      const insideEmbed = new Promise<void>((r) => { entered = r; });
      const embedGate = new Promise<void>((r) => { release = r; });
      __setHeadlessEmbedderForTest(async () => ({
        provider: 'openai', model: 'text-embedding-3-small',
        embed: async (texts) => { entered(); await embedGate; return texts.map((t) => { const v = new Array(256).fill(0); v[Math.abs(hash(t)) % 256] = 1; return v; }); },
      }));
      try {
        initHostExtPersistence(proxied);
        const drain = drainReindex(tenantId, orgId, cid);
        await insideEmbed;
        release();
        await waitForParks(1); // the cutover flip is held

        // A plain read: no guard, no admin. It recomputes the local signature and wants to
        // write it back onto the row it read BEFORE the flip.
        const reading = search(tenantId, orgId, cid, 'document body', 3, 'dense');
        await waitForParks(2);

        parked[0]!.release();
        await drain;
        parked[1]!.release();
        await reading;

        const col = (await getCollection(tenantId, orgId, cid))!;
        expect(col.activeSignature, 'an unguarded hydrate MUST NOT revert a cutover').toBe(started.toSig);
        expect(col.pendingSignature).toBeUndefined();
        expect(col.retrievalConfig?.enrichment, 'and the hydrate must not lose the other writer\'s fields either').toBe('heading-path');
      } finally {
        initHostExtPersistence(real);
        fakeEmbedder();
      }
    });

    // REVIEW SHOULD 5 — the erasure/reindex interaction, witnessed rather than asserted.
    // The precedence docblock claimed "a 409 the erasure lane retries"; nothing retried it,
    // and the throw escaped mid-scan after other collections had already been erased.
    it('a LIVE reindex blocks erasure with a named 409 and does NOT abandon the other collections', async () => {
      const subject = `erase-subject-${Date.now()}`;
      const orgB = 'org-reindex-b';
      const locked = await createCollection(tenantId, orgId, subject, { name: 'Locked by a reindex' });
      await ingestDocument(tenantId, orgId, subject, locked.collectionId, { title: 'Subject doc', text: 'body of the erasable document' }, { documentId: subject });
      const other = await createCollection(tenantId, orgB, subject, { name: 'Not locked' });
      await ingestDocument(tenantId, orgB, subject, other.collectionId, { title: 'Subject doc B', text: 'a second erasable document' }, { documentId: subject });
      await startReindex(tenantId, orgId, locked.collectionId, { provider: 'openai' }); // live, fresh

      await expect(eraseSubjectKb(tenantId, subject)).rejects.toMatchObject({ httpStatus: 409 });
      // The LOUD failure is required — the ADR 0464 fan-out counts it, and a swallowed 409
      // would report a complete erasure over an incomplete one. What must NOT happen is the
      // scan abandoning every collection after the blocked one.
      expect(await getDocument(tenantId, orgB, other.collectionId, subject), 'an unlocked collection must still be erased').toBeNull();
      expect(await getDocument(tenantId, orgId, locked.collectionId, subject), 'the locked one is honestly left behind').not.toBeNull();

      // And the exit exists: past its ceiling, the retry completes.
      await ageJob(locked.collectionId, 31 * MIN);
      await eraseSubjectKb(tenantId, subject);
      expect(await getDocument(tenantId, orgId, locked.collectionId, subject)).toBeNull();
    });

    // THE CANCELLER'S OWN ORDER. `cancelReindex` used to flip the status LAST, after the
    // staging GC — so for the whole span of that GC the job still read `running`, and a drain
    // waking inside that span saw a live job, wrote its batch into the namespace the canceller
    // had ALREADY emptied, and committed. The vectors then belonged to nobody: the cancel was
    // finished GC-ing and would never look again. D1a claims the row BEFORE it destroys
    // anything, so the drain's re-read sees `cancelled` and never writes.
    it('the canceller claims the row BEFORE it GCs, so a waking drain cannot write into the emptied namespace', async () => {
      const cid = await newColWithDocs('D1a-claim-order', 3);
      const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      await drainReindex(tenantId, orgId, cid, 1);
      expect(await stagingCount(cid, started.toSig)).toBeGreaterThan(0);

      const colKvKey = `hostext:kb:collection:${tenantId}:${orgId}:${cid}`;
      const real = __hostExtStorage()!;
      // Park the canceller at its LAST step (clearing `pendingSignature`), i.e. AFTER its
      // staging GC has run — the exact instant the old ordering left the job still `running`.
      const { proxied, parked, waitForParks } = makeParkingStorage(real, colKvKey, 1);
      const writeIsParked = waitForParks(1);
      const flushWrite = (): void => parked[0]!.release();

      let entered!: () => void;
      let release!: () => void;
      const insideEmbed = new Promise<void>((r) => { entered = r; });
      const embedGate = new Promise<void>((r) => { release = r; });
      __setHeadlessEmbedderForTest(async () => ({
        provider: 'openai', model: 'text-embedding-3-small',
        embed: async (texts) => { entered(); await embedGate; return texts.map((t) => { const v = new Array(256).fill(0); v[Math.abs(hash(t)) % 256] = 1; return v; }); },
      }));
      try {
        initHostExtPersistence(proxied);
        const drain = drainReindex(tenantId, orgId, cid, 1);
        await insideEmbed; // a drain is asleep inside the provider call

        const cancelling = cancelReindex(tenantId, orgId, cid);
        await writeIsParked; // the canceller has GC'd staging and is one write from finishing

        release();      // the drain wakes INSIDE the canceller's critical section
        await drain;
        flushWrite();
        await cancelling;

        expect((await getReindexJob(tenantId, orgId, cid))!.status).toBe('cancelled');
        expect(await stagingCount(cid, started.toSig), 'a drain waking inside the cancel must not write into the emptied namespace').toBe(0);
      } finally {
        initHostExtPersistence(real);
        fakeEmbedder();
      }
    });
  });
});

describe('ADR 0643 R3 review — Should 5 (CAS exhaustion is LOUD) and Should 7 (the driver field)', () => {
  beforeAll(async () => {
    initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-kbreindex-r3-')) });
    initHostExtPersistence(await openStorage('memory://'));
    fakeEmbedder();
  });
  afterEach(() => { _setCollectionCasInterferenceForTest(null); });

  it('Should 7 — with no chain pack loaded, the job row says `driver: "interactive-only"` (the console can stop promising a server-side rebuild)', async () => {
    const cid = await newColWithDocs('R3-driver', 1);
    const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
    // This harness never loads the workflow-chain packs, so `ensureKbReindexDriver`
    // finds no `kb.reindex` chain — exactly the production state of a host running
    // without the examples, which used to 202 with the SAME shape as a scheduled one.
    expect(started.driver).toBe('interactive-only');
    expect((await getReindexJob(tenantId, orgId, cid))!.driver).toBe('interactive-only');
    await cancelReindex(tenantId, orgId, cid);
  });

  it('Should 5 — persistent CAS contention on the collection row REFUSES with a 409, never returns the live row as if committed', async () => {
    const cid = await newColWithDocs('R3-cas', 1);
    // A concurrent writer that wins EVERY attempt: bump the row between the read and
    // the swap, four times. `commitCollection` used to return `collections.get(key)`
    // after that — indistinguishable from success — so `setRetrievalConfig` answered
    // 200 carrying the OLD config.
    const storage = __hostExtStorage()!;
    _setCollectionCasInterferenceForTest(async (key) => {
      const raw = await storage.kvGet(`hostext:kb:collection:${key}`);
      if (raw) { const row = JSON.parse(raw) as Record<string, unknown>; row.updatedAt = new Date(Date.now() + Math.random() * 1e6).toISOString(); await storage.kvSet(`hostext:kb:collection:${key}`, JSON.stringify(row)); }
    });
    await expect(setRetrievalConfig(tenantId, orgId, cid, 'actor', { mode: 'hybrid' })).rejects.toMatchObject({ httpStatus: 409, details: expect.objectContaining({ reason: 'collection_cas_exhausted' }) });
    _setCollectionCasInterferenceForTest(null);
    expect((await getCollection(tenantId, orgId, cid))!.retrievalConfig?.mode, 'the refused write did NOT land').not.toBe('hybrid');
  });

  it('Should 5 / R4 Should 1 — the CUTOVER under exhaustion goes `failed { reason: cutover-conflict }`, emits it, and never claims done', async () => {
    const delivered: HostEventEnvelope[] = [];
    initHostEventDispatcher({
      storage: __hostExtStorage()! as never,
      hostSuite: { workflowCatalog: { getWorkflow: async () => null } } as never,
      deliverWebhooks: async (e) => { delivered.push(e); },
      startRun: async () => null,
    });
    try {
      const cid = await newColWithDocs('R4-cas-cutover', 2);
      const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      const storage = __hostExtStorage()!;
      // A concurrent writer that wins EVERY collection CAS from here on — the flip and
      // the marker clear both lose. (The job row is a different store; the claims land.)
      _setCollectionCasInterferenceForTest(async (key) => {
        const raw = await storage.kvGet(`hostext:kb:collection:${key}`);
        if (raw) { const row = JSON.parse(raw) as Record<string, unknown>; row.updatedAt = new Date(Date.now() + Math.random() * 1e6).toISOString(); await storage.kvSet(`hostext:kb:collection:${key}`, JSON.stringify(row)); }
      });
      const out = await drainReindex(tenantId, orgId, cid);
      _setCollectionCasInterferenceForTest(null);
      // The R3 shape claimed `done` BEFORE the flip, then threw: a `done` row over an
      // un-flipped collection, no event either way, and the driver reap skipped.
      expect(out!.status, 'the row must say what happened').toBe('failed');
      expect(out!.error).toMatch(/cutting over/);
      expect(out!.embeddedChunks).toBe(out!.totalChunks); // it DID build; only the flip lost
      await new Promise((r) => setTimeout(r, 25));
      const failed = delivered.filter((e) => e.type === 'host.kb.reindex.failed' && e.tenantId === tenantId && e.payload.collectionId === cid);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.payload).toEqual({ orgId, collectionId: cid, reason: 'cutover-conflict' });
      expect(delivered.filter((e) => e.type === 'host.kb.reindex.completed' && e.payload.collectionId === cid)).toHaveLength(0);
      const col = (await getCollection(tenantId, orgId, cid))!;
      expect(col.activeSignature, 'the flip did not land').not.toBe(started.toSig);
      // The staging namespace was reclaimed (the failed job is not coming back).
      const ns = collectionNamespace(col, started.toSig);
      const res = await buildHostSurfaceBundle({ tenantId }).db.vector.query({ namespace: ns, vector: new Array(256).fill(0.01), topK: 500 });
      expect((res.matches as unknown[]).length).toBe(0);
      // …and a NEW reindex is startable: the failed row is terminal, not a `done` lie.
      const again = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
      expect(again.status).toBe('running');
      await cancelReindex(tenantId, orgId, cid);
    } finally {
      _setCollectionCasInterferenceForTest(null);
      __resetHostEventDispatcher();
    }
  });
  it('ADR 0643 D1a R5 — a cancel arriving AFTER the flip landed must not delete the LIVE namespace, and must not call a successful rebuild a failure', async () => {
    // The crash this covers: the cutover commits the collection flip
    // (`activeSignature = toSig`) and then dies before committing `status = 'done'`,
    // leaving a `cutting-over` row over an ALREADY-FLIPPED collection. D1a's lease then
    // expires it and lands in `cancelReindex` — where `collectionNamespace(col, job.toSig)`
    // is no longer a staging namespace at all, but the collection's SERVING one. The GC
    // there had no freshness re-check (the `pendingSignature` clear beside it did), so it
    // wiped the live dense index: a full provider re-embed, or silent lexical-only until
    // the daily budget allows one.
    const cid = await newColWithDocs('Reindex-landed-flip', 3);
    const started = await startReindex(tenantId, orgId, cid, { provider: 'openai' });
    const done = await drainReindex(tenantId, orgId, cid);
    expect(done!.status, 'the drain must have flipped and finished').toBe('done');
    const flipped = await getCollection(tenantId, orgId, cid);
    expect(flipped!.activeSignature, 'the collection is serving the NEW namespace').toBe(started.toSig);

    // Rewind the bookkeeping to the crash state: the row says `cutting-over`, the
    // collection is already flipped. Then age it past the lease so the cancel is accepted.
    const storage = __hostExtStorage()!;
    const key = `hostext:kb:reindex:${tenantId}:${orgId}:${cid}`;
    const row = JSON.parse((await storage.kvGet(key))!) as Record<string, unknown>;
    row.status = 'cutting-over';
    row.updatedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    await storage.kvSet(key, JSON.stringify(row));

    const events: HostEventEnvelope[] = [];
    initHostEventDispatcher({
      storage: __hostExtStorage()! as never,
      hostSuite: { workflowCatalog: { getWorkflow: async () => null } } as never,
      deliverWebhooks: async (e) => { events.push(e); },
      startRun: async () => null,
    });
    try {
      const cancelled = await cancelReindex(tenantId, orgId, cid);
      expect(cancelled, 'the aged cutting-over row is claimable').not.toBeNull();

      // THE ASSERTION THAT MATTERS: the live index survives. A dense search still answers.
      const hits = await search(tenantId, orgId, cid, 'reindex', 5);
      expect(hits.length, 'the LIVE namespace must not have been GC-ed by the cancel').toBeGreaterThan(0);
      const col = await getCollection(tenantId, orgId, cid);
      expect(col!.activeSignature, 'the landed flip stands').toBe(started.toSig);

      // And the report is honest: a rebuild that SUCCEEDED is not announced as failed.
      const kb = events.filter((e) => e.type.startsWith('host.kb.reindex.'));
      expect(kb.map((e) => e.type), 'a landed flip reports completed, never failed/lease-expired')
        .toContain('host.kb.reindex.completed');
      expect(kb.map((e) => e.type)).not.toContain('host.kb.reindex.failed');
    } finally {
      __resetHostEventDispatcher();
    }
  });
});
