/**
 * Podcasts workflow surface (ADR 0086 Phase 2 / ADR 0014) — `ctx.features.podcasts`,
 * the typed surface the `feature.podcasts.nodes` pipeline calls. Tenant comes from the
 * run scope (CTI-1); toggle-gated at the registry seam.
 *
 * RBAC (ADR 1115 D2 — this surface used to be "TENANT-TRUSTED … without re-gating", so
 * a run acting for a member of org A read org B's episodes and profiles and wrote any
 * episode in the tenant, a published one's public audio included; the ADR 0832 seam
 * floor keys on `args.orgId`, which only `listEpisodes` takes, `PODC93-2`):
 *   - the run's person (`scope.actingUserId`) gets exactly what the HTTP doors give
 *     them: the ONE rule in `podcastsAccess.ts` (`episodeAccess`). Reads need org read
 *     and the episode's notebook readable; writes also need `workspace:write`;
 *   - a run with NO person is refused everything (`podcast_run_needs_person`).
 *     Generic actorless starters (a sub-workflow child, host-event triggers, approvals,
 *     compose, kanban) are refused by design: `podcasts.generate` is internal host
 *     machinery;
 *   - a WRITE also needs the run to be the episode's CLAIMED run (`episode.runId ===
 *     scope.runId`) and the episode to be unpublished. The doors claim the episode
 *     before they start the run (ADR 1115 D5), so the claim is the single authority
 *     over which run may write: a `POST /v1/runs` of the chain, a fork, a debug run or
 *     a redrive of an old run, or the loser of two racing retries is refused
 *     (`podcast_run_not_claimed`), and a published episode's public audio is never
 *     replaced by a run (`podcast_episode_published`) — the code-regrade `PODCD93-1/-2`.
 *     A surface built with no `runId` (a test, never the executor) skips only the claim.
 * Authority is resolved per call, never cached from the first node, so a membership
 * removed mid-run stops the next write; the nodes call `checkWrite` before each paid
 * step, so it also stops the next paid call (`PODCD93-7`).
 *
 * Refusals: reads answer their empty shape PLUS `refused: <code>`, so a node can say
 * why without the surface ever confirming that a hidden row exists (`hidden` is
 * reported as `podcast_episode_not_found`); writes answer `refused` on their result.
 *
 * @see docs/adr/0086-multi-speaker-podcasts.md
 * @see docs/adr/1115-podcasts-one-episode-access-rule.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { resolveMediaAsset, storeMediaAsset } from '../../host/inMemorySurfaces.js';
import { type FeatureSurface, surfaceStr, surfaceOptStr } from '../../host/featureSurfaces.js';
import {
  getSpeakerProfile, getEpisodeProfile, getEpisode, listEpisodes, recordEpisodeResult,
  type EpisodeClip, type EpisodeResultWrite, type PodcastEpisode,
} from './podcastsService.js';
import { episodeAccess, filterReadableEpisodes, generateTargetAccess, orgAllows } from './podcastsAccess.js';
import { muxAudioClips, type AudioPart } from './audioMux.js';

/** ADR 1115 D2 — the closed set of run-lane refusal codes. The nodes fail with them. */
export type PodcastRunRefusal =
  | 'podcast_run_needs_person'
  | 'podcast_episode_not_found'
  | 'podcast_write_forbidden'
  | 'podcast_profile_missing'
  | 'podcast_notebook_unavailable'
  | 'podcast_notebook_has_no_sources'
  | 'podcast_run_not_claimed'
  | 'podcast_episode_published';

const REFUSAL_MESSAGE: Record<PodcastRunRefusal, string> = {
  podcast_run_needs_person: 'Only a run started by a person can generate a podcast episode.',
  podcast_episode_not_found: 'The episode was not found, or the person this run acts for cannot see it.',
  podcast_write_forbidden: 'The person this run acts for cannot change this episode.',
  podcast_profile_missing: "The episode's show format or its cast was deleted; choose another and generate again.",
  podcast_notebook_unavailable: "The episode's notebook was deleted, or the person this run acts for can no longer read it.",
  podcast_notebook_has_no_sources: "The episode's project has no sources yet; add a source, then generate again.",
  podcast_run_not_claimed: 'This run is not the generation the episode is waiting for (it was started outside the Studio, replaced by a newer retry, or forked from an old run).',
  podcast_episode_published: 'The episode is published; a run never replaces its public audio. Unpublish it, then generate again.',
};

const refusal = (code: PodcastRunRefusal): { error: { code: PodcastRunRefusal; message: string } } => ({
  error: { code, message: REFUSAL_MESSAGE[code] },
});

/** A node-chosen failure code (`failEpisode`), never free text (ADR 1115 D6). */
const ERROR_CODE = /^podcast_[a-z_]{1,64}$/;

