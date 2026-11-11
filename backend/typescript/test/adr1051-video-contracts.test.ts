/**
 * ADR 1051 — the contracts the red witnesses do not cover on their own.
 *
 *  - D9: the request hash is over the RESOLVED ratio, so two requests that differ
 *    only in ratio are two jobs (never one shared asset).
 *  - D6: a submit row stamped `submitAttemptedAt` with no provider id (a worker
 *    that crashed between the POST and recording the id) is never re-sent: fresh
 *    it reads `pending`, stale it settles `submit_unconfirmed` with its units kept.
 *  - D5: the asset carries the attestation's NON-personal fields; who attested
 *    stays on the job. The dedup branch stamps the pointer too.
 *  - D1: every surface method is named read or write, and the writes are exactly
 *    the policy's `workspace:write` methods.
 *  - D3: the governance override follows the env rule (`0` disables, only
 *    `unlimited` uncaps), and the wire never carries `Infinity`.
 *
 * Sabotage-witnessed at authoring: red when the hash drops `ratio`, when
 * `isReclaimable` stops refusing an attempted submit, and when the asset stops
 * receiving the attestation pointer. (`attestedBy` cannot reach the asset even if
 * the service sent it: `cleanLikenessConsent` keeps only the named fields.)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { configureMediaBudget, _resetMediaBudgetForTest, resolveBudget, videoBudgetWire, reserveMediaBudget } from '../src/aiProviders/mediaBudget.js';
import { generateVideo, textToVideo } from '../src/features/creative-video/videoService.js';
import { claimJob, putJob, listJobs, requestHashFor, __clearVideoJobs } from '../src/features/creative-video/entities/videoJob.js';
import { LIKENESS_CONSENT_TEXT_VERSION, consentCovers } from '../src/features/creative-video/likenessConsent.js';
import { CREATIVE_VIDEO_SURFACE_METHODS, CREATIVE_VIDEO_SURFACE_POLICY, buildCreativeVideoSurface } from '../src/features/creative-video/surface.js';
import { getAsset } from '../src/features/media/mediaService.js';
import type { VideoAdapter } from '../src/features/creative-video/host/videoProviderAdapter.js';

const TINY = Buffer.from('fake-mp4-bytes').toString('base64');
function stub(): VideoAdapter & { submits: { ratio?: string }[] } {
  const a = {
    submits: [] as { ratio?: string }[],
    async hasConnection() { return true; },
    async submitJob(input: { ratio?: string }) { a.submits.push({ ...(input.ratio ? { ratio: input.ratio } : {}) }); return { ok: true as const, value: { providerJobId: `p-${a.submits.length}`, connectionId: 'conn-1' } }; },
    async pollJob() { return { ok: true as const, value: { status: 'completed' as const, resultUrl: 'https://api.heygen.com/r.mp4' } }; },
    async downloadResult() { return { ok: true as const, value: { base64: TINY, bytes: 14, contentType: 'video/mp4' } }; },
  };
  return a;
}

let storage: Storage;
let seq = 0;
const deps = (tenantId: string) => ({ storage, tenantId, runId: 'run-1', actingUserId: 'user:alice', orgId: 'o1' });
const consent = { attestedBy: 'user:alice', attestedAt: '2026-11-03T00:00:00.000Z', textVersion: LIKENESS_CONSENT_TEXT_VERSION, avatarId: 'av1', channel: 'route' as const };

beforeEach(async () => {
  seq += 1;
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-1051c-')) });
  configureMediaBudget({ storage });
  await __clearVideoJobs();
});
afterEach(() => { delete process.env.OPENWOP_MEDIA_DAILY_VIDEO_JOBS; _resetMediaBudgetForTest(); });

describe('D9 — the hash covers the resolved ratio', () => {
  it('the same prompt at two ratios is two jobs', async () => {
    const t = `t-c-${seq}`;
    const a = stub();
    await textToVideo(deps(t), { tenantId: t, orgId: 'o1', prompt: 'A lighthouse', createdBy: 'user:alice' }, a);
    await textToVideo(deps(t), { tenantId: t, orgId: 'o1', prompt: 'A lighthouse', ratio: '720:1280', createdBy: 'user:alice' }, a);
    expect(a.submits.map((s) => s.ratio)).toEqual(['1280:720', '720:1280']);
  });
});

describe('D6 — a crash between the POST and the provider id', () => {
  async function stamped(t: string): Promise<string> {
    const hash = requestHashFor({ provider: 'heygen', orgId: 'o1', kind: 'avatar', script: 'Crash', avatarId: 'av1' });
    const c = await claimJob({ tenantId: t, orgId: 'o1', requestHash: hash, kind: 'avatar', provider: 'heygen', createdBy: 'user:alice' });
    await putJob({ ...c.job, submitAttemptedAt: new Date().toISOString(), reservation: { dayKey: `${t}:x`, units: 1, counted: true } });
    return c.job.jobId;
  }

  it('fresh: pending, and nothing is sent', async () => {
    const t = `t-c-${seq}`;
    await stamped(t);
    const a = stub();
    const out = await generateVideo(deps(t), { tenantId: t, orgId: 'o1', script: 'Crash', avatarId: 'av1', createdBy: 'user:alice', likenessConsent: consent }, a);
    expect(out.status).toBe('pending');
    expect(a.submits).toHaveLength(0);
  });

  it('stale: settles submit_unconfirmed, still sends nothing, keeps the reservation', async () => {
    const t = `t-c-${seq}`;
    const jobId = await stamped(t);
    const a = stub();
    const out = await generateVideo(deps(t), { tenantId: t, orgId: 'o1', script: 'Crash', avatarId: 'av1', createdBy: 'user:alice', likenessConsent: consent, nowMs: Date.now() + 200_000 }, a);
    expect(out).toEqual({ status: 'failed', jobId, error: 'submit_unconfirmed' });
    expect(a.submits).toHaveLength(0);
    const [job] = await listJobs(t, 'o1');
    expect(job?.reservation).toEqual({ dayKey: `${t}:x`, units: 1, counted: true });
  });
});

describe('CV83CD-1/2 — a stale download is recovered, never re-submitted', () => {
  it('a downloading row past the stale window finishes on the SAME provider job: no second submit, the pin kept', async () => {
    const t = `t-c-${seq}`;
    const hash = requestHashFor({ provider: 'heygen', orgId: 'o1', kind: 'avatar', script: 'Stuck download', avatarId: 'av1' });
    const c = await claimJob({ tenantId: t, orgId: 'o1', requestHash: hash, kind: 'avatar', provider: 'heygen', createdBy: 'user:alice' });
    await putJob({ ...c.job, status: 'downloading', providerJobId: 'p-paid', connectionId: 'conn-1', submitAttemptedAt: '2026-11-03T00:00:00.000Z', promptSnippet: 'Stuck download', lineageModel: 'heygen', rightsNote: 'r', likenessConsent: consent });
    const a = stub();
    const out = await generateVideo(deps(t), { tenantId: t, orgId: 'o1', script: 'Stuck download', avatarId: 'av1', createdBy: 'user:alice', likenessConsent: consent, nowMs: Date.now() + 200_000 }, a);
    expect(a.submits, 'the provider already took (and billed) this job').toHaveLength(0);
    expect(out.status).toBe('completed');
    const [job] = await listJobs(t, 'o1');
    expect(job).toMatchObject({ status: 'completed', providerJobId: 'p-paid', connectionId: 'conn-1' });
  });
});

describe('D5 — the asset points at the attestation; the job holds the person', () => {
  it('lineage carries jobId/version/time/avatar and never attestedBy, on the new and the dedup branch', async () => {
    const t = `t-c-${seq}`;
    const a = stub();
    const first = await generateVideo(deps(t), { tenantId: t, orgId: 'o1', script: 'One', avatarId: 'av1', createdBy: 'user:alice', likenessConsent: consent }, a);
    if (first.status !== 'completed') throw new Error(JSON.stringify(first));
    const asset = await getAsset(t, 'o1', first.assetId);
    expect(asset?.lineage?.likenessConsent).toEqual({ jobId: first.jobId, textVersion: LIKENESS_CONSENT_TEXT_VERSION, attestedAt: consent.attestedAt, avatarId: 'av1' });
    expect(JSON.stringify(asset?.lineage)).not.toContain('user:alice');
    const [job] = await listJobs(t, 'o1');
    expect(job?.likenessConsent).toEqual(consent);
  });

  it('consentCovers refuses another avatar, another voice, and an old sentence', () => {
    expect(consentCovers(consent, 'av1', undefined)).toBe(true);
    expect(consentCovers(consent, 'av2', undefined)).toBe(false);
    expect(consentCovers(consent, 'av1', 'v1')).toBe(false);
    expect(consentCovers({ ...consent, textVersion: 'cv-likeness-2025-01' }, 'av1', undefined)).toBe(false);
    expect(LIKENESS_CONSENT_TEXT_VERSION, 'the witness files carry this literal; keep them in step').toBe('cv-likeness-2026-11');
  });
});

describe('D1 — every surface method is classified', () => {
  it('the classification names every method, and its writes are exactly the policy\'s write scopes', () => {
    const methods = Object.keys(buildCreativeVideoSurface({ tenantId: 't', runId: 'r' })).sort();
    expect(Object.keys(CREATIVE_VIDEO_SURFACE_METHODS).sort()).toEqual(methods);
    const writes = Object.entries(CREATIVE_VIDEO_SURFACE_METHODS).filter(([, k]) => k === 'write').map(([m]) => m).sort();
    expect(Object.entries(CREATIVE_VIDEO_SURFACE_POLICY.methodScopes ?? {}).filter(([, s]) => s === 'workspace:write').map(([m]) => m).sort()).toEqual(writes);
  });
});

describe('D3 — the governance override follows the env rule', () => {
  it('override 0 disables, "unlimited" uncaps, absent falls to the env default; the wire never carries Infinity', async () => {
    const overrides: Record<string, { videoJobs?: number | 'unlimited' } | null> = { a: { videoJobs: 0 }, b: { videoJobs: 'unlimited' }, c: null };
    configureMediaBudget({ storage, resolveOverride: async (tid) => overrides[tid] ?? null });
    expect((await resolveBudget('a')).video).toBe(0);
    expect(await reserveMediaBudget('a', 'video', 1)).toMatchObject({ ok: false, reason: 'disabled' });
    expect(videoBudgetWire((await resolveBudget('b')).video)).toBe('unlimited');
    expect(await reserveMediaBudget('b', 'video', 1)).toMatchObject({ ok: true, token: { counted: false } });
    expect((await resolveBudget('c')).video).toBe(10);
    expect(JSON.parse(JSON.stringify({ v: videoBudgetWire((await resolveBudget('b')).video) }))).toEqual({ v: 'unlimited' });
  });

});

describe('pack 1.4.0 — a host refusal keeps its code through the node', () => {
  it('generate / text-to-video / image-to-video return the host code as a typed failure; an uncoded throw propagates', async () => {
    const { nodes: byType } = await import('../../../packs/feature.creative-video.nodes/index.mjs');
    const node = (id: string) => { const fn = byType[`feature.creative-video.nodes.${id}`]; if (!fn) throw new Error(`no node ${id}`); return fn; };
    const nodes = { generate: node('generate'), textToVideo: node('text-to-video'), imageToVideo: node('image-to-video') };
    const refuse = (code: string) => async () => { throw Object.assign(new Error(code), { code }); };
    const ctx = (fn: string, f: () => Promise<unknown>, inputs: Record<string, unknown>) => ({ inputs, features: { 'creative-video': { generateVideo: async () => ({}), [fn]: f } } });
    expect(await nodes.generate(ctx('generateVideo', refuse('likeness_consent_required'), { orgId: 'o', script: 's', avatarId: 'a' }))).toMatchObject({ status: 'failed', error: { code: 'likeness_consent_required' } });
    expect(await nodes.textToVideo(ctx('textToVideo', refuse('forbidden_scope'), { orgId: 'o', prompt: 'p' }))).toMatchObject({ status: 'failed', error: { code: 'forbidden_scope' } });
    expect(await nodes.imageToVideo(ctx('imageToVideo', refuse('validation_error'), { orgId: 'o', prompt: 'p', sourceAssetId: 'x' }))).toMatchObject({ status: 'failed', error: { code: 'validation_error' } });
    await expect(nodes.textToVideo(ctx('textToVideo', async () => { throw new Error('boom'); }, { orgId: 'o', prompt: 'p' }))).rejects.toThrow('boom');
  });
});
