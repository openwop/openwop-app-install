/**
 * AI-video orchestration (ADR 0404 §b avatar + §P4 text-to-video). ONE replay-safe
 * async pipeline serves both modes (a `kind`) — avatar (HeyGen-class, governed via
 * the `heygen` broker provider) and t2v (frontier text→video, governed via its own
 * broker provider behind the `creative-video.t2v` sub-toggle). The invariants:
 *  - SUBMIT-once: an insert-if-absent CAS on the requestHash-keyed job row gates
 *    submission; a re-run/fork with identical inputs finds the existing job and
 *    NEVER re-submits or re-charges. Cost is metered once, at submit.
 *  - PRE-SUBMIT failures leave NO tombstone: budget-denied / no-connection / a
 *    submit that never reached the provider RELEASE the dedup row so the exact
 *    inputs stay generatable once the cap resets or the provider is connected.
 *    Only a PROVIDER-CONFIRMED failure is durable.
 *  - The completed asset id is pinned on the job; the node returns it, so replay
 *    returns the recorded asset id and never regenerates.
 *  - DOWNLOAD-once: a CAS transition processing→downloading elects a single
 *    finalizer to store the (large) bytes + mint the asset — concurrent finalizers
 *    never orphan a second copy; content-hash dedup is the belt.
 *  - The node bounded-polls; if the provider isn't done within the window it
 *    returns `pending` (a re-invocation resolves the same job — poll-only v1;
 *    the provider webhook is a deferred latency optimization).
 *  - The untrusted result URL download is egress-guarded (redirect/rebind/https) +
 *    SSRF-host-allowlisted + size-capped, and `assertOrgCapacity` runs BEFORE the
 *    bytes are stored.
 *
 * @see docs/adr/0404-event-and-creative-provider-integrations.md §b / §P4
 */

import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import type { BrokeredEgressDeps } from '../../host/brokeredEgress.js';
import { checkMediaBudget, recordMediaUsage } from '../../aiProviders/mediaBudget.js';
import { createAsset, assertOrgCapacity, findAssetByContentHash } from '../media/mediaService.js';
import { put as mediaPut } from '../media/mediaStorage.js';
import { makeVideoAdapter, type VideoAdapter, type SubmitJobInput } from './host/videoProviderAdapter.js';
import { makeT2VAdapter, t2vProvider } from './host/t2vProviderAdapter.js';
import { onMediaAssetDeleted } from '../../host/mediaAssetLifecycle.js';
import { requestHashFor, jobIdFor, claimJob, casJob, getJob, getJobByHash, putJob, clearJobsForAsset, type VideoJob, type VideoJobKind } from './entities/videoJob.js';

const log = createLogger('creative-video');
const AVATAR_PROVIDER = 'heygen';

/** Whether the creative-video surface is exposed (default on when the toggle is on). */
export function creativeVideoEnabled(): boolean {
  return process.env.OPENWOP_CREATIVE_VIDEO_ENABLED !== 'false';
}

/** Poll ceiling — bounded so a node/route never pins a worker near the Cloud Run
 *  request timeout. A longer job returns `pending`; a re-invoke resolves it. */
