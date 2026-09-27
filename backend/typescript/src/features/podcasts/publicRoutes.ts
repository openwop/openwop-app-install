/**
 * Public podcast distribution surface (ADR 0390) — unauthed reads under the
 * ALREADY-allowlisted `/v1/host/openwop-app/public/:orgId/podcasts/*` prefix
 * (`PUBLIC_PATH_PREFIXES`, added by ADR 0012 — NO new allowlist entry, NO core
 * auth edit). Tenant is ALWAYS derived from the `:orgId` resource via `getOrg`,
 * never from the request. Every route is gated on the org-tenant's `podcasts`
 * toggle PLUS the editorial `published` flag on the show + episode, and 404s
 * UNIFORMLY on any miss (feature off / unpublished / unknown / wrong-org) — no
 * existence leak.
 *
 *   GET  …/public/:orgId/podcasts                          published show index (JSON)
 *   GET  …/public/:orgId/podcasts/:showSlug                one show + its episodes (JSON)
 *   GET  …/public/:orgId/podcasts/:showSlug/:episodeSlug   one episode (JSON)
 *   GET  …/public/:orgId/podcasts/:showSlug/feed.xml       the iTunes RSS 2.0 feed
 *   GET  …/public/:orgId/podcasts/episodes/:episodeId/audio  Range-capable audio enclosure
 *
 * The audio route is a NEW public, Range-capable route (the existing token asset
 * route `/assets/:token` is `private`-cached and has no Range — routes/
 * mediaAssets.ts — left untouched). It streams a published episode's
 * `audioMediaRef` bytes with `public` cache + HTTP Range/HEAD, rate-limited by
 * the existing per-IP read budget.
 *
 * @see docs/adr/0390-podcast-public-distribution.md
 */

