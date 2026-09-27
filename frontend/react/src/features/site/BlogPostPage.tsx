/**
 * ADR 0391 (a) — a single blog POST view. A post is a `cms` page with
 * `kind:'post'`, so this renders through the SAME public path as any CMS page:
 * fetch the published page JSON (`fetchPublicPage`) and render its typed sections
 * via the shared `RenderSections` (mode="public"). On top of the sections it adds
 * POST CHROME — a back-to-blog link, the byline + published date + reading time,
 * category/tag chips linking to their archives, and a copy-link share — sourced
 * from the blog list projection (`fetchBlog`) joined by slug, since that
 * projection (not the page body) carries the discovery facets. SEO head via the
 * shared `applySeo`, plus feed autodiscovery via `applyFeedAlternate`.
 *
 * Missing/unpublished ⇒ a designed "not found" state with a way back to /blog
 * (uniform 404 honesty — a draft or unknown slug never renders a body). A FAILED
 * read is a different fact and gets a different state (error + retry) — R2-BLOG-1.
 * A renamed slug canonicalizes to the payload's `slug` via replace-navigation.
 *
 * UX_UPGRADE-site (2026-07-24) closes G2/G4/G6/G8: the post was a dead end whose
 * only exit was "← All posts". It now ends with older/newer navigation and a
 * related-reading rail computed from the ALREADY-FETCHED list (no extra network),
 * and advertises the feed the index does.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { brand } from '../../brand/brand.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { CheckIcon, LinkIcon, ListIcon, MailIcon, ExternalLinkIcon } from '../../ui/icons/index.js';
import { RenderSections } from '../cms/SectionRenderer.js';
import { deriveToc, type TocEntry } from '../docs/docsToc.js';
import { ReadingProgress } from './ReadingProgress.js';
import { fetchPublicPageResult, type PublicPage } from './siteClient.js';
import { applySeo, applyFeedAlternate } from './siteSeo.js';
import { fetchBlog, blogFeedUrl, type BlogPost } from './blogClient.js';
import { PostMeta } from './BlogPage.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';

/** How many related posts the rail shows at most. */
const RELATED_MAX = 3;

/** Relatedness of `other` to `post`: same category is the strongest signal,
 *  then each shared tag. 0 ⇒ not related (never shown under "Related"). */
function relatedness(post: BlogPost, other: BlogPost): number {
  let score = 0;
  if (post.category && other.category && post.category === other.category) score += 2;
  const tags = new Set(post.tags ?? []);
  for (const tt of other.tags ?? []) if (tags.has(tt)) score += 1;
  return score;
}

/** The related rail + its honest heading. When nothing shares a facet we show
 *  the most recent OTHER posts instead — under a different heading, so the page
 *  never claims a relationship it didn't find. */
