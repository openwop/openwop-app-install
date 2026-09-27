/**
 * ADR 0404 §b — AI video provider. Covers the replay/idempotency invariant (a
 * re-run with identical inputs returns the SAME asset id and NEVER re-submits or
 * re-charges — the requestHash CAS), the ADR 0106 `video` budget cap, the
 * fork-stable request hash, and the adapterOnly governed-spend posture. Uses a
 * stub VideoAdapter so no real provider call / poll delay occurs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { configureMediaBudget, _resetMediaBudgetForTest } from '../src/aiProviders/mediaBudget.js';
import { getProvider } from '../src/features/connections/providerRegistry.js';
import { generateVideo, textToVideo, resolveVideoJob, getVideoJob, type GenerateOutput } from '../src/features/creative-video/videoService.js';
import { requestHashFor, claimJob, clearJobsForAsset, __clearVideoJobs } from '../src/features/creative-video/entities/videoJob.js';
import type { VideoAdapter } from '../src/features/creative-video/host/videoProviderAdapter.js';

// A tiny valid base64 "video" payload.
const TINY = Buffer.from('fake-mp4-bytes').toString('base64');

function stubAdapter(): VideoAdapter & { submitCalls: number } {
  const a = {
    submitCalls: 0,
    async submitJob() { a.submitCalls += 1; return { ok: true as const, value: { providerJobId: `p-${a.submitCalls}` } }; },
    async pollJob() { return { ok: true as const, value: { status: 'completed' as const, resultUrl: 'https://api.heygen.com/result.mp4' } }; },
    async downloadResult() { return { ok: true as const, value: { base64: TINY, bytes: 14, contentType: 'video/mp4' } }; },
  };
  return a;
}

const deps = (tenantId: string, orgId: string) => ({ storage: undefined as never, tenantId, runId: 'run-1', actingUserId: 'u1', orgId });

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-video-')) });
  configureMediaBudget({ storage });
  await __clearVideoJobs();
});
afterEach(() => { delete process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS; _resetMediaBudgetForTest(); });

describe('creative-video — provider posture', () => {
  it('heygen is an adapterOnly governed-spend provider', () => {
    const m = getProvider('heygen');
    expect(m?.adapterOnly).toBe(true);
    expect(m?.consumerNodes).toEqual([]);
    expect(m?.apiHosts).toContain('heygen.com');
  });
});

describe('creative-video — request hash is fork-stable', () => {
  it('depends only on the generation inputs (never run/node ids)', () => {
    const a = requestHashFor({ provider: 'heygen', script: 'Hello', avatarId: 'av1' });
    const b = requestHashFor({ provider: 'heygen', script: 'Hello', avatarId: 'av1' });
    const c = requestHashFor({ provider: 'heygen', script: 'Different', avatarId: 'av1' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('creative-video — replay/idempotency + budget', () => {
  it('a re-run with identical inputs returns the SAME asset and never re-submits (CAS)', async () => {
    const adapter = stubAdapter();
    const first = await generateVideo(deps('t1', 'o1'), { tenantId: 't1', orgId: 'o1', script: 'Hi there', avatarId: 'av1', createdBy: 'u1' }, adapter);
    expect(first.status).toBe('completed');
    const assetId = (first as Extract<GenerateOutput, { status: 'completed' }>).assetId;
    expect(assetId).toBeTruthy();

    const replay = await generateVideo(deps('t1', 'o1'), { tenantId: 't1', orgId: 'o1', script: 'Hi there', avatarId: 'av1', createdBy: 'u1' }, adapter);
    expect(replay.status).toBe('completed');
    expect((replay as Extract<GenerateOutput, { status: 'completed' }>).assetId).toBe(assetId); // same asset
    expect(adapter.submitCalls).toBe(1); // NEVER re-submitted / re-charged
  });

  it('enforces the ADR 0106 video budget cap (default OFF, opt-in)', async () => {
    process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS = '1';
    const adapter = stubAdapter();
    const ok = await generateVideo(deps('t2', 'o1'), { tenantId: 't2', orgId: 'o1', script: 'First', avatarId: 'av1', createdBy: 'u1' }, adapter);
    expect(ok.status).toBe('completed');
    // A DIFFERENT generation the same day is over the 1-job cap → failed, not submitted.
    const denied = await generateVideo(deps('t2', 'o1'), { tenantId: 't2', orgId: 'o1', script: 'Second', avatarId: 'av1', createdBy: 'u1' }, adapter);
    expect(denied.status).toBe('failed');
    expect((denied as Extract<GenerateOutput, { status: 'failed' }>).error).toBe('budget_exceeded');
    expect(adapter.submitCalls).toBe(1); // the denied job never reached the provider
  });

  it('isolates jobs by tenant (same inputs, different tenants → distinct assets)', async () => {
    const adapter = stubAdapter();
    const a = await generateVideo(deps('t3', 'o1'), { tenantId: 't3', orgId: 'o1', script: 'Same', avatarId: 'av1', createdBy: 'u1' }, adapter);
    const b = await generateVideo(deps('t4', 'o1'), { tenantId: 't4', orgId: 'o1', script: 'Same', avatarId: 'av1', createdBy: 'u1' }, adapter);
    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
    expect(adapter.submitCalls).toBe(2); // each tenant submits its own
  });

  it('isolates jobs by ORG within a tenant (grade-data CV-1 — no cross-org dedup)', async () => {
    // Two orgs in ONE tenant with byte-identical inputs must get DISTINCT jobs +
    // distinct assets — org B must never dedup onto org A's org-scoped asset id.
    const adapter = stubAdapter();
    const a = await generateVideo(deps('t10', 'oA'), { tenantId: 't10', orgId: 'oA', script: 'Same', avatarId: 'av1', createdBy: 'u1' }, adapter);
    const b = await generateVideo(deps('t10', 'oB'), { tenantId: 't10', orgId: 'oB', script: 'Same', avatarId: 'av1', createdBy: 'u1' }, adapter);
    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
    expect(adapter.submitCalls).toBe(2); // each org submits its own job
    expect((b as Extract<GenerateOutput, { status: 'completed' }>).assetId).not.toBe((a as Extract<GenerateOutput, { status: 'completed' }>).assetId);
  });

  it('a PRE-SUBMIT failure does NOT poison the requestHash (re-claimable)', async () => {
    // Regression for the P3 code-review HIGH-2: a no-connection / failed submit must
    // leave NO permanent tombstone — the exact inputs must be generatable once the
    // provider is connected.
    let n = 0;
    const adapter: VideoAdapter & { submitCalls: number } = {
      submitCalls: 0,
      async submitJob() { n += 1; adapter.submitCalls = n; return n === 1 ? { ok: false as const, error: 'no_connection' } : { ok: true as const, value: { providerJobId: `p-${n}` } }; },
      async pollJob() { return { ok: true as const, value: { status: 'completed' as const, resultUrl: 'https://api.heygen.com/r.mp4' } }; },
      async downloadResult() { return { ok: true as const, value: { base64: TINY, bytes: 14, contentType: 'video/mp4' } }; },
    };
    const first = await generateVideo(deps('t5', 'o1'), { tenantId: 't5', orgId: 'o1', script: 'Retry me', avatarId: 'av1', createdBy: 'u1' }, adapter);
    expect(first.status).toBe('failed');
    expect((first as Extract<GenerateOutput, { status: 'failed' }>).error).toBe('no_connection');
    // Same inputs again — the hash was released, so it re-submits and completes.
    const second = await generateVideo(deps('t5', 'o1'), { tenantId: 't5', orgId: 'o1', script: 'Retry me', avatarId: 'av1', createdBy: 'u1' }, adapter);
    expect(second.status).toBe('completed');
    expect((second as Extract<GenerateOutput, { status: 'completed' }>).assetId).toBeTruthy();
  });

  it('a permanent (host-denied) download is TERMINAL — no eternal pending, no re-charge on retry', async () => {
    // Regression for P4 MEDIUM-2 + grade-code CV-1: an SSRF-denied result URL must
    // fail with the reason (not loop as pending) AND must NOT be re-claimable — a
    // retry with identical inputs must not submit a second paid job.
    const adapter: VideoAdapter & { submitCalls: number } = {
      submitCalls: 0,
      async submitJob() { adapter.submitCalls += 1; return { ok: true as const, value: { providerJobId: `p${adapter.submitCalls}` } }; },
      async pollJob() { return { ok: true as const, value: { status: 'completed' as const, resultUrl: 'https://evil.example.com/x.mp4' } }; },
      async downloadResult() { return { ok: false as const, error: 'video_result_url_host_denied:evil.example.com' }; },
    };
    const out = await generateVideo(deps('t8', 'o1'), { tenantId: 't8', orgId: 'o1', script: 'Denied', avatarId: 'av1', createdBy: 'u1' }, adapter);
    expect(out.status).toBe('failed');
    expect((out as Extract<GenerateOutput, { status: 'failed' }>).error).toBe('video_result_url_host_denied:evil.example.com');
    // Retry: the terminal error is NOT reclaimable → returns failed, never re-submits.
    const retry = await generateVideo(deps('t8', 'o1'), { tenantId: 't8', orgId: 'o1', script: 'Denied', avatarId: 'av1', createdBy: 'u1' }, adapter);
    expect(retry.status).toBe('failed');
    expect(adapter.submitCalls).toBe(1); // NO second paid job
  });

  it('resolveVideoJob finishes a job still pending after the inline poll (grade-code CV-2)', async () => {
    // A real (minutes-long) job lands `pending` inline (here: first poll not-ready);
    // the status/resolve path must drive it to completion — not only re-invoking generate.
    let polls = 0;
    const adapter: VideoAdapter & { submitCalls: number } = {
      submitCalls: 0,
      async submitJob() { adapter.submitCalls += 1; return { ok: true as const, value: { providerJobId: 'p1' } }; },
      async pollJob() { polls += 1; return polls <= 1 ? { ok: false as const, error: 'not_ready' } : { ok: true as const, value: { status: 'completed' as const, resultUrl: 'https://api.heygen.com/r.mp4' } }; },
      async downloadResult() { return { ok: true as const, value: { base64: TINY, bytes: 14, contentType: 'video/mp4' } }; },
    };
    const gen = await generateVideo(deps('t11', 'o1'), { tenantId: 't11', orgId: 'o1', script: 'Long', avatarId: 'av1', createdBy: 'u1' }, adapter);
    expect(gen.status).toBe('pending'); // inline poll not ready → pending, job stays processing
    const resolved = await resolveVideoJob(deps('t11', 'o1'), 't11', 'o1', gen.jobId, adapter);
    expect(resolved?.status).toBe('completed'); // resolve's poll finds it done + stores the asset
    expect(resolved?.assetId).toBeTruthy();
    expect(adapter.submitCalls).toBe(1); // resolve polls; it never re-submits
  });

  it('clearJobsForAsset prunes a completed job when its media asset is deleted (grade-data CV-2)', async () => {
    const adapter = stubAdapter();
    const gen = await generateVideo(deps('t12', 'o1'), { tenantId: 't12', orgId: 'o1', script: 'Asset', avatarId: 'av1', createdBy: 'u1' }, adapter);
    const assetId = (gen as Extract<GenerateOutput, { status: 'completed' }>).assetId;
    const pruned = await clearJobsForAsset('t12', 'o1', assetId);
    expect(pruned).toBe(1);
    expect(await getVideoJob('t12', 'o1', gen.jobId)).toBeNull(); // gone → re-generatable
  });

  it('does NOT steal a live submitting row, but re-claims an ABANDONED one after the stale window', async () => {
    // Regression for the P4 code-review HIGH-1: a concurrent caller must never delete/
    // steal a fresh in-flight claim (double-charge), only a crashed (stale) one.
    const hash = requestHashFor({ provider: 'heygen', orgId: 'o1', kind: 'avatar', script: 'Stuck', avatarId: 'av1' });
    await claimJob({ tenantId: 't9', orgId: 'o1', requestHash: hash, kind: 'avatar', provider: 'heygen', createdBy: 'u0' });
    const adapter = stubAdapter();
    // Fresh stuck row (age ~0): a concurrent caller must NOT submit — it returns pending.
    const live = await generateVideo(deps('t9', 'o1'), { tenantId: 't9', orgId: 'o1', script: 'Stuck', avatarId: 'av1', createdBy: 'u1' }, adapter);
    expect(live.status).toBe('pending');
    expect(adapter.submitCalls).toBe(0);
    // Once the row is stale (crashed worker), a later caller re-claims + completes it.
    const recovered = await generateVideo(deps('t9', 'o1'), { tenantId: 't9', orgId: 'o1', script: 'Stuck', avatarId: 'av1', createdBy: 'u1', nowMs: Date.now() + 200_000 }, adapter);
    expect(recovered.status).toBe('completed');
    expect(adapter.submitCalls).toBe(1);
  });

  it('dedups identical bytes to ONE asset within a tenant (no orphan)', async () => {
    // Regression for the P3 code-review MEDIUM-4: two distinct jobs whose provider
    // returns identical bytes reuse one media asset (content-hash dedup).
    const adapter = stubAdapter(); // downloadResult always returns TINY
    const a = await generateVideo(deps('t6', 'o1'), { tenantId: 't6', orgId: 'o1', script: 'Alpha', avatarId: 'av1', createdBy: 'u1' }, adapter);
    const b = await generateVideo(deps('t6', 'o1'), { tenantId: 't6', orgId: 'o1', script: 'Beta', avatarId: 'av1', createdBy: 'u1' }, adapter);
    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
    expect((b as Extract<GenerateOutput, { status: 'completed' }>).assetId).toBe((a as Extract<GenerateOutput, { status: 'completed' }>).assetId);
  });
});

describe('creative-video — text-to-video (ADR 0404 §P4)', () => {
  it('runway is an adapterOnly governed-spend provider', () => {
    const m = getProvider('runway');
    expect(m?.adapterOnly).toBe(true);
    expect(m?.consumerNodes).toEqual([]);
    expect(m?.apiHosts).toContain('runwayml.com');
  });

  it('the request hash does NOT collide across mode/model (no under-charge/wrong-asset)', () => {
    const avatar = requestHashFor({ provider: 'heygen', kind: 'avatar', script: 'Hello', avatarId: 'av1' });
    const t2v = requestHashFor({ provider: 'runway', kind: 't2v', script: 'Hello' });
    const t2vModelB = requestHashFor({ provider: 'runway', kind: 't2v', model: 'veo-2', script: 'Hello' });
    expect(avatar).not.toBe(t2v); // same script, different mode → distinct jobs
    expect(t2v).not.toBe(t2vModelB); // same prompt, different model → distinct jobs
  });

  it('text-to-video is replay-safe (submit-once, asset pinned)', async () => {
    const adapter = stubAdapter();
    const first = await textToVideo(deps('t7', 'o1'), { tenantId: 't7', orgId: 'o1', prompt: 'A robot dances', createdBy: 'u1' }, adapter);
    expect(first.status).toBe('completed');
    const assetId = (first as Extract<GenerateOutput, { status: 'completed' }>).assetId;
    expect(assetId).toBeTruthy();
    const replay = await textToVideo(deps('t7', 'o1'), { tenantId: 't7', orgId: 'o1', prompt: 'A robot dances', createdBy: 'u1' }, adapter);
    expect((replay as Extract<GenerateOutput, { status: 'completed' }>).assetId).toBe(assetId);
    expect(adapter.submitCalls).toBe(1); // never re-submitted / re-charged
  });
});
