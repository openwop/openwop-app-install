/** ADR 0951 P2 review, finding 3 — a chunk upload must not re-read the
 * org-level fences at every boundary. `fencesHold` cost about ten storage
 * reads (attestation, the session row AGAIN inside the eligibility check, the
 * enablement row, three toggles, consent) and `putReplayChunk` called it about
 * three times per chunk. The org fences (attestation, replay state, epoch) are
 * now read once per call and compared with the row in hand; consent, the fence
 * a visitor can move at any moment, is still re-read at every boundary, and a
 * read re-checks every fence. The witness counts the storage reads themselves.
 * Real SQLite rows, real toggle service, real blob bytes (memory backend).
 *
 * Sabotage witnesses (w103; src/features/analytics/replayStore.ts): re-reading
 * the org fences (`readReplayOrgFences`) at each consent boundary of an upload,
 * the shape this finding removed, pushes a follow-on chunk past the read bound. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { mergeConsentCategories } from '../src/features/consent/consentService.js';
import { getReplaySession, putReplayChunk, type ReplaySession } from '../src/features/analytics/replayStore.js';
import { attestReplayOrg, setReplayToggles } from './helpers/replayToggles.js';

let a: Storage;
let dir: string;
let saved: Record<string, string | undefined>;
const CHUNK = Buffer.from('masked geometry').toString('base64');
const ENV = ['OPENWOP_SURFACE_BLOB', 'OPENWOP_REPLAY_ALLOW_MEMORY_BLOB'] as const;
/** The measured cost after the fix is 21 storage reads for a follow-on chunk
 *  (it was 45). The bound leaves room for one more fence without allowing the
 *  per-boundary org re-reads back. */
const MAX_READS_PER_CHUNK = 25;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-replay-reads-'));
  a = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  initHostExtPersistence(a);
  initInMemorySurfaces({ dataDir: dir });
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.OPENWOP_SURFACE_BLOB = 'memory';
  process.env.OPENWOP_REPLAY_ALLOW_MEMORY_BLOB = 'true';
  await setReplayToggles('on');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await a.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ADR 0951 P2 review #3 — per-chunk reads', () => {
  it('a follow-on chunk reads the org fences once, not at every boundary', async () => {
    const now = new Date().toISOString();
    const r: ReplaySession = { tenantId: `replay-reads-${randomUUID()}`, orgId: 'client-a', sessionId: randomUUID(), subjectKey: 'visitor:reads',
      pageIds: [], startedAt: now, updatedAt: now, durationMs: 0, bytes: 0, chunkCount: 0, flags: {} };
    await attestReplayOrg(r.tenantId, r.orgId);
    await mergeConsentCategories({ tenantId: r.tenantId, subjectKey: r.subjectKey, categories: { 'analytics.replay': true }, source: `public:${r.orgId}` });
    await putReplayChunk(r, 0, CHUNK);
    const gets = vi.spyOn(a, 'kvGet');
    const lists = vi.spyOn(a, 'kvList');
    await putReplayChunk(r, 1, CHUNK);
    const reads = gets.mock.calls.length + lists.mock.calls.length;
    gets.mockRestore(); lists.mockRestore();
    expect(reads).toBeLessThanOrEqual(MAX_READS_PER_CHUNK);
    expect(await getReplaySession(r.tenantId, r.orgId, r.sessionId)).toMatchObject({ chunkCount: 2 });
  });
});
