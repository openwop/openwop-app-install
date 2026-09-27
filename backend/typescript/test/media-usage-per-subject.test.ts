/**
 * ADR 0693 phase 3 — TTS/STT must not pool one daily budget across a shared
 * workspace.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `managed-usage-per-subject.test.ts`.
 * That file tests the COMPOSER. I first added the media cases there too, and a
 * sabotage proved them vacuous: reverting `mediaBudget`'s read to the pooled
 * tenant left all 13 green, because a composer test cannot see whether
 * `checkMediaBudget` actually calls the composer. Mechanism and WIRING have to
 * be pinned separately — the same lesson the ADR 0684 suite taught, one layer
 * over.
 *
 * So every case here drives the real `checkMediaBudget` / `recordMediaUsage`
 * against real storage and asserts what a PARTICIPANT would observe.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  checkMediaBudget, recordMediaUsage, configureMediaBudget, _resetMediaBudgetForTest,
} from '../src/aiProviders/mediaBudget.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';

let storage: Storage;
const WS = 'host-sharedprog';              // a declared default workspace
const A = 'user:aaaa1111';
const B = 'user:bbbb2222';
const CAP = { ttsChars: 1000, sttBytes: 1000 };  // the override keys, not the resolved ones

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});
beforeEach(() => {
  _resetMediaBudgetForTest();
  configureMediaBudget({ storage, resolveOverride: async () => CAP });
});

describe('ADR 0693 phase 3 — a shared workspace does not pool TTS/STT', () => {
  it('participant A spending does NOT appear in participant B usage', async () => {
    await recordMediaUsage(WS, 'tts', 900, A);

    const forA = await checkMediaBudget(WS, 'tts', 1, A);
    const forB = await checkMediaBudget(WS, 'tts', 1, B);

    // THE assertion. Before phase 3 both read the same row, so B saw A's 900
    // and was one short request from a budget they had never used.
    expect(forA.used, 'A must see their own spend').toBe(900);
    expect(forB.used, "B must not inherit A's spend").toBe(0);
  });

  it('A can be over budget while B is still free', async () => {
    await recordMediaUsage(WS, 'tts', 1000, A);
    expect((await checkMediaBudget(WS, 'tts', 1, A)).exceeded).toBe(true);
    expect((await checkMediaBudget(WS, 'tts', 1, B)).exceeded).toBe(false);
  });

  it('STT is metered the same way — not just TTS', async () => {
    await recordMediaUsage(WS, 'stt', 800, A);
    expect((await checkMediaBudget(WS, 'stt', 1, A)).used).toBe(800);
    expect((await checkMediaBudget(WS, 'stt', 1, B)).used).toBe(0);
  });

  it('one subject accumulates across calls — the charge is not thrown away', async () => {
    // A bucket that changed per call would satisfy "A and B differ" while
    // metering nothing at all.
    // A FRESH subject: storage persists across cases in this file and the
    // bucket is keyed by (tenant, subject, UTC date), so reusing A here would
    // measure the accumulated spend of every earlier case. Caught by the test
    // itself reading 2150 instead of 250 — which is the accumulation working.
    const C = 'user:cccc3333';
    await recordMediaUsage(WS, 'tts', 100, C);
    await recordMediaUsage(WS, 'tts', 150, C);
    expect((await checkMediaBudget(WS, 'tts', 1, C)).used).toBe(250);
  });
});

describe('ADR 0693 phase 3 — the cases that must NOT change', () => {
  it('a personal tenant meters exactly as before, with or without a subject', async () => {
    const T = 'user:solo9';
    await recordMediaUsage(T, 'tts', 300, 'user:solo9');
    // Same row either way: a personal tenant's bucket IS the tenant.
    expect((await checkMediaBudget(T, 'tts', 1)).used).toBe(300);
    expect((await checkMediaBudget(T, 'tts', 1, 'user:solo9')).used).toBe(300);
  });

  it('NO subject charges the tenant — the unattributed paths keep working', async () => {
    // kb/notebooks STT and anything without an acting user land here. This is
    // today's behaviour and is why the parameter is optional rather than
    // required: making it mandatory would have broken these callers.
    const W2 = 'host-otherprog';
    await recordMediaUsage(W2, 'stt', 400);
    expect((await checkMediaBudget(W2, 'stt', 1)).used).toBe(400);
  });
});
