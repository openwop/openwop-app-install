/** ADR 0951 P2.4 — the recordings list is bounded per request: narrowed to the
 * org, committed, active, unexpired and fence-current BEFORE any per-row read,
 * one consent read per visitor, and paginated. Real SQLite rows in the
 * production shape; the toggles and consent run through their real services.
 *
 * Sabotage witnesses (w103; src/features/analytics/replayStore.ts
 * `listReplaySessionsForOrg`): dropping the retention cutoff, the committed
 * filter, the page break, the newest-first sort or the strict cursor `<` reds
 * the paging case; keying the consent memo per row reds the one-read-per-visitor
 * case; ignoring the consent generation, a cached attestation, or listing while
 * replay is off reds the withdrawn/unattested/off case. */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { getStrictGrantGeneration, mergeConsentCategories } from '../src/features/consent/consentService.js';
import { REPLAY_DEFAULT_RETENTION_DAYS, REPLAY_LIST_PAGE, listReplaySessionsForOrg, setReplayOrgEligibility } from '../src/features/analytics/replayStore.js';
import { attestReplayOrg, setReplayToggles } from './helpers/replayToggles.js';

let a: Storage;
let dir: string;
let tenantId: string;
let saved: Record<string, string | undefined>;
const ENV = ['OPENWOP_SURFACE_BLOB', 'OPENWOP_REPLAY_ALLOW_MEMORY_BLOB'] as const;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'owp-replay-list-'));
  a = await openStorage(`sqlite://${join(dir, 'store.db')}`);
  initHostExtPersistence(a);
  initInMemorySurfaces({ dataDir: dir });
  tenantId = `replay-list-${randomUUID()}`;
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.OPENWOP_SURFACE_BLOB = 'memory';
  process.env.OPENWOP_REPLAY_ALLOW_MEMORY_BLOB = 'true';
  await setReplayToggles('on');
  await attestReplayOrg(tenantId, 'client-a');
  await attestReplayOrg(tenantId, 'client-b');
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await a.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seed(n: number, opts: { orgId?: string; subjectKey?: string; ageDays?: number; committed?: boolean } = {}): Promise<string[]> {
  const orgId = opts.orgId ?? 'client-a';
  const subjectKey = opts.subjectKey ?? 'visitor:list';
  await mergeConsentCategories({ tenantId, subjectKey, categories: { 'analytics.replay': true }, source: `public:${orgId}` });
  const generation = await getStrictGrantGeneration(tenantId, subjectKey, 'analytics.replay');
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const sessionId = randomUUID();
    const startedAt = new Date(Date.now() - (opts.ageDays ?? 0) * 86_400_000 - i * 1000).toISOString();
    await a.kvSet(`hostext:analytics:replay:${tenantId}:${orgId}:${sessionId}`, JSON.stringify({
      tenantId, orgId, sessionId, subjectKey, pageIds: [], startedAt, updatedAt: startedAt, durationMs: 0, bytes: 15, chunkCount: 1, flags: {},
      privacy: { state: 'active', committed: opts.committed ?? true, pending: [], chunks: { 0: { digest: 'd', bytes: 15 } },
        consentGeneration: generation, enablementEpoch: 'initial', eligibilityId: `test-${tenantId}-${orgId}` },
    }));
    ids.push(sessionId);
  }
  return ids;
}

describe('ADR 0951 P2.4 — bounded recordings list', () => {
  it('pages newest first, and leaves out other orgs, expired and uncommitted rows', async () => {
    const mine = await seed(REPLAY_LIST_PAGE + 3);
    await seed(4, { orgId: 'client-b', subjectKey: 'visitor:other' });
    await seed(2, { ageDays: REPLAY_DEFAULT_RETENTION_DAYS + 1, subjectKey: 'visitor:old' });
    await seed(2, { committed: false, subjectKey: 'visitor:pending' });
    const first = await listReplaySessionsForOrg(tenantId, 'client-a');
    expect(first.sessions.map((s) => s.sessionId)).toEqual(mine.slice(0, REPLAY_LIST_PAGE));
    expect(first.nextCursor).toBeTypeOf('string');
    const second = await listReplaySessionsForOrg(tenantId, 'client-a', { cursor: first.nextCursor! });
    expect(second.sessions.map((s) => s.sessionId)).toEqual(mine.slice(REPLAY_LIST_PAGE));
    expect(second.nextCursor).toBeUndefined();
  });

  it('reads consent once per visitor, never once per row', async () => {
    await seed(40, { subjectKey: 'visitor:one' });
    await seed(5, { subjectKey: 'visitor:two' });
    const read = a.kvGet.bind(a);
    let consentReads = 0;
    vi.spyOn(a, 'kvGet').mockImplementation(async (key) => {
      if (key.startsWith('hostext:consent:record:')) consentReads++;
      return read(key);
    });
    expect((await listReplaySessionsForOrg(tenantId, 'client-a')).sessions).toHaveLength(45);
    // getStrictGrantGeneration reads the consent row twice per visitor: two visitors, four reads.
    expect(consentReads).toBe(4);
  });

  it('a withdrawn visitor, an unattested org and replay off all list nothing for those rows', async () => {
    const stays = await seed(3, { subjectKey: 'visitor:stays' });
    await seed(2, { subjectKey: 'visitor:leaves' });
    await seed(2, { orgId: 'client-b', subjectKey: 'visitor:org-b' });
    await mergeConsentCategories({ tenantId, subjectKey: 'visitor:leaves', categories: { 'analytics.replay': false }, source: 'public:client-a' });
    expect((await listReplaySessionsForOrg(tenantId, 'client-a')).sessions.map((s) => s.sessionId)).toEqual(stays);
    // client-b's attestation is withdrawn: its rows stop listing, client-a's do not.
    expect((await listReplaySessionsForOrg(tenantId, 'client-b')).sessions).toHaveLength(2);
    await setReplayOrgEligibility(tenantId, 'client-b', false, 'user:admin');
    expect(await listReplaySessionsForOrg(tenantId, 'client-b')).toEqual({ sessions: [] });
    expect((await listReplaySessionsForOrg(tenantId, 'client-a')).sessions.map((s) => s.sessionId)).toEqual(stays);
    await setReplayToggles('off');
    expect(await listReplaySessionsForOrg(tenantId, 'client-a')).toEqual({ sessions: [] });
  });
});
