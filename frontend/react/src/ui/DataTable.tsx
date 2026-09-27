import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../i18n/format.js';
import { announce } from './announce.js';
import { ChevronDownIcon } from './icons/index.js';

/**
 * <DataTable> — the one tabular-data primitive for the operate surfaces
 * (Runs, Memory, Orgs, …). Sticky header, click-to-sort columns, a static
 * comfortable/compact `density` prop (a fixed per-table layout choice — the
 * user-facing density *toggle* was retired in favour of the list/grid
 * <ViewToggle>), optional row-click navigation, optional
 * bulk-select + bulk-action bar, and a built-in empty slot. Token-only styling
 * lives under `.data-table` in global.css. A surface MUST NOT hand-roll a
 * second sortable table.
 *
 * Sorting is opt-in per column (provide `sortValue`); the table owns the sort
 * state. Selection is opt-in (`selectable`) and **controlled** — the parent
 * owns the `Set` of selected row keys so it can clear it after a bulk op. Rows
 * are sorted client-side — fine for the page-sized lists these screens render.
 */

export interface DataColumn<T> {
  /** Stable column id (also the sort key). */
  key: string;
  header: ReactNode;
  /** Cell renderer. */
  render: (row: T) => ReactNode;
  /** Provide to make the column sortable; returns the comparable value.
   *  Return `null` for "no value" — a null row sinks LAST in BOTH directions
   *  ("no renewal date" is not a far-future date; a descending sort must not
   *  float the undated rows to the top — the CSM R2 review follow-up). */
  sortValue?: (row: T) => string | number | null;
  align?: 'left' | 'right' | 'center';
  /** CSS width for the column (e.g. '1fr', '120px'). */
  width?: string;
  /** Cell class (e.g. 'muted' for low-emphasis columns). */
  cellClassName?: string;
  /** Render this column's body cells as row headers (`th scope=row`). Use for
   * key/value identity tables where the first cell names the value beside it. */
  rowHeader?: boolean;
  /** Native title on the header cell. */
  headerTitle?: string;
}

interface SortState { key: string; dir: 'asc' | 'desc' }

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

/**
 * Stacked headers (`stackHeaders`) wrap a long column title onto several lines.
 * A spaced connector — " / ", " & ", " – ", " — " — is its own whitespace-
 * delimited token, so a tight column orphans it onto a line by itself
 * ("COMPLIANCE" / "/" / "LEGISLATIVE"). Glue the connector to the preceding
 * word with a non-breaking space so it can never be a lone line, and so its
 * min-content keeps the column from being squeezed below "word /". Operates on
 * the separator, not the words, so it's locale-agnostic and a no-op for titles
 * with no spaced connector.
 */
const STACK_CONNECTOR = / ([/&\u2013\u2014]) /g;
function glueHeaderConnectors(s: string): string {
  return s.replace(STACK_CONNECTOR, '\u00A0$1 ');
}

interface BaseProps<T> {
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Row click (e.g. navigate to detail). Rows render as clickable when set. */
  onRowClick?: (row: T) => void;
  density?: 'comfortable' | 'compact';
  /** Accessible table caption (visually hidden). */
  caption?: string;
  /** A ref to the caption, which then becomes programmatically focusable
   *  (`tabIndex={-1}`). For the surface to land focus on after a row's own
   *  Delete button unmounts (CRM-UX-16) — otherwise the browser drops focus to
   *  `<body>` and a screen-reader user has no position and no announcement. */
  captionRef?: React.Ref<HTMLTableCaptionElement> | undefined;
  /** Default sort applied on mount. */
  initialSort?: SortState;
  /** Rendered in place of the table body when `rows` is empty. */
  empty?: ReactNode;
  /** Optional per-row class (e.g. a highlight for the caller's own rows).
   *  Appended to the built-in clickable/selected classes. */
  rowClassName?: (row: T) => string | undefined;
  /** Opt-in: let column titles wrap onto multiple lines instead of the default
   *  single-line nowrap. For wide tables (many columns) this lets long
   *  localized titles stack, so each column only needs its longest word —
   *  wrapping happens at natural word boundaries, so it holds in any locale. */
  stackHeaders?: boolean;
}

