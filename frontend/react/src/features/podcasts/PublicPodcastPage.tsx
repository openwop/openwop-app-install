/**
 * ADR 0390 — the visitor-facing public podcast pages (bare PublicShell, mounted
 * above AppGate by App.tsx). Three views keyed off the matched URL:
 *   - show index  (`/pod/:orgId`)                    → the org's published shows
 *   - show page   (`/pod/:orgId/:showSlug`)          → a show + episode list + feed
 *   - episode page(`/pod/:orgId/:showSlug/:episodeSlug`) → one episode + player
 * Composes the public podcast JSON API (never the authed studio surface). Uniform
 * "unavailable" state (the API 404s unpublished uniformly). `ui/` cohesion.
 */

import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { toast } from '../../ui/toast.js';
import { MicIcon, LinkIcon, CopyIcon, PlayIcon, ExternalLinkIcon } from '../../ui/icons/index.js';
import {
  assetUrl, getPublicShows, getPublicShow, getPublicEpisode,
  type PublicShow, type PublicEpisode,
} from './podcastsClient.js';
import type { PodcastView } from './podcastRoute.js';
import { useFormat } from '../../i18n/useFormat.js';
import { applyPublicHead, applyFeedAlternate } from '../site/siteSeo.js';
import { PodcastAudio } from './PodcastAudio.js';

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  /** R2 SP-10 — a transport/5xx failure is NOT "not published": distinct state + retry. */
  | { kind: 'loadFailed' }
  | { kind: 'index'; shows: PublicShow[] }
  | { kind: 'show'; show: PublicShow; episodes: PublicEpisode[] }
  | { kind: 'episode'; show: { slug: string; title: string; author: string }; episode: PublicEpisode; siblings: PublicEpisode[]; feedUrl?: string };

function podPath(orgId: string, ...rest: string[]): string {
  return `/pod/${encodeURIComponent(orgId)}${rest.map((s) => `/${encodeURIComponent(s)}`).join('')}`;
}

/** R2 PR2-3 — recent episodes shown before "Show all". */
const EPISODE_LIST_CAP = 20;

/** R2 PR2-1 — "52 min" / "1 h 6 min" row furniture (every leader shows it). */
function useDurationLabel(): (seconds: number | undefined) => string | null {
  const { t } = useTranslation('podcasts');
  return (seconds) => {
    if (!seconds || seconds <= 0) return null;
    const m = Math.max(1, Math.round(seconds / 60));
    return m >= 60 ? t('durationHM', { h: Math.floor(m / 60), m: m % 60 }) : t('durationMin', { m });
  };
}

