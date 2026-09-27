/**
 * `/memory` route — MemoryAdapter inspector (RFC 0004 read-side).
 *
 * Lists the authenticated tenant's memory entries (host-extension
 * GET /host/openwop-app/memory), with a free-text search over content + tags
 * and an optional server-side tag filter. Each row can be deleted via the
 * demo-only DELETE /host/openwop-app/memory/:memoryId route.
 *
 * Companion to RunMemoryPanel (which shows the same ledger scoped to a single
 * run); this is the standalone, run-agnostic browser. Reuses the same
 * `.memory-table` / `.memory-tag` styles for visual consistency.
 *
 * CTI-1: every read/delete is tenant-scoped server-side from the caller's
 * principal. The page never sends a tenantId — tenant selection is the auth
 * layer's job — so it cannot cross a tenant boundary.
 */

import { Button } from '../ui/Button.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { formatNumber } from '../i18n/format.js';
import { deleteMemoryEntry, listMemory, type MemoryEntry } from './lib/memoryClient.js';
import { DatabaseIcon, TrashIcon } from '../ui/icons/index.js';
import { PageHeader } from '../ui/PageHeader.js';
import { DataTable, type DataColumn } from '../ui/DataTable.js';
import { ViewToggle, useViewMode } from '../ui/ViewToggle.js';
import { MemoryCard, MemoryContent, MemoryTags, MemoryCreated } from './MemoryViews.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { TextField } from '../ui/Field.js';
import { toast } from '../ui/toast.js';

