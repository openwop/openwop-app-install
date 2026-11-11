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
 *  - ADR 1051: nothing is claimed without a connection (D7) or, for an avatar,
 *    a person's likeness attestation (D5); the daily units are RESERVED by CAS
 *    before the submit (D3) and given back only when the provider provably did
 *    not take the job; a submit whose outcome is unknown is terminal
 *    `submit_unconfirmed`, never re-sent (D6); polling pins the submit's
 *    connection and person (D10).
 *
 * @see docs/adr/0404-event-and-creative-provider-integrations.md §b / §P4
 */

import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import type { BrokeredEgressDeps } from '../../host/brokeredEgress.js';
import { reserveMediaBudget, releaseMediaBudget } from '../../aiProviders/mediaBudget.js';
import { createAsset, assertOrgCapacity, findAssetByContentHash, getAsset, isVerifiedProductSource, promptHashOf, setGroundingFidelity, stampGroundingIfAbsent, stampLikenessConsentIfAbsent, PROVIDER_DEFAULT_MODEL, type MediaLikenessConsent } from '../media/mediaService.js';
import { FIDELITY_RULESET_VERSION, getVerdict, imageSize, isRasterisable, recordVerdict, verdictIdFor } from '../../host/creativeFidelity/index.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import { put as mediaPut } from '../media/mediaStorage.js';
import { makeVideoAdapter, submitProvablyRefused, type VideoAdapter, type VideoConnectionPin, type SubmitJobInput } from './host/videoProviderAdapter.js';
import { makeT2VAdapter, t2vProvider, t2vDefaultModel } from './host/t2vProviderAdapter.js';
import { resolveRunwayRequest, type RunwayEndpoint } from './host/runwayModels.js';
import { consentCovers, type LikenessConsentSnapshot } from './likenessConsent.js';
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
const TERMINAL_ERRORS = new Set(['provider_failed', 'capacity_exceeded', 'video_too_large', 'submit_unconfirmed']);
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
  /** ADR 1051 D5 — the attestation this render runs under: made on the page
   *  (`channel:'route'`) or the run person's own record (`'record'`). The caller
   *  resolves it; the service refuses one that does not cover this avatar/voice. */
  likenessConsent: LikenessConsentSnapshot;
  /** Injectable clock for tests. */
  nowMs?: number;
}

export interface TextToVideoInput {
  tenantId: string;
  orgId: string;
  prompt: string;
  model?: string;
  durationSec?: number;
  /** ADR 1051 D2 — a ratio the model takes (default `1280:720`). */
  ratio?: string;
  createdBy: string;
  nowMs?: number;
}

