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

import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';

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
 *  and accumulates the durable result refs as the run's nodes write them back. */
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
  clips: EpisodeClip[];
  briefing?: string;
  error?: string;
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
 *  they are produced. Merges (never clears) so each node can append its own result. */
export async function recordEpisodeResult(
  tenantId: string,
  id: string,
  patch: { outlineDocRef?: string; transcriptDocRef?: string; clips?: EpisodeClip[]; audioMediaRef?: string; error?: string },
): Promise<{ recorded: boolean }> {
  const e = await episodes.get(`${tenantId}:${id}`);
  if (!e) return { recorded: false };
  await episodes.put({
    ...e,
    ...(patch.outlineDocRef ? { outlineDocRef: patch.outlineDocRef } : {}),
    ...(patch.transcriptDocRef ? { transcriptDocRef: patch.transcriptDocRef } : {}),
    ...(patch.clips ? { clips: patch.clips } : {}),
    ...(patch.audioMediaRef ? { audioMediaRef: patch.audioMediaRef } : {}),
    ...(patch.error ? { error: patch.error } : {}),
    updatedAt: now(),
  });
  return { recorded: true };
}

export async function deleteEpisode(tenantId: string, id: string): Promise<{ deleted: boolean }> {
  const existing = await episodes.get(`${tenantId}:${id}`);
  if (!existing) return { deleted: false };
  await episodes.delete(`${tenantId}:${id}`);
  return { deleted: true };
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