import type { Request, Response } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { createLogger } from '../../observability/logger.js';
import { throttleLog } from '../../observability/logSampler.js';
import { publicBaseUrl } from '../featureRoute.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getOrg } from '../../host/accessControlService.js';
import { resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import {
  listPublishedShows, getPublishedShowBySlug, listPublishedEpisodes, ensureShowGuid,
  getPublishedEpisode, getPublishedEpisodeById, episodeSlugOf, getPublicEpisodeTranscript,
  type PodcastShow, type PodcastEpisode,
} from './podcastsService.js';
import { buildPodcastFeed, type FeedItemInput } from './podcastFeed.js';
import { getOrDecodeAudio } from './audioCache.js';
import { renderShowPrerender, renderEpisodePrerender } from './podcastPrerender.js';
import { prerenderDisabled, prerenderTtlSeconds } from '../publishing/prerenderService.js';
import { vendorPublicBase } from '../featureRoute.js';

const log = createLogger('features.podcasts.public');

const TOGGLE_ID = 'podcasts';

/** Resolve `:orgId` → its tenant, but only when the org-tenant has `podcasts`
 *  ON. Returns null (→ uniform 404) for an unknown org or a disabled toggle. The
 *  public visitor's own tenant is irrelevant — the gate is the RESOURCE org's. */
async function resolvePublicOrg(orgId: string): Promise<{ tenantId: string } | null> {
  const org = await getOrg(orgId);
  if (!org) return null;
  const assignment = await resolveOne(TOGGLE_ID, { tenantId: org.tenantId });
  if (!assignment || !assignment.enabled) return null;
  return { tenantId: org.tenantId };
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found', message: 'Not found.' });
}

/** Absolute audio enclosure URL for an episode (the Range-capable route). */
function audioUrl(baseUrl: string, orgId: string, episodeId: string): string {
  return `${vendorPublicBase(baseUrl)}/public/${encodeURIComponent(orgId)}/podcasts/episodes/${encodeURIComponent(episodeId)}/audio`;
}

/** Absolute human-facing web URLs (the SPA public podcast pages). */
function showPageUrl(baseUrl: string, orgId: string, showSlug: string): string {
  return `${baseUrl}/pod/${encodeURIComponent(orgId)}/${encodeURIComponent(showSlug)}`;
}
function episodePageUrl(baseUrl: string, orgId: string, showSlug: string, episodeSlug: string): string {
  return `${baseUrl}/pod/${encodeURIComponent(orgId)}/${encodeURIComponent(showSlug)}/${encodeURIComponent(episodeSlug)}`;
}

/** The public JSON projection of a show (no tenant/internal fields leaked). */
function projectShow(show: PodcastShow, episodeCount: number): Record<string, unknown> {
  return {
    slug: show.slug,
    title: show.title,
    author: show.author,
    description: show.description,
    languageCode: show.languageCode,
    ...(show.imageMediaRef ? { imageMediaRef: show.imageMediaRef } : {}),
    ...(show.category ? { category: show.category } : {}),
    ...(show.subcategory ? { subcategory: show.subcategory } : {}),
    explicit: show.explicit,
    type: show.type,
    episodeCount,
    // R2 PR2-4 — operator-entered directory pages, for the "Listen on" row.
    ...(show.appleUrl ? { appleUrl: show.appleUrl } : {}),
    ...(show.spotifyUrl ? { spotifyUrl: show.spotifyUrl } : {}),
    ...(show.amazonUrl ? { amazonUrl: show.amazonUrl } : {}),
  };
}

/** The public JSON projection of an episode. R2 SP-1: `explicit` INHERITS the
 *  show's flag when no per-episode override exists — `?? false` made the
 *  directory-required marker read false for every episode of an explicit show
 *  (the feed always had the inheritance; the JSON lied). */
function projectEpisode(episode: PodcastEpisode, orgId: string, showSlug: string, baseUrl: string, showExplicit: boolean): Record<string, unknown> {
  const slug = episodeSlugOf(episode);
  return {
    slug,
    title: episode.title,
    ...(episode.descriptionOverride ? { description: episode.descriptionOverride } : {}),
    publishedAt: episode.publishedAt ?? episode.createdAt,
    audioUrl: audioUrl(baseUrl, orgId, episode.id),
    pageUrl: episodePageUrl(baseUrl, orgId, showSlug, slug),
    explicit: episode.explicitOverride ?? showExplicit,
    ...(episode.durationSeconds ? { durationSeconds: episode.durationSeconds } : {}),
  };
}

/** Parse a single-range `Range: bytes=start-end` header against a known size.
 *  Returns the inclusive [start, end], `null` for no/invalid range (→ full 200),
 *  or `'unsatisfiable'` (→ 416). Multi-range is treated as no-range (serve full),
 *  the conservative choice a podcast client tolerates. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  if (startStr === '' && endStr === '') return null;
  let start: number;
  let end: number;
  if (startStr === '') {
    // suffix range: last N bytes
    const n = Number(endStr);
    if (n <= 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? size - 1 : Number(endStr);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

export function registerPublicPodcastRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const PUB = '/v1/host/openwop-app/public/:orgId/podcasts';

  // ── Show index (JSON) ──
  app.get(PUB, async (req, res, next) => {
    try {
      const ctx = await resolvePublicOrg(req.params.orgId);
      if (!ctx) return notFound(res);
      const baseUrl = publicBaseUrl(req);
      const shows = await listPublishedShows(ctx.tenantId, req.params.orgId);
      const out = await Promise.all(shows.map(async (s) => {
        const eps = await listPublishedEpisodes(ctx.tenantId, s.id);
        return { ...projectShow(s, eps.length), pageUrl: showPageUrl(baseUrl, req.params.orgId, s.slug) };
      }));
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ shows: out });
    } catch (err) { next(err); }
  });

  // ── One show + its published episodes (JSON) ──
  app.get(`${PUB}/:showSlug`, async (req, res, next) => {
    try {
      const ctx = await resolvePublicOrg(req.params.orgId);
      if (!ctx) return notFound(res);
      const show = await getPublishedShowBySlug(ctx.tenantId, req.params.orgId, req.params.showSlug);
      if (!show) return notFound(res);
      const baseUrl = publicBaseUrl(req);
      const eps = await listPublishedEpisodes(ctx.tenantId, show.id);
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({
        show: { ...projectShow(show, eps.length), pageUrl: showPageUrl(baseUrl, req.params.orgId, show.slug), feedUrl: `${vendorPublicBase(baseUrl)}/public/${encodeURIComponent(req.params.orgId)}/podcasts/${encodeURIComponent(show.slug)}/feed.xml` },
        episodes: eps.map((e) => projectEpisode(e, req.params.orgId, show.slug, baseUrl, show.explicit)),
      });
    } catch (err) { next(err); }
  });

  // ── iTunes RSS feed (feed.xml) ── (registered before /:episodeSlug via the
  //    literal segment; Express still needs the explicit route to win, so we key
  //    the episode route to a non-`feed.xml` slug below.)
  app.get(`${PUB}/:showSlug/feed.xml`, async (req, res, next) => {
    try {
      const ctx = await resolvePublicOrg(req.params.orgId);
      if (!ctx) return notFound(res);
      const show = await getPublishedShowBySlug(ctx.tenantId, req.params.orgId, req.params.showSlug);
      if (!show) return notFound(res);
      const baseUrl = publicBaseUrl(req);
      const eps = await listPublishedEpisodes(ctx.tenantId, show.id);
      const items: FeedItemInput[] = [];
      for (const e of eps) {
        const meta = await resolveEpisodeAudio(ctx.tenantId, e);
        if (!meta) continue; // no resolvable audio → not a valid enclosure; skip
        items.push({
          episode: e,
          audioUrl: audioUrl(baseUrl, req.params.orgId, e.id),
          sizeBytes: meta.bytes,
          contentType: meta.contentType,
          link: episodePageUrl(baseUrl, req.params.orgId, show.slug, episodeSlugOf(e)),
          // R2 PR2-1 — measured at publish; `itunes:duration` finally has a caller.
          ...(e.durationSeconds ? { durationSeconds: e.durationSeconds } : {}),
        });
      }
      const selfUrl = `${vendorPublicBase(baseUrl)}/public/${encodeURIComponent(req.params.orgId)}/podcasts/${encodeURIComponent(show.slug)}/feed.xml`;
      // R3 XP-R2-4 — mint-once on first render, persisted thereafter.
      const guid = await ensureShowGuid(ctx.tenantId, show.id, selfUrl);
      const xml = buildPodcastFeed({
        show,
        items,
        selfUrl,
        ...(guid ? { guid } : {}),
        channelLink: showPageUrl(baseUrl, req.params.orgId, show.slug),
        ...(show.imageMediaRef ? { imageUrl: `${baseUrl}${show.imageMediaRef}` } : {}),
      });
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.type('application/rss+xml').send(xml);
    } catch (err) { next(err); }
  });

  // ── Crawler prerender (ADR 0390 P3) — semantic HTML + head + JSON-LD for the
  //    show + episode pages (PodcastSeries / PodcastEpisode). Registered BEFORE
  //    the `/:showSlug/:episodeSlug` JSON route so the literal `prerender`
  //    segment wins. Same cache/Vary/kill-switch posture as the ADR 0384
  //    prerender route (customDomain.ts rewrites `/pod/*` on a bound host here).
  const sendPrerender = (res: Response, isHead: boolean, html: string | null, languageCode: string): void => {
    if (html === null) { notFound(res); return; }
    res.setHeader('Content-Language', languageCode);
    res.setHeader('Vary', 'Accept-Language, Accept-Encoding');
    res.setHeader('Cache-Control', `public, max-age=${prerenderTtlSeconds()}`);
    res.type('html');
    if (isHead) { res.end(); return; }
    res.send(html);
  };

  const showPrerenderHandler = async (req: Request, res: Response, isHead: boolean): Promise<void> => {
    if (prerenderDisabled()) { notFound(res); return; }
    const ctx = await resolvePublicOrg(req.params.orgId);
    if (!ctx) { notFound(res); return; }
    const out = await renderShowPrerender(ctx.tenantId, req.params.orgId, req.params.showSlug, publicBaseUrl(req));
    sendPrerender(res, isHead, out?.html ?? null, out?.languageCode ?? 'en');
  };
  const episodePrerenderHandler = async (req: Request, res: Response, isHead: boolean): Promise<void> => {
    if (prerenderDisabled()) { notFound(res); return; }
    const ctx = await resolvePublicOrg(req.params.orgId);
    if (!ctx) { notFound(res); return; }
    const out = await renderEpisodePrerender(ctx.tenantId, req.params.orgId, req.params.showSlug, req.params.episodeSlug, publicBaseUrl(req));
    sendPrerender(res, isHead, out?.html ?? null, out?.languageCode ?? 'en');
  };

  app.get(`${PUB}/:showSlug/prerender`, async (req, res, next) => {
    try { await showPrerenderHandler(req, res, false); } catch (err) { next(err); }
  });
  app.head(`${PUB}/:showSlug/prerender`, async (req, res, next) => {
    try { await showPrerenderHandler(req, res, true); } catch (err) { next(err); }
  });
  app.get(`${PUB}/:showSlug/prerender/:episodeSlug`, async (req, res, next) => {
    try { await episodePrerenderHandler(req, res, false); } catch (err) { next(err); }
  });
  app.head(`${PUB}/:showSlug/prerender/:episodeSlug`, async (req, res, next) => {
    try { await episodePrerenderHandler(req, res, true); } catch (err) { next(err); }
  });

  // ── One episode (JSON) ──
  app.get(`${PUB}/:showSlug/:episodeSlug`, async (req, res, next) => {
    try {
      if (req.params.episodeSlug === 'feed.xml' || req.params.episodeSlug === 'prerender') return notFound(res); // handled above
      const ctx = await resolvePublicOrg(req.params.orgId);
      if (!ctx) return notFound(res);
      const hit = await getPublishedEpisode(ctx.tenantId, req.params.orgId, req.params.showSlug, req.params.episodeSlug);
      if (!hit) return notFound(res);
      const baseUrl = publicBaseUrl(req);
      res.setHeader('Cache-Control', 'public, max-age=300');
      // PODU-1 (ADR 0603 §4) — the transcript RIDES THE SINGLE-EPISODE ROUTE ONLY.
      // WCAG 2.1 SC 1.2.1 (Level A) requires a text alternative for prerecorded
      // audio-only content, and the episode page shipped a bare `<audio>`.
      //
      // R2 SP-8 was RIGHT that `transcriptDocRef` must not ride the public wire —
      // it references an AUTHED (ADR 0053) document a public consumer cannot fetch,
      // so the ref leaked an internal id and bought nothing. The projection SP-8
      // itself named as the fix is this: the CONTENT, resolved server-side, bounded.
      // It is deliberately NOT on the show/index routes — those list up to 20
      // episodes and a transcript is unbounded model prose.
      const transcript = await getPublicEpisodeTranscript(ctx.tenantId, hit.episode);
      res.json({
        show: { slug: hit.show.slug, title: hit.show.title, author: hit.show.author },
        episode: {
          ...projectEpisode(hit.episode, req.params.orgId, hit.show.slug, baseUrl, hit.show.explicit),
          ...(transcript ? { transcript: transcript.text, transcriptTruncated: transcript.truncated } : {}),
        },
      });
    } catch (err) { next(err); }
  });

  // ── Range-capable audio enclosure ──
  // Rate-limited serve log (PODCAST-2): a bounded outcome key set + suppressed
  // count, so this bandwidth-heavy public route stays observable (status split +
  // bytes served) without one line per Range request.
  const logAudio = (outcome: '200' | '206' | '416' | 'head', size: number, bytesServed: number): void => {
    const t = throttleLog(`podcast_audio_${outcome}`);
    if (t.emit) log.info('podcast_audio_serve', { outcome, size, bytesServed, suppressed: t.suppressed });
  };

  const audioHandler = async (req: Request, res: Response, isHead: boolean): Promise<void> => {
    const ctx = await resolvePublicOrg(req.params.orgId);
    if (!ctx) { notFound(res); return; }
    const hit = await getPublishedEpisodeById(ctx.tenantId, req.params.orgId, req.params.episodeId);
    if (!hit) { notFound(res); return; }

    // HEAD needs only size + content-type — resolve METADATA and never decode the
    // (up to 256MB) audio into memory (PODCAST-1a). GET serves the decoded bytes
    // through the byte-budgeted decode-once LRU (PODCAST-1): a cache hit skips
    // both the base64 store load and the decode; a miss decodes behind the
    // concurrency semaphore. The stored `bytes` and the decoded `buffer.length`
    // are the same value.
    const token = audioTokenOf(hit.episode);
    if (!token) { notFound(res); return; }
    let size: number;
    let contentType: string;
    let buffer: Buffer | null = null;
    if (isHead) {
      const m = await resolveEpisodeAudio(ctx.tenantId, hit.episode);
      if (!m) { notFound(res); return; }
      size = m.bytes; contentType = m.contentType;
    } else {
      const m = await getOrDecodeAudio(token, ctx.tenantId, () => decodeAudioByToken(token, ctx.tenantId));
      if (!m) { notFound(res); return; }
      buffer = m.buffer; size = m.buffer.length; contentType = m.contentType;
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${size}`);
      logAudio('416', size, 0);
      res.status(416).end();
      return;
    }
    if (range === null) {
      res.setHeader('Content-Length', String(size));
      res.status(200);
      logAudio(isHead ? 'head' : '200', size, isHead ? 0 : size);
      if (isHead || !buffer) { res.end(); return; }
      res.end(buffer);
      return;
    }
    const chunkLen = range.end - range.start + 1;
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Content-Length', String(chunkLen));
    res.status(206);
    logAudio(isHead ? 'head' : '206', size, isHead ? 0 : chunkLen);
    if (isHead || !buffer) { res.end(); return; }
    res.end(buffer.subarray(range.start, range.end + 1));
  };

  app.get(`${PUB}/episodes/:episodeId/audio`, async (req, res, next) => {
    try { await audioHandler(req, res, false); } catch (err) { next(err); }
  });
  app.head(`${PUB}/episodes/:episodeId/audio`, async (req, res, next) => {
    try { await audioHandler(req, res, true); } catch (err) { next(err); }
  });

  log.info('public podcast routes registered (/v1/host/openwop-app/public/:orgId/podcasts/*)');
}

/** The opaque Media-asset token an episode's audio enclosure points at. */
function audioTokenOf(episode: PodcastEpisode): string | undefined {
  return episode.audioMediaRef?.split('/').pop() || undefined;
}

/** Resolve an episode's audio Media asset → its byte length + content type (for
 *  the enclosure + the HEAD path), tenant-checked. Null when the ref is
 *  missing/expired or the bytes belong to another tenant (bytes never cross
 *  tenants). Metadata only — never decodes the (up to 256MB) buffer. */
async function resolveEpisodeAudio(
  tenantId: string,
  episode: PodcastEpisode,
): Promise<{ bytes: number; contentType: string } | null> {
  const token = audioTokenOf(episode);
  if (!token) return null;
  const asset = await resolveMediaAsset(token);
  if (!asset || asset.tenantId !== tenantId) return null;
  return { bytes: asset.bytes, contentType: asset.contentType || 'audio/mpeg' };
}

/** The DECODE step for the audio LRU: resolve + tenant-check + `Buffer.from`.
 *  Called only on a cold cache, behind the decode-concurrency semaphore. */
async function decodeAudioByToken(token: string, tenantId: string): Promise<{ buffer: Buffer; contentType: string; tenantId: string } | null> {
  const asset = await resolveMediaAsset(token);
  if (!asset || asset.tenantId !== tenantId) return null;
  return { buffer: Buffer.from(asset.contentBase64, 'base64'), contentType: asset.contentType || 'audio/mpeg', tenantId: asset.tenantId };
}