export type GenerateOutput =
  | { status: 'completed'; jobId: string; assetId: string }
  | { status: 'pending'; jobId: string }
  | { status: 'failed'; jobId: string; error: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function jobView(job: VideoJob): Record<string, unknown> {
  return {
    jobId: job.jobId, kind: job.kind, status: job.status, provider: job.provider, ...(job.model ? { model: job.model } : {}),
    // ADR 1051 D4 — what was ASKED; nothing measured is claimed here.
    ...(job.requested ? { requested: job.requested } : {}),
    ...(job.assetId ? { assetId: job.assetId } : {}), ...(job.error ? { error: job.error } : {}), createdAt: job.createdAt,
  };
}

/** ADR 1051 D2 — resolve a frontier request against the model table, or refuse
 *  it as a typed 422 BEFORE any row, reservation or submit. */
function resolveFrontier(endpoint: RunwayEndpoint, input: { model?: string; ratio?: string; durationSec?: number; portrait?: boolean }): { model: string; ratio: string; durationSec: number } {
  const r = resolveRunwayRequest(endpoint, { ...input, defaultModel: t2vDefaultModel(endpoint) });
  if (!r.ok) throw new OpenwopError('validation_error', r.message, 422, { field: r.field });
  return r.value;
}

/** ADR 1051 — the adapter for a job: the caller's (tests), else the provider's,
 *  pinned to the submit's connection and person once there is one (D10). */
type AdapterFor = (pin?: VideoConnectionPin) => VideoAdapter;
function adapterFactory(deps: BrokeredEgressDeps, kind: VideoJobKind, injected?: VideoAdapter): AdapterFor {
  if (injected) return () => injected;
  return (pin) => (kind === 't2v' || kind === 'i2v' ? makeT2VAdapter(deps, pin) : makeVideoAdapter(deps, pin));
}
function pinOf(job: VideoJob): VideoConnectionPin | undefined {
  return job.connectionId ? { connectionId: job.connectionId, ...(job.submitterUserId ? { actingUserId: job.submitterUserId } : {}) } : undefined;
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
  /** The acting person whose connection submits (absent for a caused run). */
  submitterUserId?: string;
  nowMs?: number;
  lineage: { model: string; rightsNote: string };
  /** ADR 0945 D7 (i2v) — the verified still and the product it depicts. */
  source?: { assetId: string; sha256: string; productId?: string };
  /** ADR 1051 D2 — the resolved frontier request (t2v/i2v). */
  requested?: { model: string; ratio: string; durationSec: number };
  /** ADR 1051 D5 — avatar only. */
  likenessConsent?: LikenessConsentSnapshot;
}

/** Generate (or resolve) an avatar video (ADR 0404 §b). */
export async function generateVideo(deps: BrokeredEgressDeps, input: GenerateVideoInput, adapter?: VideoAdapter): Promise<GenerateOutput> {
  const script = input.script.trim();
  const avatarId = input.avatarId.trim();
  const voiceId = input.voiceId?.trim() || undefined;
  if (!script || !avatarId) throw new OpenwopError('validation_error', 'A script and an avatarId are required.', 400, {});
  // ADR 1051 D5 — a person's attestation for exactly this avatar and voice, under
  // the current sentence, BEFORE the hash lookup (a dedup hit cannot skip it).
  if (!consentCovers(input.likenessConsent, avatarId, voiceId)) {
    throw new OpenwopError('likeness_consent_required', "Confirm you have the depicted person's consent to use their likeness and voice.", 422, { field: 'likenessConsent' });
  }
  return runGeneration(adapterFactory(deps, 'avatar', adapter), {
    tenantId: input.tenantId, orgId: input.orgId, kind: 'avatar', provider: AVATAR_PROVIDER,
    text: script, submit: { script, avatarId, ...(voiceId ? { voiceId } : {}) },
    costUnits: 1, createdBy: input.createdBy, ...(deps.actingUserId ? { submitterUserId: deps.actingUserId } : {}),
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    lineage: { model: AVATAR_PROVIDER, rightsNote: 'AI-generated avatar video' },
    likenessConsent: input.likenessConsent,
  });
}

/** ADR 0945 D7 — an image→video request. */
export interface ImageToVideoInput {
  tenantId: string;
  orgId: string;
  sourceAssetId: string;
  /** The product the still depicts (required when the still is a raw product photo). */
  productId?: string;
  prompt: string;
  model?: string;
  durationSec?: number;
  /** ADR 1051 D2 — a ratio the model takes (default: the still's orientation). */
  ratio?: string;
  createdBy: string;
  nowMs?: number;
}

/** A still above this many bytes is refused before any spend (the provider caps
 *  data-URI images, and base64 inflates the bytes by a third). */
const I2V_MAX_SOURCE_BYTES = 3_500_000;

/**
 * ADR 0945 D7 — animate a still (image→video) on the SAME job pipeline as t2v.
 * The source must be (a) a grounded still (a composite or edit whose STORED
 * verdict is `pass`) or (b) one of the product's own photos. Anything else is
 * `product_depiction_ungrounded`. Both checks re-run on every call, BEFORE the
 * request hash, so a dedup hit cannot skip them. Every product video lands
 * `needs_review` (no frame sampling yet, G7): the publish gate holds it for a
 * person. Gated by `creative-video.t2v` at the verb/route boundary.
 */
export async function imageToVideo(deps: BrokeredEgressDeps, input: ImageToVideoInput, adapter?: VideoAdapter): Promise<GenerateOutput> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new OpenwopError('validation_error', 'A motion prompt is required.', 400, { field: 'prompt' });
  // ADR 1051 D2 — refuse a model/ratio/duration the provider would reject before
  // reading the source (orientation is applied below, once the still is known).
  resolveFrontier('i2v', { ...(input.model ? { model: input.model } : {}), ...(input.ratio ? { ratio: input.ratio } : {}), ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}) });
  const source = await getAsset(input.tenantId, input.orgId, input.sourceAssetId);
  if (!source) throw new OpenwopError('not_found', 'Source image not found.', 404, { assetId: input.sourceAssetId });
  if (!isRasterisable(source.contentType)) throw new OpenwopError('validation_error', `The source must be a PNG, JPEG or GIF image (it is ${source.contentType}).`, 422, { field: 'sourceAssetId' });
  if (source.sizeBytes > I2V_MAX_SOURCE_BYTES) throw new OpenwopError('validation_error', `The source image is over ${Math.floor(I2V_MAX_SOURCE_BYTES / 1_000_000 * 10) / 10} MB — use a smaller one.`, 422, { field: 'sourceAssetId' });
  const entry = await resolveMediaAsset(source.serveToken);
  if (!entry || entry.tenantId !== input.tenantId) throw new OpenwopError('not_found', 'Source image bytes unavailable.', 404, { assetId: input.sourceAssetId });
  const sha256 = createHash('sha256').update(Buffer.from(entry.contentBase64, 'base64')).digest('hex');

  // (a) a grounded still with a PASSING stored verdict, or (b) a product photo.
  let allowed = false;
  let productId: string | undefined;
  const g = source.lineage?.grounding;
  if (g && (g.mode === 'composite' || g.mode === 'edit') && g.fidelity) {
    const v = await getVerdict(input.tenantId, source.orgId, g.fidelity.verdictId).catch(() => null);
    const sourceKeys = (sources: readonly { assetId: string; sha256: string }[]): string =>
      JSON.stringify(sources.map((s) => JSON.stringify([s.assetId, s.sha256])).sort());
    if (v && v.assetId === source.assetId && v.assetSha256 === sha256 && v.outcome === 'pass'
      && g.productId && v.productId === g.productId && v.mode === g.mode && g.sources.length > 0
      && v.rulesetVersion === FIDELITY_RULESET_VERSION && sourceKeys(v.sources) === sourceKeys(g.sources)) {
      allowed = true; productId = g.productId;
    }
  }
  // The catalog owner answers through media's verifier seam (commerce fills it, G11-gated).
  if (!allowed && input.productId && await isVerifiedProductSource(input.tenantId, input.orgId, input.productId, sha256)) {
    allowed = true;
    productId = input.productId;
  }
  if (!allowed) {
    throw new OpenwopError('product_depiction_ungrounded', 'Only a checked product shot, or one of the product\'s own photos, can be animated.', 422, { assetId: input.sourceAssetId });
  }
  // The provider takes a fixed set of output ratios; with none asked for, pick the
  // orientation that matches the still (its own pixel size is not a ratio value).
  const size = imageSize(Buffer.from(entry.contentBase64, 'base64'));
  const req = resolveFrontier('i2v', {
    ...(input.model ? { model: input.model } : {}), ...(input.ratio ? { ratio: input.ratio } : {}),
    ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}), portrait: !!size && size.h > size.w,
  });
  return runGeneration(adapterFactory(deps, 'i2v', adapter), {
    tenantId: input.tenantId, orgId: input.orgId, kind: 'i2v', provider: t2vProvider(), model: req.model,
    text: prompt,
    submit: { script: prompt, avatarId: '', promptImage: `data:${source.contentType};base64,${entry.contentBase64}`, model: req.model, ratio: req.ratio, durationSec: req.durationSec },
    costUnits: t2vCostUnits(), createdBy: input.createdBy, ...(deps.actingUserId ? { submitterUserId: deps.actingUserId } : {}),
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    lineage: { model: req.model, rightsNote: 'AI-generated video (image-to-video)' },
    source: { assetId: source.assetId, sha256, ...(productId ? { productId } : {}) },
    requested: req,
  });
}

