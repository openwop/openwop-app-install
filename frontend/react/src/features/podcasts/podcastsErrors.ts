/**
 * ADR 1115 D10 — refused requests and failed runs, in the reader's language. Shared by
 * the Studio and the shows manager so the two panels of one page never disagree about
 * how a refusal reads (UX regrade `PODUX93R-5`).
 */
import type { PodcastsRequestError } from './podcastsClient.js';

/** The typed failure codes a generation run writes on the episode (`errorCode`); each
 *  has a `failure_<code>` key in the `podcasts` namespace. An unknown code falls back to
 *  the generic failure line. Mirrors the backend's `PodcastRunRefusal` plus the node
 *  codes (`packs/feature.podcasts.nodes`). */
export const FAILURE_CODES: ReadonlySet<string> = new Set([
  'podcast_episode_not_found', 'podcast_run_needs_person', 'podcast_write_forbidden',
  'podcast_profile_missing', 'podcast_notebook_unavailable', 'podcast_notebook_has_no_sources',
  'podcast_content_empty', 'podcast_outline_empty', 'podcast_transcript_unusable',
  'podcast_no_cast_voice', 'podcast_synthesis_returned_no_audio', 'podcast_mix_no_clips',
  'podcast_mix_clips_rejected', 'podcast_run_not_claimed', 'podcast_episode_published',
]);

/** The typed 409 reasons the doors answer with; each has a `refusal_<reason>` key. */
export const DOOR_REASONS: ReadonlySet<string> = new Set([
  'episode_published', 'generation_in_progress', 'episode_not_ready', 'notebooks_disabled',
  'notebook_has_no_sources', 'notebook_unavailable',
]);

export type ErrorFallbackKey = 'createFailed' | 'generateFailed' | 'deleteFailed' | 'publishFailed' | 'updateFailed';

/** A refused request → a `podcasts` key: a typed 409 reason, then the status (403 /
 *  404), else the caller's own fallback. */
export function requestErrorKey(err: unknown, fallback: ErrorFallbackKey): string {
  const e = err as PodcastsRequestError | undefined;
  if (e?.reason && DOOR_REASONS.has(e.reason)) return `refusal_${e.reason}`;
  if (e?.status === 403) return 'refusal_forbidden';
  if (e?.status === 404) return 'refusal_not_found';
  return fallback;
}

/** The text to show: the mapped key's copy, or — only for an unmapped failure (a
 *  field validation message) — the server's own text. */
export function requestErrorText(t: (key: string) => string, err: unknown, fallback: ErrorFallbackKey): string {
  const key = requestErrorKey(err, fallback);
  if (key === fallback && err instanceof Error && err.message) return err.message;
  return t(key);
}
