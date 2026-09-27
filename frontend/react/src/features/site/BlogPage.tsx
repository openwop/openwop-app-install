/**
 * ADR 0391 (a) — the public blog INDEX + the tag/category/author ARCHIVES.
 * Rendered inside <PublicShell> (above <AppGate>) for anonymous visitors, in the
 * same "engineering broadsheet" aesthetic as the CMS front page (`.fp-*`). One
 * component serves all four list views (index + three archives); the `route`
 * discriminates the header + the list query.
 *
 * A post is a `cms` page with `kind:'post'` (ADR 0391), so this reads the public
 * blog projection (`fetchBlog`) — title/excerpt/byline/date/category/tags, never
 * draft bodies. Chips (category + tags) link to their archives; the whole card
 * links to the post. The head gets the page title + a `<link rel="alternate">`
 * to the blog RSS feed. Designed empty + error states (DESIGN.md §5.5).
 *
 * UX_UPGRADE-site (2026-07-24) closes G1/G2/G3/G7 against the Ghost baseline:
 *   - G1 a client-side FILTER band over the loaded list (title/excerpt/tags/
 *     category) — Ghost ships native search; ours needs no network because the
 *     projection is already in memory and server-capped.
 *   - G2 a reading estimate on every card (`readingMinutes`, server-computed).
 *   - G3 SHOW MORE batching so a long archive doesn't dump every post at once.
 *   - G7 a cover thumbnail from the post's OG image, when the author set one.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { brand } from '../../brand/brand.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { useFormat } from '../../i18n/useFormat.js';
import { SearchIcon, XIcon } from '../../ui/icons/index.js';
import { assetUrl } from '../cms/cmsClient.js';
import { fetchBlog, blogFeedUrl, type BlogPost } from './blogClient.js';
import { applyFeedAlternate } from './siteSeo.js';
import type { BlogRoute } from './blogRoute.js';

/** Posts revealed per batch (G3). Small enough that the first screen stays
 *  light, large enough that most archives never need a second click. */
const PAGE_SIZE = 10;
/** Below this the filter band is noise — a reader can see everything at once. */
const FILTER_MIN_POSTS = 5;

/** Set the document title + an RSS `<link rel="alternate">`; returns an undo. */
function applyBlogHead(title: string, feedUrl: string): () => void {
  if (typeof document === 'undefined') return () => {};
  const prevTitle = document.title;
  document.title = title;
  const undoFeed = applyFeedAlternate(title, feedUrl);
  return () => { document.title = prevTitle; undoFeed(); };
}

/** The archive filter passed to the list read, derived from the route. */
function filterFor(route: BlogRoute): { tag?: string; category?: string; author?: string } {
  switch (route.kind) {
    case 'tag': return { tag: route.value };
    case 'category': return { category: route.value };
    case 'author': return { author: route.value };
    default: return {};
  }
}

/** Whether a post matches the free-text query (title + excerpt + facets). */
function postMatches(p: BlogPost, q: string): boolean {
  const hay = `${p.title} ${p.excerpt ?? ''} ${p.category ?? ''} ${(Array.isArray(p.tags) ? p.tags : []).join(' ')}`;
  return hay.toLowerCase().includes(q);
}

/** Content-shaped loading placeholder for the post list — a few card-shaped rows
 *  (title + meta + two excerpt lines) so the loading frame previews the content,
 *  not a single bare bar. `Skeleton` is aria-hidden; the wrapper announces load. */