/** ADR 0945 D7 — a product video's verdict: `needs_review`, because no frame of
 *  it can be sampled on this host yet. Recorded once per asset (idempotent id). */
async function recordAnimateReview(tenantId: string, orgId: string, assetId: string, assetSha256: string, job: VideoJob): Promise<void> {
  const checks = [{ id: 'mode' as const, status: 'not_applicable' as const, detail: 'Video frames cannot be sampled on this host yet, so a person must review every product video.' }];
  const sources = [{ assetId: job.sourceAssetId!, sha256: job.sourceSha256! }];
  const verdict = await recordVerdict({
    verdictId: verdictIdFor({ assetId, assetSha256, mode: 'animate', rulesetVersion: FIDELITY_RULESET_VERSION, sources, outcome: 'needs_review', checks }),
    tenantId, orgId, assetId, assetSha256, mode: 'animate', ...(job.productId ? { productId: job.productId } : {}),
    sources, checks, outcome: 'needs_review', rulesetVersion: FIDELITY_RULESET_VERSION, checkedAt: new Date().toISOString(),
  });
  await setGroundingFidelity(tenantId, orgId, assetId, { verdictId: verdict.verdictId, outcome: verdict.outcome, rulesetVersion: verdict.rulesetVersion });
}

/** Generate (or resolve) a frontier text-to-video (ADR 0404 §P4). Gated by the
 *  `creative-video.t2v` sub-toggle at the route/verb boundary. */