/**
 * Selection is all-or-nothing at the type level: opting into `selectable`
 * REQUIRES the controlled `selected` set + `onSelectionChange` (otherwise the
 * checkboxes would render inert). Omitting `selectable` forbids the selection
 * props entirely, so a non-selectable table can't accidentally carry stale
 * selection wiring.
 */
type SelectionProps<T> =
  | {
      selectable?: false; selected?: undefined; onSelectionChange?: undefined; bulkActions?: undefined; rowSelectable?: undefined;
      /** BIZ-3 — opt-in stacked-row reflow at ≤640px: rows become labeled
       *  blocks (each cell shows its column header via `data-th`) instead of
       *  relying on horizontal scroll. Only for tables whose string headers
       *  make good inline labels. DEF-5: type-incompatible with `selectable`
       *  (the checkbox cell has no header label to stack under). */
      stack?: boolean;
      /** JSUX-LIST-1 (filter half) — opt-in client-side text filter: ONE
       *  labeled search input above the table, matching case-insensitively
       *  over `textOf(row)` when given, else over the columns' `sortValue`
       *  projections joined. A non-empty filter with zero hits renders a
       *  DISTINCT "no rows match" body — never the `empty` slot, whose copy
       *  claims "no data yet" (the failure-as-empty family, one seat over).
       *  The placeholder doubles as the input's accessible label and is the
       *  CALLER's (localized per feature). Type-incompatible with
       *  `selectable` until selection is filter-aware: select-all and the
       *  bulk bar derive from the UNFILTERED rows, so combining them would
       *  let "select all" grab rows the filter is hiding (re-grade finding —
       *  a destructive bulk action must never hit rows the user can't see). */
      filterable?: { placeholder: string; textOf?: (row: T) => string };
    }
  | {
      selectable: true;
      filterable?: never;
      /** Controlled set of selected row keys (parent-owned so it can clear it). */
      selected: ReadonlySet<string>;
      onSelectionChange: (next: Set<string>) => void;
      /** Rendered in the bar above the table when ≥1 row is selected. */
      bulkActions?: (selectedRows: T[]) => ReactNode;
      /** ADR 0475 (ux-review H3) — per-row eligibility: rows failing the
       *  predicate render NO checkbox and are excluded from select-all.
       *  Omit for the historical every-row behavior. */
      rowSelectable?: (row: T) => boolean;
      stack?: never;
    };

type Props<T> = BaseProps<T> & SelectionProps<T>;

