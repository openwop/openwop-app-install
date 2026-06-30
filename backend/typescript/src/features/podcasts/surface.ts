/**
 * Podcasts workflow surface (ADR 0086 Phase 2 / ADR 0014) — `ctx.podcasts`, the
 * typed surface the `feature.podcasts.nodes` pipeline calls. Tenant comes from the
 * run scope (CTI-1); toggle-gated at the registry seam.
 *
 * The run is TENANT-TRUSTED (a BundleScope carries no caller subject — the strategy
 * precedent) and was enqueued by an already-authorized `workspace:write` route over
 * an ORG-scoped episode, so the surface resolves config/episodes by tenant+id
 * without re-gating per-member visibility (episodes are org config, not member-
 * scoped containers).
 *
 * READS: the profiles + episode the pipeline needs (cast voices, segment count, the
 * episode being generated). The ONE write `recordEpisodeResult` is how the run's
 * nodes write the outline/transcript Document refs + the ordered synthesized clips
 * back onto the tracking record as they are produced (ADR 0086 — write-back goes
 * through the service, the run is the status SoT).
 *
 * @see docs/adr/0086-multi-speaker-podcasts.md
 */

import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { resolveMediaAsset, storeMediaAsset } from '../../host/inMemorySurfaces.js';
import { type FeatureSurface, surfaceStr, surfaceOptStr } from '../../host/featureSurfaces.js';
import {
  getSpeakerProfile, getEpisodeProfile, getEpisode, listEpisodes, recordEpisodeResult,
  type EpisodeClip,
} from './podcastsService.js';
import { muxAudioClips, type AudioPart } from './audioMux.js';

export function buildPodcastsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  return {
    /** A cast (speaker) profile by id — the voices the synthesize node uses. */
    getSpeakerProfile: async (args) => {
      const profile = await getSpeakerProfile(tenantId, surfaceStr(args.id));
      return { profile };
    },

    /** A show-format (episode) profile by id — models, segment count, briefing. */
    getEpisodeProfile: async (args) => {
      const profile = await getEpisodeProfile(tenantId, surfaceStr(args.id));
      return { profile };
    },

    /** One episode tracking record by id. */
    getEpisode: async (args) => {
      const episode = await getEpisode(tenantId, surfaceStr(args.episodeId));
      return { episode };
    },

    /** Episodes in an org (newest-first). */
    listEpisodes: async (args) => {
      const episodes = await listEpisodes(tenantId, surfaceStr(args.orgId));
      return { episodes };
    },

    /**
     * Write-back the generation result refs (ADR 0086) — the outline/transcript
     * Document ids + the ordered synthesized clips, as the pipeline's nodes produce
     * them. Merges (never clears); a no-op for a missing episode. The run remains the
     * status source of truth — this only persists the durable result artifacts.
     */
    recordEpisodeResult: async (args) => {
      const episodeId = surfaceStr(args.episodeId);
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
      return recordEpisodeResult(tenantId, episodeId, {
        ...(surfaceOptStr(args.outlineDocRef) ? { outlineDocRef: surfaceOptStr(args.outlineDocRef)! } : {}),
        ...(surfaceOptStr(args.transcriptDocRef) ? { transcriptDocRef: surfaceOptStr(args.transcriptDocRef)! } : {}),
        ...(clips ? { clips } : {}),
        ...(surfaceOptStr(args.audioMediaRef) ? { audioMediaRef: surfaceOptStr(args.audioMediaRef)! } : {}),
        ...(surfaceOptStr(args.error) ? { error: surfaceOptStr(args.error)! } : {}),
      });
    },

    /**
     * Mux the episode's ordered clips into ONE playable asset (ADR 0086 §mix) —
     * resolves each clip's stored bytes (tenant-checked), concatenates where the
     * codec allows (MP3 byte-concat / WAV header-strip+rewrap), stores the result,
     * and returns its asset URL. Returns `{ url: '' }` when the clips mix codecs,
     * can't all be resolved, or use an unknown container — the caller keeps the
     * playlist (degrade, never corrupt). Server-side byte handling (no SSRF egress).
     */
    mixClips: async (args) => {
      const clips = Array.isArray(args.clips) ? (args.clips as Array<{ url?: unknown }>) : [];
      const parts: AudioPart[] = [];
      for (const c of clips) {
        const url = typeof c?.url === 'string' ? c.url : '';
        const token = url.split('/').pop();
        if (!token) return { url: '' };
        const asset = await resolveMediaAsset(token);
        if (!asset || asset.tenantId !== tenantId) return { url: '' };
        parts.push({ contentBase64: asset.contentBase64, contentType: asset.contentType });
      }
      const muxed = muxAudioClips(parts);
      if (!muxed) return { url: '' };
      const stored = await storeMediaAsset(tenantId, { contentBase64: muxed.contentBase64, contentType: muxed.contentType });
      return { url: stored.url, mimeType: muxed.contentType };
    },
  };
}
