/**
 * ADR 1051 D3/D5/D6/D7 — what may reach a paid video provider.
 *
 *  - D3: the daily cap is a RESERVATION taken before the submit. Concurrent
 *    distinct jobs over the cap: exactly the cap's worth reach the provider.
 *    Unset means the shipped default (10 units); `0` disables paid video; only
 *    `unlimited` is uncapped. A provably-refused submit gives its units back; a
 *    submit the provider may have taken keeps them.
 *  - D5: an avatar job without a person's likeness attestation is refused before
 *    anything is claimed, reserved or sent.
 *  - D6: a submit whose outcome is unknown (a reset or timeout after send, a 5xx,
 *    a 2xx without a job id) is terminal `submit_unconfirmed`, never resubmitted.
 *  - D7: no connection → `no_connection` with no job row.
 *
 * Uses a stub VideoAdapter (no network). RED on unmodified main `ec97cbb21`:
 * the cap was check-then-record (all concurrent jobs submitted), unset meant
 * uncapped and 0 meant uncapped, consent did not exist, an unknown-outcome
 * submit was retriable (the next call paid again), and a missing connection
 * left a failed row.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { configureMediaBudget, _resetMediaBudgetForTest } from '../src/aiProviders/mediaBudget.js';
import { generateVideo, textToVideo, type GenerateOutput } from '../src/features/creative-video/videoService.js';
import { listJobs, __clearVideoJobs } from '../src/features/creative-video/entities/videoJob.js';
import type { VideoAdapter } from '../src/features/creative-video/host/videoProviderAdapter.js';

/** The consent sentence's version (ADR 1051 D5). A literal, so the file ran red on
 *  a tree without the module; `adr1051-video-contracts.test.ts` pins it to the source. */
const LIKENESS_CONSENT_TEXT_VERSION = 'cv-likeness-2026-11';
const TINY = Buffer.from('fake-mp4-bytes').toString('base64');

type SubmitResult = Awaited<ReturnType<VideoAdapter['submitJob']>>;
function stub(opts: { submit?: () => Promise<SubmitResult>; connected?: boolean } = {}): VideoAdapter & { submitCalls: number } {
  const a = {
    submitCalls: 0,
    async hasConnection() { return opts.connected ?? true; },
    async submitJob() {
      a.submitCalls += 1;
      if (opts.submit) return opts.submit();
      return { ok: true as const, value: { providerJobId: `p-${a.submitCalls}`, connectionId: 'conn-1' } };
    },
    async pollJob() { return { ok: true as const, value: { status: 'completed' as const, resultUrl: 'https://api.heygen.com/r.mp4' } }; },
    async downloadResult() { return { ok: true as const, value: { base64: TINY, bytes: 14, contentType: 'video/mp4' } }; },
  };
  return a;
}

let storage: Storage;
let seq = 0;
const T = () => `t-1051-${seq}`;
const deps = (tenantId: string) => ({ storage, tenantId, runId: 'run-1', actingUserId: 'user:alice', orgId: 'o1' });
const consent = (avatarId = 'av1') => ({ attestedBy: 'user:alice', attestedAt: '2026-11-03T00:00:00.000Z', textVersion: LIKENESS_CONSENT_TEXT_VERSION, avatarId, channel: 'route' as const });
const avatar = (tenantId: string, script: string, adapter: VideoAdapter): Promise<GenerateOutput> =>
  generateVideo(deps(tenantId), { tenantId, orgId: 'o1', script, avatarId: 'av1', createdBy: 'user:alice', likenessConsent: consent() }, adapter);
const errorOf = (o: GenerateOutput): string => { if (o.status !== 'failed') throw new Error(`expected failed, got ${JSON.stringify(o)}`); return o.error; };

beforeEach(async () => {
  seq += 1;
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-1051-')) });
  configureMediaBudget({ storage });
  await __clearVideoJobs();
});
afterEach(() => { delete process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS; _resetMediaBudgetForTest(); });