export function DataTable<T>({
  columns, rows, rowKey, onRowClick, density = 'comfortable', caption, captionRef, initialSort, empty, rowClassName, stack, stackHeaders,
  filterable, selectable, selected = EMPTY_SELECTION, onSelectionChange, bulkActions, rowSelectable,
}: Props<T>): JSX.Element {
  const { t } = useTranslation('ui');
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);
  const [filter, setFilter] = useState('');

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!filterable || !needle) return rows;
    const textOf = filterable.textOf ?? ((row: T) =>
      columns.map((c) => { const v = c.sortValue?.(row); return v === null || v === undefined ? '' : String(v); }).join(' '));
    return rows.filter((row) => textOf(row).toLowerCase().includes(needle));
  }, [rows, filter, filterable, columns]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return filtered;
    const sv = col.sortValue;
    const factor = sort.dir === 'asc' ? 1 : -1;
    // Stable sort over a copy; never mutate the caller's array.
    return [...filtered].sort((a, b) => {
      const av = sv(a); const bv = sv(b);
      // Nulls last regardless of direction (no factor on these branches).
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;

      if (av < bv) return -1 * factor;
      if (av > bv) return 1 * factor;
      return 0;
    });
  }, [filtered, sort, columns]);

  // Filter results announced through the always-mounted GlobalLiveRegion —
  // a `role="status"` born WITH its text announces unreliably (the repo's
  // live-region doctrine), and sighted-only feedback on the non-zero case
  // fails WCAG 4.1.3. Debounced so per-keystroke churn coalesces into one
  // settled announcement; skipped entirely while the filter is empty.
  const announceTimer = useRef<ReturnType<typeof setTimeout>>();
  const filterActive = Boolean(filterable) && filter.trim().length > 0;
  const filteredCount = filtered.length;
  useEffect(() => {
    if (!filterActive) return;
    announceTimer.current = setTimeout(() => {
      announce(filteredCount === 0
        ? t('tableNoFilterMatches', { query: filter.trim() })
        : t('tableFilterMatches', { count: filteredCount, n: formatNumber(filteredCount) }));
    }, 350);
    return () => clearTimeout(announceTimer.current);
  }, [filterActive, filteredCount, filter, t]);

  function toggleSort(key: string) {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' };
      return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
    });
  }

  const allKeys = useMemo(
    () => rows.filter((r) => rowSelectable?.(r) ?? true).map(rowKey),
    [rows, rowKey, rowSelectable],
  );
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));
  const someSelected = allKeys.some((k) => selected.has(k));
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(rowKey(r))), [rows, selected, rowKey]);

  function toggleAll() {
    const next = new Set(selected);
    if (allSelected) allKeys.forEach((k) => next.delete(k));
    else allKeys.forEach((k) => next.add(k));
    onSelectionChange?.(next);
  }
  function toggleRow(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    onSelectionChange?.(next);
  }

  return (
    <>
      {selectable && bulkActions && selected.size > 0 && (
        <div className="data-bulkbar" role="region" aria-label={t('tableBulkActionsLabel')}>
          <span className="data-bulkbar-count">{t('tableSelectedCount', { n: formatNumber(selected.size) })}</span>
          <div className="data-bulkbar-actions">{bulkActions(selectedRows)}</div>
          <button type="button" className="data-bulkbar-clear" onClick={() => onSelectionChange?.(new Set())}>{t('tableClear')}</button>
        </div>
      )}
      {filterable && rows.length > 0 && (
        <div className="data-filter">
          <input
            type="search"
            className="data-filter__input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={filterable.placeholder}
            aria-label={filterable.placeholder}
          />
        </div>
      )}
      {rows.length === 0 && empty !== undefined ? (
        empty
      ) : filterable && filter.trim() && sorted.length === 0 ? (
        // A non-matching FILTER is not "no data yet" — say which it is, and
        // keep the input rendered above so the user can loosen the query.
        // Deliberately NO role="status": a live region born WITH its text
        // won't announce; the useEffect above speaks via GlobalLiveRegion.
        <p className="dash-tile__state muted data-filter__nomatch">{t('tableNoFilterMatches', { query: filter.trim() })}</p>
      ) : (
        <div className={`table-scroll${stack ? ' table--stack' : ''}`}>
          <table className={`data-table${density === 'compact' ? ' data-table--compact' : ''}${stackHeaders ? ' data-table--stack-headers' : ''}`}>
            {caption ? <caption className="data-table-caption" {...(captionRef ? { ref: captionRef, tabIndex: -1 } : {})}>{caption}</caption> : null}
            <thead>
              <tr>
                {selectable && (
                  <th className="data-col--check" aria-label={t('tableSelectHeader')}>
                    <input
                      type="checkbox"
                      aria-label={allSelected ? t('tableDeselectAll') : t('tableSelectAll')}
                      checked={allSelected}
                      ref={(cb) => { if (cb) cb.indeterminate = someSelected && !allSelected; }}
                      onChange={toggleAll}
                    />
                  </th>
                )}
                {columns.map((col) => {
                  const active = sort?.key === col.key;
                  const alignClass = col.align ? ` data-col--${col.align}` : '';
                  // In stacked mode, keep a spaced connector from orphaning onto
                  // its own wrapped line (string headers only; ReactNode headers
                  // are the caller's own layout).
                  const headerNode = stackHeaders && typeof col.header === 'string'
                    ? glueHeaderConnectors(col.header)
                    : col.header;
                  if (!col.sortValue) {
                    return (
                      <th key={col.key} className={alignClass.trim()} style={col.width ? { width: col.width } : undefined} title={col.headerTitle}>
                        {headerNode}
                      </th>
                    );
                  }
                  return (
                    <th
                      key={col.key}
                      className={`data-th--sortable${active ? ' is-sorted' : ''}${alignClass}`}
                      style={col.width ? { width: col.width } : undefined}
                      aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      <button type="button" className="data-sort-btn" onClick={() => toggleSort(col.key)} title={col.headerTitle ?? t('tableSortBy', { column: typeof col.header === 'string' ? col.header : col.key })}>
                        <span>{headerNode}</span>
                        <span className={`data-sort-caret${active ? ` is-${sort?.dir}` : ''}`} aria-hidden>
                          <ChevronDownIcon size={12} />
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => {
                const key = rowKey(row);
                const isSel = selectable && selected.has(key);
                return (
                  <tr
                    key={key}
                    className={`${onRowClick ? 'data-row--clickable' : ''}${isSel ? ' is-selected' : ''} ${rowClassName?.(row) ?? ''}`.trim() || undefined}
                    {...(onRowClick
                      ? {
                          onClick: () => onRowClick(row),
                          // Roving keyboard support for clickable rows (DS-1):
                          // Enter/Space activate; Arrow Up/Down move focus to the
                          // adjacent clickable row. Only act when the row itself is
                          // focused so inner controls (checkbox, links) keep their
                          // own keys. Deliberately NO `role="button"`: cells hold
                          // real interactive children (links, checkboxes), and a
                          // widget-role row wrapping them is a serious
                          // nested-interactive violation (axe caught it on /runs
                          // the first time the table rendered populated rows in
                          // e2e). A focusable tr still reads its cell content to
                          // screen readers; the handler keeps Enter/Space parity.
                          tabIndex: 0,
                          onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => {
                            if (e.target !== e.currentTarget) return;
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onRowClick(row);
                            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                              e.preventDefault();
                              const rowsEls = e.currentTarget.parentElement
                                ? Array.from(
                                    e.currentTarget.parentElement.querySelectorAll<HTMLTableRowElement>('tr.data-row--clickable'),
                                  )
                                : [];
                              const idx = rowsEls.indexOf(e.currentTarget);
                              const next = e.key === 'ArrowDown' ? rowsEls[idx + 1] : rowsEls[idx - 1];
                              next?.focus();
                            }
                          },
                        }
                      : {})}
                  >
                    {selectable && (
                      <td className="data-col--check" onClick={(e) => e.stopPropagation()}>
                        {(rowSelectable?.(row) ?? true) ? (
                          <input
                            type="checkbox"
                            aria-label={t('tableSelectRow')}
                            checked={selected.has(key)}
                            onChange={() => toggleRow(key)}
                          />
                        ) : null}
                      </td>
                    )}
                    {columns.map((col) => {
                      const Cell = col.rowHeader ? 'th' : 'td';
                      return (
                      <Cell
                        key={col.key}
                        {...(col.rowHeader ? { scope: 'row' as const } : {})}
                        className={`${col.align ? `data-col--${col.align} ` : ''}${col.cellClassName ?? ''}`.trim() || undefined}
                      >
                        {/* Stacked-reflow label (UXDEF-3): real DOM text, shown only
                            ≤640px inside .table--stack (display:none elsewhere, so
                            desktop AT keeps the table's own header association). */}
                        {stack && typeof col.header === 'string' && (
                          <span className="data-stack-label">{col.header}</span>
                        )}
                        {col.render(row)}
                      </Cell>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
