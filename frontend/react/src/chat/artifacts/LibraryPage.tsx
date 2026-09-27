/**
 * Library (ADR 0083 P3, §Amendment 2026-07-05) — a cross-source gallery of the
 * generated ASSETS the AI produced: documents, media (images/video/audio/pdf), and
 * TYPED run artifacts (slide decks, CAD, campaigns, app designs, drawings, charts,
 * code results, …). Raw JSON/text run OUTPUTS are filtered out server-side
 * (`isLibraryAsset`) — the Library is an asset library, not a run log. Lists the
 * type-neutral `artifactProjection` (GET /host/openwop-app/artifacts) and opens
 * any row in the existing `ArtifactWorkbench` (preview / raw / revisions / diff /
 * provenance) — no parallel viewer.
 *
 * Token-only (DESIGN.md): no color literals; status/source shown as labeled chips + icons.
 */

import { Button } from '../../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { handleTablistKeyDown } from '../../ui/rovingTabs.js';
import { useUrlTab } from '../../ui/Tabs.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { BoxesIcon } from '../../ui/icons/index.js';
import { formatDate } from '../../i18n/format.js';
import { listArtifacts, type ArtifactProjection } from './artifactClient.js';
import { ArtifactWorkbench } from './ArtifactWorkbench.js';
import { ArtifactCard, sourceIcon, sourceLabel, artifactKindLabel } from './ArtifactViews.js';

type Tab = 'all' | 'images' | 'files';

/**
 * ONE VOICE PER FAILURE — which of the two error surfaces on this page speaks.
 *
 * The warning Notice and the empty-state `StateCard` are both gated on the same
 * `error`, and both can call `announce()`. Two callers of ONE polite region for ONE
 * event race, and the later render wins, so a screen-reader user hears whichever
 * landed last and can lose the other. That is DS-8 (`toast.tsx:80`, "a double region
 * made errors announce twice") by a different route: not two regions, but two callers
 * of one region.
 *
 * The house rule is "when both are present, the CARD announces" — it is the page's
 * state; the Notice stays a visual report. But the card is **not always present**: it
 * renders only on `loaded && rowCount === 0`. With rows on screen and a refresh
 * failure the card never mounts, so deferring unconditionally would trade the race for
 * SILENCE — a worse defect than the one being fixed.
 *
 * Exported and named rather than inlined so the rule is testable without mounting the
 * whole page, and so a change to the card's render condition is a visible edit here
 * instead of a silent regression.
 */
export function noticeCarriesTheVoice(loaded: boolean, rowCount: number): boolean {
  const cardWillRenderAndAnnounce = loaded && rowCount === 0;
  return !cardWillRenderAndAnnounce;
}