function pickRelated(posts: BlogPost[], slug: string): { items: BlogPost[]; related: boolean } {
  const others = posts.filter((p) => p.slug !== slug);
  const current = posts.find((p) => p.slug === slug);
  if (current) {
    const scored = others
      .map((p) => ({ p, s: relatedness(current, p) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    if (scored.length > 0) return { items: scored.slice(0, RELATED_MAX).map((x) => x.p), related: true };
  }
  return { items: others.slice(0, RELATED_MAX), related: false };
}

/** Copy this post's URL to the clipboard, with a transient "Copied" state.
 *  Hidden entirely when the browser exposes no clipboard (never a dead button). */
function CopyLinkButton(): JSX.Element | null {
  const { t } = useTranslation('site');
  const [copied, setCopied] = useState(false);
  const canCopy = typeof navigator !== 'undefined' && Boolean(navigator.clipboard);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);
  if (!canCopy) return null;
  return (
    <button
      type="button"
      className="fp-post__share"
      onClick={() => { void copyToClipboard(window.location.href, null).then((r) => setCopied(r.ok)); }}
    >
      {copied ? <CheckIcon size={15} /> : <LinkIcon size={15} />}
      <span aria-live="polite">{copied ? t('blogCopied') : t('blogCopyLink')}</span>
    </button>
  );
}

/**
 * R3-G4 — the end-of-post share row (the premium-Ghost-theme catalog row's
 * "social share row at the end of a post"). REAL anchors to the platforms'
 * documented intent URLs — no SDK, no tracking script, no JS interception, so
 * middle-click/new-tab/copy-link-address all behave like links. External
 * targets carry `noopener noreferrer`; email is a plain `mailto:`. The hrefs
 * are computed at render from the CURRENT location — the page re-renders after
 * the canonicalizing replace-navigation, so a renamed slug shares its new URL.
 */
function ShareRow({ title }: { title: string }): JSX.Element {
  const { t } = useTranslation('site');
  useLocation(); // re-render on navigation so the hrefs below stay current
  const here = typeof window === 'undefined' ? '' : window.location.href;
  const q = (params: Record<string, string>): string => new URLSearchParams(params).toString();
  return (
    <div className="fp-post__sharerow" role="group" aria-label={t('blogShareLabel')}>
      <a className="fp-post__share" href={`https://x.com/intent/post?${q({ text: title, url: here })}`} target="_blank" rel="noopener noreferrer">
        <ExternalLinkIcon size={15} /> {t('blogShareX')}
      </a>
      <a className="fp-post__share" href={`https://www.linkedin.com/sharing/share-offsite/?${q({ url: here })}`} target="_blank" rel="noopener noreferrer">
        <ExternalLinkIcon size={15} /> {t('blogShareLinkedIn')}
      </a>
      <a className="fp-post__share" href={`mailto:?${q({ subject: title, body: here })}`}>
        <MailIcon size={15} /> {t('blogShareEmail')}
      </a>
      <CopyLinkButton />
    </div>
  );
}

export function BlogPostPage({ orgId, slug }: { orgId: string; slug: string }): JSX.Element {
  const { t } = useTranslation('site');
  const navigate = useNavigate();
  const location = useLocation();
  const relatedHeadingId = useId();
  // Latest-ref: the canonicalizing navigate keeps the current query/hash
  // without adding them as fetch-effect deps (review R2-4).
  const locRef = useRef(location);
  locRef.current = location;
  // R3-G1/G2 — the article body: the progress bar measures it and the ToC is
  // derived from what ACTUALLY renders in it (the docs `deriveToc` seam — same
  // slug algorithm as the section renderer, duplicate ids rewritten, its own
  // ≥2-heading gate so a two-line post never grows chrome).
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const tocHeadingId = useId();
  const [page, setPage] = useState<PublicPage | null>(null);
  // 'notFound' (the server answered: no such post) and 'error' (the read failed)
  // are different claims with different copy — conflating them told a visitor on
  // a flaky connection the post "may have been unpublished" (R2-BLOG-1).
  const [failure, setFailure] = useState<'notFound' | 'error' | null>(null);
  const [posts, setPosts] = useState<BlogPost[]>([]);
  // A failed LIST read is not an empty list: without this flag the byline, date,
  // chips, pager and related rail silently vanish (R2-BLOG-2).
  const [postsFailed, setPostsFailed] = useState(false);
  const [done, setDone] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    let undoSeo: (() => void) | null = null;
    setDone(false);
    // The page carries the sections; the blog projection carries the discovery
    // facets (byline/date/category/tags/reading time) for the post chrome AND
    // the related/older/newer rails. Fetch both.
    void Promise.all([fetchPublicPageResult(orgId, slug), fetchBlog(orgId)]).then(([r, list]) => {
      if (!live) return;
      if (r.status === 'ok' && r.page.slug && r.page.slug !== slug) {
        // Renamed slug: the payload announces the canonical address — move there
        // (replace, so back doesn't bounce). This also makes the list join below
        // find the post, so the chrome and the related rail stay correct
        // (R2-BLOG-4 / SITE-R2-10).
        navigate(`/blog/${encodeURIComponent(r.page.slug)}${locRef.current.search}${locRef.current.hash}`, { replace: true });
        return;
      }
      setPage(r.status === 'ok' ? r.page : null);
      setFailure(r.status === 'ok' ? null : r.status === 'notFound' ? 'notFound' : 'error');
      setPosts(list ?? []);
      setPostsFailed(list === null);
      setDone(true);
      if (r.status === 'ok') undoSeo = applySeo(r.page);
    });
    return () => { live = false; if (undoSeo) undoSeo(); };
  }, [orgId, slug, navigate, attempt]);

  // Feed autodiscovery — a post URL is what readers land on and share (G8).
  useEffect(() => applyFeedAlternate(t('blogTitle'), blogFeedUrl(orgId)), [orgId, t]);

  // R2-BLOG-8 — the failure states title the document too (the success path
  // titles via applySeo; the 404/error page used to keep the previous title).
  useEffect(() => {
    if (!done || page || typeof document === 'undefined') return;
    const prev = document.title;
    document.title = `${t(failure === 'error' ? 'postLoadErrorTitle' : 'postNotFoundTitle')} — ${brand.productName}`;
    return () => { document.title = prev; };
  }, [done, page, failure, t]);

  const meta = useMemo(() => posts.find((x) => x.slug === slug) ?? null, [posts, slug]);
  // The list is newest-first, so the NEXT index is the older post.
  const idx = useMemo(() => posts.findIndex((x) => x.slug === slug), [posts, slug]);
  const newer = idx > 0 ? posts[idx - 1] : undefined;
  const older = idx >= 0 && idx < posts.length - 1 ? posts[idx + 1] : undefined;
  const related = useMemo(() => pickRelated(posts, slug), [posts, slug]);

  // R2-BLOG-6 — BLOG-2's recorded carve-out: the post-page skeleton is now a
  // LABELED status region like the index one. Honest scope: role="status"
  // mounted WITH content does not reliably announce on insertion (the repo's
  // recorded live-region spec note) — this makes the load state discoverable
  // and consistent, not spoken-on-mount.
  // Mirrors DocsPublicPage's observer pattern (sections render async): try
  // now, observe until headings exist, disconnect on first success. Also
  // resolves a cold-load fragment the browser couldn't (the body was not in
  // the DOM when native fragment navigation ran) — getElementById, not
  // querySelector+CSS.escape (undefined in jsdom/older webviews).
  useEffect(() => {
    setToc([]);
    if (!page || !bodyRef.current) return;
    const container = bodyRef.current;
    const attempt = (): boolean => {
      const entries = deriveToc(container);
      if (entries.length > 0) {
        setToc(entries);
        const hash = typeof window !== 'undefined' ? window.location.hash.slice(1) : '';
        if (hash) {
          const target = document.getElementById(hash);
          if (target && container.contains(target)) target.scrollIntoView();
        }
        return true;
      }
      return false;
    };
    if (attempt()) return;
    const observer = new MutationObserver(() => { if (attempt()) observer.disconnect(); });
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [page]);

  if (!done) return <div className="cms-public-page"><div className="u-p-4" role="status" aria-label={t('common:loading')}><Skeleton /></div></div>;

  if (!page) {
    const notFound = failure !== 'error';
    return (
      <div className="cms-public-page">
        <section className="cms-public-section fp-section fp-blog">
          <div className="fp-shell fp-shell--narrow">
            <div className="fp-blog__empty">
              <h1 className="fp-blog__empty-title">{t(notFound ? 'postNotFoundTitle' : 'postLoadErrorTitle')}</h1>
              <p className="fp-blog__empty-body">{t(notFound ? 'postNotFoundBody' : 'postLoadErrorBody')}</p>
              {notFound
                ? <Link to="/blog" className="fp-btn fp-btn--ghost">{t('blogBackToBlog')}</Link>
                : <button type="button" className="fp-btn fp-btn--ghost" onClick={() => setAttempt((n) => n + 1)}>{t('common:retry')}</button>}
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <article className="cms-public-page fp-post">
      <ReadingProgress targetRef={bodyRef} />
      <div className="fp-shell fp-shell--narrow fp-post__chrome">
        <Link to="/blog" className="fp-post__back">{t('blogBackToBlog')}</Link>
        <h1 className="fp-post__title">{page.title}</h1>
        {/* The body rendered but the list projection (byline/date/chips/pager/
            related) failed — say so instead of silently shedding the chrome. */}
        {postsFailed ? <p className="fp-pricing__note">{t('blogChromeDegraded')}</p> : null}
        {meta ? (
          <PostMeta
            post={meta}
            className="fp-post__meta"
            {...(meta.authorId && meta.authorName ? { authorHref: `/blog/author/${encodeURIComponent(meta.authorId)}` } : {})}
          />
        ) : null}
        {(meta?.category || (meta?.tags && meta.tags.length > 0)) ? (
          <div className="fp-post__chips">
            {meta?.category ? (
              <Link to={`/blog/category/${encodeURIComponent(meta.category)}`} className="fp-tag fp-tag--accent">{meta.category}</Link>
            ) : null}
            {(meta?.tags ?? []).map((tag) => (
              <Link key={tag} to={`/blog/tag/${encodeURIComponent(tag)}`} className="fp-tag">{tag}</Link>
            ))}
          </div>
        ) : null}
      </div>

      {toc.length > 0 ? (
        <div className="fp-shell fp-shell--narrow">
          {/* Collapsible on every width — the narrow single-column shell has no
              sidebar to pin it to, and an always-open list pushes the body a
              full viewport down on mobile (the 60-70%-mobile catalog row). */}
          <details className="fp-post__toc">
            <summary className="fp-post__toc-summary">
              <ListIcon size={15} aria-hidden /> <span id={tocHeadingId}>{t('blogTocTitle')}</span>
            </summary>
            <nav aria-labelledby={tocHeadingId}>
              <ul className="fp-post__toc-list">
                {toc.map((e) => (
                  <li key={e.id}>
                    <a href={`#${e.id}`} className={e.level === 3 ? 'fp-post__toc-item fp-post__toc-item--nested' : 'fp-post__toc-item'}>{e.text}</a>
                  </li>
                ))}
              </ul>
            </nav>
          </details>
        </div>
      ) : null}

      <div ref={bodyRef}>
        <RenderSections sections={page.sections} mode="public" />
      </div>

      <div className="fp-shell fp-shell--narrow fp-post__footer">
        <div className="fp-post__footer-actions">
          <Link to="/blog" className="fp-btn fp-btn--ghost">{t('blogBackToBlog')}</Link>
          <ShareRow title={page.title} />
        </div>

        {newer || older ? (
          <nav className="fp-post__pager" aria-label={t('blogPagerLabel')}>
            {older ? (
              <Link to={`/blog/${encodeURIComponent(older.slug)}`} className="fp-post__pager-link">
                <span className="fp-post__pager-dir">{t('blogOlderPost')}</span>
                <span className="fp-post__pager-title">{older.title}</span>
              </Link>
            ) : <span />}
            {newer ? (
              <Link to={`/blog/${encodeURIComponent(newer.slug)}`} className="fp-post__pager-link fp-post__pager-link--end">
                <span className="fp-post__pager-dir">{t('blogNewerPost')}</span>
                <span className="fp-post__pager-title">{newer.title}</span>
              </Link>
            ) : null}
          </nav>
        ) : null}

        {related.items.length > 0 ? (
          <section className="fp-post__related" aria-labelledby={relatedHeadingId}>
            <h2 id={relatedHeadingId} className="fp-post__related-title">
              {related.related ? t('blogRelatedTitle') : t('blogMoreTitle')}
            </h2>
            <ul className="fp-post__related-list">
              {related.items.map((p) => (
                <li key={p.pageId}>
                  <Link to={`/blog/${encodeURIComponent(p.slug)}`} className="fp-post__related-link">
                    <span className="fp-post__related-name">{p.title}</span>
                    {p.readingMinutes ? <span className="fp-post__related-meta">{t('blogReadingTime', { count: p.readingMinutes })}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </article>
  );
}