export function PublicPodcastPage({ view }: { view: PodcastView }): JSX.Element {
  const { t } = useTranslation('podcasts');
  const fmt = useFormat();
  const durationLabel = useDurationLabel();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // R2 PR2-3 — bounded recent list on the show page (the leader pattern).
  const [showAllEpisodes, setShowAllEpisodes] = useState(false);

  // `L6` (ADR 0603 R1) — the transcript panel's a11y plumbing. `useId` gives the
  // heading a per-INSTANCE id (the literal it replaces would collide if this page
  // ever rendered two episode panels), and the scroll container's focusability is
  // MEASURED rather than assumed: SC 2.1.1 needs a keyboard route into content that
  // scrolls, and a container that does not scroll is a tab stop announcing a region
  // with nothing behind it. Re-measured on resize because the overflow depends on
  // viewport width, so a value computed once at mount goes stale the moment the
  // window changes.
  const transcriptHeadingId = useId();
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [transcriptScrolls, setTranscriptScrolls] = useState(false);
  const measureTranscript = useCallback(() => {
    const el = transcriptRef.current;
    setTranscriptScrolls(el ? el.scrollHeight > el.clientHeight + 1 : false);
  }, []);
  useEffect(() => {
    measureTranscript();
    window.addEventListener('resize', measureTranscript);
    return () => window.removeEventListener('resize', measureTranscript);
  }, [measureTranscript, state]);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    setShowAllEpisodes(false); // review F8 — a Show-all on show A must not pre-expand show B
    (async () => {
      try {
        if (view.showSlug && view.episodeSlug) {
          // P-G3 — the show read supplies the sibling list for older/newer
          // navigation. Best-effort: an episode page must still render if the
          // show read fails, just without the pager.
          // R2 SP-7 — the same best-effort show read also carries the FEED URL;
          // dropping it left the episode page (the URL people actually share)
          // with no RSS autodiscovery, against siteSeo's own G8 lesson.
          const [{ show, episode }, sib] = await Promise.all([
            getPublicEpisode(view.orgId, view.showSlug, view.episodeSlug),
            getPublicShow(view.orgId, view.showSlug)
              .then((r) => ({ episodes: r.episodes, feedUrl: r.show.feedUrl }))
              .catch(() => ({ episodes: [] as PublicEpisode[], feedUrl: undefined })),
          ]);
          if (!cancelled) setState({ kind: 'episode', show, episode, siblings: sib.episodes, ...(sib.feedUrl ? { feedUrl: sib.feedUrl } : {}) });
        } else if (view.showSlug) {
          const { show, episodes } = await getPublicShow(view.orgId, view.showSlug);
          if (!cancelled) setState({ kind: 'show', show, episodes });
        } else {
          const shows = await getPublicShows(view.orgId);
          if (!cancelled) setState({ kind: 'index', shows });
        }
      } catch (e) {
        // R2 SP-10 — only a real 404 may claim "not published / link invalid";
        // a blip or 5xx gets the retryable card instead of a publish-state lie.
        const status = (e as Error & { status?: number }).status;
        if (!cancelled) setState(status === 404 ? { kind: 'unavailable' } : { kind: 'loadFailed' });
      }
    })();
    return () => { cancelled = true; };
  }, [view.orgId, view.showSlug, view.episodeSlug, attempt]);

  // P-G1 — these pages are MEANT to be found (the deliberate counterpart to the
  // noindex posture on capability-token pages), so give them a real title and
  // description, and advertise the feed so podcast apps and browsers can
  // autodiscover it.
  const head = useMemo(() => {
    if (state.kind === 'show') return { title: `${state.show.title} — ${state.show.author}`, description: state.show.description, feedUrl: state.show.feedUrl };
    if (state.kind === 'episode') return { title: `${state.episode.title} — ${state.show.title}`, description: state.episode.description ?? '', feedUrl: state.feedUrl };
    return { title: '', description: '', feedUrl: undefined };
  }, [state]);
  useEffect(() => {
    if (!head.title) return;
    return applyPublicHead(head.title, head.description || undefined);
  }, [head.title, head.description]);
  useEffect(() => {
    if (!head.feedUrl || !head.title) return;
    return applyFeedAlternate(head.title, head.feedUrl);
  }, [head.feedUrl, head.title]);

  if (state.kind === 'loading') return <div className="u-p-4"><Skeleton height={120} /></div>;
  if (state.kind === 'loadFailed') {
    return (
      <section className="u-grid u-gap-4 u-p-4">
        <StateCard
          announce
          icon={<MicIcon size={20} />}
          title={t('publicLoadFailedTitle')}
          body={t('publicLoadFailedBody')}
          action={<Button variant="secondary" onClick={() => setAttempt((a) => a + 1)}>{t('common:retry')}</Button>}
        />
      </section>
    );
  }
  if (state.kind === 'unavailable') {
    return (
      <section className="u-grid u-gap-4 u-p-4">
        <StateCard announce icon={<MicIcon size={20} />} title={t('publicUnavailableTitle')} body={t('publicUnavailableBody')} />
      </section>
    );
  }

  if (state.kind === 'index') {
    return (
      <section className="u-grid u-gap-4 u-p-4">
        <PageHeader eyebrow={t('publicEyebrow')} title={t('publicIndexTitle')} lede={t('publicIndexLede')} />
        {state.shows.length === 0 ? (
          <StateCard icon={<MicIcon size={20} />} title={t('publicIndexTitle')} body={t('publicNoShows')} />
        ) : (
          <ul className="nb-list">
            {state.shows.map((s) => (
              <li key={s.slug} className="nb-list__item">
                <Link className="u-flex u-items-center u-gap-2" to={podPath(view.orgId, s.slug)}>
                  {s.imageMediaRef ? <img src={assetUrl(s.imageMediaRef)} alt="" width={48} height={48} style={{ borderRadius: 'var(--radius)' }} /> : <MicIcon size={20} />}
                  <span><strong>{s.title}</strong> · {s.author} <span className="chip chip--muted">{t('episodeCountN', { count: s.episodeCount })}</span></span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  if (state.kind === 'show') {
    const { show } = state;
    const copyFeed = async (): Promise<void> => {
      if (!show.feedUrl) return;
      try { await navigator.clipboard.writeText(show.feedUrl); toast.success(t('feedUrlCopied')); }
      catch { toast.error(t('copyFailed')); }
    };
    return (
      <section className="u-grid u-gap-4 u-p-4">
        <div className="u-flex u-items-center u-gap-3">
          {show.imageMediaRef ? <img src={assetUrl(show.imageMediaRef)} alt="" width={96} height={96} style={{ borderRadius: 'var(--radius)' }} /> : null}
          <PageHeader eyebrow={show.author} title={show.title} lede={show.description} />
        </div>
        {/* R2 SP-8a — the payload always carried these; the page dropped them.
            An explicit SHOW must be labelled at the channel level too. */}
        <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
          {show.explicit ? <span className="chip chip--warning">{t('explicitLabel')}</span> : null}
          {show.category ? <span className="chip chip--muted">{show.category}{show.subcategory ? ` · ${show.subcategory}` : ''}</span> : null}
          <span className="chip chip--muted">{t('episodeCountN', { count: show.episodeCount })}</span>
        </div>
        {/* R2 PR2-4 — "Listen on": operator-entered directory pages + the feed. */}
        {show.appleUrl || show.spotifyUrl || show.amazonUrl ? (
          <div className="action-bar u-flex-wrap">
            <span className="u-label-sm">{t('listenOnLabel')}</span>
            {show.appleUrl ? <a className="btn secondary" href={show.appleUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon size={14} /> Apple Podcasts</a> : null}
            {show.spotifyUrl ? <a className="btn secondary" href={show.spotifyUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon size={14} /> Spotify</a> : null}
            {show.amazonUrl ? <a className="btn secondary" href={show.amazonUrl} target="_blank" rel="noreferrer"><ExternalLinkIcon size={14} /> Amazon Music</a> : null}
          </div>
        ) : null}
        {show.feedUrl ? (
          <div className="surface-card u-p-3 u-grid u-gap-2">
            <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
              <LinkIcon size={16} />
              <code className="u-text-sm u-break-all">{show.feedUrl}</code>
              <Button variant="quiet" size="sm" className="u-ml-auto" onClick={() => void copyFeed()}>
                <CopyIcon size={14} /> {t('copyFeedUrl')}
              </Button>
            </div>
            <p className="u-text-sm muted">{t('subscribeHint')}</p>
          </div>
        ) : null}
        {state.episodes.length === 0 ? (
          <StateCard icon={<MicIcon size={20} />} title={show.title} body={t('publicNoEpisodes')} />
        ) : (
          <ul className="nb-list">
            {/* R2 PR2-3 (closes P-G5) — the leader pattern is a BOUNDED recent
                list, never N mounted players (Apple web mounts zero on the show
                page; Buzzcast bounds + "See All"). preload="none" already kept
                requests lazy; this bounds the DOM too. */}
            {(showAllEpisodes ? state.episodes : state.episodes.slice(0, EPISODE_LIST_CAP)).map((e) => (
              <li key={e.slug} className="nb-list__item u-grid u-gap-2">
                <Link to={podPath(view.orgId, show.slug, e.slug)}><strong>{e.title}</strong></Link>
                {/* P-G2/P-G4 — `publishedAt` and `explicit` were already in the
                    payload and never shown. A podcast listing without a date
                    reads as undated, and Apple requires explicit content be
                    LABELLED, not merely flagged in the feed. */}
                <p className="u-text-sm muted u-m-0">
                  <time dateTime={e.publishedAt}>{fmt.date(e.publishedAt)}</time>
                  {durationLabel(e.durationSeconds) ? <> · {durationLabel(e.durationSeconds)}</> : null}
                  {e.explicit ? <> · <span className="chip chip--warning">{t('explicitLabel')}</span></> : null}
                </p>
                {e.description ? <p className="u-text-sm muted">{e.description}</p> : null}
                <PodcastAudio controls preload="none" src={e.audioUrl} aria-label={t('episodeAudioLabel', { title: e.title })} />
              </li>
            ))}
          </ul>
        )}
        {!showAllEpisodes && state.episodes.length > EPISODE_LIST_CAP ? (
          <div className="u-flex u-justify-center">
            <Button variant="secondary" onClick={() => setShowAllEpisodes(true)}>
              {t('showAllEpisodes', { count: state.episodes.length })}
            </Button>
          </div>
        ) : null}
      </section>
    );
  }

  // episode
  const { show, episode, siblings } = state;
  // The show read is newest-first, so the NEXT index is the older episode.
  const ix = siblings.findIndex((e) => e.slug === episode.slug);
  const newer = ix > 0 ? siblings[ix - 1] : undefined;
  const older = ix >= 0 && ix < siblings.length - 1 ? siblings[ix + 1] : undefined;
  return (
    <section className="u-grid u-gap-4 u-p-4">
      <Link className="u-text-sm" to={podPath(view.orgId, show.slug)}>&larr; {show.title}</Link>
      <PageHeader eyebrow={show.author} title={episode.title} lede={episode.description} />
      <div className="surface-card u-p-4 u-grid u-gap-2">
        <div className="u-flex u-items-center u-gap-2 u-flex-wrap">
          <PlayIcon size={16} /> {show.author}
          <span aria-hidden="true">·</span>
          <time dateTime={episode.publishedAt}>{fmt.date(episode.publishedAt)}</time>
          {durationLabel(episode.durationSeconds) ? <span>{durationLabel(episode.durationSeconds)}</span> : null}
          {episode.explicit ? <span className="chip chip--warning">{t('explicitLabel')}</span> : null}
        </div>
        <PodcastAudio controls preload="metadata" src={episode.audioUrl} aria-label={t('episodeAudioLabel', { title: episode.title })} />
      </div>
      {/* PODU-1 (ADR 0603 §4) — WCAG 2.1 SC 1.2.1 (Level A): prerecorded audio-only
          content needs a text alternative, and this page shipped a bare <audio>.
          Rendered as a real landmark with a heading (not a bare <details> summary) so
          it is reachable by heading navigation as well as by sight, and stated
          HONESTLY when absent — an INGESTED episode (ADR 0562) has no generated
          transcript, and silence about that is what let the gap hide for two rounds. */}
      {/* `L6` (ADR 0603 R1) — three a11y nits INSIDE the a11y fix, each fixed on
          mechanism rather than by deleting the attribute that caused it:
            · the heading id was a hard-coded document-global literal, so two
              episode panels on one document would collide and `aria-labelledby`
              would resolve to whichever won. `useId()` is per-instance.
            · the scroll container repeated the section's OWN accessible name, so a
              screen reader met two nested regions both called "Transcript" and
              neither told you which one you were in. It now carries its own,
              distinct name in all four locales.
            · `tabIndex={0}` was UNCONDITIONAL. SC 2.1.1 requires a keyboard route
              into content that scrolls; a container that does NOT scroll is just a
              tab stop that announces a region and does nothing, which is noise on a
              page whose whole point is being easy to traverse. It is now measured
              (and re-measured on resize), so the tab stop exists exactly when there
              is something to reach with it. */}
      <section className="surface-card u-p-4 u-grid u-gap-2" aria-labelledby={transcriptHeadingId}>
        <h2 id={transcriptHeadingId} className="nb-panel__title u-m-0">{t('transcriptHeading')}</h2>
        {episode.transcript ? (
          <>
            <p className="u-text-sm muted u-m-0">{t('transcriptHint')}</p>
            {episode.transcriptTruncated ? (
              <p className="u-text-sm u-m-0"><strong>{t('transcriptTruncated')}</strong></p>
            ) : null}
            <div
              ref={transcriptRef}
              className="pod-transcript u-text-sm"
              {...(transcriptScrolls ? { tabIndex: 0, role: 'region', 'aria-label': t('transcriptScrollLabel') } : {})}
            >
              {episode.transcript.split(/\n{2,}/).map((para, i) => (
                <p key={i} className="u-m-0">{para}</p>
              ))}
            </div>
          </>
        ) : (
          <p className="u-text-sm muted u-m-0">{t('transcriptUnavailable')}</p>
        )}
      </section>
      {/* P-G3 — an episode was a dead end; the only exit was back to the show. */}
      {newer || older ? (
        <nav className="pod-pager" aria-label={t('episodePagerLabel')}>
          {older ? (
            <Link to={podPath(view.orgId, show.slug, older.slug)} className="pod-pager__link">
              <span className="pod-pager__dir">{t('olderEpisode')}</span>
              <span className="pod-pager__title">{older.title}</span>
            </Link>
          ) : <span />}
          {newer ? (
            <Link to={podPath(view.orgId, show.slug, newer.slug)} className="pod-pager__link pod-pager__link--end">
              <span className="pod-pager__dir">{t('newerEpisode')}</span>
              <span className="pod-pager__title">{newer.title}</span>
            </Link>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}
