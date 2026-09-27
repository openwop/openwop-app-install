/**
 * Multi-speaker podcasts client (ADR 0086) — host-extension, non-normative. Wraps
 * /host/openwop-app/podcasts/*. 404s when the `podcasts` toggle is off. Mirrors
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
  // ── ADR 0390 public-distribution fields ──
  showId?: string;
  slug?: string;
  published?: boolean;
  publishedAt?: string;
  /** Publish metadata (mirrors backend; review F3 pre-fills the form from these). */
  descriptionOverride?: string;
  explicitOverride?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Org {
  orgId: string;
  name: string;
}

/** A subscribable podcast channel (ADR 0390). Mirrors backend PodcastShow. */
export interface PodcastShow {
  id: string;
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
  /** R2 PR2-4 — operator-entered directory listing URLs ("Listen on"). */
  appleUrl?: string;
  spotifyUrl?: string;
  amazonUrl?: string;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ShowInput {
  orgId: string;
  title: string;
  author: string;
  description?: string;
  languageCode?: string;
  imageMediaRef?: string;
  category?: string;
  subcategory?: string;
  explicit?: boolean;
  ownerName?: string;
  ownerEmail?: string;
  type?: 'episodic' | 'serial';
  appleUrl?: string;
  spotifyUrl?: string;
  amazonUrl?: string;
}

/** Make a backend-relative asset path (`/host/openwop-app/assets/<token>`)
 *  absolute against the API base, so a clip/episode plays in an `<audio>` element
 *  regardless of the SPA origin (mirrors media's `absoluteServeUrl`). */
export function assetUrl(url: string): string {
  return url.startsWith('http') ? url : `${config.baseUrl}${url}`;
}

const base = `${config.baseUrl}/host/openwop-app/podcasts`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    // R2 SP-10 — carry the status so a page can tell "not published" (404)
    // from "our server hiccuped" (anything else) instead of claiming a
    // publish-state fact over a transport failure.
    throw Object.assign(new Error(detail || `${ctx} returned ${res.status}`), { status: res.status });
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

export interface EpisodesList { episodes: PodcastEpisode[]; /** SP-9 — same predicate as the write routes. */ canWrite: boolean }
export async function listEpisodesWithCapability(orgId: string): Promise<EpisodesList> {
  const res = await fetch(`${base}/episodes${q(orgId)}`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ episodes: PodcastEpisode[]; canWrite?: boolean }>(res, 'listEpisodes');
  return { episodes: body.episodes, canWrite: body.canWrite !== false };
}
export async function listEpisodes(orgId: string): Promise<PodcastEpisode[]> {
  return (await listEpisodesWithCapability(orgId)).episodes;
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
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

// ── Shows (channels) + publish — ADR 0390 ─────────────────────────────────────

export interface ShowsList { shows: PodcastShow[]; /** SP-9 — from the SAME predicate the write routes enforce. */ canWrite: boolean }
export async function listShowsWithCapability(orgId: string): Promise<ShowsList> {
  const res = await fetch(`${base}/shows?orgId=${encodeURIComponent(orgId)}`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ shows: PodcastShow[]; canWrite?: boolean }>(res, 'listShows');
  // An older server omits canWrite: default TRUE so the actions stay rendered
  // and the server keeps enforcing — read-capability is a COURTESY layer; the
  // 403 remains the authority. Defaulting false would HIDE working actions.
  return { shows: body.shows, canWrite: body.canWrite !== false };
}
export async function listShows(orgId: string): Promise<PodcastShow[]> {
  return (await listShowsWithCapability(orgId)).shows;
}

export async function createShow(input: ShowInput): Promise<PodcastShow> {
  const res = await fetch(`${base}/shows`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return (await asJson<{ show: PodcastShow }>(res, 'createShow')).show;
}

export async function updateShow(id: string, patch: Partial<ShowInput>): Promise<PodcastShow> {
  const res = await fetch(`${base}/shows/${encodeURIComponent(id)}`, fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return (await asJson<{ show: PodcastShow }>(res, 'updateShow')).show;
}

export async function setShowPublished(id: string, published: boolean): Promise<PodcastShow> {
  const res = await fetch(`${base}/shows/${encodeURIComponent(id)}/${published ? 'publish' : 'unpublish'}`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return (await asJson<{ show: PodcastShow }>(res, 'setShowPublished')).show;
}

export async function deleteShow(id: string): Promise<void> {
  const res = await fetch(`${base}/shows/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  await asJson(res, 'deleteShow');
}

export async function setEpisodePublished(
  id: string,
  published: boolean,
  showId?: string,
  // R2 SP-1 — the publish route has accepted these since ADR 0390; the client
  // never sent them, so the public description and explicit override were
  // dead capabilities no operator could exercise. Review F3: `null` is an
  // explicit CLEAR (restore inheritance / drop the description).
  opts?: { descriptionOverride?: string | null; explicitOverride?: boolean | null },
): Promise<PodcastEpisode> {
  const path = `${base}/episodes/${encodeURIComponent(id)}/${published ? 'publish' : 'unpublish'}`;
  const res = await fetch(path, fetchOpts({
    method: 'POST', headers: jsonHeaders(),
    ...(published ? {
      body: JSON.stringify({
        showId,
        ...(opts?.descriptionOverride !== undefined ? { descriptionOverride: opts.descriptionOverride } : {}),
        ...(opts?.explicitOverride !== undefined ? { explicitOverride: opts.explicitOverride } : {}),
      }),
    } : {}),
  }));
  return (await asJson<{ episode: PodcastEpisode }>(res, 'setEpisodePublished')).episode;
}

/** The submittable iTunes feed URL for a show (paste into Apple Podcasts Connect
 *  / Spotify for Podcasters). Absolute against the API base. */
export function feedUrl(orgId: string, showSlug: string): string {
  return `${config.baseUrl}/host/openwop-app/public/${encodeURIComponent(orgId)}/podcasts/${encodeURIComponent(showSlug)}/feed.xml`;
}

// ── Public reads (unauthed) — the public show/episode pages ───────────────────

export interface PublicShow {
  slug: string; title: string; author: string; description: string; languageCode: string;
  imageMediaRef?: string; category?: string; subcategory?: string; explicit: boolean;
  type: 'episodic' | 'serial'; episodeCount: number; pageUrl?: string; feedUrl?: string;
  /** R2 PR2-4 — operator-entered directory pages ("Listen on"). */
  appleUrl?: string; spotifyUrl?: string; amazonUrl?: string;
}
export interface PublicEpisode {
  slug: string; title: string; description?: string; publishedAt: string;
  audioUrl: string; pageUrl: string; explicit: boolean;
  /** R2 PR2-1 — measured at publish; row furniture like every leader shows. */
  durationSeconds?: number;
  /** PODU-1 (ADR 0603 §4) — the WCAG 2.1 SC 1.2.1 text alternative. Present ONLY on
   *  the single-episode read (the show/index reads carry up to 20 episodes and a
   *  transcript is unbounded model prose). Absent = this episode has none (an
   *  INGESTED episode legitimately does not) — a state the page must state, not hide. */
  transcript?: string;
  transcriptTruncated?: boolean;
}

const pub = (orgId: string): string => `${config.baseUrl}/host/openwop-app/public/${encodeURIComponent(orgId)}/podcasts`;

export async function getPublicShows(orgId: string): Promise<PublicShow[]> {
  const res = await fetch(`${pub(orgId)}`, fetchOpts({}));
  const shows = (await asJson<{ shows: PublicShow[] }>(res, 'getPublicShows')).shows;
  return Array.isArray(shows) ? shows : []; // guard a wire drift (pricing-'*' class)
}

export async function getPublicShow(orgId: string, showSlug: string): Promise<{ show: PublicShow; episodes: PublicEpisode[] }> {
  const res = await fetch(`${pub(orgId)}/${encodeURIComponent(showSlug)}`, fetchOpts({}));
  const out = await asJson<{ show: PublicShow; episodes: PublicEpisode[] }>(res, 'getPublicShow');
  return { ...out, episodes: Array.isArray(out.episodes) ? out.episodes : [] };
}

export async function getPublicEpisode(orgId: string, showSlug: string, episodeSlug: string): Promise<{ show: { slug: string; title: string; author: string }; episode: PublicEpisode }> {
  const res = await fetch(`${pub(orgId)}/${encodeURIComponent(showSlug)}/${encodeURIComponent(episodeSlug)}`, fetchOpts({}));
  return await asJson<{ show: { slug: string; title: string; author: string }; episode: PublicEpisode }>(res, 'getPublicEpisode');
}

/**
 * Notebooks the caller can generate an episode from (the podcast's source content).
 * Re-uses the notebooks host-extension list endpoint.
 *
 * R2 SP-3 established the first half: every failure THROWS, because the old
 * swallow-everything shape rendered "No notebooks found — create a research notebook
 * first" over a 500 (an INSTRUCTIVE empty state on a failed read).
 *
 * `PODU-8` (ADR 0603 §7) is the OTHER half, and its own test had PINNED it. SP-3
 * mapped 404 — the notebooks feature being switched OFF, so its routes do not exist —
 * onto the same bare `[]` as "this org has no notebooks yet". Same array, two
 * completely different situations, and the Studio told a user whose administrator has
 * disabled notebooks to go and create one. They cannot: there is no notebooks surface
 * to create it on.
 *
 * So the two are now DISTINGUISHED at the boundary that knows the difference, and the
 * caller renders them differently. Not a throw: a switched-off feature is not a failed
 * read either, and routing it into the failed-read card would be the same conflation
 * one step over.
 */
export async function listNotebooksForPodcasts(): Promise<{ notebooks: Array<{ id: string; name: string }>; featureUnavailable: boolean }> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/notebooks`, fetchOpts({ headers: authedHeaders() }));
  if (res.status === 404) return { notebooks: [], featureUnavailable: true };
  if (!res.ok) throw Object.assign(new Error(`listNotebooks returned ${res.status}`), { status: res.status });
  const body = (await res.json()) as { notebooks?: Array<{ id: string; name: string }> };
  return { notebooks: body.notebooks ?? [], featureUnavailable: false };
}