function BlogListSkeleton(): JSX.Element {
  const { t } = useTranslation('site');
  return (
    <div className="fp-blog__list" role="status" aria-label={t('common:loading')}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="fp-post-card">
          <div className="u-grid u-gap-3">
            <Skeleton width="70%" height={30} />
            <Skeleton width="40%" height={14} />
            <div className="u-grid u-gap-2">
              <Skeleton width="100%" height={14} />
              <Skeleton width="85%" height={14} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The byline · date · reading-time line shared by the card and the post view.
 *  `authorHref` turns the byline into a link to that author's archive (the post
 *  view does; the index card doesn't, so the card exposes one link per target). */
export function PostMeta({ post, className = 'fp-post-card__meta', authorHref }: {
  post: BlogPost; className?: string; authorHref?: string;
}): JSX.Element {
  const { t } = useTranslation('site');
  const fmt = useFormat();
  const parts: JSX.Element[] = [];
  if (post.authorName) {
    const byline = t('blogByline', { author: post.authorName });
    parts.push(authorHref
      ? <Link key="by" to={authorHref} className="fp-post__author">{byline}</Link>
      : <span key="by">{byline}</span>);
  }
  if (post.publishedAt) parts.push(<time key="at" dateTime={post.publishedAt}>{fmt.date(post.publishedAt)}</time>);
  if (post.readingMinutes) parts.push(<span key="rt">{t('blogReadingTime', { count: post.readingMinutes })}</span>);
  return (
    <p className={className}>
      {parts.map((el, i) => (i === 0
        ? el
        : <span key={`sep-${el.key}`}><span aria-hidden="true"> · </span>{el}</span>))}
    </p>
  );
}

/** One post row: the whole card links to the post; chips link to archives. */
function PostCard({ post, titleRef }: { post: BlogPost; titleRef?: React.Ref<HTMLAnchorElement> }): JSX.Element {
  const href = `/blog/${encodeURIComponent(post.slug)}`;
  return (
    <article className={`fp-post-card${post.coverImageToken ? ' fp-post-card--cover' : ''}`}>
      {post.coverImageToken ? (
        // Decorative duplicate of the title link: hidden from the a11y tree and
        // out of the tab order so the card exposes exactly ONE link to the post.
        <Link to={href} className="fp-post-card__cover" aria-hidden="true" tabIndex={-1}>
          <img src={assetUrl(post.coverImageToken)} alt="" loading="lazy" decoding="async" />
        </Link>
      ) : null}
      <div className="fp-post-card__body">
        <Link ref={titleRef} to={href} className="fp-post-card__title-link">
          <h2 className="fp-post-card__title">{post.title}</h2>
        </Link>
        <PostMeta post={post} />
        {post.excerpt ? <p className="fp-post-card__excerpt">{post.excerpt}</p> : null}
        {(post.category || (Array.isArray(post.tags) && post.tags.length > 0)) ? (
          <div className="fp-post-card__chips">
            {post.category ? (
              <Link to={`/blog/category/${encodeURIComponent(post.category)}`} className="fp-tag fp-tag--accent">{post.category}</Link>
            ) : null}
            {(Array.isArray(post.tags) ? post.tags : []).map((tag) => (
              <Link key={tag} to={`/blog/tag/${encodeURIComponent(tag)}`} className="fp-tag">{tag}</Link>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function BlogPage({ orgId, route }: { orgId: string; route: BlogRoute }): JSX.Element {
  const { t } = useTranslation('site');
  const [posts, setPosts] = useState<BlogPost[] | null>(null);
  const [error, setError] = useState(false);
  const [done, setDone] = useState(false);
  const [attempt, setAttempt] = useState(0); // R2-BLOG-5 — the error state's retry re-runs the fetch
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);
  // R3-G3 — the Ghost catalog row wires search to Cmd/Ctrl-K "in every
  // official theme". Guarded: only when the band is rendered, and never while
  // the user is typing in another field (other inputs keep their meaning —
  // the shortcut yields rather than hijacks).
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.key === 'k' || e.key === 'K') || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const el = searchRef.current;
      if (!el) return;
      const active = document.activeElement;
      if (active && active !== el && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active as HTMLElement).isContentEditable)) return;
      e.preventDefault();
      el.focus();
      el.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // After "show more", move focus to the first newly-revealed post title so a
  // keyboard/screen-reader user lands on the new content, not back at the top.
  const focusAtRef = useRef<number | null>(null);
  const nextFocusRef = useRef<HTMLAnchorElement | null>(null);

  // Serialize the route so the effect re-runs when the archive facet changes
  // (App keeps this component mounted across /blog → /blog/tag/x navigations).
  const key = route.kind === 'index' ? 'index' : route.kind === 'post' ? `post:${route.slug}` : `${route.kind}:${route.value}`;

  useEffect(() => {
    let live = true;
    setDone(false);
    setError(false);
    setQuery('');
    setShown(PAGE_SIZE);
    const undo = applyBlogHead(`${t('blogTitle')} — ${brand.productName}`, blogFeedUrl(orgId));
    void fetchBlog(orgId, filterFor(route)).then((list) => {
      if (!live) return;
      if (list === null) { setError(true); setPosts(null); } else { setPosts(list); }
      setDone(true);
    });
    return () => { live = false; undo(); };
    // R2-BLOG-8 — `t` IS a dependency: a locale switch must retitle the
    // document AND refetch (excerpts/reading estimates localize server-side).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, key, attempt, t]);

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => (posts ?? []).filter((p) => (q ? postMatches(p, q) : true)),
    [posts, q],
  );
  const visible = matches.slice(0, shown);

  useEffect(() => {
    if (focusAtRef.current === null) return;
    focusAtRef.current = null;
    nextFocusRef.current?.focus();
  }, [shown]);

  // The archive header label + a display value (author archives show the byline
  // name once posts resolve, not the raw id in the URL).
  const filterLabel = ((): string | null => {
    switch (route.kind) {
      case 'tag': return t('blogFilterTag', { value: route.value });
      case 'category': return t('blogFilterCategory', { value: route.value });
      // Resolve the byline name from the loaded posts; never leak the raw
      // authorId from the URL when the archive is empty (or still loading).
      case 'author': return posts?.[0]?.authorName
        ? t('blogFilterAuthor', { value: posts[0].authorName })
        : t('blogFilterAuthorUnknown');
      default: return null;
    }
  })();

  const showFilter = done && !error && (posts?.length ?? 0) >= FILTER_MIN_POSTS;

  return (
    <div className="cms-public-page">
      <section className="cms-public-section fp-section fp-blog">
        <div className="fp-shell fp-shell--narrow">
          <header className="fp-blog__head">
            <p className="fp-eyebrow fp-eyebrow--accent">{t('blogEyebrow')}</p>
            <h1 className="fp-head__title">{t('blogTitle')}</h1>
            {filterLabel ? (
              <div className="fp-blog__filter">
                <span className="fp-tag fp-tag--accent">{filterLabel}</span>
                <Link to="/blog" className="fp-blog__clear">{t('blogClearFilter')}</Link>
              </div>
            ) : (
              <a className="fp-blog__rss" href={blogFeedUrl(orgId)} rel="alternate">{t('blogSubscribe')}</a>
            )}
          </header>

          {showFilter ? (
            <div className="fp-blog__searchband">
              <form role="search" className="fp-search" onSubmit={(e) => e.preventDefault()}>
                <SearchIcon size={18} />
                <input
                  ref={searchRef}
                  type="text"
                  inputMode="search"
                  className="fp-search__input"
                  placeholder={t('blogSearchPlaceholder', { count: posts?.length ?? 0 })}
                  aria-label={t('blogSearchLabel')}
                  aria-keyshortcuts="Meta+K Control+K"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setShown(PAGE_SIZE); }}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); setShown(PAGE_SIZE); } }}
                />
                {!query ? <kbd className="fp-search__kbd" aria-hidden="true">{typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform) ? t('blogSearchShortcutHintMac') : t('blogSearchShortcutHint')}</kbd> : null}
                {query ? (
                  <button type="button" className="fp-search__clear" onClick={() => { setQuery(''); setShown(PAGE_SIZE); }} aria-label={t('blogSearchClear')}>
                    <XIcon size={16} />
                  </button>
                ) : null}
              </form>
              <p className="fp-search__status" aria-live="polite">
                {q ? t('blogSearchStatus', { count: matches.length, total: posts?.length ?? 0 }) : ''}
              </p>
            </div>
          ) : null}

          {!done ? (
            <BlogListSkeleton />
          ) : error ? (
            <div className="fp-blog__empty">
              <h2 className="fp-blog__empty-title">{t('blogLoadErrorTitle')}</h2>
              <p className="fp-blog__empty-body">{t('blogLoadErrorBody')}</p>
              {/* R2-BLOG-5 — the copy says "try again"; give the reader the control. */}
              <button type="button" className="fp-btn fp-btn--ghost" onClick={() => setAttempt((n) => n + 1)}>{t('common:retry')}</button>
            </div>
          ) : q && matches.length === 0 ? (
            <div className="fp-blog__empty">
              <h2 className="fp-blog__empty-title">{t('blogSearchEmptyTitle', { query: query.trim() })}</h2>
              <p className="fp-blog__empty-body">{t('blogSearchEmptyBody')}</p>
              <button type="button" className="fp-btn fp-btn--ghost" onClick={() => setQuery('')}>{t('blogSearchShowAll')}</button>
            </div>
          ) : posts && posts.length > 0 ? (
            <>
              <div className="fp-blog__list">
                {visible.map((p, i) => (
                  <PostCard
                    key={p.pageId}
                    post={p}
                    {...(focusAtRef.current === i ? { titleRef: nextFocusRef } : {})}
                  />
                ))}
              </div>
              {/* R2-BLOG-7 — the wrapper stays MOUNTED once batching applies at
                  all (matches > one page), so the final "Show more" click still
                  has a live region to announce into; unmounting it with the
                  button silenced exactly the last reveal. */}
              {matches.length > PAGE_SIZE ? (
                <div className="fp-blog__more">
                  {matches.length > visible.length ? (
                    <button
                      type="button"
                      className="fp-btn fp-btn--ghost"
                      onClick={() => { focusAtRef.current = visible.length; setShown((n) => n + PAGE_SIZE); }}
                    >
                      {t('blogShowMore', { count: Math.min(PAGE_SIZE, matches.length - visible.length) })}
                    </button>
                  ) : null}
                  {/* Announces the new position after a batch reveal, so the
                      change isn't silent for a screen-reader user. */}
                  <p className="fp-blog__more-count" aria-live="polite">{t('blogShownCount', { count: visible.length, total: matches.length })}</p>
                </div>
              ) : null}
            </>
          ) : (
            <div className="fp-blog__empty">
              <h2 className="fp-blog__empty-title">{route.kind === 'index' ? t('blogEmptyTitle') : t('blogArchiveEmptyTitle')}</h2>
              <p className="fp-blog__empty-body">{route.kind === 'index' ? t('blogEmptyBody') : t('blogArchiveEmptyBody')}</p>
              {route.kind === 'index' ? (
                <div className="fp-blog__empty-actions">
                  <Link to="/docs/quickstart" className="fp-btn fp-btn--primary">{t('blogEmptyPrimaryCta')}</Link>
                  <Link to="/p/features" className="fp-btn fp-btn--ghost">{t('blogEmptySecondaryCta')}</Link>
                </div>
              ) : <Link to="/blog" className="fp-btn fp-btn--ghost">{t('blogBackToBlog')}</Link>}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