function pollMaxMs(): number {
  const raw = Number(process.env.OPENWOP_VIDEO_POLL_MAX_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90_000;
}
const POLL_INTERVAL_MS = 5_000;
/** A `submitting`/`downloading` row older than this is treated as ABANDONED (a
 *  crashed worker) and re-claimable — long enough that a live in-flight submit or
 *  download (seconds) is never stolen by a concurrent caller. */
const STALE_STATE_MS = 120_000;
/** Deterministic terminal failures — a retry would repeat the SAME real rejection,
 *  so the job is NOT re-claimable and must not re-submit/re-charge (grade-code CV-1/
 *  CV-3): a provider-confirmed failure, a capacity rejection, an over-cap download,
 *  or an SSRF-refused result URL. Everything else (budget cap, no-connection, a
 *  transient network blip) IS retriable. */
const TERMINAL_ERRORS = new Set(['provider_failed', 'capacity_exceeded', 'video_too_large']);
/** A download rejection that a retry can never fix (the URL is refused by the SSRF
 *  guard) — surface it as a real failure, don't loop forever as `pending`. */
function isPermanentDownloadError(err: string): boolean {
  return err.startsWith('video_result_url_');
}
/** Any deterministic terminal error (set membership OR a permanent URL rejection). */
function isTerminalError(err: string): boolean {
  return TERMINAL_ERRORS.has(err) || isPermanentDownloadError(err);
}
/** Frontier T2V is pricier than an avatar render — meter a heavier weight per job
 *  against the shared daily `video` budget (operator-tunable). */
function t2vCostUnits(): number {
  const raw = Number(process.env.OPENWOP_T2V_COST_UNITS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
}

export interface GenerateVideoInput {
  tenantId: string;
  orgId: string;
  script: string;
  avatarId: string;
  voiceId?: string;
  createdBy: string;
  /** Injectable clock for tests. */
  nowMs?: number;
}

export interface TextToVideoInput {
  tenantId: string;
  orgId: string;
  prompt: string;
  model?: string;
  durationSec?: number;
  createdBy: string;
  nowMs?: number;
}

export type GenerateOutput =
  | { status: 'completed'; jobId: string; assetId: string }
  | { status: 'pending'; jobId: string }
  | { status: 'failed'; jobId: string; error: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function jobView(job: VideoJob): Record<string, unknown> {
  return { jobId: job.jobId, kind: job.kind, status: job.status, provider: job.provider, ...(job.model ? { model: job.model } : {}), ...(job.assetId ? { assetId: job.assetId } : {}), ...(job.error ? { error: job.error } : {}), createdAt: job.createdAt };
}

/** The provider-neutral generation parameters the shared core runs. */
interface RunParams {
  tenantId: string;
  orgId: string;
  kind: VideoJobKind;
  provider: string;
  model?: string;
  /** The text driving the render — an avatar script or a t2v prompt. */
  text: string;
  submit: SubmitJobInput;
  costUnits: number;
  createdBy: string;
  nowMs?: number;
  lineage: { model: string; rightsNote: string };
}

/** Generate (or resolve) an avatar video (ADR 0404 §b). */
export async function generateVideo(deps: BrokeredEgressDeps, input: GenerateVideoInput, adapter: VideoAdapter = makeVideoAdapter(deps)): Promise<GenerateOutput> {
  const script = input.script.trim();
  const avatarId = input.avatarId.trim();
  if (!script || !avatarId) throw new OpenwopError('validation_error', 'A script and an avatarId are required.', 400, {});
  return runGeneration(adapter, {
    tenantId: input.tenantId, orgId: input.orgId, kind: 'avatar', provider: AVATAR_PROVIDER,
    text: script, submit: { script, avatarId, ...(input.voiceId ? { voiceId: input.voiceId } : {}) },
    costUnits: 1, createdBy: input.createdBy, ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    lineage: { model: AVATAR_PROVIDER, rightsNote: 'AI-generated avatar video' },
  });
}

/** Generate (or resolve) a frontier text-to-video (ADR 0404 §P4). Gated by the
 *  `creative-video.t2v` sub-toggle at the route/verb boundary. */
export async function textToVideo(deps: BrokeredEgressDeps, input: TextToVideoInput, adapter: VideoAdapter = makeT2VAdapter(deps)): Promise<GenerateOutput> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new OpenwopError('validation_error', 'A prompt is required.', 400, {});
  const model = (input.model ?? '').trim() || undefined;
  const durationSec = Number.isFinite(input.durationSec) && (input.durationSec ?? 0) > 0 ? Math.floor(input.durationSec!) : undefined;
  return runGeneration(adapter, {
    tenantId: input.tenantId, orgId: input.orgId, kind: 't2v', provider: t2vProvider(), ...(model ? { model } : {}),
    text: prompt, submit: { script: prompt, avatarId: '', ...(model ? { model } : {}), ...(durationSec ? { durationSec } : {}) },
    costUnits: t2vCostUnits(), createdBy: input.createdBy, ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    lineage: { model: model ?? t2vProvider(), rightsNote: 'AI-generated video (text-to-video)' },
  });
}

/** Build a fresh `submitting` row from a prior (retriable-failed or stale) row —
 *  clears the provider id / error / asset so a re-claim starts clean. */
function reclaimRow(prev: VideoJob): VideoJob {
  const { providerJobId: _p, error: _e, assetId: _a, ...rest } = prev;
  return { ...rest, status: 'submitting' };
}

/** A row a concurrent/later caller may RE-CLAIM (CAS →submitting) rather than treat
 *  as owned: a retriable-failed row (cap reset / provider now connected), or a
 *  `submitting`/`downloading` row abandoned by a crashed worker (aged past the
 *  stale window). A FRESH in-flight row is never reclaimable — no stealing a live
 *  submit/download, no double-charge. */
function isReclaimable(job: VideoJob, nowMs: number): boolean {
  if (job.status === 'failed') return !isTerminalError(job.error ?? '');
  if ((job.status === 'submitting' && !job.providerJobId) || job.status === 'downloading') {
    return nowMs - Date.parse(job.updatedAt) > STALE_STATE_MS;
  }
  return false;
}

/** The shared replay-safe pipeline for both modes. */
async function runGeneration(adapter: VideoAdapter, p: RunParams): Promise<GenerateOutput> {
  const requestHash = requestHashFor({ provider: p.provider, orgId: p.orgId, kind: p.kind, ...(p.model ? { model: p.model } : {}), script: p.text, avatarId: p.submit.avatarId, ...(p.submit.voiceId ? { voiceId: p.submit.voiceId } : {}), ...(p.submit.durationSec ? { durationSec: p.submit.durationSec } : {}) });
  const jobId = jobIdFor(p.tenantId, requestHash);
  const nowMs = p.nowMs ?? Date.now();
  const claimArgs = { tenantId: p.tenantId, orgId: p.orgId, requestHash, kind: p.kind, provider: p.provider, ...(p.model ? { model: p.model } : {}), createdBy: p.createdBy };

  let claim = await claimJob(claimArgs);
  // Bounded loop: resolve a pre-existing row, re-claiming a retriable/stale one via
  // CAS (race-free — a lost CAS means someone else advanced it, so we re-read).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (claim.outcome === 'claimed') return doSubmit(adapter, p, claim.job);
    const job = claim.job;
    if (job.status === 'completed' && job.assetId) return { status: 'completed', jobId, assetId: job.assetId };
    if (isReclaimable(job, nowMs)) {
      const won = await casJob(job, reclaimRow(job));
      if (won) return doSubmit(adapter, p, won); // WE own the fresh claim now
      const fresh = await getJobByHash(p.tenantId, requestHash); // lost the CAS — re-evaluate
      if (!fresh) { claim = await claimJob(claimArgs); continue; }
      claim = { outcome: 'exists', job: fresh };
      continue;
    }
    if (job.status === 'failed') return { status: 'failed', jobId, error: job.error ?? 'failed' };
    return finalize(adapter, job, { maxMs: pollMaxMs(), ...(p.nowMs !== undefined ? { nowMs: p.nowMs } : {}) }); // live → poll or pending
  }
  // Contended past the attempt budget — resolve conservatively without re-claiming.
  const last = await getJobByHash(p.tenantId, requestHash);
  return last ? finalize(adapter, last, { maxMs: pollMaxMs(), ...(p.nowMs !== undefined ? { nowMs: p.nowMs } : {}) }) : { status: 'pending', jobId };
}

/** Budget-gate → submit → meter → finalize. Runs ONLY for the caller that owns a
 *  fresh `submitting` claim (won the insert CAS or a re-claim CAS). A pre-submit
 *  failure writes a RETRIABLE `failed` row (re-claimable next call) — never a
 *  permanent tombstone, and never a delete that could race a concurrent caller. */
async function doSubmit(adapter: VideoAdapter, p: RunParams, claimed: VideoJob): Promise<GenerateOutput> {
  const jobId = claimed.jobId;
  // Gate on the ADR 0106 budget FIRST (before the spend).
  const budget = await checkMediaBudget(p.tenantId, 'video', p.costUnits);
  if (budget.exceeded) {
    await putJob({ ...claimed, status: 'failed', error: 'budget_exceeded' }); // retriable (cap resets)
    return { status: 'failed', jobId, error: 'budget_exceeded' };
  }
  const submitted = await adapter.submitJob(p.submit);
  if (!submitted.ok) {
    // Retriable (e.g. no_connection). NOTE (accepted residual): a `request_failed`
    // whose POST actually reached the provider before the response timed out could,
    // on re-claim, submit a second paid job — inherent to submit-without-an-
    // idempotency-key. Acceptable for v1; a future hardening is a client idempotency
    // key derived from requestHash so the provider dedups the retry.
    await putJob({ ...claimed, status: 'failed', error: submitted.error });
    return { status: 'failed', jobId, error: submitted.error };
  }
  // Stamp the asset-lineage inputs on the row so the STATUS/resolve path (which lacks
  // the original request) can mint the asset once the provider finishes.
  const job: VideoJob = {
    ...claimed, providerJobId: submitted.value.providerJobId, status: 'processing',
    promptSnippet: p.text.slice(0, 2000), lineageModel: p.lineage.model, rightsNote: p.lineage.rightsNote,
  };
  await putJob(job);
  // Meter the spend AT submit; the claim CAS guarantees this runs exactly once.
  await recordMediaUsage(p.tenantId, 'video', p.costUnits);
  return finalize(adapter, job, { maxMs: pollMaxMs(), ...(p.nowMs !== undefined ? { nowMs: p.nowMs } : {}) });
}

interface FinalizeOpts { maxMs: number; nowMs?: number }

/** Bounded-poll the provider; on completion elect ONE finalizer to store the bytes.
 *  Reads everything it needs from the JOB row (tenant/org/lineage) so BOTH the inline
 *  generate path and the status/resolve path can drive it. `maxMs:0` = a single poll
 *  (the status endpoint, which must not hold the request). */
async function finalize(adapter: VideoAdapter, job: VideoJob, opts: FinalizeOpts): Promise<GenerateOutput> {
  if (job.status === 'completed' && job.assetId) return { status: 'completed', jobId: job.jobId, assetId: job.assetId };
  if (!job.providerJobId) return { status: 'pending', jobId: job.jobId };
  const deadline = Date.now() + opts.maxMs;
  // Poll immediately; if still processing and the budget is spent (maxMs:0 = a single
  // poll for the status/resolve path), stop with `pending`; else sleep + poll again.
  for (;;) {
    const polled = await adapter.pollJob(job.providerJobId);
    if (!polled.ok) return { status: 'pending', jobId: job.jobId }; // transient — a re-run/resolve resolves
    if (polled.value.status === 'failed') {
      await putJob({ ...job, status: 'failed', error: 'provider_failed' }); // provider-confirmed → durable
      return { status: 'failed', jobId: job.jobId, error: 'provider_failed' };
    }
    if (polled.value.status === 'completed' && polled.value.resultUrl) {
      return storeCompletion(adapter, job, polled.value.resultUrl, opts.nowMs ?? Date.now());
    }
    if (Date.now() >= deadline) return { status: 'pending', jobId: job.jobId }; // budget spent
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Elect a single finalizer (CAS processing→downloading), then download + capacity-gate
 *  + createAsset. A loser (or a re-run) reuses the winner's asset or waits (`pending`);
 *  a finalizer that CRASHED mid-download (stale `downloading`) is recovered here too.
 *  Lineage + tenant/org come from the JOB row (works from the resolve path too). */
async function storeCompletion(adapter: VideoAdapter, job: VideoJob, resultUrl: string, nowMs: number): Promise<GenerateOutput> {
  const { tenantId, orgId } = job;
  let fresh = await getJob(tenantId, orgId, job.jobId);
  if (!fresh) return { status: 'pending', jobId: job.jobId };
  if (fresh.status === 'completed' && fresh.assetId) return { status: 'completed', jobId: job.jobId, assetId: fresh.assetId };
  if (fresh.status === 'failed') return { status: 'failed', jobId: job.jobId, error: fresh.error ?? 'failed' };
  if (fresh.status === 'downloading') {
    // Another finalizer holds the download — UNLESS it crashed (stale), in which
    // case recover the job (CAS downloading→processing) and re-elect below.
    if (nowMs - Date.parse(fresh.updatedAt) <= STALE_STATE_MS) return { status: 'pending', jobId: job.jobId };
    const recovered = await casJob(fresh, { ...reclaimRow(fresh), status: 'processing' });
    if (!recovered) return { status: 'pending', jobId: job.jobId }; // someone else recovered it
    fresh = recovered;
  }
  if (fresh.status !== 'processing') return { status: 'pending', jobId: job.jobId };

  const claimedDl = await casJob(fresh, { ...fresh, status: 'downloading' });
  if (!claimedDl) {
    const after = await getJob(tenantId, orgId, job.jobId);
    if (after?.status === 'completed' && after.assetId) return { status: 'completed', jobId: job.jobId, assetId: after.assetId };
    return { status: 'pending', jobId: job.jobId };
  }

  const dl = await adapter.downloadResult(resultUrl);
  if (!dl.ok) {
    log.warn('video download failed', { jobId: job.jobId, error: dl.error });
    if (isTerminalError(dl.error)) {
      // A deterministic rejection (SSRF-denied URL, over-cap size) — a retry can't fix
      // it. Surface a real failure instead of looping forever as `pending`.
      await putJob({ ...claimedDl, status: 'failed', error: dl.error });
      return { status: 'failed', jobId: job.jobId, error: dl.error };
    }
    // Transient (network blip) — revert to processing so a re-invoke retries.
    await putJob({ ...claimedDl, status: 'processing' });
    return { status: 'pending', jobId: job.jobId };
  }
  const bytes = Buffer.from(dl.value.base64, 'base64');
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  // Capacity gate BEFORE storing the (large) bytes — a real rejection is durable.
  try { await assertOrgCapacity(tenantId, orgId, dl.value.bytes); }
  catch (err) {
    await putJob({ ...claimedDl, status: 'failed', error: 'capacity_exceeded' });
    log.warn('video capacity gate rejected', { jobId: job.jobId, error: err instanceof Error ? err.message : String(err) });
    return { status: 'failed', jobId: job.jobId, error: 'capacity_exceeded' };
  }
  // Content-hash dedup — reuse an identical asset rather than mint a second copy.
  const dup = await findAssetByContentHash(tenantId, orgId, contentHash).catch(() => null);
  let assetId: string;
  if (dup) {
    assetId = dup.assetId;
  } else {
    const stored = await mediaPut(tenantId, { contentBase64: dl.value.base64, contentType: dl.value.contentType });
    const asset = await createAsset({
      tenantId, orgId,
      name: `video-${claimedDl.providerJobId ?? claimedDl.requestHash.slice(0, 12)}.mp4`,
      contentType: dl.value.contentType, sizeBytes: stored.sizeBytes, storageRef: stored.storageRef, serveToken: stored.serveToken,
      uploadedBy: claimedDl.createdBy, contentHash,
      lineage: { generatedBy: 'ai', prompt: claimedDl.promptSnippet ?? '', model: claimedDl.lineageModel ?? claimedDl.provider, provider: claimedDl.provider, rightsNote: claimedDl.rightsNote ?? 'AI-generated video' },
    });
    assetId = asset.assetId;
  }
  await putJob({ ...claimedDl, status: 'completed', assetId });
  return { status: 'completed', jobId: job.jobId, assetId };
}

/** Read a job's status AND drive a single poll if it's still in flight — the status
 *  node / GET-job resolve surface (grade-code CV-2): a job longer than the inline
 *  budget lands `processing`, and re-invoking generate is not the only way to finish
 *  it — this advances + completes it without holding the request (one poll). */
export async function resolveVideoJob(deps: BrokeredEgressDeps, tenantId: string, orgId: string, jobId: string, adapter?: VideoAdapter): Promise<VideoJob | null> {
  const job = await getJob(tenantId, orgId, jobId);
  if (!job) return null;
  if ((job.status === 'processing' || job.status === 'downloading') && job.providerJobId) {
    const a = adapter ?? (job.kind === 't2v' ? makeT2VAdapter(deps) : makeVideoAdapter(deps));
    await finalize(a, job, { maxMs: 0 }); // single poll — never hold the request
    return getJob(tenantId, orgId, jobId);
  }
  return job;
}

/** Read a job's status without polling (the dashboard list-row read). */
export async function getVideoJob(tenantId: string, orgId: string, jobId: string): Promise<VideoJob | null> {
  return getJob(tenantId, orgId, jobId);
}

/** When a media asset is deleted, DELETE the jobs that pinned it — else a `completed`
 *  job replays a DEAD asset id forever (completed is terminal/non-reclaimable). Keyed
 *  registration, idempotent across boots. (ADR 0404 grade-data CV-2.) */
export function registerVideoMediaCascade(): void {
  onMediaAssetDeleted('creative-video', async ({ tenantId, orgId, assetId }) => {
    const pruned = await clearJobsForAsset(tenantId, orgId, assetId);
    if (pruned > 0) log.info('pruned video jobs for deleted media asset', { assetId, pruned });
  });
}
export async function resolveByHash(tenantId: string, requestHash: string): Promise<VideoJob | null> {
  return getJobByHash(tenantId, requestHash);
}