describe('D3 — the cap is reserved before the paid call', () => {
  it('six concurrent distinct jobs under a cap of 3: exactly 3 reach the provider', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '3';
    const a = stub();
    const outs = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => avatar(T(), `script ${i}`, a)));
    expect(a.submitCalls).toBe(3);
    expect(outs.filter((o) => o.status === 'completed')).toHaveLength(3);
    expect(outs.filter((o) => o.status === 'failed').map(errorOf)).toEqual(['budget_exceeded', 'budget_exceeded', 'budget_exceeded']);
  });

  it('unset ships a default of 10 units: the 11th avatar job is refused', async () => {
    const a = stub();
    for (let i = 0; i < 10; i += 1) expect((await avatar(T(), `s${i}`, a)).status).toBe('completed');
    expect(errorOf(await avatar(T(), 's10', a))).toBe('budget_exceeded');
    expect(a.submitCalls).toBe(10);
  });

  it('`0` disables paid video (never "uncapped")', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '0';
    const a = stub();
    expect(errorOf(await avatar(T(), 'x', a))).toBe('video_budget_disabled');
    expect(a.submitCalls).toBe(0);
  });

  it('`unlimited` is the only uncapped value', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = 'unlimited';
    const a = stub();
    for (let i = 0; i < 12; i += 1) expect((await avatar(T(), `u${i}`, a)).status).toBe('completed');
    expect(a.submitCalls).toBe(12);
  });

  it('text-to-video weighs 3 units', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '4';
    const a = stub();
    const t = T();
    expect((await textToVideo(deps(t), { tenantId: t, orgId: 'o1', prompt: 'one', createdBy: 'user:alice' }, a)).status).toBe('completed');
    expect(errorOf(await textToVideo(deps(t), { tenantId: t, orgId: 'o1', prompt: 'two', createdBy: 'user:alice' }, a))).toBe('budget_exceeded');
    expect(a.submitCalls).toBe(1);
  });

  it('a provably-refused submit (a 4xx) gives its units back', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '1';
    const t = T();
    const refused = stub({ submit: async () => ({ ok: false as const, error: 'heygen_400' }) });
    expect(errorOf(await avatar(t, 'first', refused))).toBe('heygen_400');
    expect((await avatar(t, 'second', stub())).status).toBe('completed');
  });
});

describe('D6 — an unknown-outcome submit is never paid twice', () => {
  for (const error of ['request_failed', 'heygen_502', 'heygen_no_job_id']) {
    it(`${error}: terminal submit_unconfirmed, the same inputs never resubmit, and the units stay spent`, async () => {
      process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '1';
      const t = T();
      const a = stub({ submit: async () => ({ ok: false as const, error }) });
      expect(errorOf(await avatar(t, 'once', a))).toBe('submit_unconfirmed');
      expect(errorOf(await avatar(t, 'once', a))).toBe('submit_unconfirmed');
      expect(a.submitCalls).toBe(1);
      expect(errorOf(await avatar(t, 'other', stub())), 'the reservation was kept').toBe('budget_exceeded');
    });
  }
});

describe('D5 — no attestation, nothing sent', () => {
  it('an avatar job without likenessConsent is refused before any row, reservation or submit', async () => {
    const t = T();
    const a = stub();
    await expect(generateVideo(deps(t), { tenantId: t, orgId: 'o1', script: 'hi', avatarId: 'av1', createdBy: 'user:alice' } as never, a))
      .rejects.toMatchObject({ code: 'likeness_consent_required' });
    await expect(generateVideo(deps(t), { tenantId: t, orgId: 'o1', script: 'hi', avatarId: 'av1', createdBy: 'user:alice', likenessConsent: { ...consent(), textVersion: 'old' } }, a))
      .rejects.toMatchObject({ code: 'likeness_consent_required' });
    await expect(generateVideo(deps(t), { tenantId: t, orgId: 'o1', script: 'hi', avatarId: 'av1', createdBy: 'user:alice', likenessConsent: consent('another-avatar') }, a))
      .rejects.toMatchObject({ code: 'likeness_consent_required' });
    expect(a.submitCalls).toBe(0);
    expect(await listJobs(t, 'o1')).toEqual([]);
  });

  it('with an attestation, the job records it', async () => {
    const t = T();
    const out = await avatar(t, 'hi', stub());
    expect(out.status).toBe('completed');
    const [job] = await listJobs(t, 'o1');
    expect(job?.likenessConsent).toEqual(consent());
  });
});

describe('D7 — no row without a connection', () => {
  it('no connection: no_connection, nothing claimed, nothing reserved', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '1';
    const t = T();
    const a = stub({ connected: false });
    expect(errorOf(await avatar(t, 'x', a))).toBe('no_connection');
    expect(a.submitCalls).toBe(0);
    expect(await listJobs(t, 'o1')).toEqual([]);
    expect((await avatar(t, 'y', stub())).status, 'the unit was never taken').toBe('completed');
  });
});
