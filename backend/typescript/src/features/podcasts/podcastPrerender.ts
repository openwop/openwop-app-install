/**
 * Crawler prerender for the public podcast pages (ADR 0390 Phase 3). Podcast
 * pages are NOT CMS pages, so they cannot ride publishing's `prerenderPage`
 * (which projects a `Page`'s sections). This composes the SAME public
 * projections the JSON reads use (`getPublishedShowBySlug` / `listPublishedEpisodes`
 * / `getPublishedEpisode`) into semantic HTML + inline `<head>` + JSON-LD
 * (`PodcastSeries` for a show page, `PodcastEpisode` for an episode page —
 * schema.org, honest fields only), reusing publishing's `escapeHtml` +
 * `buildHtmlDocument` head/meta builder (ADR 0012 cross-feature-composition
 * precedent — publishing already composes CMS + billing + commerce).
 *
 * Honest-off / uniform-404: an unpublished / unknown show or episode returns
 * null → the route 404s, exactly like the JSON reads (no existence leak).
 *
 * @see docs/adr/0390-podcast-public-distribution.md
 */

import { escapeHtml } from '../publishing/sectionHtml.js';
import { vendorPublicBase } from '../featureRoute.js';
import { buildHtmlDocument, type HeadInput } from '../publishing/prerenderService.js';
import {
  getPublishedShowBySlug, listPublishedEpisodes, getPublishedEpisode, episodeSlugOf, getPublicEpisodeTranscript,
  type PodcastShow, type PodcastEpisode,
} from './podcastsService.js';

export interface PodcastPrerenderResult {
  html: string;
  languageCode: string;
}

// ── absolute URL helpers (mirror publicRoutes — human page + feed + audio) ─────
const enc = encodeURIComponent;
function showPageUrl(baseUrl: string, orgId: string, showSlug: string): string {
  return `${baseUrl}/pod/${enc(orgId)}/${enc(showSlug)}`;
}
function episodePageUrl(baseUrl: string, orgId: string, showSlug: string, episodeSlug: string): string {
  return `${baseUrl}/pod/${enc(orgId)}/${enc(showSlug)}/${enc(episodeSlug)}`;
}
function feedUrl(baseUrl: string, orgId: string, showSlug: string): string {
  return `${vendorPublicBase(baseUrl)}/public/${enc(orgId)}/podcasts/${enc(showSlug)}/feed.xml`;
}
function audioUrl(baseUrl: string, orgId: string, episodeId: string): string {
  return `${vendorPublicBase(baseUrl)}/public/${enc(orgId)}/podcasts/episodes/${enc(episodeId)}/audio`;
}
function imageUrl(baseUrl: string, ref: string): string {
  // `imageMediaRef` is a root-relative asset path; a bare token is unexpected but
  // tolerated (rendered relative to the base) — never fabricated.
  return ref.startsWith('http') ? ref : `${baseUrl}${ref}`;
}

const episodeDescription = (e: PodcastEpisode): string => e.descriptionOverride ?? '';
const publishedAt = (e: PodcastEpisode): string => e.publishedAt ?? e.createdAt;

/** A bounded meta description from a show's own description (never invented). */
function clip(text: string, max = 300): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ── show page ─────────────────────────────────────────────────────────────────

export async function renderShowPrerender(
  tenantId: string,
  orgId: string,
  showSlug: string,
  baseUrl: string,
): Promise<PodcastPrerenderResult | null> {
  const show = await getPublishedShowBySlug(tenantId, orgId, showSlug);
  if (!show) return null;
  const episodes = await listPublishedEpisodes(tenantId, show.id);
  const canonical = showPageUrl(baseUrl, orgId, show.slug);

  const itemsHtml = episodes.map((e) => {
    const slug = episodeSlugOf(e);
    const link = episodePageUrl(baseUrl, orgId, show.slug, slug);
    const desc = episodeDescription(e);
    return `<li><article>`
      + `<h3><a href="${escapeHtml(link)}">${escapeHtml(e.title)}</a></h3>`
      + `<p><time datetime="${escapeHtml(publishedAt(e))}">${escapeHtml(publishedAt(e))}</time></p>`
      + (desc ? `<p>${escapeHtml(clip(desc))}</p>` : '')
      + `</article></li>`;
  }).join('\n');

  const body = `<main>
<header>
<h1>${escapeHtml(show.title)}</h1>
<p>${escapeHtml(show.author)}</p>
${show.description ? `<p>${escapeHtml(show.description)}</p>` : ''}
<p><a href="${escapeHtml(feedUrl(baseUrl, orgId, show.slug))}">RSS feed</a></p>
</header>
<section>
<h2>Episodes</h2>
<ol>
${itemsHtml}
</ol>
</section>
</main>`;

  const head: HeadInput = {
    seo: {
      title: show.title,
      description: clip(show.description || show.title),
      canonicalUrl: canonical,
      ogTitle: show.title,
      ogDescription: clip(show.description || show.title),
      noindex: false,
      ...(show.imageMediaRef ? { ogImageUrl: imageUrl(baseUrl, show.imageMediaRef) } : {}),
    },
    locale: show.languageCode || 'en',
    siteName: show.author,
    jsonLd: [podcastSeriesJsonLd(show, canonical, baseUrl, orgId)],
  };
  return { html: buildHtmlDocument(head, body), languageCode: show.languageCode || 'en' };
}

