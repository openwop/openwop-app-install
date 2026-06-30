/**
 * Multi-speaker podcasts client (ADR 0086) — host-extension, non-normative. Wraps
 * /v1/host/openwop-app/podcasts/*. 404s when the `podcasts` toggle is off. Mirrors
 * the backend podcastsService / routes response shapes 1:1.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Speaker {
  name: string;
  voiceId: string;
  backstory?: string;
  personality?: string;
}

export interface SpeakerProfile {
  id: string;
  orgId: string;
  name: string;
  provider: string;
  model?: string;
  speakers: Speaker[];
  createdAt: string;
  updatedAt: string;
}

export interface EpisodeProfile {
  id: string;
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

export interface EpisodeClip {
  speaker: string;
  voiceId: string;
  url: string;
  mimeType: string;
}

export type EpisodeStatus = 'queued' | 'running' | 'awaiting-approval' | 'done' | 'failed';

export interface PodcastEpisode {
  id: string;
  orgId: string;
  notebookId: string;
  episodeProfileId: string;
  title: string;
  runId?: string;
  outlineDocRef?: string;
  transcriptDocRef?: string;
  /** Single muxed audio file (ADR 0086 §mix) when the clips share a codec; the
   *  player prefers it, else falls back to the ordered `clips` playlist. */
  audioMediaRef?: string;
  clips: EpisodeClip[];
  briefing?: string;
  error?: string;
  status: EpisodeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Org {
  orgId: string;
  name: string;
}

/** Make a backend-relative asset path (`/v1/host/openwop-app/assets/<token>`)
 *  absolute against the API base, so a clip/episode plays in an `<audio>` element
 *  regardless of the SPA origin (mirrors media's `absoluteServeUrl`). */
export function assetUrl(url: string): string {
  return url.startsWith('http') ? url : `${config.baseUrl}${url}`;
}

const base = `${config.baseUrl}/v1/host/openwop-app/podcasts`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

const q = (orgId: string): string => `?orgId=${encodeURIComponent(orgId)}`;

// ── Speaker profiles ──────────────────────────────────────────────────────────

export async function listSpeakerProfiles(orgId: string): Promise<SpeakerProfile[]> {
  const res = await fetch(`${base}/speaker-profiles${q(orgId)}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ profiles: SpeakerProfile[] }>(res, 'listSpeakerProfiles')).profiles;
}

export async function createSpeakerProfile(
  input: { orgId: string; name: string; provider?: string; model?: string; speakers: Speaker[] },
): Promise<SpeakerProfile> {
  const res = await fetch(`${base}/speaker-profiles`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return (await asJson<{ profile: SpeakerProfile }>(res, 'createSpeakerProfile')).profile;
}

export async function deleteSpeakerProfile(id: string): Promise<void> {
  const res = await fetch(`${base}/speaker-profiles/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  await asJson(res, 'deleteSpeakerProfile');
}

// ── Episode profiles ──────────────────────────────────────────────────────────

export async function listEpisodeProfiles(orgId: string): Promise<EpisodeProfile[]> {
  const res = await fetch(`${base}/episode-profiles${q(orgId)}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ profiles: EpisodeProfile[] }>(res, 'listEpisodeProfiles')).profiles;
}

export async function createEpisodeProfile(
  input: {
    orgId: string; name: string; outlineModel?: string; transcriptModel?: string;
    segmentCount?: number; languageCode?: string; defaultBriefing?: string; speakerProfileId: string;
  },
): Promise<EpisodeProfile> {
  const res = await fetch(`${base}/episode-profiles`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return (await asJson<{ profile: EpisodeProfile }>(res, 'createEpisodeProfile')).profile;
}

export async function deleteEpisodeProfile(id: string): Promise<void> {
  const res = await fetch(`${base}/episode-profiles/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  await asJson(res, 'deleteEpisodeProfile');
}

// ── Episodes ──────────────────────────────────────────────────────────────────

export async function listEpisodes(orgId: string): Promise<PodcastEpisode[]> {
  const res = await fetch(`${base}/episodes${q(orgId)}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ episodes: PodcastEpisode[] }>(res, 'listEpisodes')).episodes;
}

export async function getEpisode(id: string): Promise<PodcastEpisode> {
  const res = await fetch(`${base}/episodes/${encodeURIComponent(id)}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ episode: PodcastEpisode }>(res, 'getEpisode')).episode;
}

export async function createEpisode(
  input: { orgId: string; notebookId: string; episodeProfileId: string; title?: string; briefing?: string },
): Promise<PodcastEpisode> {
  const res = await fetch(`${base}/episodes`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return (await asJson<{ episode: PodcastEpisode }>(res, 'createEpisode')).episode;
}

export async function retryEpisode(id: string): Promise<PodcastEpisode> {
  const res = await fetch(`${base}/episodes/${encodeURIComponent(id)}/retry`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return (await asJson<{ episode: PodcastEpisode }>(res, 'retryEpisode')).episode;
}

export async function deleteEpisode(id: string): Promise<void> {
  const res = await fetch(`${base}/episodes/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  await asJson(res, 'deleteEpisode');
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

/** Notebooks the caller can generate an episode from (the podcast's source content).
 *  Re-uses the notebooks host-extension list endpoint; returns [] when that toggle
 *  is off so the Studio degrades to "no notebooks" rather than erroring. */
export async function listNotebooksForPodcasts(): Promise<Array<{ id: string; name: string }>> {
  try {
    const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/notebooks`, fetchOpts({ headers: authedHeaders() }));
    if (!res.ok) return [];
    return ((await res.json()) as { notebooks: Array<{ id: string; name: string }> }).notebooks ?? [];
  } catch {
    return [];
  }
}
