/**
 * iTunes-namespaced podcast RSS 2.0 generator (ADR 0390) — a SECOND, podcast-
 * specific feed generator, deliberately NOT composing `publishingService.feedRss`
 * (that emits a CMS page feed: a `<link>`-per-page channel with no `xmlns:itunes`
 * and no `<enclosure>`). A podcast feed's defining elements are the audio
 * `<enclosure>` (URL + byte length + MIME type) and the iTunes channel tags, so
 * this ships its own builder while reusing the proven `escapeXml` + item-cap
 * PATTERNS from publishing (hand-rolled, zero-dep, XML-escaped).
 *
 * The generator is PURE string-building over already-resolved inputs — the route
 * does the async Media/byte resolution and passes each item's enclosure metadata
 * (length/type) in. `<guid isPermaLink="false">` is the immutable episode id (the
 * Apple/Spotify dedup key), so re-publishing or moving the audio URL never
 * duplicates an item in a subscriber's client.
 *
 * @see docs/adr/0390-podcast-public-distribution.md
 */

import { escapeXml } from '../../host/boundedStrings.js';
import type { PodcastShow, PodcastEpisode } from './podcastsService.js';

const ITUNES_NS = 'http://www.itunes.com/dtds/podcast-1.0.dtd';
const PODCAST_NS = 'https://podcastindex.org/namespace/1.0';

/** Per-item enclosure facts the route resolved from the episode's Media asset. */
export interface FeedItemInput {
  episode: PodcastEpisode;
  /** Absolute audio enclosure URL (the Range-capable public route). */
  audioUrl: string;
  /** Exact byte length of the audio asset (Apple requires a non-zero length). */
  sizeBytes: number;
  /** Enclosure MIME type (`audio/mpeg`, …). */
  contentType: string;
  /** Absolute human-facing episode page URL (`<link>`). */
  link: string;
  /** Best-effort duration in whole seconds (`<itunes:duration>`), if known. */
  durationSeconds?: number;
}

export interface FeedInput {
  show: PodcastShow;
  items: FeedItemInput[];
  /** Absolute self URL of this feed (the submittable `feed.xml`). */
  selfUrl: string;
  /** Absolute human-facing show page URL (channel `<link>`). */
  channelLink: string;
  /** Absolute channel artwork URL, if the show has `imageMediaRef`. */
  imageUrl?: string;
  /** Persisted Podcasting 2.0 channel GUID (`<podcast:guid>`), when minted. */
  guid?: string;
}

/** Max items emitted per feed (the publishing URL-cap pattern — bounds feed size
 *  against an unbounded back-catalogue). */
const MAX_FEED_ITEMS = 300;

const yesNo = (b: boolean): string => (b ? 'yes' : 'no');

/** hh:mm:ss (or mm:ss) — the `<itunes:duration>` form Apple accepts. */
function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

function channelHead(input: FeedInput): string {
  const { show } = input;
  const lines: string[] = [
    `    <title>${escapeXml(show.title)}</title>`,
    `    <link>${escapeXml(input.channelLink)}</link>`,
    `    <language>${escapeXml(show.languageCode || 'en')}</language>`,
    `    <description>${escapeXml(show.description)}</description>`,
    `    <itunes:author>${escapeXml(show.author)}</itunes:author>`,
    `    <itunes:explicit>${yesNo(show.explicit)}</itunes:explicit>`,
    `    <itunes:type>${escapeXml(show.type)}</itunes:type>`,
  ];
  if (input.imageUrl) lines.push(`    <itunes:image href="${escapeXml(input.imageUrl)}"/>`);
  if (show.category) {
    lines.push(
      show.subcategory
        ? `    <itunes:category text="${escapeXml(show.category)}"><itunes:category text="${escapeXml(show.subcategory)}"/></itunes:category>`
        : `    <itunes:category text="${escapeXml(show.category)}"/>`,
    );
  }
  if (show.ownerName || show.ownerEmail) {
    lines.push(
      `    <itunes:owner>${show.ownerName ? `<itunes:name>${escapeXml(show.ownerName)}</itunes:name>` : ''}${show.ownerEmail ? `<itunes:email>${escapeXml(show.ownerEmail)}</itunes:email>` : ''}</itunes:owner>`,
    );
  }
  // R3 XP-R2-4 — the tag only renders when the mint-once value EXISTS; the
  // namespace is declared unconditionally (below) so validators see it either way.
  if (input.guid) lines.push(`    <podcast:guid>${escapeXml(input.guid)}</podcast:guid>`);
  lines.push(`    <atom:link href="${escapeXml(input.selfUrl)}" rel="self" type="application/rss+xml"/>`);
  return lines.join('\n');
}

function itemXml(it: FeedItemInput): string {
  const { episode } = it;
  const explicit = episode.explicitOverride;
  const description = episode.descriptionOverride ?? episode.title;
  const pubDate = new Date(episode.publishedAt ?? episode.createdAt).toUTCString();
  const lines: string[] = [
    '    <item>',
    `      <title>${escapeXml(episode.title)}</title>`,
    `      <guid isPermaLink="false">${escapeXml(episode.id)}</guid>`,
    `      <link>${escapeXml(it.link)}</link>`,
    `      <pubDate>${escapeXml(pubDate)}</pubDate>`,
    `      <enclosure url="${escapeXml(it.audioUrl)}" length="${it.sizeBytes}" type="${escapeXml(it.contentType)}"/>`,
  ];
  if (typeof it.durationSeconds === 'number' && it.durationSeconds > 0) {
    lines.push(`      <itunes:duration>${escapeXml(formatDuration(it.durationSeconds))}</itunes:duration>`);
  }
  if (typeof explicit === 'boolean') lines.push(`      <itunes:explicit>${yesNo(explicit)}</itunes:explicit>`);
  lines.push(`      <description>${escapeXml(description)}</description>`);
  lines.push('    </item>');
  return lines.join('\n');
}

/** Build the complete iTunes RSS document for one show. */
export function buildPodcastFeed(input: FeedInput): string {
  const items = input.items.slice(0, MAX_FEED_ITEMS).map(itemXml).join('\n');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:itunes="${ITUNES_NS}" xmlns:podcast="${PODCAST_NS}" xmlns:atom="http://www.w3.org/2005/Atom">\n` +
    `  <channel>\n` +
    `${channelHead(input)}\n` +
    `${items}${items ? '\n' : ''}` +
    `  </channel>\n` +
    `</rss>\n`
  );
}
