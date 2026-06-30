/**
 * Library (ADR 0083 P3) — a cross-source gallery of every artifact the AI produced:
 * run outputs (run-event), generated documents, and uploaded media. Lists the type-neutral
 * `artifactProjection` (GET /v1/host/openwop-app/artifacts) and opens any row in the existing
 * `ArtifactWorkbench` (preview / raw / revisions / diff / provenance) — no parallel viewer.
 *
 * Token-only (DESIGN.md): no color literals; status/source shown as labeled chips + icons.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../ui/PageHeader.js';
import { handleTablistKeyDown } from '../../ui/rovingTabs.js';
import { DataTable, type DataColumn } from '../../ui/DataTable.js';
import { ViewToggle, useViewMode } from '../../ui/ViewToggle.js';
import { Notice } from '../../ui/Notice.js';
import { StateCard } from '../../ui/StateCard.js';
import { BoxesIcon } from '../../ui/icons/index.js';
import { formatDate } from '../../i18n/format.js';
import { listArtifacts, type ArtifactProjection } from './artifactClient.js';
import { ArtifactWorkbench } from './ArtifactWorkbench.js';
import { ArtifactCard, sourceIcon, sourceLabel } from './ArtifactViews.js';

type Tab = 'all' | 'images' | 'files';

export function LibraryPage(): JSX.Element {
  const { t } = useTranslation('chat');
  const [artifacts, setArtifacts] = useState<ArtifactProjection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
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
    if (tab === 'images') return artifacts.filter((a) => a.kind === 'image');
    if (tab === 'files') return artifacts.filter((a) => a.kind !== 'image');
    return artifacts;
  }, [artifacts, tab]);

  const columns: DataColumn<ArtifactProjection>[] = [
    {
      key: 'name', header: t('libraryColName'),
      render: (a) => (
        <span className="u-iflex u-items-center u-gap-1-5">{sourceIcon(a)} {a.title}</span>
      ),
      sortValue: (a) => a.title.toLowerCase(),
    },
    { key: 'type', header: t('libraryColType'), render: (a) => <span className="chip">{a.kind}</span>, sortValue: (a) => a.kind },
    { key: 'source', header: t('libraryColSource'), render: (a) => sourceLabel(a.source, t), sortValue: (a) => a.source, cellClassName: 'muted' },
    { key: 'modified', header: t('libraryColModified'), align: 'right', render: (a) => formatDate(a.createdAt), sortValue: (a) => a.createdAt, cellClassName: 'muted' },
  ];

  const tabs: { id: Tab; label: string }[] = [
    { id: 'all', label: t('libraryAll') },
    { id: 'images', label: t('libraryImages') },
    { id: 'files', label: t('libraryFiles') },
  ];

  return (
    <section className="u-p-4 u-flex u-flex-col u-gap-4">
      <PageHeader eyebrow={t('libraryEyebrow')} title={t('libraryTitle')} lede={t('libraryLede')} />

      {error ? <Notice variant="warning">{t('libraryError')}</Notice> : null}

      <div className="u-flex u-items-center u-gap-3 u-wrap">
        <div className="action-bar u-gap-1-5" role="tablist" aria-label={t('libraryTitle')} onKeyDown={handleTablistKeyDown}>
          {tabs.map((tb) => (
            <button
              key={tb.id}
              type="button"
              role="tab"
              id={`lib-tab-${tb.id}`}
              aria-selected={tab === tb.id}
              tabIndex={tab === tb.id ? 0 : -1}
              aria-controls="lib-panel"
              className={tab === tb.id ? 'btn-sm' : 'secondary btn-sm'}
              onClick={() => setTab(tb.id)}
            >
              {tb.label}
            </button>
          ))}
        </div>
        <ViewToggle value={viewMode} onChange={setViewMode} className="u-ml-auto" labels={{ list: t('libraryViewTable') }} />
      </div>

      <div role="tabpanel" id="lib-panel" aria-labelledby={`lib-tab-${tab}`}>
        {!loaded ? (
          <StateCard title={t('libraryLoading')} loading />
        ) : rows.length === 0 ? (
          <StateCard icon={<BoxesIcon size={20} />} title={t('libraryEmpty')} />
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

      {cursor && tab === 'all' ? (
        <div className="u-flex u-justify-center">
          <button type="button" className="secondary btn-sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? t('libraryLoading') : t('libraryLoadMore')}
          </button>
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
