/**
 * Memory-entry Card + shared cells — the grid cell of the §4.5 collection-view
 * canon for the Memory inspector. The page's `<ViewToggle>` switches between the
 * selectable `<DataTable>` (`list`) and a `.card-grid` of `<MemoryCard>` (`grid`).
 *
 * Bulk-select + bulk-delete are a table affordance (the checkbox column), so they
 * stay LIST-only; the grid offers a scannable read view with per-card delete, and
 * the toggle defaults to `list` so no capability is lost. `<MemoryContent>`,
 * `<MemoryTags>` and `<MemoryCreated>` are shared by both the card and the table
 * columns so grid and list never diverge. Reuses the existing `.memory-*` styles
 * — no new CSS.
 */

import { Button } from '../ui/Button.js';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../i18n/format.js';
import { LockIcon, TrashIcon } from '../ui/icons/index.js';
import type { MemoryEntry } from './lib/memoryClient.js';

export function isRedacted(content: string): boolean {
  return /\[REDACTED:[^\]]*\]/.test(content);
}

/** Redacted badge (if any) + the entry content — the `content` column + card body. */
export function MemoryContent({ entry: e }: { entry: MemoryEntry }): JSX.Element {
  const { t } = useTranslation('memory');
  return (
    <>
      {isRedacted(e.content) && (
        <span className="memory-redacted-badge" title={t('redactedTitle')}>
          <LockIcon size={12} /> {t('redactedBadge')}
        </span>
      )}
      <span className="memory-content">{e.content}</span>
    </>
  );
}

/** The entry's tags — shared by the `tags` column + card. Renders nothing when
 *  the entry has no tags (avoids a phantom gap in the card). */
export function MemoryTags({ entry: e }: { entry: MemoryEntry }): JSX.Element | null {
  if (e.tags.length === 0) return null;
  return <>{e.tags.map((tag) => <span key={tag} className="memory-tag">{tag}</span>)}</>;
}

/** Created timestamp + optional TTL suffix — shared by the `created` column + card. */
export function MemoryCreated({ entry: e }: { entry: MemoryEntry }): JSX.Element {
  const { t } = useTranslation('memory');
  return (
    <span title={e.createdAt}>
      {formatDateTime(e.createdAt)}
      {e.expiresAt && <span className="muted" title={t('expiresTitle', { date: formatDateTime(e.expiresAt) })}> · {t('ttlSuffix')}</span>}
    </span>
  );
}

export function MemoryCard({ entry: e, onDelete }: { entry: MemoryEntry; onDelete: (e: MemoryEntry) => void }): JSX.Element {
  const { t } = useTranslation('memory');
  return (
    <div className="surface-card u-grid u-gap-2">
      <div className="u-fs-13"><MemoryContent entry={e} /></div>
      <div className="memory-tags u-flex u-gap-1 u-wrap"><MemoryTags entry={e} /></div>
      <div className="u-flex u-items-center u-gap-2 u-wrap memory-created">
        <MemoryCreated entry={e} />
        <Button
          variant="secondary" size="sm" className="u-ml-auto"
          onClick={() => onDelete(e)}
          title={t('deleteEntryTitle')}
          aria-label={t('deleteEntryAria', { id: e.id })}
        >
          <TrashIcon size={13} />
        </Button>
      </div>
    </div>
  );
}