export async function textToVideo(deps: BrokeredEgressDeps, input: TextToVideoInput, adapter?: VideoAdapter): Promise<GenerateOutput> {
  const prompt = input.prompt.trim();
  if (!prompt) throw new OpenwopError('validation_error', 'A prompt is required.', 400, {});
  const req = resolveFrontier('t2v', { ...(input.model ? { model: input.model } : {}), ...(input.ratio ? { ratio: input.ratio } : {}), ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}) });
  return runGeneration(adapterFactory(deps, 't2v', adapter), {
    tenantId: input.tenantId, orgId: input.orgId, kind: 't2v', provider: t2vProvider(), model: req.model,
    text: prompt, submit: { script: prompt, avatarId: '', model: req.model, ratio: req.ratio, durationSec: req.durationSec },
    costUnits: t2vCostUnits(), createdBy: input.createdBy, ...(deps.actingUserId ? { submitterUserId: deps.actingUserId } : {}),
    ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
    lineage: { model: req.model, rightsNote: 'AI-generated video (text-to-video)' },
    requested: req,
  });
}

/** Build a fresh `submitting` row from a prior (retriable-failed or stale) row —
 *  clears the provider id / error / asset so a re-claim starts clean. */
function reclaimRow(prev: VideoJob): VideoJob {
  const { providerJobId: _p, error: _e, assetId: _a, submitAttemptedAt: _s, reservation: _r, connectionId: _c, ...rest } = prev;
  return { ...rest, status: 'submitting' };
}

/** ADR 1051 D6 — a submit was attempted and no provider job id was recorded: the
 *  provider may have taken (and charged for) it, so it is never re-sent. */
function submitOutcomeUnknown(job: VideoJob): boolean {
  return job.status === 'submitting' && !!job.submitAttemptedAt && !job.providerJobId;
}

/** A row a concurrent/later caller may RE-CLAIM (CAS →submitting) rather than treat
 *  as owned: a retriable-failed row (cap reset / provider now connected), or a
 *  `submitting`/`downloading` row abandoned by a crashed worker (aged past the
 *  stale window). A FRESH in-flight row is never reclaimable — no stealing a live
 *  submit/download, no double-charge. */
