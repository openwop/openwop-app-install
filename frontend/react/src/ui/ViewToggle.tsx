/**
 * <ViewToggle> — the ONE grid/list switch for collection pages (the §4.5
 * "Collection view canon"). A `.segmented` control (the documented view-toggle
 * primitive, sibling of <DensityToggle>) with two `aria-pressed` buttons:
 * Grid (cards in a `.card-grid`) · List (dense rows in a `.list-view`).
 *
 * Extracted from the hand-rolled toggle on `/agents` so every collection
 * surface (Projects, Documents, Advisors, Strategy, Priority-matrix, Agents)
 * shares one control instead of copy-pasting it. A surface MUST NOT reimplement
 * a second grid/list switch — render this. Pair it with `useViewMode` to
 * persist the choice per-surface in `localStorage`.
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BoxesIcon, ListIcon } from './icons/index.js';

export type CollectionView = 'grid' | 'list';

export function ViewToggle({
  value,
  onChange,
  className,
  labels,
}: {
  value: CollectionView;
  onChange: (v: CollectionView) => void;
  /** Extra classes on the segmented root (e.g. `u-ml-auto` to push it right). */
  className?: string;
  /** Per-surface label overrides — e.g. agents calls the grid view "Tiles". */
  labels?: { grid?: string; list?: string };
}): JSX.Element {
  const { t } = useTranslation('ui');
  const gridLabel = labels?.grid ?? t('viewGrid');
  const listLabel = labels?.list ?? t('viewList');
  return (
    <div
      className={`segmented view-toggle${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={t('viewToggleLabel')}
    >
      <button type="button" aria-pressed={value === 'grid'} title={gridLabel} onClick={() => onChange('grid')}>
        <BoxesIcon size={14} aria-hidden /> <span className="view-toggle-label">{gridLabel}</span>
      </button>
      <button type="button" aria-pressed={value === 'list'} title={listLabel} onClick={() => onChange('list')}>
        <ListIcon size={14} aria-hidden /> <span className="view-toggle-label">{listLabel}</span>
      </button>
    </div>
  );
}

/**
 * Per-surface grid/list preference, persisted to `localStorage`. Pass a stable
 * key (e.g. `'projects'`) so each surface remembers its own choice. Falls back
 * gracefully when storage is unavailable (private mode / SSR).
 */
export function useViewMode(
  storageKey: string,
  fallback: CollectionView = 'grid',
): [CollectionView, (v: CollectionView) => void] {
  const key = `openwop:view:${storageKey}`;
  const [view, setView] = useState<CollectionView>(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === 'grid' || saved === 'list' ? saved : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (v: CollectionView) => {
      setView(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        /* storage unavailable — keep the in-memory choice */
      }
    },
    [key],
  );
  return [view, set];
}
