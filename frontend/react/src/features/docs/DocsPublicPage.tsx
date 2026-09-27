/**
 * Public docs tier (ADR 0392) — a two-pane reference surface rendered in the
 * bare PublicShell: a nav tree sidebar + the selected doc rendered by the
 * EXISTING public page renderer (`FrontPage`). NO second section renderer.
 * `/docs` shows the designed index (grouped list-cards, UX-D4); `/docs/:slug`
 * shows the doc with an in-page TOC nested UNDER the active nav item (UX-D3 —
 * DOM-derived per the architect ruling: markdown headings only exist rendered;
 * capped at h3, plain anchors, no scroll-spy).
 *
 * UX_UPGRADE-docs (2026-07-24) closes D-G1/D-G2/D-G3/D-G5/D-G6 against the
 * Docusaurus / Mintlify / GitBook baseline:
 *   - D-G1 a sidebar FILTER (`/` or ⌘K to focus) — no doc site at this size
 *     ships without search, and ours had none at all.
 *   - D-G2 the sidebar is GROUPED by the same `docsNav` prefix the index groups
 *     by; it previously rendered flat, contradicting the index's own IA.
 *   - D-G3/D-G5 article chrome: a breadcrumb and previous/next pagination
 *     derived from the ordered nav (Docusaurus derives prev/next the same way).
 *   - D-G6 a "last updated" freshness signal from the nav projection.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { FrontPage } from '../site/FrontPage.js';
import { Button } from '../../ui/Button.js';
import { PageHeader } from '../../ui/PageHeader.js';
import { StateCard } from '../../ui/StateCard.js';
import { Skeleton } from '../../ui/Skeleton.js';
import { BookOpenIcon, CheckIcon, CopyIcon, SearchIcon, XIcon } from '../../ui/icons/index.js';
import { copyToClipboard } from '../../ui/copyToClipboard.js';
import { toast } from '../../ui/toast.js';
import { useFormat } from '../../i18n/useFormat.js';
import { getDocsNav, docMarkdownUrl, type DocsNavItem } from './docsClient.js';
import { deriveToc, type TocEntry } from './docsToc.js';

/** Below this the filter is noise — a reader can see every doc at once. */
const FILTER_MIN_DOCS = 8;

/** R2-D8 — which focus chord to ADVERTISE (both always work; the hint used to
 *  hard-code "⌘K", teaching Windows/Linux readers the wrong — or no — chord). */
const IS_APPLE = typeof navigator !== 'undefined' && /Mac|iP(?:hone|ad|od)/.test(navigator.platform || navigator.userAgent);

/** R2-D12 — fetch the page's `.md` projection and copy it. Hidden when the
 *  browser exposes no clipboard (the CopyLinkButton rule: never a dead
 *  control); a failed fetch toasts, a success flips the label briefly. */
function CopyMarkdownButton({ orgId, slug }: { orgId: string; slug: string }): JSX.Element | null {
  const { t } = useTranslation('docs');
  const [copied, setCopied] = useState(false);
  const canCopy = typeof navigator !== 'undefined' && Boolean(navigator.clipboard);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);
  if (!canCopy) return null;
  const onClick = async (): Promise<void> => {
    try {
      const res = await fetch(docMarkdownUrl(orgId, slug));
      if (!res.ok) throw new Error(String(res.status));
      const md = await res.text();
      const r = await copyToClipboard(md, null);
      setCopied(r.ok);
    } catch {
      toast.error(t('copyMarkdownFailed'));
    }
  };
  return (
    <Button variant="quiet" size="sm" className="u-w-auto" onClick={() => { void onClick(); }}>
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      <span aria-live="polite">{copied ? t('copyMarkdownCopied') : t('copyMarkdown')}</span>
    </Button>
  );
}

/** Group label from the `docsNav` path-prefix convention (`getting-started/10`
 *  → "getting-started"); no prefix ⇒ ungrouped. Order is a sort key, never
 *  shown (numbering would encode a false sequence — design pass). */
function groupOf(d: DocsNavItem): string | null {
  const slash = d.order.indexOf('/');
  return slash > 0 ? d.order.slice(0, slash) : null;
}

/** A group label as shown to a reader (`getting-started` → `getting started`). */
const groupLabel = (g: string): string => g.replace(/-/g, ' ');

/** Group an ordered doc list by its `docsNav` prefix — grouped sections first
 *  (in first-appearance order), ungrouped last. ONE grouping used by BOTH the
 *  sidebar and the index, so the two can never teach different structures. */