function isReclaimable(job: VideoJob, nowMs: number): boolean {
  if (job.status === 'failed') return !isTerminalError(job.error ?? '');
  if (submitOutcomeUnknown(job)) return false; // D6 — never a second paid submit
  // ADR 1051 grade-code CV83CD-1 — a row with a provider job id was TAKEN (and
  // billed) by the provider. A stale `downloading` row is recovered by
  // `storeCompletion` (downloading → processing → re-download), never re-claimed
  // into a second submit.
  if (job.providerJobId) return false;
  if (job.status === 'submitting') return nowMs - Date.parse(job.updatedAt) > STALE_STATE_MS;
  return false;
}

/** The shared replay-safe pipeline for both modes. */
async function runGeneration(adapterFor: AdapterFor, p: RunParams): Promise<GenerateOutput> {
  const requestHash = requestHashFor({ provider: p.provider, orgId: p.orgId, kind: p.kind, ...(p.model ? { model: p.model } : {}), script: p.text, avatarId: p.submit.avatarId, ...(p.submit.voiceId ? { voiceId: p.submit.voiceId } : {}), ...(p.submit.durationSec ? { durationSec: p.submit.durationSec } : {}), ...(p.submit.ratio ? { ratio: p.submit.ratio } : {}), ...(p.source ? { sourceSha256: p.source.sha256 } : {}) });
  const jobId = jobIdFor(p.tenantId, requestHash);
  const nowMs = p.nowMs ?? Date.now();
  const claimArgs = { tenantId: p.tenantId, orgId: p.orgId, requestHash, kind: p.kind, provider: p.provider, ...(p.model ? { model: p.model } : {}), createdBy: p.createdBy };
  const adapter = adapterFor();

  // ADR 1051 D7 — a request that would CLAIM (no row yet, or a re-claimable one)
  // must have a connection first: no row, no reservation, for a submit that
  // cannot be made. A completed or in-flight row is resolved below without it.
  const prior = await getJobByHash(p.tenantId, requestHash);
  if ((!prior || isReclaimable(prior, nowMs)) && !(await adapter.hasConnection())) {
    return { status: 'failed', jobId, error: 'no_connection' };
  }

  let claim = await claimJob(claimArgs);
  // Bounded loop: resolve a pre-existing row, re-claiming a retriable/stale one via
  // CAS (race-free — a lost CAS means someone else advanced it, so we re-read).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (claim.outcome === 'claimed') return doSubmit(adapterFor, p, claim.job);
    const job = claim.job;
    if (job.status === 'completed' && job.assetId) return { status: 'completed', jobId, assetId: job.assetId };
    if (isReclaimable(job, nowMs)) {
      const won = await casJob(job, reclaimRow(job));
      if (won) return doSubmit(adapterFor, p, won); // WE own the fresh claim now
      const fresh = await getJobByHash(p.tenantId, requestHash); // lost the CAS — re-evaluate
      if (!fresh) { claim = await claimJob(claimArgs); continue; }
      claim = { outcome: 'exists', job: fresh };
      continue;
    }
    if (job.status === 'failed') return { status: 'failed', jobId, error: job.error ?? 'failed' };
    if (submitOutcomeUnknown(job)) return settleUnknownSubmit(job, nowMs);
    return finalize(adapterFor(pinOf(job)), job, { maxMs: pollMaxMs(), ...(p.nowMs !== undefined ? { nowMs: p.nowMs } : {}) }); // live → poll or pending
  }
  // Contended past the attempt budget — resolve conservatively without re-claiming.
  const last = await getJobByHash(p.tenantId, requestHash);
  return last ? finalize(adapterFor(pinOf(last)), last, { maxMs: pollMaxMs(), ...(p.nowMs !== undefined ? { nowMs: p.nowMs } : {}) }) : { status: 'pending', jobId };
}

/** ADR 1051 D6 — a row whose submit outcome is unknown. While fresh, its own
 *  caller may still be waiting on the provider's response (`pending`). Once
 *  stale, the caller crashed between the POST and recording the id: the job may
 *  exist and be billed at the provider, so it becomes terminal
 *  `submit_unconfirmed` and its reservation stays spent. */
