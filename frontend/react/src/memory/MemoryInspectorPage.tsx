/**
 * `/memory` route — MemoryAdapter inspector (RFC 0004 read-side).
 *
 * Lists the authenticated tenant's memory entries (host-extension
 * GET /v1/host/openwop-app/memory), with a free-text search over content + tags
 * and an optional server-side tag filter. Each row can be deleted via the
 * demo-only DELETE /v1/host/openwop-app/memory/:memoryId route.
 *
 * Companion to RunMemoryPanel (which shows the same ledger scoped to a single
 * run); this is the standalone, run-agnostic browser. Reuses the same
 * `.memory-table` / `.memory-tag` styles for visual consistency.
 *
 * CTI-1: every read/delete is tenant-scoped server-side from the caller's
 * principal. The page never sends a tenantId — tenant selection is the auth
 * layer's job — so it cannot cross a tenant boundary.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirm } from '../ui/confirm.js';
import { formatDateTime, formatNumber } from '../i18n/format.js';
import { deleteMemoryEntry, listMemory, type MemoryEntry } from './lib/memoryClient.js';
import { DatabaseIcon, LockIcon, TrashIcon } from '../ui/icons/index.js';
import { PageHeader } from '../ui/PageHeader.js';
import { DataTable, DensityToggle, type DataColumn } from '../ui/DataTable.js';
import { SkeletonRows } from '../ui/Skeleton.js';
import { Notice } from '../ui/Notice.js';
import { StateCard } from '../ui/StateCard.js';
import { TextField } from '../ui/Field.js';
import { toast } from '../ui/toast.js';

function isRedacted(content: string): boolean {
  return /\[REDACTED:[^\]]*\]/.test(content);
}

export function MemoryInspectorPage(): JSX.Element {
  const { t } = useTranslation('memory');
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [memoryRef, setMemoryRef] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listMemory({ limit: 200, ...(tag ? { tag } : {}) });
      setEntries(res.entries);
      setMemoryRef(res.memoryRef);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntries([]);
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
      setError(err instanceof Error ? err.message : String(err));
      toast.error(t('deleteError'));
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
      render: (e) => (
        <>
          {isRedacted(e.content) && (
            <span className="memory-redacted-badge" title={t('redactedTitle')}>
              <LockIcon size={12} /> {t('redactedBadge')}
            </span>
          )}
          <span className="memory-content">{e.content}</span>
        </>
      ),
    },
    {
      key: 'tags',
      header: t('columnTags'),
      cellClassName: 'memory-tags',
      render: (e) => e.tags.map((t) => <span key={t} className="memory-tag">{t}</span>),
    },
    {
      key: 'created',
      header: t('columnCreated'),
      cellClassName: 'memory-created',
      sortValue: (e) => (e.createdAt ? Date.parse(e.createdAt) : 0),
      render: (e) => (
        <span title={e.createdAt}>
          {formatDateTime(e.createdAt)}
          {e.expiresAt && <span className="muted" title={t('expiresTitle', { date: formatDateTime(e.expiresAt) })}> · {t('ttlSuffix')}</span>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (e) => (
        <button className="secondary btn-sm" onClick={() => { void onDelete(e); }} title={t('deleteEntryTitle')} aria-label={t('deleteEntryAria', { id: e.id })}>
          <TrashIcon size={13} />
        </button>
      ),
    },
  ];

  return (
    <section>
      <PageHeader
        eyebrow={t('eyebrow')}
        title={t('inspectorTitle')}
        lede={<>{t('inspectorLedePrefix')}{memoryRef && <> {t('inspectorLedeShowing')} <code>{memoryRef}</code>.</>}</>}
        actions={<button className="secondary" onClick={() => { void refresh(); }}>{t('common:refresh')}</button>}
      />
      <div className="surface-card">

        <div className="form-row u-flex u-gap-2 u-wrap u-items-end">
          <TextField
            className="memory-search-field"
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

        {entries === null && <SkeletonRows rows={5} columns={[24, '60%', 120, 140, 60]} />}

        {entries !== null && !error && (
          <>
            <div className="action-bar u-justify-between">
              <p className="muted u-fs-12 u-m-0">
                {t('entryCount', { count: filtered.length, n: formatNumber(filtered.length) })}
                {entries.length !== filtered.length ? ` ${t('entryCountOf', { shown: formatNumber(filtered.length), total: formatNumber(entries.length) })}` : ''}
              </p>
              <DensityToggle value={density} onChange={setDensity} />
            </div>
            <DataTable
              rows={filtered}
              rowKey={(e) => e.id}
              columns={columns}
              density={density}
              caption={t('tableCaption')}
              initialSort={{ key: 'created', dir: 'desc' }}
              selectable
              selected={selected}
              onSelectionChange={setSelected}
              bulkActions={(rows) => (
                <button className="secondary btn-sm" onClick={() => { void onBulkDelete(rows); }}>
                  <TrashIcon size={13} /> {t('deleteSelected')}
                </button>
              )}
              empty={
                <StateCard
                  icon={<DatabaseIcon size={28} />}
                  title={search || tag ? t('emptyNoMatchTitle') : t('emptyNoEntriesTitle')}
                  body={
                    search || tag
                      ? t('emptyNoMatchBody')
                      : t('emptyNoEntriesBody')
                  }
                />
              }
            />
          </>
        )}
      </div>
    </section>
  );
}
