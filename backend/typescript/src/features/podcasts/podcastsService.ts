/**
 * Multi-speaker AI podcasts (ADR 0086) — a NotebookLM-style audio-overview studio
 * built by COMPOSING existing seams, never forking them (MEMORY.md
 * no-parallel-architecture law):
 *   - the generation job   → an executor RUN of the `podcasts.generate` workflow
 *                            (ADR 0014/0025) — NOT a new job queue; status/retry/
 *                            cancel/HITL all ride the run.
 *   - the source content   → a NOTEBOOK's KB sources/notes (ADR 0084) via
 *                            ctx.features.notebooks — no new content store.
 *   - outline + transcript → versioned DOCUMENTS (ADR 0053) owned by the notebook
 *                            subject — reviewable before TTS.
 *   - the per-turn audio   → MEDIA assets (ADR 0007); each `ctx.callSpeechSynthesizer`
 *                            turn (RFC 0105) already stores a tenant-scoped asset and
 *                            returns its URL, so the episode tracks an ORDERED CLIP
 *                            LIST (the v1 mix — see the §"mix" correction in ADR 0086).
 *   - the TTS provider key → the Connections broker (ADR 0024) on the wire (BYOK).
 *
 * This feature OWNS only: two reusable CONFIG entities (EpisodeProfile +
 * SpeakerProfile) and a thin PodcastEpisode tracking record (the run is the real
 * state machine — the episode never duplicates run state, it links `runId` and the
 * route projects status from `storage.getRun`).
 *
 * Tenant + org isolation rides the DurableCollection keys (CTI-1); the routes layer
 * adds the RBAC scope + uniform-404 IDOR guard (see routes.ts).
 *
 * @see docs/adr/0086-multi-speaker-podcasts.md
 */