export function MemoryInspectorPage(): JSX.Element {
  const { t } = useTranslation('memory');
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [memoryRef, setMemoryRef] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // List/grid collection view (§4.5 canon), persisted per-user. `list` keeps the
  // selectable table (bulk-delete is a list-only affordance); `grid` shows cards.
  const [view, setView] = useViewMode('memory', 'list');

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listMemory({ limit: 200, ...(tag ? { tag } : {}) });
      setEntries(res.entries);
      setMemoryRef(res.memoryRef);
    } catch (err) {
      // TWIN-8 — a FAILED read used to resolve to `[]`, i.e. an empty ledger,
      // which is a claim ("you have no memories") the read never established.
      // `null` keeps it out of the list branch; the error Notice below is what
      // the user sees, and the skeleton is suppressed so it cannot spin forever.
      setError(err instanceof Error ? err.message : String(err));
      setEntries(null);
    }
  }, [tag]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Free-text search is client-side over the tenant-scoped result set (the
  // host route exposes a tag filter but no full-text index).
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = entries ?? [];
    if (!term) return list;
    return list.filter(
      (e) =>
        e.content.toLowerCase().includes(term) ||
        e.tags.some((t) => t.toLowerCase().includes(term)),
    );
  }, [entries, search]);

  async function onDelete(e: MemoryEntry) {
    if (!(await confirm({ title: t('confirmDelete', { id: e.id }), danger: true, confirmLabel: t('common:delete') }))) return;
    try {
      await deleteMemoryEntry(e.id, memoryRef || undefined);
      toast.success(t('deleteSuccess'));
      await refresh();
    } catch (err) {
      // TWIN-8 — this used to `setError(...)`, and the list branch is guarded by
      // `!error`, so ONE failed row delete UNMOUNTED THE WHOLE LEDGER. `error` is
      // the READ's state; a write failure is reported by its own toast, exactly
      // as `onBulkDelete` already does (`:86-96`, the correct sibling).
      toast.error(err instanceof Error ? err.message : t('deleteError'));
    }
  }

  async function onBulkDelete(rows: MemoryEntry[]) {
    if (rows.length === 0) return;
    if (!(await confirm({ title: t('confirmBulkDelete', { count: rows.length, n: formatNumber(rows.length) }), danger: true, confirmLabel: t('common:delete') }))) return;
    const results = await Promise.allSettled(rows.map((e) => deleteMemoryEntry(e.id, memoryRef || undefined)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    const ok = rows.length - failed;
    if (ok > 0) toast.success(t('bulkDeleteSuccess', { count: ok, n: formatNumber(ok) }));
    if (failed > 0) toast.error(t('bulkDeleteError', { count: failed, n: formatNumber(failed) }));
    setSelected(new Set());
    await refresh();
  }

  const columns: DataColumn<MemoryEntry>[] = [
    {
      key: 'content',
      header: t('columnContent'),
      render: (e) => <MemoryContent entry={e} />,
    },
    {
      key: 'tags',
      header: t('columnTags'),
      cellClassName: 'memory-tags',
      render: (e) => <MemoryTags entry={e} />,
    },
    {
      key: 'created',
      header: t('columnCreated'),
      cellClassName: 'memory-created',
      sortValue: (e) => (e.createdAt ? Date.parse(e.createdAt) : 0),
      render: (e) => <MemoryCreated entry={e} />,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (e) => (
        <Button variant="secondary" size="sm" onClick={() => { void onDelete(e); }} title={t('deleteEntryTitle')} aria-label={t('deleteEntryAria', { id: e.id })}>
          <TrashIcon size={13} />
        </Button>
      ),
    },
  ];

  // Shared empty node — rendered for BOTH the grid and the list so the two views
  // stay consistent.
  const emptyCard = (
    <StateCard
      icon={<DatabaseIcon size={28} />}
      title={search || tag ? t('emptyNoMatchTitle') : t('emptyNoEntriesTitle')}
      body={search || tag ? t('emptyNoMatchBody') : t('emptyNoEntriesBody')}
      {...(search || tag
        ? { action: <Button variant="secondary" size="sm" onClick={() => { setSearch(''); setTag(''); }}>{t('clearFilters')}</Button> }
        : {})}
    />
  );

  return (
    <section data-walkthrough="memory.page">
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('inspectorTitle')}
        lede={<>{t('inspectorLedePrefix')}{memoryRef && <> {t('inspectorLedeShowing')} <code>{memoryRef}</code>.</>}</>}
        actions={<Button variant="secondary" onClick={() => { void refresh(); }}>{t('common:refresh')}</Button>}
      />
      <div className="surface-card">

        <div className="filterbar u-items-end">
          <TextField
            className="filterbar-search"
            label={<>{t('searchLabel')} <span className="muted">{t('searchHint')}</span></>}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
          />
          <TextField
            className="memory-tag-field"
            label={<>{t('tagFilterLabel')} <span className="muted">{t('tagFilterHint')}</span></>}
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder={t('tagFilterPlaceholder')}
            onKeyDown={(e) => { if (e.key === 'Enter') void refresh(); }}
          />
        </div>

        {error && <Notice variant="error">{error}</Notice>}

        {entries === null && !error && <SkeletonRows rows={5} columns={[24, '60%', 120, 140, 60]} />}

        {entries !== null && !error && (
          <>
            <div className="action-bar u-justify-between">
              <p className="muted u-fs-12 u-m-0">
                {t('entryCount', { count: filtered.length, n: formatNumber(filtered.length) })}
                {entries.length !== filtered.length ? ` ${t('entryCountOf', { shown: formatNumber(filtered.length), total: formatNumber(entries.length) })}` : ''}
              </p>
              <ViewToggle value={view} onChange={setView} />
            </div>
            {filtered.length === 0 ? (
              emptyCard
            ) : view === 'grid' ? (
              <div className="card-grid">
                {filtered.map((e) => (
                  <MemoryCard key={e.id} entry={e} onDelete={(x) => { void onDelete(x); }} />
                ))}
              </div>
            ) : (
              <DataTable
                rows={filtered}
                rowKey={(e) => e.id}
                columns={columns}
                caption={t('tableCaption')}
                initialSort={{ key: 'created', dir: 'desc' }}
                selectable
                selected={selected}
                onSelectionChange={setSelected}
                bulkActions={(rows) => (
                  <Button variant="secondary" size="sm" onClick={() => { void onBulkDelete(rows); }}>
                    <TrashIcon size={13} /> {t('deleteSelected')}
                  </Button>
                )}
                empty={emptyCard}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}