// ── episode page ──────────────────────────────────────────────────────────────

export async function renderEpisodePrerender(
  tenantId: string,
  orgId: string,
  showSlug: string,
  episodeSlug: string,
  baseUrl: string,
): Promise<PodcastPrerenderResult | null> {
  const hit = await getPublishedEpisode(tenantId, orgId, showSlug, episodeSlug);
  if (!hit) return null;
  const { show, episode } = hit;
  const slug = episodeSlugOf(episode);
  const canonical = episodePageUrl(baseUrl, orgId, show.slug, slug);
  const showUrl = showPageUrl(baseUrl, orgId, show.slug);
  const audio = audioUrl(baseUrl, orgId, episode.id);
  const desc = episodeDescription(episode);

  // PODU-1 (ADR 0603 §4) — the transcript rides the PRERENDER too. This document is
  // what a bot, a reader-mode client, and any no-JS visitor actually receive, so a
  // text alternative that existed only in the React tree would be missing for exactly
  // the consumers least able to play audio. Bounded by `getPublicEpisodeTranscript`;
  // paragraph-split, escaped, and stated honestly when absent.
  const transcript = await getPublicEpisodeTranscript(tenantId, episode);
  const transcriptHtml = transcript
    ? `<section>
<h2>Transcript</h2>
${transcript.truncated ? '<p><strong>This transcript is long and is shown in part.</strong></p>' : ''}
${transcript.text.split(/\n{2,}/).map((para) => `<p>${escapeHtml(para)}</p>`).join('\n')}
</section>`
    : `<section>
<h2>Transcript</h2>
<p>No transcript is available for this episode.</p>
</section>`;

  const body = `<main>
<article>
<header>
<h1>${escapeHtml(episode.title)}</h1>
<p>${escapeHtml(show.author)} · <a href="${escapeHtml(showUrl)}">${escapeHtml(show.title)}</a></p>
<p><time datetime="${escapeHtml(publishedAt(episode))}">${escapeHtml(publishedAt(episode))}</time></p>
</header>
${desc ? `<p>${escapeHtml(desc)}</p>` : ''}
<p><a href="${escapeHtml(audio)}">Listen (audio)</a></p>
${transcriptHtml}
</article>
</main>`;

  const head: HeadInput = {
    seo: {
      title: `${episode.title} — ${show.title}`,
      description: clip(desc || episode.title),
      canonicalUrl: canonical,
      ogTitle: episode.title,
      ogDescription: clip(desc || episode.title),
      noindex: false,
      ...(show.imageMediaRef ? { ogImageUrl: imageUrl(baseUrl, show.imageMediaRef) } : {}),
    },
    locale: show.languageCode || 'en',
    siteName: show.author,
    jsonLd: [podcastEpisodeJsonLd(show, episode, canonical, showUrl, audio)],
  };
  return { html: buildHtmlDocument(head, body), languageCode: show.languageCode || 'en' };
}

// ── JSON-LD (schema.org, honest fields only) ──────────────────────────────────

function podcastSeriesJsonLd(show: PodcastShow, canonical: string, baseUrl: string, orgId: string): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'PodcastSeries',
    name: show.title,
    url: canonical,
    inLanguage: show.languageCode || 'en',
    author: { '@type': 'Person', name: show.author },
    webFeed: feedUrl(baseUrl, orgId, show.slug),
    ...(show.description ? { description: show.description } : {}),
    ...(show.imageMediaRef ? { image: imageUrl(baseUrl, show.imageMediaRef) } : {}),
  };
}

function podcastEpisodeJsonLd(show: PodcastShow, episode: PodcastEpisode, canonical: string, showUrl: string, audio: string): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'PodcastEpisode',
    name: episode.title,
    url: canonical,
    datePublished: publishedAt(episode),
    inLanguage: show.languageCode || 'en',
    associatedMedia: { '@type': 'MediaObject', contentUrl: audio },
    partOfSeries: { '@type': 'PodcastSeries', name: show.title, url: showUrl },
    ...(episodeDescription(episode) ? { description: episodeDescription(episode) } : {}),
  };
}