export function LibraryPage(): JSX.Element {
  const { t } = useTranslation('chat');
  const [artifacts, setArtifacts] = useState<ArtifactProjection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  // Tab rides `?tab=` (useUrlTab) — reload/share keeps the filter.
  const [tab, setTab] = useUrlTab<Tab>('tab', ['all', 'images', 'files'], 'all');
  // Name search — CLIENT-side over the loaded pages (the list route paginates
  // with no `q` param). Honesty rides the existing "more pages may match"
  // empty state below, exactly like the tab filters.
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<ArtifactProjection | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined); // ART-1 — next-page cursor
  const [loadingMore, setLoadingMore] = useState(false);
  // ADR 0131 — a DataTable operate-surface: the sortable table stays the default
  // "list" view; Grid is the opt-in card presentation alongside it.
  const [viewMode, setViewMode] = useViewMode('library', 'list');

  useEffect(() => {
    let cancelled = false;
    listArtifacts({ limit: 100 })
      .then((page) => { if (!cancelled) { setArtifacts(page.artifacts); setCursor(page.nextCursor); setLoaded(true); } })
      .catch(() => { if (!cancelled) { setError(true); setLoaded(true); } });
    return () => { cancelled = true; };
  }, []);

  // ART-1 — append the next bounded page (the Library no longer ships every row at once).
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listArtifacts({ limit: 100, cursor });
      setArtifacts((prev) => [...prev, ...page.artifacts]);
      setCursor(page.nextCursor);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  const rows = useMemo(() => {
    const byTab = tab === 'images' ? artifacts.filter((a) => a.kind === 'image')
      : tab === 'files' ? artifacts.filter((a) => a.kind !== 'image')
      : artifacts;
    const q = query.trim().toLowerCase();
    return q ? byTab.filter((a) => a.title.toLowerCase().includes(q)) : byTab;
  }, [artifacts, tab, query]);

  const columns: DataColumn<ArtifactProjection>[] = [
    {
      key: 'name', header: t('libraryColName'),
      render: (a) => (
        <span className="u-iflex u-items-center u-gap-1-5">{sourceIcon(a)} {a.title}</span>
      ),
      sortValue: (a) => a.title.toLowerCase(),
    },
    { key: 'type', header: t('libraryColType'), render: (a) => <span className="chip chip--muted">{artifactKindLabel(a, t)}</span>, sortValue: (a) => artifactKindLabel(a, t) },
    { key: 'source', header: t('libraryColSource'), render: (a) => sourceLabel(a.source, t), sortValue: (a) => a.source, cellClassName: 'muted' },
    { key: 'modified', header: t('libraryColModified'), align: 'right', render: (a) => formatDate(a.createdAt), sortValue: (a) => a.createdAt, cellClassName: 'muted' },
  ];

  const tabs: { id: Tab; label: string }[] = [
    { id: 'all', label: t('libraryAll') },
    { id: 'images', label: t('libraryImages') },
    { id: 'files', label: t('libraryFiles') },
  ];

  return (
    <section data-walkthrough="library.page" className="u-p-4 u-flex u-flex-col u-gap-4">
      <PageHeader eyebrow={t('libraryEyebrow')} title={t('libraryTitle')} lede={t('libraryLede')} />

      {/*
        ONE VOICE PER FAILURE (openwop-app-2's finding, tranche-1 intersection). Both this
        Notice and the empty-state StateCard below were gated on the same `error` and both
        called `announce()`. Two callers of ONE polite region for ONE event race, and the
        later render wins — so a screen-reader user heard whichever landed last and could
        lose the other. That is DS-8 by a different route: not two regions (`toast.tsx:80`),
        but two callers of one region.

        The house rule is "when both are present, the CARD announces" — it is the page's
        state, and the Notice stays a visual report. But the card is NOT always present:
        it renders only on `loaded && rows.length === 0` (see the tabpanel below). With
        rows on screen and a refresh failure, the card never mounts, so deferring
        unconditionally would trade the race for SILENCE — a worse defect than the one
        being fixed.

        So this announces exactly when the card will not, computed from the card's own
        render condition rather than duplicating the logic. Exactly one voice in both
        states, and a change to that condition surfaces here as a type/scope error rather
        than as a silent regression.
      */}
      {error ? (
        <Notice
          variant="warning"
          {...(noticeCarriesTheVoice(loaded, rows.length) ? { announce: t('libraryError') } : {})}
        >
          {t('libraryError')}
        </Notice>
      ) : null}

      <div className="u-flex u-items-center u-gap-3 u-wrap">
        <div className="tabs" role="tablist" aria-label={t('libraryTitle')} onKeyDown={handleTablistKeyDown}>
          {tabs.map((tb) => (
            <button
              key={tb.id}
              type="button"
              role="tab"
              id={`lib-tab-${tb.id}`}
              aria-selected={tab === tb.id}
              tabIndex={tab === tb.id ? 0 : -1}
              aria-controls="lib-panel"
              className="tab"
              onClick={() => setTab(tb.id)}
            >
              {tb.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="ui-input filterbar-search"
          placeholder={t('librarySearchPlaceholder')}
          aria-label={t('librarySearchAria')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" labels={{ list: t('libraryViewTable') }} />
      </div>

      <div role="tabpanel" id="lib-panel" aria-labelledby={`lib-tab-${tab}`}>
        {!loaded ? (
          <StateCard title={t('libraryLoading')} loading />
        ) : rows.length === 0 ? (
          // A filtered tab (Images/Files) may have no matches on the loaded page while
          // more exist server-side — say so and keep "Load more" reachable, don't lie "empty".
          //
          // UX-LIB-1 — that "don't lie 'empty'" rule was delivered for the
          // PAGINATION case (cursor) and the SEARCH case (query) but not for a
          // FAILED READ. The warning Notice above does fire, but this card still
          // said "No assets yet. Generate a document, deck, image, or design and
          // it'll appear here." — telling someone whose library just failed to
          // load to go regenerate work they already own. An error beside a false
          // claim is still a false claim (same shape as UX-BRD-1 on /boards).
          //
          // The `error` arm must come FIRST in each spread below — a later
          // conditional spread of the same key would silently overwrite it.
          <StateCard
            announce={!!error}
            icon={<BoxesIcon size={20} />}
            title={error ? t('libraryUnavailableTitle')
              : cursor ? t('libraryMorePagesTitle') : (query ? t('libraryNoMatch') : t('libraryEmpty'))}
            {...(error ? { body: t('libraryUnavailableBody') }
              : cursor ? { body: t('libraryMorePagesBody') } : {})}
            {...(!error && query ? { action: <Button variant="secondary" onClick={() => setQuery('')}>{t('libraryClearSearch')}</Button> } : {})}
          />
        ) : viewMode === 'grid' ? (
          <div className="card-grid">
            {rows.map((a) => <ArtifactCard key={a.artifactId} artifact={a} onOpen={() => setOpen(a)} />)}
          </div>
        ) : (
          <div className="surface-card">
            <DataTable<ArtifactProjection>
              columns={columns}
              rows={rows}
              rowKey={(a) => a.artifactId}
              caption={t('libraryTitle')}
              onRowClick={(a) => setOpen(a)}
              initialSort={{ key: 'modified', dir: 'desc' }}
              empty={<StateCard icon={<BoxesIcon size={20} />} title={t('libraryEmpty')} />}
            />
          </div>
        )}
      </div>

      {cursor ? (
        <div className="u-flex u-justify-center">
          <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? t('libraryLoading') : t('libraryLoadMore')}
          </Button>
        </div>
      ) : null}

      {open ? (
        <ArtifactWorkbench
          artifactId={open.artifactId}
          {...(open.latestRevisionId ? { revisionId: open.latestRevisionId } : {})}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </section>
  );
}
