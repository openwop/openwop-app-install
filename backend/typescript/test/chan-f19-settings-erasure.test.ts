/**
 * CHAN-F19 #4 (ADR 0464 §9) — the settings feature keeps two per-person stores:
 * `settings:user-prefs` (one row per tenant and user: personal budget cap,
 * reasoning-directive override, privacy opt-outs) and `settings:byok-usage`
 * (one row per tenant, user and UTC day: that person's BYOK token counters).
 * Neither had an eraser; the first sat in RECORDED_DEBT, the second in the
 * signal-free baseline because its rows did not name the user outside the key.
 *
 * This boots the REAL app (so the registered eraser set is the production one),
 * writes rows through the real store functions, and erases one person through the
 * host fan-out (`eraseSubject`). It pins:
 *  - the person's prefs row and every one of their day counters are deleted;
 *  - a counter written before rows carried `userId` (read from its key) is deleted too;
 *  - another person's rows in the same workspace are kept;
 *  - the same person's rows in ANOTHER workspace are kept (tenant-scoped).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { getUserByokUsage, getUserPrefs, incrementUserByokUsage, putUserPrefs } from '../src/features/settings/prefsStore.js';

let server: http.Server;
const T = 'ws-settings-f19-a';
const OTHER_T = 'ws-settings-f19-b';
const ALICE = 'user:settings-f19-alice';
const BOB = 'user:settings-f19-bob';
const DAY1 = '2026-11-13';
const DAY2 = '2026-11-14';
const LEGACY_DAY = '2026-11-01';

interface LegacyUsageRow { id: string; tenantId: string; inputTokens: number; outputTokens: number; updatedAt: string }
// The same tenant-indexed collection the store uses, to write a row in the
// pre-`userId` shape (the email-engagement-retention precedent).
const usageView = () => new DurableCollection<LegacyUsageRow>('settings:byok-usage', (r) => r.id, undefined, (r) => r.tenantId);

async function seed(tenantId: string, userId: string): Promise<void> {
  await putUserPrefs(tenantId, userId, { personalBudget: { dailyTokenCap: 5000 }, privacy: { analyticsOptOut: true } });
  await incrementUserByokUsage(tenantId, userId, DAY1, 100, 20);
  await incrementUserByokUsage(tenantId, userId, DAY2, 300, 40);
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo).port; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('CHAN-F19 #4 — personal settings on a DSAR', () => {
  it('deletes the subject\'s prefs and BYOK counters, in their workspace only', async () => {
    await seed(T, ALICE);
    await seed(T, BOB);
    await seed(OTHER_T, ALICE);
    await usageView().put({ id: `${T}:${ALICE}:${LEGACY_DAY}`, tenantId: T, inputTokens: 7, outputTokens: 1, updatedAt: new Date().toISOString() });
    expect((await getUserByokUsage(T, ALICE, LEGACY_DAY)).inputTokens, 'the legacy row is readable before erasure').toBe(7);

    await eraseSubject(T, ALICE);

    expect(await getUserPrefs(T, ALICE)).toBeNull();
    for (const day of [DAY1, DAY2, LEGACY_DAY]) {
      expect(await getUserByokUsage(T, ALICE, day), `Alice's ${day} counter`).toEqual({ inputTokens: 0, outputTokens: 0 });
    }

    // Bob, in the same workspace, keeps everything.
    expect((await getUserPrefs(T, BOB))?.personalBudget?.dailyTokenCap).toBe(5000);
    expect(await getUserByokUsage(T, BOB, DAY2)).toEqual({ inputTokens: 300, outputTokens: 40 });

    // Alice in another workspace is a different erasure.
    expect((await getUserPrefs(OTHER_T, ALICE))?.privacy?.analyticsOptOut).toBe(true);
    expect(await getUserByokUsage(OTHER_T, ALICE, DAY1)).toEqual({ inputTokens: 100, outputTokens: 20 });
  });
});