type Resolved = { episode: PodcastEpisode } | { refused: PodcastRunRefusal };

/** ADR 1115 D2 — resolve an episode FOR THIS RUN. The one gate every episode method
 *  passes through. */
async function resolveForRun(scope: BundleScope, episodeId: string, need: 'read' | 'write'): Promise<Resolved> {
  const person = scope.actingUserId;
  if (!person) return { refused: 'podcast_run_needs_person' };
  const episode = await getEpisode(scope.tenantId, episodeId);
  if (!episode) return { refused: 'podcast_episode_not_found' };
  const access = await episodeAccess(scope.tenantId, episode, person, need);
  if (access === 'hidden') return { refused: 'podcast_episode_not_found' };
  if (access === 'forbidden') return { refused: 'podcast_write_forbidden' };
  if (need === 'write') {
    if (episode.published) return { refused: 'podcast_episode_published' };
    if (scope.runId !== undefined && episode.runId !== scope.runId) return { refused: 'podcast_run_not_claimed' };
  }
  return { episode };
}

const writeRefused = (code: PodcastRunRefusal): EpisodeResultWrite => ({
  found: false, recorded: false, applied: [], dropped: [], refused: code,
});

export function buildPodcastsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;

  /** A profile the run's person may read (its org), or the refusal. */
  const readableProfile = async <P extends { orgId: string }>(profile: P | null): Promise<{ profile: P | null; refused?: PodcastRunRefusal }> => {
    if (!scope.actingUserId) return { profile: null, refused: 'podcast_run_needs_person' };
    if (!profile || !(await orgAllows(tenantId, profile.orgId, scope.actingUserId, 'workspace:read'))) {
      return { profile: null, refused: 'podcast_profile_missing' };
    }
    return { profile };
  };

  return {
    /**
     * ADR 1115 D2 — the FIRST call of every generation (`select-content`), so an
     * unauthorized or unconfigured run fails before any paid call: the run's person may
     * WRITE the episode, the episode's notebook is still a valid generation target (an
     * orphan or an unprovisioned project is not), and its show format and cast resolve
     * in its org. Answers `{ episode, episodeProfile, speakerProfile }` or a typed
     * `{ error: { code, message } }`.
     */
    authorizeGeneration: async (args) => {
      const r = await resolveForRun(scope, surfaceStr(args.episodeId), 'write');
      if ('refused' in r) return refusal(r.refused);
      const { episode } = r;
      const target = await generateTargetAccess(tenantId, episode.orgId, episode.notebookId, scope.actingUserId);
      if ('refused' in target) {
        return refusal(target.refused === 'notebook_has_no_sources'
          ? 'podcast_notebook_has_no_sources'
          : target.refused === 'forbidden' ? 'podcast_write_forbidden' : 'podcast_notebook_unavailable');
      }
      const episodeProfile = await getEpisodeProfile(tenantId, episode.episodeProfileId);
      const speakerProfile = episodeProfile ? await getSpeakerProfile(tenantId, episodeProfile.speakerProfileId) : null;
      if (!episodeProfile || episodeProfile.orgId !== episode.orgId || !speakerProfile || speakerProfile.orgId !== episode.orgId) {
        return refusal('podcast_profile_missing');
      }
      return { episode, episodeProfile, speakerProfile };
    },

    /** ADR 1115 D2 (`PODCD93-7`) — "may this run still write this episode?", asked by
     *  each node immediately before its paid step (model or TTS), so a membership
     *  revoked, an episode published, or a claim lost mid-run stops the NEXT paid call
     *  rather than only the next write. `{ ok: true }` or `{ error: { code, message } }`. */
    checkWrite: async (args) => {
      const r = await resolveForRun(scope, surfaceStr(args.episodeId), 'write');
      return 'refused' in r ? refusal(r.refused) : { ok: true };
    },

    /** A cast (speaker) profile by id — the voices the synthesize node uses. */
    getSpeakerProfile: async (args) => readableProfile(await getSpeakerProfile(tenantId, surfaceStr(args.id))),

    /** A show-format (episode) profile by id — models, segment count, briefing. */
    getEpisodeProfile: async (args) => readableProfile(await getEpisodeProfile(tenantId, surfaceStr(args.id))),

    /** One episode tracking record by id, or `{ episode: null, refused }`. */
    getEpisode: async (args) => {
      const r = await resolveForRun(scope, surfaceStr(args.episodeId), 'read');
      return 'refused' in r ? { episode: null, refused: r.refused } : { episode: r.episode };
    },

    /** Episodes in an org (newest-first) that the run's person may read: the ADR 0832
     *  floor checks org membership (`orgId` arg); this applies the notebook filter the
     *  HTTP list applies (CPU-2). */
    listEpisodes: async (args) => {
      if (!scope.actingUserId) return { episodes: [], refused: 'podcast_run_needs_person' };
      const episodes = await listEpisodes(tenantId, surfaceStr(args.orgId));
      return { episodes: await filterReadableEpisodes(tenantId, episodes, scope.actingUserId) };
    },

    /**
     * Write-back the generation result refs (ADR 0086) — the outline/transcript
     * Document ids + the ordered synthesized clips, as the pipeline's nodes produce
     * them. Merges (never clears); see `recordEpisodeResult` for the report.
     * WRITE-gated (ADR 1115 D2); a refusal comes back as `refused` and the node fails
     * typed with it (`recordOrFail`).
     *
     * PODC-1 (ADR 0603): every string field below rides `surfaceOptStr`, which is falsy
     * for `''`, so an absent value is DROPPED. `clips` takes the raw-array path, where
     * the identical-looking `x ? {x} : {}` idiom silently INVERTS (`[]` is truthy); the
     * service-side write is length-gated.
     *
     * `M2` (ADR 0603 R1) — THIS validation is the one that can reduce a non-empty
     * caller list to `[]` (the `flatMap` drops any clip without a string
     * `url`/`voiceId`), which the node cannot see; the service result reports
     * `applied`/`dropped`/`clipsRecorded`.
     */
    recordEpisodeResult: async (args) => {
      const r = await resolveForRun(scope, surfaceStr(args.episodeId), 'write');
      if ('refused' in r) return writeRefused(r.refused);
      const clips = Array.isArray(args.clips)
        ? (args.clips as unknown[]).flatMap((c) => {
            const o = (c ?? {}) as Record<string, unknown>;
            if (typeof o.url !== 'string' || typeof o.voiceId !== 'string') return [];
            return [{
              speaker: typeof o.speaker === 'string' ? o.speaker : '',
              voiceId: o.voiceId,
              url: o.url,
              mimeType: typeof o.mimeType === 'string' ? o.mimeType : 'audio/mpeg',
            } satisfies EpisodeClip];
          })
        : undefined;
      const errorCode = surfaceOptStr(args.errorCode);
      return recordEpisodeResult(tenantId, r.episode.id, {
        ...(surfaceOptStr(args.outlineDocRef) ? { outlineDocRef: surfaceOptStr(args.outlineDocRef)! } : {}),
        ...(surfaceOptStr(args.transcriptDocRef) ? { transcriptDocRef: surfaceOptStr(args.transcriptDocRef)! } : {}),
        ...(clips ? { clips } : {}),
        ...(surfaceOptStr(args.audioMediaRef) ? { audioMediaRef: surfaceOptStr(args.audioMediaRef)! } : {}),
        ...(surfaceOptStr(args.error) ? { error: surfaceOptStr(args.error)! } : {}),
        // ADR 1115 D6 — the third of the three allowlists `errorCode` must pass.
        ...(errorCode && ERROR_CODE.test(errorCode) ? { errorCode } : {}),
      });
    },

    /**
     * Mux the episode's STORED clips into ONE playable asset (ADR 0086 §mix) — resolves
     * each clip's bytes (tenant-checked), concatenates where the codec allows (MP3
     * byte-concat / WAV header-strip+rewrap), stores the result, and returns its asset
     * URL. Returns `{ url: '' }` when the clips mix codecs, can't all be resolved, or use
     * an unknown container — the caller keeps the playlist (degrade, never corrupt).
     *
     * ADR 1115 D2 (architect finding 6) — takes the `episodeId` and muxes what the
     * episode holds; it used to mux whatever clip URLs the node passed, so any run could
     * concatenate any tenant media token into a new asset. WRITE-gated; a refusal comes
     * back as `refused`, distinct from the codec degrade.
     */
    mixClips: async (args) => {
      const r = await resolveForRun(scope, surfaceStr(args.episodeId), 'write');
      if ('refused' in r) return { url: '', refused: r.refused };
      const parts: AudioPart[] = [];
      for (const c of r.episode.clips) {
        const token = c.url.split('/').pop();
        if (!token) return { url: '' };
        const asset = await resolveMediaAsset(token);
        if (!asset || asset.tenantId !== tenantId) return { url: '' };
        parts.push({ contentBase64: asset.contentBase64, contentType: asset.contentType });
      }
      if (parts.length === 0) return { url: '' };
      const muxed = muxAudioClips(parts);
      if (!muxed) return { url: '' };
      const stored = await storeMediaAsset(tenantId, { contentBase64: muxed.contentBase64, contentType: muxed.contentType });
      return { url: stored.url, mimeType: muxed.contentType };
    },
  };
}