function groupDocs(docs: DocsNavItem[]): Array<{ group: string | null; items: DocsNavItem[] }> {
  const byGroup = new Map<string | null, DocsNavItem[]>();
  for (const d of docs) {
    const g = groupOf(d);
    byGroup.set(g, [...(byGroup.get(g) ?? []), d]);
  }
  const named = [...byGroup.entries()].filter(([g]) => g !== null) as Array<[string, DocsNavItem[]]>;
  const rest = byGroup.get(null) ?? [];
  return [
    ...named.map(([g, items]) => ({ group: g as string | null, items })),
    ...(rest.length > 0 ? [{ group: null as string | null, items: rest }] : []),
  ];
}

/** Whether a doc matches the sidebar filter (its title + its group label). */
function docMatches(d: DocsNavItem, q: string): boolean {
  const g = groupOf(d);
  return `${d.title} ${g ? groupLabel(g) : ''}`.toLowerCase().includes(q);
}

export function DocsPublicPage({ orgId, slug }: { orgId: string; slug: string | null }): JSX.Element {
  const { t } = useTranslation('docs');
  const fmt = useFormat();
  // null = loading · [] = designed empty · 'error' = fetch failed (UX-D2).
  const [nav, setNav] = useState<DocsNavItem[] | 'error' | null>(null);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [query, setQuery] = useState('');
  const bodyRef = useRef<HTMLElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  // Instance-unique, never a hard-coded DOM id (the defect class the site pass
  // caught: a duplicate id silently breaks every aria reference to it).
  const hintId = useId();

  // R2-D6 — the error states' Retry re-runs this read (the copy used to say
  // "reload the page"; the article body got a real Retry in #3041, so the nav
  // read matches it now).
  const [navAttempt, setNavAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setNav(null);
    void getDocsNav(orgId).then((items) => { if (live) setNav(items ?? 'error'); });
    return () => { live = false; };
  }, [orgId, navAttempt]);

  // UX-D3 — derive the TOC from the RENDERED article (FrontPage fetches async,
  // so observe until headings appear; re-derive on slug change). The observer
  // disconnects itself once a TOC is found and on cleanup.
  useEffect(() => {
    setToc([]);
    if (!slug || !bodyRef.current) return;
    const container = bodyRef.current;
    const attempt = (): boolean => {
      const entries = deriveToc(container);
      if (entries.length > 0) {
        setToc(entries);
        // R2-D3 — resolve the fragment the browser couldn't: the body renders
        // async, so native fragment navigation on a cold load found no target
        // and a SHARED section link silently landed at the top. One scroll,
        // only when the fragment names a real heading on this page.
        // getElementById, NOT querySelector + CSS.escape — CSS.escape is
        // undefined in jsdom and older embedded webviews (a recorded public-
        // surface crash class), and an id lookup needs no escaping.
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
  }, [slug, orgId]);

  const docs = useMemo(() => (nav === null || nav === 'error' ? [] : nav), [nav]);
  const q = query.trim().toLowerCase();

  // The sidebar shows matches; the ACTIVE doc always stays listed, so filtering
  // can never strand a reader on a page they can no longer navigate from.
  const sidebarDocs = useMemo(
    () => (q ? docs.filter((d) => docMatches(d, q) || d.slug === slug) : docs),
    [docs, q, slug],
  );
  const sidebarGroups = useMemo(() => groupDocs(sidebarDocs), [sidebarDocs]);
  const indexGroups = useMemo(() => groupDocs(docs), [docs]);

  const showFilter = docs.length >= FILTER_MIN_DOCS;

  // `/` or ⌘/Ctrl-K focuses the filter — the shortcut every doc site trains for.
  // Ignored while typing in a field so it never hijacks ordinary input.
  const onGlobalKey = useCallback((e: KeyboardEvent): void => {
    const el = e.target;
    const typing = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey;
    const isCmdK = e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey);
    if (!isSlash && !isCmdK) return;
    if (typing && !isCmdK) return;
    if (!filterRef.current) return;
    e.preventDefault();
    filterRef.current.focus();
    filterRef.current.select();
  }, []);
  useEffect(() => {
    if (!showFilter) return;
    document.addEventListener('keydown', onGlobalKey);
    return () => document.removeEventListener('keydown', onGlobalKey);
  }, [showFilter, onGlobalKey]);

  // D-G3/D-G5 — article chrome derived from the ORDERED nav (the same order the
  // sidebar shows), so pagination and breadcrumb can never disagree with it.
  const active = slug ? docs.find((d) => d.slug === slug) ?? null : null;
  const idx = slug ? docs.findIndex((d) => d.slug === slug) : -1;
  const prev = idx > 0 ? docs[idx - 1] : undefined;
  const next = idx >= 0 && idx < docs.length - 1 ? docs[idx + 1] : undefined;
  const activeGroup = active ? groupOf(active) : null;

  /** The in-page TOC, rendered only under the ACTIVE nav item. */
  const tocFor = (d: DocsNavItem): JSX.Element | null => (
    d.slug === slug && toc.length > 0 ? (
      <ul className="u-m-0 u-p-0 u-list-none docs-toc" aria-label={t('onThisPage')}>
        {toc.map((e) => (
          <li key={e.id}>
            <a href={`#${e.id}`} className={e.level === 3 ? 'docs-toc-item docs-toc-item--nested' : 'docs-toc-item'}>{e.text}</a>
          </li>
        ))}
      </ul>
    ) : null
  );

  return (
    <div className="docs-layout u-p-4">
      <nav className="docs-nav surface-card u-p-3" aria-label={t('navLabel')}>
        <div className="action-bar u-items-center u-gap-2 u-mb-2">
          <BookOpenIcon size={18} aria-hidden />
          <strong>{t('navTitle')}</strong>
        </div>

        {showFilter ? (
          <div className="docs-filter-wrap u-mb-2">
            <form role="search" className="docs-filter" onSubmit={(e) => e.preventDefault()}>
              <SearchIcon size={15} aria-hidden />
              <input
                ref={filterRef}
                type="text"
                inputMode="search"
                className="docs-filter__input"
                placeholder={t('filterPlaceholder', { count: docs.length })}
                aria-label={t('filterLabel')}
                aria-describedby={hintId}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); } }}
              />
              {query ? (
                <button type="button" className="docs-filter__clear" onClick={() => setQuery('')} aria-label={t('filterClear')}>
                  <XIcon size={14} />
                </button>
              ) : null}
            </form>
            {/* R2-D8 — advertise the chord the reader's OS actually uses. */}
            <p id={hintId} className="docs-filter__hint">{t('filterHint', { chord: IS_APPLE ? '⌘K' : 'Ctrl+K' })}</p>
            <p className="docs-filter__status" aria-live="polite">
              {q ? t('filterStatus', { count: sidebarDocs.length, total: docs.length }) : ''}
            </p>
          </div>
        ) : null}

        {nav === null ? (
          <Skeleton />
        ) : nav === 'error' ? (
          /* R2-D5 — role="alert" (this node INSERTS on failure, so it announces
             — unlike role=status mounted with content) + a real Retry (R2-D6). */
          <div role="alert" className="u-grid u-gap-1 u-justify-start">
            <p className="u-m-0 u-text-sm muted">{t('navError')}</p>
            <Button variant="quiet" size="sm" className="u-w-auto" onClick={() => setNavAttempt((n) => n + 1)}>{t('common:retry')}</Button>
          </div>
        ) : nav.length === 0 ? (
          <p className="u-m-0 u-text-sm muted">{t('emptyNav')}</p>
        ) : q && sidebarDocs.length === 0 ? (
          <p className="u-m-0 u-text-sm muted">{t('filterEmpty', { query: query.trim() })}</p>
        ) : (
          // D-G2 — GROUPED, matching the index. One `groupDocs` feeds both.
          <div className="u-grid u-gap-3">
            {sidebarGroups.map(({ group, items }) => (
              <div key={group ?? '__ungrouped__'}>
                {group ? <div className="docs-nav-group">{groupLabel(group)}</div> : null}
                <ul className="u-m-0 u-p-0 u-list-none u-grid u-gap-1">
                  {items.map((d) => {
                    const isActive = d.slug === slug;
                    return (
                      <li key={d.slug}>
                        <Link
                          to={`/docs/${encodeURIComponent(d.slug)}`}
                          className={isActive ? 'docs-nav-item docs-nav-item--active' : 'docs-nav-item'}
                          aria-current={isActive ? 'page' : undefined}
                        >
                          {d.title}
                        </Link>
                        {/* UX-D3 — the in-page TOC nests under the ACTIVE item: the
                            sidebar stays the single map; collapses with it at 720px. */}
                        {tocFor(d)}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </nav>

      <main className="docs-body" ref={bodyRef}>
        {slug ? (
          <>
            {/* D-G5 — breadcrumb: where this page sits in the tree. Rendered only
                once the nav resolves, so it never shows a half-trail. */}
            {active ? (
              <nav className="docs-crumbs" aria-label={t('breadcrumbLabel')}>
                <Link to="/docs" className="docs-crumbs__link">{t('navTitle')}</Link>
                {activeGroup ? (
                  <>
                    <span aria-hidden="true" className="docs-crumbs__sep">/</span>
                    <span className="docs-crumbs__group">{groupLabel(activeGroup)}</span>
                  </>
                ) : null}
                <span aria-hidden="true" className="docs-crumbs__sep">/</span>
                <span aria-current="page">{active.title}</span>
              </nav>
            ) : null}

            {/* surface="slug" (R2-G1): a dead/failed docs slug renders the honest
                not-found / error state — never the marketing home page in here.
                The embed config (R2-D1/D2) keeps a renamed slug INSIDE docs
                (/docs/new-slug, not /p/) and points the 404/empty fallback at
                the docs index. `isKnownSlug` is the R2-D4 collection guard —
                consulted by FrontPage AFTER redirect canonicalization (so a
                RENAMED doc still redirects rather than 404ing on its old
                slug), failing OPEN while the nav loads / errors / is at the
                500-doc projection cap (never 404 a real doc over a failed or
                truncated nav read). */}
            <FrontPage
              orgId={orgId} slug={slug} surface="slug"
              embed={{
                basePath: '/docs/', fallbackTo: '/docs', fallbackLabel: t('backToDocs'),
                isKnownSlug: (s) => !(Array.isArray(nav) && nav.length > 0 && nav.length < 500) || nav.some((d) => d.slug === s),
              }}
            />

            {active ? (
              <footer className="docs-article-foot">
                {/* D-G6 — the freshness signal. A machine-readable <time> so the
                    stamp is honest to assistive tech and crawlers alike. */}
                <p className="docs-updated">
                  {t('lastUpdated')}{' '}
                  <time dateTime={active.updatedAt}>{fmt.date(active.updatedAt)}</time>
                </p>
                {/* R2-D12 — 2026 table stakes: agents (and readers pasting into
                    them) get the page as markdown. Hidden without a clipboard —
                    never a dead control. */}
                <CopyMarkdownButton orgId={orgId} slug={slug!} />
                {prev || next ? (
                  <nav className="docs-pager" aria-label={t('pagerLabel')}>
                    {prev ? (
                      <Link to={`/docs/${encodeURIComponent(prev.slug)}`} className="docs-pager__link">
                        <span className="docs-pager__dir">{t('previousDoc')}</span>
                        <span className="docs-pager__title">{prev.title}</span>
                      </Link>
                    ) : <span />}
                    {next ? (
                      <Link to={`/docs/${encodeURIComponent(next.slug)}`} className="docs-pager__link docs-pager__link--end">
                        <span className="docs-pager__dir">{t('nextDoc')}</span>
                        <span className="docs-pager__title">{next.title}</span>
                      </Link>
                    ) : null}
                  </nav>
                ) : null}
              </footer>
            ) : null}
          </>
        ) : (
          <section className="u-grid u-gap-4">
            <PageHeader eyebrow={t('eyebrow')} title={t('indexTitle')} lede={t('indexLede')} />
            {nav === 'error' ? (
              <StateCard
                announce icon={<BookOpenIcon />} title={t('errorTitle')} body={t('errorBody')}
                action={<Button variant="secondary" onClick={() => setNavAttempt((n) => n + 1)}>{t('common:retry')}</Button>}
              />
            ) : nav !== null && nav.length === 0 ? (
              <StateCard icon={<BookOpenIcon />} title={t('emptyTitle')} body={t('emptyBody')} />
            ) : nav !== null && nav.length > 0 ? (
              // UX-D4 — grouped list-cards (not a grid of stubs): one card per
              // docsNav path-prefix group, title-only whole-row links.
              indexGroups.map(({ group, items }) => (
                <div key={group ?? '__ungrouped__'} className="surface-card u-p-4 u-grid u-gap-2">
                  {group ? <div className="u-text-sm muted docs-index-group">{groupLabel(group)}</div> : null}
                  <ul className="u-m-0 u-p-0 u-list-none docs-index-list">
                    {items.map((d) => (
                      <li key={d.slug}>
                        {/* R2-D9 — the freshness stamp the projection carries
                            (D-G6) now shows where readers scan for currency,
                            not only on the article foot. One anchor per row. */}
                        <Link to={`/docs/${encodeURIComponent(d.slug)}`} className="docs-index-item">
                          <span>{d.title}</span>
                          <time dateTime={d.updatedAt} className="docs-index-updated">{fmt.date(d.updatedAt)}</time>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            ) : null}
          </section>
        )}
      </main>
    </div>
  );
}