async function settleUnknownSubmit(job: VideoJob, nowMs: number): Promise<GenerateOutput> {
  if (nowMs - Date.parse(job.updatedAt) <= STALE_STATE_MS) return { status: 'pending', jobId: job.jobId };
  const settled = await casJob(job, { ...job, status: 'failed', error: 'submit_unconfirmed' });
  if (settled) log.warn('video submit outcome unknown after a crash — not resubmitted', { jobId: job.jobId, provider: job.provider });
  const now = settled ?? await getJobByHash(job.tenantId, job.requestHash);
  return now?.status === 'completed' && now.assetId ? { status: 'completed', jobId: job.jobId, assetId: now.assetId }
    : { status: 'failed', jobId: job.jobId, error: now?.error ?? 'submit_unconfirmed' };
}

/** Reserve → stamp → submit → finalize. Runs ONLY for the caller that owns a
 *  fresh `submitting` claim (won the insert CAS or a re-claim CAS). */
async function doSubmit(adapterFor: AdapterFor, p: RunParams, claimed: VideoJob): Promise<GenerateOutput> {
  const jobId = claimed.jobId;
  // ADR 1051 D3 — take the units BEFORE the spend, atomically. A refusal writes
  // a RETRIABLE failed row (the cap resets at midnight UTC, or an admin raises it).
  const reserved = await reserveMediaBudget(p.tenantId, 'video', p.costUnits);
  if (!reserved.ok) {
    const error = reserved.reason === 'disabled' ? 'video_budget_disabled' : 'budget_exceeded';
    await putJob({ ...claimed, status: 'failed', error });
    return { status: 'failed', jobId, error };
  }
  // ADR 1051 D6 — record that a submit is about to leave, with its reservation,
  // BEFORE the POST: a crash between the POST and recording the provider id must
  // read as "maybe taken", never as a submit that can be sent again.
  const attempting = await casJob(claimed, {
    ...claimed, submitAttemptedAt: new Date().toISOString(), reservation: reserved.token,
    ...(p.requested ? { requested: p.requested } : {}), ...(p.likenessConsent ? { likenessConsent: p.likenessConsent } : {}),
    ...(p.submitterUserId ? { submitterUserId: p.submitterUserId } : {}),
  });
  if (!attempting) {
    await releaseMediaBudget(reserved.token); // another writer moved the row; we sent nothing
    const fresh = await getJobByHash(p.tenantId, claimed.requestHash);
    return fresh?.status === 'completed' && fresh.assetId ? { status: 'completed', jobId, assetId: fresh.assetId } : { status: 'pending', jobId };
  }
  const submitted = await adapterFor().submitJob(p.submit);
  if (!submitted.ok) {
    if (submitProvablyRefused(submitted.error)) {
      // Provably not taken (no connection, refused before the dial, a 4xx): the
      // units go back and the same inputs stay generatable.
      await releaseMediaBudget(reserved.token);
      const { submitAttemptedAt: _s, reservation: _r, ...rest } = attempting;
      await putJob({ ...rest, status: 'failed', error: submitted.error });
      return { status: 'failed', jobId, error: submitted.error };
    }
    // Unconfirmed (a reset or timeout after send, a 5xx, a 2xx without an id):
    // the provider may be rendering and charging. Terminal; the units stay spent.
    log.warn('video submit outcome unconfirmed — not retried', { jobId, provider: p.provider, error: submitted.error });
    await putJob({ ...attempting, status: 'failed', error: 'submit_unconfirmed' });
    return { status: 'failed', jobId, error: 'submit_unconfirmed' };
  }
  // Stamp the asset-lineage inputs on the row so the STATUS/resolve path (which lacks
  // the original request) can mint the asset once the provider finishes.
  const job: VideoJob = {
    ...attempting, providerJobId: submitted.value.providerJobId, status: 'processing',
    ...(submitted.value.connectionId ? { connectionId: submitted.value.connectionId } : {}),
    promptSnippet: p.text.slice(0, 2000), promptHash: promptHashOf(p.text), lineageModel: p.lineage.model, rightsNote: p.lineage.rightsNote,
    ...(p.source ? { sourceAssetId: p.source.assetId, sourceSha256: p.source.sha256, ...(p.source.productId ? { productId: p.source.productId } : {}) } : {}),
  };
  await putJob(job);
  return finalize(adapterFor(pinOf(job)), job, { maxMs: pollMaxMs(), ...(p.nowMs !== undefined ? { nowMs: p.nowMs } : {}) });
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
    // CV83CD-2 — recover the row as it is: the provider job id, the connection pin
    // and the reservation all stay, so the re-download can find the job again.
    const recovered = await casJob(fresh, { ...fresh, status: 'processing' });
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
  // ADR 0945 D4 — the provenance stamp, from the job row (a text-to-video or
  // avatar render depicts no product source: mode `none`). Rows submitted
  // before the hash existed record none rather than a hash of the snippet.
  const animated = claimedDl.kind === 'i2v' && claimedDl.sourceAssetId && claimedDl.sourceSha256;
  const grounding = {
    mode: animated ? 'animate' : 'none',
    sources: animated ? [{ assetId: claimedDl.sourceAssetId, sha256: claimedDl.sourceSha256 }] : [],
    ...(animated && claimedDl.productId ? { productId: claimedDl.productId } : {}),
    ...(claimedDl.promptHash ? { promptHash: claimedDl.promptHash } : {}),
    provider: claimedDl.provider,
    model: claimedDl.model ?? claimedDl.lineageModel ?? PROVIDER_DEFAULT_MODEL,
    op: claimedDl.kind === 'i2v' ? 'image-to-video' : claimedDl.kind === 't2v' ? 'text-to-video' : 'avatar-video',
  };
  // ADR 1051 D5 — the asset points at the attestation; who attested stays on the job.
  const consent: MediaLikenessConsent | undefined = claimedDl.likenessConsent ? {
    jobId: claimedDl.jobId, textVersion: claimedDl.likenessConsent.textVersion, attestedAt: claimedDl.likenessConsent.attestedAt,
    avatarId: claimedDl.likenessConsent.avatarId, ...(claimedDl.likenessConsent.voiceId ? { voiceId: claimedDl.likenessConsent.voiceId } : {}),
  } : undefined;
  let assetId: string;
  if (dup) {
    assetId = (await stampGroundingIfAbsent(dup, grounding)).assetId;
    if (consent) await stampLikenessConsentIfAbsent(dup, consent);
    if (animated && claimedDl.productId) await recordAnimateReview(tenantId, orgId, assetId, contentHash, claimedDl);
  } else {
    const stored = await mediaPut(tenantId, { contentBase64: dl.value.base64, contentType: dl.value.contentType });
    const asset = await createAsset({
      tenantId, orgId,
      name: `video-${claimedDl.providerJobId ?? claimedDl.requestHash.slice(0, 12)}.mp4`,
      contentType: dl.value.contentType, sizeBytes: stored.sizeBytes, storageRef: stored.storageRef, serveToken: stored.serveToken,
      uploadedBy: claimedDl.createdBy, contentHash,
      lineage: { generatedBy: 'ai', prompt: claimedDl.promptSnippet ?? '', model: claimedDl.lineageModel ?? claimedDl.provider, provider: claimedDl.provider, rightsNote: claimedDl.rightsNote ?? 'AI-generated video' },
      grounding,
      ...(consent ? { likenessConsent: consent } : {}),
    });
    assetId = asset.assetId;
    if (animated && claimedDl.productId) await recordAnimateReview(tenantId, orgId, assetId, contentHash, claimedDl);
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
    // i2v rides the t2v provider (ADR 0945 D7). ADR 1051 D10 — pinned to the
    // submit's connection and person, never the reader's own credential.
    const a = adapterFactory(deps, job.kind, adapter)(pinOf(job));
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
