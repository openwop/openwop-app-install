/**
 * ADR 0106 Phase 1 — per-org media-generation cost budget. Covers:
 *  - the storage round-trip (`incrementMediaUsage`/`getMediaUsage`, additive upsert);
 *  - the budget checker (`checkMediaBudget`): off-by-default, under/over a cap,
 *    per-kind isolation, fail-open on no store;
 *  - `recordMediaUsage` no-ops when the kind is uncapped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import {
  checkMediaBudget,
  recordMediaUsage,
  configureMediaBudget,
  _resetMediaBudgetForTest,
  mediaDailyBudget,
  estimateMediaBytes,
  resolveBudget,
} from '../src/aiProviders/mediaBudget.js';
import type { Storage } from '../src/storage/storage.js';

const TTS = 'OPENWOP_MEDIA_DAILY_TTS_CHARS';
const STT = 'OPENWOP_MEDIA_DAILY_STT_BYTES';
const today = new Date().toISOString().slice(0, 10);

let storage: Storage;

beforeEach(async () => {
  storage = await openStorage('memory://');
  configureMediaBudget({ storage });
});
afterEach(() => {
  delete process.env[TTS];
  delete process.env[STT];
  _resetMediaBudgetForTest();
});

describe('storage media usage round-trip (ADR 0106)', () => {
  it('starts at zero, accumulates additively per (tenant, day)', async () => {
    expect(await storage.getMediaUsage('user:a', today)).toEqual({ ttsChars: 0, sttBytes: 0 });
    await storage.incrementMediaUsage('user:a', today, 100, 0);
    await storage.incrementMediaUsage('user:a', today, 50, 2048);
    expect(await storage.getMediaUsage('user:a', today)).toEqual({ ttsChars: 150, sttBytes: 2048 });
    // a different tenant is isolated
    expect(await storage.getMediaUsage('user:b', today)).toEqual({ ttsChars: 0, sttBytes: 0 });
  });
});

describe('checkMediaBudget (ADR 0106)', () => {
  it('is off by default (no env) — never exceeded, no read needed', async () => {
    expect(mediaDailyBudget()).toEqual({ tts: 0, stt: 0 });
    const v = await checkMediaBudget('user:a', 'tts', 1_000_000);
    expect(v.exceeded).toBe(false);
    expect(v.cap).toBe(0);
  });

  it('admits up to the cap, then reports exceeded', async () => {
    process.env[TTS] = '1000';
    await storage.incrementMediaUsage('user:a', today, 900, 0);
    // 900 + 100 = 1000 ≤ cap → ok
    expect((await checkMediaBudget('user:a', 'tts', 100)).exceeded).toBe(false);
    // 900 + 101 = 1001 > cap → exceeded
    const over = await checkMediaBudget('user:a', 'tts', 101);
    expect(over.exceeded).toBe(true);
    expect(over.cap).toBe(1000);
    expect(over.used).toBe(900);
    expect(over.nextTotal).toBe(1001);
  });

  it('budgets tts and stt independently', async () => {
    process.env[STT] = '4096';
    // tts has no cap → never exceeded even at a huge size
    expect((await checkMediaBudget('user:a', 'tts', 9_999_999)).exceeded).toBe(false);
    // stt is capped
    await storage.incrementMediaUsage('user:a', today, 0, 4000);
    expect((await checkMediaBudget('user:a', 'stt', 97)).exceeded).toBe(true);
    expect((await checkMediaBudget('user:a', 'stt', 96)).exceeded).toBe(false);
  });

  it('fails OPEN when no store is configured (a usage outage must not block a paid call)', async () => {
    process.env[TTS] = '10';
    _resetMediaBudgetForTest(); // drop the store
    expect((await checkMediaBudget('user:a', 'tts', 1000)).exceeded).toBe(false);
  });
});

describe('estimateMediaBytes (ADR 0106 Phase 2 pre-flight)', () => {
  it('approximates decoded bytes from base64 length, accounting for padding', () => {
    expect(estimateMediaBytes('')).toBe(0);
    // 'AAAA' (4 chars, no padding) → 3 bytes
    expect(estimateMediaBytes('AAAA')).toBe(3);
    // matches the actual decoded length for real payloads
    const buf = Buffer.from('the quick brown fox jumps over the lazy dog');
    const b64 = buf.toString('base64');
    expect(estimateMediaBytes(b64)).toBe(buf.length);
  });
});

describe('recordMediaUsage (ADR 0106)', () => {
  it('writes when the kind is capped', async () => {
    process.env[TTS] = '1000';
    await recordMediaUsage('user:a', 'tts', 120);
    expect((await storage.getMediaUsage('user:a', today)).ttsChars).toBe(120);
  });

  it('NO-OPs when the kind is uncapped (default) — zero write overhead', async () => {
    await recordMediaUsage('user:a', 'tts', 120); // tts uncapped
    expect((await storage.getMediaUsage('user:a', today)).ttsChars).toBe(0);
  });
});

describe('resolveBudget — per-org override (ADR 0106 editable override)', () => {
  it('a per-org override field WINS over the env default, field by field', async () => {
    process.env[TTS] = '1000';
    process.env[STT] = '2000';
    configureMediaBudget({ storage, resolveOverride: async () => ({ ttsChars: 50 }) }); // only TTS overridden
    const b = await resolveBudget('user:a');
    expect(b.tts).toBe(50);   // override wins
    expect(b.stt).toBe(2000); // absent field ⇒ env default
  });

  it('an explicit override of 0 UNCAPS that kind for the org (overrides a non-zero env)', async () => {
    process.env[TTS] = '1000';
    configureMediaBudget({ storage, resolveOverride: async () => ({ ttsChars: 0 }) });
    const b = await resolveBudget('user:a');
    expect(b.tts).toBe(0); // 0 = uncapped, overriding the env 1000
    expect((await checkMediaBudget('user:a', 'tts', 9_999_999)).exceeded).toBe(false);
  });

  it('falls back to env when no resolver / null override', async () => {
    process.env[TTS] = '1000';
    configureMediaBudget({ storage, resolveOverride: async () => null });
    expect((await resolveBudget('user:a')).tts).toBe(1000);
  });

  it('fails SOFT to the env default when the resolver throws', async () => {
    process.env[TTS] = '1000';
    configureMediaBudget({ storage, resolveOverride: async () => { throw new Error('gov down'); } });
    expect((await resolveBudget('user:a')).tts).toBe(1000); // not blocked by the outage
  });

  it('checkMediaBudget + recordMediaUsage honor the override (cap from override, env unset)', async () => {
    // env unset for both ⇒ without an override, uncapped. The override caps STT.
    configureMediaBudget({ storage, resolveOverride: async () => ({ sttBytes: 100 }) });
    await storage.incrementMediaUsage('user:a', today, 0, 90);
    expect((await checkMediaBudget('user:a', 'stt', 11)).exceeded).toBe(true);  // 90+11 > 100
    expect((await checkMediaBudget('user:a', 'stt', 10)).exceeded).toBe(false); // 90+10 = 100
    // recordMediaUsage accumulates for an override-capped kind even with env unset.
    await recordMediaUsage('user:a', 'stt', 5);
    expect((await storage.getMediaUsage('user:a', today)).sttBytes).toBe(95);
  });
});