import { createHash, randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { slugify, uniqueSlug } from '../../host/slug.js';
import { optionalCleanString, cleanString } from '../../host/boundedStrings.js';
// PODU-1 (ADR 0603 §4) — a DIRECT cross-feature read of the documents service, the
// precedent set by `notebooks/notebooksService.ts:41-44` (and sharing / chat-export /
// priority-matrix / strategy). The transcript the public page needs IS an ADR 0053
// document; re-storing a copy under podcasts would be the parallel-store defect.
// The `getDocument` half is `L5`'s KIND re-check; the toggle read beside it is the
// `documents` gate this direct import would otherwise bypass (see
// `getPublicEpisodeTranscript`).
import { listVersions as listDocumentVersions, getDocument as getDocumentRecord } from '../documents/documentsService.js';
import { resolveOne } from '../../host/featureToggles/service.js';

/** One cast member — an opaque host-resolved `voiceId` (RFC 0105 does NOT enumerate
 *  voices) + persona text injected into the transcript prompt. */
export interface Speaker {
  name: string;
  voiceId: string;
  backstory?: string;
  personality?: string;
}

/** Reusable CAST config (1–4 speakers) + the TTS provider/model that voices them. */
export interface SpeakerProfile {
  id: string;
  tenantId: string;
  orgId: string;
  name: string;
  provider: string;
  model?: string;
  speakers: Speaker[];
  createdAt: string;
  updatedAt: string;
}

/** Reusable "show format" config — which LLMs draft the outline/transcript, how many
 *  dialogue segments, the language, and standing briefing instructions. */
export interface EpisodeProfile {
  id: string;
  tenantId: string;
  orgId: string;
  name: string;
  outlineModel: string;
  transcriptModel: string;
  segmentCount: number;
  languageCode?: string;
  defaultBriefing?: string;
  speakerProfileId: string;
  createdAt: string;
  updatedAt: string;
}

/** One synthesized dialogue turn — the bytes already live in Media (the synth host
 *  impl stored them); the episode keeps the asset URL + who spoke (v1 mix). */
export interface EpisodeClip {
  speaker: string;
  voiceId: string;
  url: string;
  mimeType: string;
}

/** Tracks ONE generation run. The executor run is the source of truth for STATUS
 *  (the route projects it from `storage.getRun(runId)`); this record links `runId`
 *  and accumulates the durable result refs as the run's nodes write them back.
 *
 *  ADR 0390 (public distribution) EXTENDS this record additively (no SQL
 *  migration — the KV-blob read path tolerates missing optional keys, the 0383
 *  pattern): `showId` binds an episode to a PodcastShow channel, `slug` is its
 *  stable per-show public identity, and `published`/`publishedAt` are the
 *  editorial public gate (an episode is public iff its show + itself are
 *  published AND the org-tenant's `podcasts` toggle is on). */
export interface PodcastEpisode {
  id: string;
  tenantId: string;
  orgId: string;
  notebookId: string;
  episodeProfileId: string;
  title: string;
  runId?: string;
  outlineDocRef?: string;
  transcriptDocRef?: string;
  /** R2 PR2-1 — measured at publish time from the stored audio (audioDuration.ts);
   *  feeds `itunes:duration` + the public pages. Absent = never measured. */
  durationSeconds?: number;
  audioMediaRef?: string;
  clips: EpisodeClip[];
  briefing?: string;
  error?: string;
  // ── ADR 0390 public-distribution fields (additive) ──
  showId?: string;
  slug?: string;
  published?: boolean;
  publishedAt?: string;
  descriptionOverride?: string;
  explicitOverride?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A subscribable podcast channel (ADR 0390) — one feed = one show, carrying the
 *  iTunes `<channel>` metadata Apple Podcasts / Spotify require. Introduced here:
 *  no channel entity existed (episodes bind to a `notebookId` + reusable
 *  `EpisodeProfile` format config, neither of which is a channel). Org-scoped,
 *  KV-blob (no SQL migration). `slug` is the stable feed identity — renaming the
 *  title never breaks a subscribed URL. */
export interface PodcastShow {
  id: string;
  tenantId: string;
  orgId: string;
  slug: string;
  title: string;
  author: string;
  description: string;
  languageCode: string;
  imageMediaRef?: string;
  category?: string;
  subcategory?: string;
  explicit: boolean;
  ownerName?: string;
  ownerEmail?: string;
  type: 'episodic' | 'serial';
  /** R2 PR2-4 — operator-entered directory listing URLs (the Buzzsprout
   *  "Listen On" model: a show's Apple/Spotify/Amazon pages exist only after
   *  directory approval and carry directory-minted ids, so they are DATA the
   *  operator pastes back, never derivable from the feed). http(s) only. */
  appleUrl?: string;
  spotifyUrl?: string;
  amazonUrl?: string;
  /** R3 XP-R2-4 — the Podcasting 2.0 channel GUID (`<podcast:guid>`): minted
   *  ONCE (UUIDv5 of the scheme-stripped feed URL, the podcastindex.org
   *  namespace) on the show's first feed render, then persisted — the id must
   *  survive feed-URL moves, so it is DATA, never re-derived. */
  guid?: string;
  published: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const MIN_SPEAKERS = 1;
const MAX_SPEAKERS = 4;
const MIN_SEGMENTS = 3;
const MAX_SEGMENTS = 20;

const speakerProfiles = new DurableCollection<SpeakerProfile>('podcast-speaker-profile', (r) => `${r.tenantId}:${r.id}`);
const episodeProfiles = new DurableCollection<EpisodeProfile>('podcast-episode-profile', (r) => `${r.tenantId}:${r.id}`);
const episodes = new DurableCollection<PodcastEpisode>('podcast-episode', (r) => `${r.tenantId}:${r.id}`);
const shows = new DurableCollection<PodcastShow>('podcasts:show', (r) => `${r.tenantId}:${r.id}`);

const TITLE_MAX = 200;
const TEXT_MAX = 4000;
const SHORT_MAX = 120;

const now = (): string => new Date().toISOString();

function reqStr(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new OpenwopError('validation_error', `${field} must be a non-empty string.`, 400, { field });
  }
  return v.trim();
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' ? Math.floor(v) : NaN;
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

/** Validate + normalize a 1–4-speaker cast (ADR 0086 — the differentiator vs
 *  NotebookLM's fixed two-host format). */
function normalizeSpeakers(raw: unknown): Speaker[] {
  if (!Array.isArray(raw) || raw.length < MIN_SPEAKERS || raw.length > MAX_SPEAKERS) {
    throw new OpenwopError('validation_error', `speakers must be a list of ${MIN_SPEAKERS}–${MAX_SPEAKERS}.`, 400, { min: MIN_SPEAKERS, max: MAX_SPEAKERS });
  }
  return raw.map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    return {
      name: reqStr(o.name, `speakers[${i}].name`),
      voiceId: reqStr(o.voiceId, `speakers[${i}].voiceId`),
      ...(typeof o.backstory === 'string' && o.backstory.trim() ? { backstory: o.backstory.trim() } : {}),
      ...(typeof o.personality === 'string' && o.personality.trim() ? { personality: o.personality.trim() } : {}),
    };
  });
}

// ── SpeakerProfile CRUD ───────────────────────────────────────────────────────

export async function createSpeakerProfile(
  tenantId: string,
  orgId: string,
  input: { name?: unknown; provider?: unknown; model?: unknown; speakers?: unknown },
): Promise<SpeakerProfile> {
  const profile: SpeakerProfile = {
    id: randomUUID(),
    tenantId,
    orgId,
    name: reqStr(input.name, 'name'),
    provider: typeof input.provider === 'string' && input.provider.trim() ? input.provider.trim() : 'minimax',
    ...(typeof input.model === 'string' && input.model.trim() ? { model: input.model.trim() } : {}),
    speakers: normalizeSpeakers(input.speakers),
    createdAt: now(),
    updatedAt: now(),
  };
  await speakerProfiles.put(profile);
  return profile;
}

export async function listSpeakerProfiles(tenantId: string, orgId: string): Promise<SpeakerProfile[]> {
  return (await speakerProfiles.listByPrefix(`${tenantId}:`)).filter((p) => p.orgId === orgId);
}

export async function getSpeakerProfile(tenantId: string, id: string): Promise<SpeakerProfile | null> {
  return (await speakerProfiles.get(`${tenantId}:${id}`)) ?? null;
}

export async function deleteSpeakerProfile(tenantId: string, id: string): Promise<{ deleted: boolean }> {
  const existing = await speakerProfiles.get(`${tenantId}:${id}`);
  if (!existing) return { deleted: false };
  await speakerProfiles.delete(`${tenantId}:${id}`);
  return { deleted: true };
}

// ── EpisodeProfile CRUD ───────────────────────────────────────────────────────

export async function createEpisodeProfile(
  tenantId: string,
  orgId: string,
  input: {
    name?: unknown; outlineModel?: unknown; transcriptModel?: unknown;
    segmentCount?: unknown; languageCode?: unknown; defaultBriefing?: unknown; speakerProfileId?: unknown;
  },
): Promise<EpisodeProfile> {
  const speakerProfileId = reqStr(input.speakerProfileId, 'speakerProfileId');
  // The referenced cast must exist in the same tenant+org (no dangling reference).
  const cast = await getSpeakerProfile(tenantId, speakerProfileId);
  if (!cast || cast.orgId !== orgId) {
    throw new OpenwopError('validation_error', 'speakerProfileId does not resolve to a speaker profile in this org.', 400, { speakerProfileId });
  }
  const profile: EpisodeProfile = {
    id: randomUUID(),
    tenantId,
    orgId,
    name: reqStr(input.name, 'name'),
    outlineModel: typeof input.outlineModel === 'string' && input.outlineModel.trim() ? input.outlineModel.trim() : 'claude-sonnet-4-6',
    transcriptModel: typeof input.transcriptModel === 'string' && input.transcriptModel.trim() ? input.transcriptModel.trim() : 'claude-sonnet-4-6',
    segmentCount: clampInt(input.segmentCount, MIN_SEGMENTS, MAX_SEGMENTS, 5),
    ...(typeof input.languageCode === 'string' && input.languageCode.trim() ? { languageCode: input.languageCode.trim() } : {}),
    ...(typeof input.defaultBriefing === 'string' && input.defaultBriefing.trim() ? { defaultBriefing: input.defaultBriefing.trim() } : {}),
    speakerProfileId,
    createdAt: now(),
    updatedAt: now(),
  };
  await episodeProfiles.put(profile);
  return profile;
}

export async function listEpisodeProfiles(tenantId: string, orgId: string): Promise<EpisodeProfile[]> {
  return (await episodeProfiles.listByPrefix(`${tenantId}:`)).filter((p) => p.orgId === orgId);
}

export async function getEpisodeProfile(tenantId: string, id: string): Promise<EpisodeProfile | null> {
  return (await episodeProfiles.get(`${tenantId}:${id}`)) ?? null;
}

export async function deleteEpisodeProfile(tenantId: string, id: string): Promise<{ deleted: boolean }> {
  const existing = await episodeProfiles.get(`${tenantId}:${id}`);
  if (!existing) return { deleted: false };
  await episodeProfiles.delete(`${tenantId}:${id}`);
  return { deleted: true };
}

// ── PodcastEpisode (tracking record) ──────────────────────────────────────────

/** Create the tracking record for a new generation (status lives on the run). */
export async function createEpisode(
  tenantId: string,
  orgId: string,
  input: { notebookId: string; episodeProfileId: string; title: string; briefing?: string },
): Promise<PodcastEpisode> {
  const episode: PodcastEpisode = {
    id: randomUUID(),
    tenantId,
    orgId,
    notebookId: input.notebookId,
    episodeProfileId: input.episodeProfileId,
    title: input.title,
    clips: [],
    ...(input.briefing ? { briefing: input.briefing } : {}),
    createdAt: now(),
    updatedAt: now(),
  };
  await episodes.put(episode);
  return episode;
}

export async function getEpisode(tenantId: string, id: string): Promise<PodcastEpisode | null> {
  return (await episodes.get(`${tenantId}:${id}`)) ?? null;
}

export async function listEpisodes(tenantId: string, orgId: string): Promise<PodcastEpisode[]> {
  return (await episodes.listByPrefix(`${tenantId}:`))
    .filter((e) => e.orgId === orgId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Attach the enqueued run id to the episode (called by the create route right
 *  after `startWorkflowRun`). */
export async function setEpisodeRun(tenantId: string, id: string, runId: string): Promise<void> {
  const e = await episodes.get(`${tenantId}:${id}`);
  if (!e) return;
  await episodes.put({ ...e, runId, updatedAt: now() });
}

/** Write-back from the generation run's nodes (via the ctx.podcasts WRITE surface):
 *  record the outline/transcript Document refs + the ordered synthesized clips as
 *  they are produced. Merges (never clears) so each node can append its own result.
 *
 *  PODC-1 (ADR 0603) — "merges (never clears)" was TRUE for every string field and
 *  FALSE for `clips`, and the docblock asserted it anyway. The guard idiom
 *  `...(x ? { x } : {})` drops an ABSENT value because `''`/`undefined` are falsy —
 *  but `[]` is TRUTHY, so an empty `clips` array OVERWROTE the stored list. Four
 *  fields were right and one was wrong inside one expression list. The clips guard
 *  is now explicitly length-gated, so the semantics match the sentence above:
 *
 *    an EMPTY `clips` array is a NO-OP, exactly as `''` is for the string fields.
 *
 *  Nothing clears clips today (`retry` re-enqueues without resetting, and the mix
 *  node is the only writer). A caller that genuinely needs to clear must add an
 *  EXPLICIT field and say so at the call site — it must never ride on `[]`, which
 *  is indistinguishable from "this node produced nothing".
 *
 *  `M2` (ADR 0603 R1) — the guard above was correct and its REPORT was not. It
 *  returned `{ recorded: true }` for a write it had just decided to drop, so the
 *  §1 fix closed a destructive write by opening a success-with-empty one layer up:
 *  the surface's per-clip validation can reduce a NON-EMPTY caller input to `[]`
 *  (any clip lacking a string `url`/`voiceId` is dropped), the service then drops
 *  the write, and the caller was told it succeeded. The `mix` node acted on that
 *  and wrote a NEW `audioMediaRef` computed from its own unvalidated list — old
 *  clips beside new audio, the PODC-1 inconsistency in reverse, reported as
 *  `status:'success'` with a `clipCount` for clips that were never stored.
 *
 *  So the result now says what actually happened. `found` and `recorded` are
 *  separate facts (a deleted episode is not the same as a fully-dropped patch),
 *  `applied`/`dropped` name the fields, and `clipsRecorded` is the length actually
 *  stored — never the length requested. A caller that asked for something and did
 *  not get it can now see that it did not get it. */
export type EpisodeResultField = 'outlineDocRef' | 'transcriptDocRef' | 'clips' | 'audioMediaRef' | 'error';

export type EpisodeResultWrite = {
  /** The episode row exists. `false` = there was nothing to write to (deleted
   *  mid-run) — deliberately distinct from "the patch was dropped". */
  found: boolean;
  /** At least one requested field was actually written. */
  recorded: boolean;
  /** The fields written. */
  applied: EpisodeResultField[];
  /** Fields the caller ASKED to write and did not get, because the value was empty
   *  (or was reduced to empty by validation before it arrived here). */
  dropped: EpisodeResultField[];
  /** The number of clips actually stored — present only when `clips` was applied. */
  clipsRecorded?: number;
};

export async function recordEpisodeResult(
  tenantId: string,
  id: string,
  patch: { outlineDocRef?: string; transcriptDocRef?: string; clips?: EpisodeClip[]; audioMediaRef?: string; error?: string },
): Promise<EpisodeResultWrite> {
  const e = await episodes.get(`${tenantId}:${id}`);
  if (!e) return { found: false, recorded: false, applied: [], dropped: [] };

  // One table, so the guard and the report cannot drift apart: each row is the
  // field, whether the caller asked for it, and whether the value survives the
  // same emptiness test the merge below applies.
  const asked: Array<{ field: EpisodeResultField; requested: boolean; keep: boolean }> = [
    { field: 'outlineDocRef', requested: patch.outlineDocRef !== undefined, keep: Boolean(patch.outlineDocRef) },
    { field: 'transcriptDocRef', requested: patch.transcriptDocRef !== undefined, keep: Boolean(patch.transcriptDocRef) },
    { field: 'clips', requested: patch.clips !== undefined, keep: Boolean(patch.clips && patch.clips.length > 0) },
    { field: 'audioMediaRef', requested: patch.audioMediaRef !== undefined, keep: Boolean(patch.audioMediaRef) },
    { field: 'error', requested: patch.error !== undefined, keep: Boolean(patch.error) },
  ];
  const applied = asked.filter((a) => a.keep).map((a) => a.field);
  const dropped = asked.filter((a) => a.requested && !a.keep).map((a) => a.field);
  if (applied.length === 0) {
    // Nothing to write. Bumping `updatedAt` for a no-op would also be a small lie
    // (the episode did not change), so the row is left exactly as it was.
    return { found: true, recorded: false, applied, dropped };
  }

  const next: PodcastEpisode = {
    ...e,
    ...(patch.outlineDocRef ? { outlineDocRef: patch.outlineDocRef } : {}),
    ...(patch.transcriptDocRef ? { transcriptDocRef: patch.transcriptDocRef } : {}),
    ...(patch.clips && patch.clips.length > 0 ? { clips: patch.clips } : {}),
    ...(patch.audioMediaRef ? { audioMediaRef: patch.audioMediaRef } : {}),
    ...(patch.error ? { error: patch.error } : {}),
    updatedAt: now(),
  };
  // R2 review note — a REPLACED audio must not keep the old measurement: a
  // stale duration is a confidently wrong public claim. It re-measures on the
  // next publish flip.
  if (patch.audioMediaRef && patch.audioMediaRef !== e.audioMediaRef) delete next.durationSeconds;
  await episodes.put(next);
  return {
    found: true,
    recorded: true,
    applied,
    dropped,
    ...(applied.includes('clips') ? { clipsRecorded: next.clips.length } : {}),
  };
}

/**
 * PODC-3 (ADR 0603 §3) — the EXPLICIT clear for the episode's failure testimony,
 * called from `enqueueGeneration` (shared by create + retry) so a re-run never shows
 * the PREVIOUS run's error.
 *
 * It is a separate named function on purpose. `recordEpisodeResult` merges and never
 * clears — deliberately, since `''` is falsy there and an empty string is
 * indistinguishable from "this node had nothing to say" (the exact confusion that made
 * `PODC-1` destructive for `clips`). A clear must be something a caller ASKS for by
 * name, at a site where the intent is legible.
 */
export async function clearEpisodeError(tenantId: string, id: string): Promise<{ cleared: boolean }> {
  const e = await episodes.get(`${tenantId}:${id}`);
  if (!e) return { cleared: false };
  if (e.error === undefined) return { cleared: false };
  const next = { ...e, updatedAt: now() };
  delete next.error;
  await episodes.put(next);
  return { cleared: true };
}

export async function deleteEpisode(tenantId: string, id: string): Promise<{ deleted: boolean }> {
  const existing = await episodes.get(`${tenantId}:${id}`);
  if (!existing) return { deleted: false };
  await episodes.delete(`${tenantId}:${id}`);
  return { deleted: true };
}

// ── PodcastShow (channel) CRUD + publish — ADR 0390 ───────────────────────────

const SHOW_TYPES = new Set(['episodic', 'serial']);

/** Normalize the writable iTunes-channel fields from a request body (shared by
 *  create + update). `strict` requires the Apple-mandatory text on create. */
/** R2 PR2-4 — a directory URL must be http(s) and bounded; anything else is
 *  dropped (never stored), so a stored value is always renderable as a link. */
function safeDirectoryUrl(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim() || v.length > 512) return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch { return undefined; }
}

function readShowInput(input: Record<string, unknown>, existing?: PodcastShow): {
  title: string; author: string; description: string; languageCode: string;
  imageMediaRef?: string; category?: string; subcategory?: string; explicit: boolean;
  ownerName?: string; ownerEmail?: string; type: 'episodic' | 'serial';
  appleUrl?: string; spotifyUrl?: string; amazonUrl?: string;
} {
  const title = input.title !== undefined || !existing ? reqStr(input.title, 'title') : existing.title;
  const author = input.author !== undefined || !existing ? reqStr(input.author, 'author') : existing.author;
  const type = typeof input.type === 'string' && SHOW_TYPES.has(input.type)
    ? (input.type as 'episodic' | 'serial')
    : existing?.type ?? 'episodic';
  return {
    title: cleanString(title, TITLE_MAX, existing?.title ?? title),
    author: cleanString(author, SHORT_MAX, existing?.author ?? author),
    description: input.description !== undefined
      ? cleanString(input.description, TEXT_MAX)
      : existing?.description ?? '',
    languageCode: (optionalCleanString(input.languageCode, 16) ?? existing?.languageCode ?? 'en').trim(),
    ...(optionalCleanString(input.imageMediaRef, 512) ? { imageMediaRef: optionalCleanString(input.imageMediaRef, 512)! } : existing?.imageMediaRef ? { imageMediaRef: existing.imageMediaRef } : {}),
    ...(optionalCleanString(input.category, SHORT_MAX) ? { category: optionalCleanString(input.category, SHORT_MAX)! } : existing?.category ? { category: existing.category } : {}),
    ...(optionalCleanString(input.subcategory, SHORT_MAX) ? { subcategory: optionalCleanString(input.subcategory, SHORT_MAX)! } : existing?.subcategory ? { subcategory: existing.subcategory } : {}),
    explicit: typeof input.explicit === 'boolean' ? input.explicit : existing?.explicit ?? false,
    ...(optionalCleanString(input.ownerName, SHORT_MAX) ? { ownerName: optionalCleanString(input.ownerName, SHORT_MAX)! } : existing?.ownerName ? { ownerName: existing.ownerName } : {}),
    ...(optionalCleanString(input.ownerEmail, SHORT_MAX) ? { ownerEmail: optionalCleanString(input.ownerEmail, SHORT_MAX)! } : existing?.ownerEmail ? { ownerEmail: existing.ownerEmail } : {}),
    // Review F6 — an explicit '' CLEARS a directory URL (these are the first
    // merge-only fields on a PUBLIC surface; a wrong Apple link must be
    // removable, not just replaceable).
    ...(input.appleUrl === '' ? {} : safeDirectoryUrl(input.appleUrl) ? { appleUrl: safeDirectoryUrl(input.appleUrl)! } : existing?.appleUrl ? { appleUrl: existing.appleUrl } : {}),
    ...(input.spotifyUrl === '' ? {} : safeDirectoryUrl(input.spotifyUrl) ? { spotifyUrl: safeDirectoryUrl(input.spotifyUrl)! } : existing?.spotifyUrl ? { spotifyUrl: existing.spotifyUrl } : {}),
    ...(input.amazonUrl === '' ? {} : safeDirectoryUrl(input.amazonUrl) ? { amazonUrl: safeDirectoryUrl(input.amazonUrl)! } : existing?.amazonUrl ? { amazonUrl: existing.amazonUrl } : {}),
    type,
  };
}

/** Slug taken by any OTHER show in the org (uniqueness scope = org). */
async function orgShowSlugs(tenantId: string, orgId: string, exceptId?: string): Promise<Set<string>> {
  const list = (await shows.listByPrefix(`${tenantId}:`)).filter((s) => s.orgId === orgId && s.id !== exceptId);
  return new Set(list.map((s) => s.slug));
}

export async function createShow(
  tenantId: string,
  orgId: string,
  createdBy: string,
  input: Record<string, unknown>,
): Promise<PodcastShow> {
  const fields = readShowInput(input);
  const slug = uniqueSlug(
    optionalCleanString(input.slug, 64) ?? fields.title,
    await orgShowSlugs(tenantId, orgId),
    'show',
  );
  const show: PodcastShow = {
    id: randomUUID(),
    tenantId,
    orgId,
    slug,
    ...fields,
    published: false,
    createdBy,
    createdAt: now(),
    updatedAt: now(),
  };
  await shows.put(show);
  return show;
}

export async function listShows(tenantId: string, orgId: string): Promise<PodcastShow[]> {
  return (await shows.listByPrefix(`${tenantId}:`))
    .filter((s) => s.orgId === orgId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getShow(tenantId: string, id: string): Promise<PodcastShow | null> {
  return (await shows.get(`${tenantId}:${id}`)) ?? null;
}

export async function updateShow(
  tenantId: string,
  id: string,
  input: Record<string, unknown>,
): Promise<PodcastShow | null> {
  const existing = await shows.get(`${tenantId}:${id}`);
  if (!existing) return null;
  const fields = readShowInput(input, existing);
  const slug = input.slug !== undefined
    ? uniqueSlug(reqStr(input.slug, 'slug'), await orgShowSlugs(tenantId, existing.orgId, id), 'show')
    : existing.slug;
  const updated: PodcastShow = { ...existing, ...fields, slug, updatedAt: now() };
  await shows.put(updated);
  return updated;
}

/** Podcasting 2.0 `podcast:guid` namespace (fixed by the spec — every platform
 *  derives channel GUIDs against this UUID). */
const PODCAST_GUID_NS = 'ead4c236-bf58-58c6-a2c6-a6b28d128cb6';

/** RFC 4122 UUIDv5 (SHA-1, name-based) — hand-rolled because node:crypto ships
 *  v4 only; the shape (version + variant bits over the hash) is the whole spec. */
function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Mint-once channel GUID: return the persisted value when present; otherwise
 *  derive it from the CURRENT feed URL (scheme + trailing slashes stripped, the
 *  Podcasting 2.0 recipe) and persist it. Later feed-URL changes do NOT re-mint
 *  — stability across moves is the tag's entire purpose. */
export async function ensureShowGuid(tenantId: string, id: string, feedUrl: string): Promise<string | null> {
  const existing = await shows.get(`${tenantId}:${id}`);
  if (!existing) return null;
  if (existing.guid) return existing.guid;
  const name = feedUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  const guid = uuidV5(name, PODCAST_GUID_NS);
  // CAS, not get→put: this write rides a PUBLIC read, so a blind put could
  // clobber a concurrent operator update (lost title/artwork). A failed swap
  // means the row moved — return the peer's mint when one landed; otherwise
  // serve the derived value unpersisted and let the NEXT render persist it
  // (derivation is deterministic while the URL is stable, so the tag stays
  // consistent across the retry window).
  const swapped = await shows.compareAndSwap(existing, { ...existing, guid, updatedAt: now() });
  if (!swapped) {
    const current = await shows.get(`${tenantId}:${id}`);
    if (current?.guid) return current.guid;
  }
  return guid;
}

/** Flip the channel's editorial public gate. */
export async function setShowPublished(tenantId: string, id: string, published: boolean): Promise<PodcastShow | null> {
  const existing = await shows.get(`${tenantId}:${id}`);
  if (!existing) return null;
  const updated: PodcastShow = { ...existing, published, updatedAt: now() };
  await shows.put(updated);
  return updated;
}

/** Delete a show + orphan its episodes back to draft (clear `showId`, force
 *  unpublish) so a deleted channel can never leave an episode in the public
 *  surface (ADR 0390 cascade). */
export async function deleteShow(tenantId: string, id: string): Promise<{ deleted: boolean }> {
  const existing = await shows.get(`${tenantId}:${id}`);
  if (!existing) return { deleted: false };
  const orphans = (await episodes.listByPrefix(`${tenantId}:`)).filter((e) => e.showId === id);
  for (const e of orphans) {
    const { showId: _drop, ...rest } = e;
    await episodes.put({ ...rest, published: false, updatedAt: now() });
  }
  await shows.delete(`${tenantId}:${id}`);
  return { deleted: true };
}

// ── Episode publish/assign — ADR 0390 ─────────────────────────────────────────

/** Assign an episode to a show (validated same-org by the route) + set its
 *  publish state. Generates a stable per-show `slug` on first publish. Optional
 *  episode-level overrides ride the same call. */
export async function setEpisodePublish(
  tenantId: string,
  id: string,
  // Review F3 — `null` is an explicit CLEAR (restore inheritance / drop the
  // description); `undefined` means "leave as stored". Without the null shape,
  // an unpublish→republish with "Inherit" selected silently kept the old
  // override while the UI claimed inheritance.
  patch: { published: boolean; showId?: string; descriptionOverride?: string | null; explicitOverride?: boolean | null; durationSeconds?: number },
): Promise<PodcastEpisode | null> {
  const e = await episodes.get(`${tenantId}:${id}`);
  if (!e) return null;
  const showId = patch.showId ?? e.showId;
  const movingShow = !!showId && showId !== e.showId;
  let slug = e.slug;
  // Generate a slug on first publish, AND re-uniquify an existing slug when the
  // episode moves to a DIFFERENT show whose catalog already has that slug —
  // otherwise two episodes in the destination show would share a slug and one
  // would shadow the other on the public `(:showSlug/:episodeSlug)` read (P0PUB-3).
  if (patch.published && showId && (!slug || movingShow)) {
    const taken = new Set(
      (await episodes.listByPrefix(`${tenantId}:`))
        .filter((o) => o.showId === showId && o.id !== id && o.slug)
        .map((o) => o.slug!),
    );
    if (!slug) slug = uniqueSlug(e.title, taken, 'episode');
    else if (movingShow && taken.has(slug)) slug = uniqueSlug(slug, taken, 'episode');
  }
  const base: PodcastEpisode = {
    ...e,
    ...(showId ? { showId } : {}),
    ...(slug ? { slug } : {}),
    published: patch.published,
    ...(patch.published ? { publishedAt: e.publishedAt ?? now() } : {}),
    ...(typeof patch.descriptionOverride === 'string' ? { descriptionOverride: cleanString(patch.descriptionOverride, TEXT_MAX) } : {}),
    ...(typeof patch.explicitOverride === 'boolean' ? { explicitOverride: patch.explicitOverride } : {}),
    ...(typeof patch.durationSeconds === 'number' && patch.durationSeconds > 0 ? { durationSeconds: Math.round(patch.durationSeconds) } : {}),
    updatedAt: now(),
  };
  // Review F3 — null CLEARS: strip the field so inheritance genuinely resumes.
  if (patch.descriptionOverride === null) delete base.descriptionOverride;
  if (patch.explicitOverride === null) delete base.explicitOverride;
  const updated = base;
  await episodes.put(updated);
  return updated;
}

// ── Public read helpers — ADR 0390 (org→tenant resolved by the route) ─────────

/** Published shows in an org (the public index). */
export async function listPublishedShows(tenantId: string, orgId: string): Promise<PodcastShow[]> {
  return (await shows.listByPrefix(`${tenantId}:`))
    .filter((s) => s.orgId === orgId && s.published)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** A published show by its public slug, or null. */
export async function getPublishedShowBySlug(tenantId: string, orgId: string, slug: string): Promise<PodcastShow | null> {
  return (await shows.listByPrefix(`${tenantId}:`))
    .find((s) => s.orgId === orgId && s.published && s.slug === slug) ?? null;
}

/** A show's published episodes, newest published first (feed + show-page order). */
export async function listPublishedEpisodes(tenantId: string, showId: string): Promise<PodcastEpisode[]> {
  return (await episodes.listByPrefix(`${tenantId}:`))
    .filter((e) => e.showId === showId && e.published)
    .sort((a, b) => ((a.publishedAt ?? a.createdAt) < (b.publishedAt ?? b.createdAt) ? 1 : -1));
}

/** A single published episode by (published show slug, episode slug). Returns
 *  the episode + its show, or null if either is unpublished / not found. */
export async function getPublishedEpisode(
  tenantId: string,
  orgId: string,
  showSlug: string,
  episodeSlug: string,
): Promise<{ show: PodcastShow; episode: PodcastEpisode } | null> {
  const show = await getPublishedShowBySlug(tenantId, orgId, showSlug);
  if (!show) return null;
  const episode = (await episodes.listByPrefix(`${tenantId}:`))
    .find((e) => e.showId === show.id && e.published && e.slug === episodeSlug);
  return episode ? { show, episode } : null;
}

/** Resolve one published episode by id (the audio route's lookup — the enclosure
 *  URL is id-addressed, not slug-addressed). Enforces show+episode published +
 *  org match. */
export async function getPublishedEpisodeById(
  tenantId: string,
  orgId: string,
  episodeId: string,
): Promise<{ show: PodcastShow; episode: PodcastEpisode } | null> {
  const episode = await episodes.get(`${tenantId}:${episodeId}`);
  if (!episode || episode.orgId !== orgId || !episode.published || !episode.showId) return null;
  const show = await shows.get(`${tenantId}:${episode.showId}`);
  if (!show || !show.published) return null;
  return { show, episode };
}

/**
 * PODU-1 (ADR 0603 §4) — the PUBLIC transcript projection. WCAG 2.1 SC 1.2.1
 * (Level A) requires a text alternative for prerecorded audio-only content; the
 * public episode page shipped a bare `<audio>` and nothing else.
 *
 * The gap had been deferred twice on a premise that was FALSE: the transcript was
 * said not to exist. It does — `feature.podcasts.nodes.transcript` writes a Document
 * and records `transcriptDocRef`, and the public route's own comment at
 * `publicRoutes.ts:275-279` says so ("the data exists for generated episodes"). What
 * that comment correctly refused was leaking the internal `transcriptDocRef` id onto
 * the public wire, since a public consumer cannot fetch an authed ADR 0053 document.
 * This is the projection it named as the fix: the CONTENT, resolved server-side.
 *
 * Bounded because a transcript is model-produced text of unbounded length and this
 * rides an unauthed, cacheable route. Returns `null` when the episode has no
 * transcript — an episode INGESTED rather than generated (ADR 0562) legitimately has
 * none, so absence is a real state the caller must render honestly, not an error.
 *
 * Tenancy: the caller has already resolved `tenantId` from the `:orgId` RESOURCE and
 * proved show+episode `published`; this re-checks tenant AND org on the document read
 * (`listVersions` filters on both), so a mis-referenced doc from another org cannot be
 * projected.
 *
 * ── `M1`-elevated + `L5` (ADR 0603 R1) — two checks this projection was missing ──
 *
 * This function is the ONE composition owner for the public transcript: both the
 * JSON route and the bot/no-JS PRERENDER call it and nothing else resolves a
 * document for a public consumer. So both checks belong here, once, rather than
 * at each caller.
 *
 * 1. **The `documents` TOGGLE.** The first cut imported `documentsService` directly,
 *    which bypasses the `featureSurfaces` gate whose entire purpose is that "a node
 *    must not read a feature's data for a tenant that disabled it" — so a tenant
 *    that had switched `documents` OFF still had its document content served on an
 *    UNAUTHENTICATED, `public`-cached route. ADR 0603 §4 promised this edge
 *    "degrades rather than breaks, IN BOTH DIRECTIONS"; only one direction was
 *    honoured. It now genuinely is: with `documents` off the projection returns
 *    `null` and the page states "No transcript is available for this episode" —
 *    the SAME honest absence a never-generated episode produces, and the same one
 *    direction (a) already produced. Deliberately NOT a distinct public state:
 *    telling an anonymous visitor which internal features their host has disabled
 *    is a config leak, and the tenant's operator is the one who chose it.
 *    Precedented at `features/strategy/routes.ts` (`resolveOne('documents', …)`
 *    before a decision record is written).
 * 2. **The document KIND.** `transcriptDocRef` is a plain id on a mutable episode
 *    row; nothing downstream re-checked what it POINTS AT, so a mis-set or
 *    hand-edited ref could project any document in the same tenant+org — a
 *    contract briefing, a decision record — onto a public 300s-cached page.
 *    Tenant and org were re-checked; the kind was not. It must be the kind the
 *    transcript node actually writes.
 */
export const PUBLIC_TRANSCRIPT_MAX = 200_000;

/** The ONLY document kind the public transcript projection will serve — the kind
 *  `feature.podcasts.nodes.transcript` writes (`packs/feature.podcasts.nodes`). */
const PUBLIC_TRANSCRIPT_KIND = 'podcast-transcript';

export async function getPublicEpisodeTranscript(
  tenantId: string,
  episode: PodcastEpisode,
): Promise<{ text: string; truncated: boolean } | null> {
  if (!episode.transcriptDocRef) return null;
  const docsOn = await resolveOne('documents', { tenantId });
  if (!docsOn?.enabled) return null;
  const doc = await getDocumentRecord(tenantId, episode.orgId, episode.transcriptDocRef);
  if (!doc || doc.kind !== PUBLIC_TRANSCRIPT_KIND) return null;
  const list = await listDocumentVersions(tenantId, episode.orgId, episode.transcriptDocRef);
  const latest = list[0]; // listVersions is newest-first
  const content = typeof latest?.content === 'string' ? latest.content.trim() : '';
  if (content.length === 0) return null;
  return content.length > PUBLIC_TRANSCRIPT_MAX
    ? { text: content.slice(0, PUBLIC_TRANSCRIPT_MAX), truncated: true }
    : { text: content, truncated: false };
}

/** The public episode slug ↔ derived fallback (used when a legacy episode has no
 *  stored slug). Kept deterministic for stable URLs. */
export function episodeSlugOf(e: PodcastEpisode): string {
  return e.slug ?? slugify(e.title, e.id);
}

/** Project a coarse status from the executor run status (the SoT). Used by the
 *  routes for list/get so the episode never duplicates run state. */
export function projectStatus(runStatus: string | undefined): 'queued' | 'running' | 'awaiting-approval' | 'done' | 'failed' {
  if (!runStatus) return 'queued';
  if (runStatus === 'completed') return 'done';
  if (runStatus === 'failed' || runStatus === 'cancelled') return 'failed';
  if (runStatus.startsWith('waiting-')) return 'awaiting-approval';
  if (runStatus === 'pending') return 'queued';
  return 'running';
}

export const PODCAST_LIMITS = { MIN_SPEAKERS, MAX_SPEAKERS, MIN_SEGMENTS, MAX_SEGMENTS };
