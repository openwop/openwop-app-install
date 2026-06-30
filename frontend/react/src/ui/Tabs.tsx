/**
 * Shared tab primitive (ADR 0144).
 *
 * The app had no single <Tabs> — each surface hand-rolled a `role="tablist"` of
 * `.tab` buttons (profiles, projects, CRM, strategy, kanban …). `rovingTabs.ts`
 * already centralizes the keyboard nav; this centralizes the markup + a11y wiring
 * (tab↔panel ids, `aria-selected`, roving `tabIndex`) on top of the existing
 * editorial `.tabs`/`.tab` CSS (`styles/global.css`). No new tokens, no new CSS.
 *
 * It is intentionally PRESENTATIONAL and routing-agnostic: the consumer owns the
 * active `value` + `onChange` and renders the active panel as a conditional
 * sibling (the pattern already in use). For the common "tab id lives in `?tab`"
 * case, pair it with `useUrlTab` below.
 */
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { handleTablistKeyDown } from './rovingTabs.js';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  /** Rendered but non-activatable (greyed) — e.g. a gated tab shown as locked. */
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  items: readonly TabItem<T>[];
  /** Active tab id (controlled). */
  value: T;
  onChange: (id: T) => void;
  /** Accessible name for the tablist (WAI-ARIA `aria-label`). */
  label?: string;
  /** Base id wiring each tab to its panel (`<TabPanel>` below). Must be unique
   *  per tablist on a page. Defaults to `'tabs'`. */
  idBase?: string;
  /** The id of the region these tabs control, for `aria-controls`. Defaults to
   *  `<idBase>-panel` (paired with `<TabPanel idBase>`). Pass an explicit id when
   *  the tablist controls a panel owned by a DIFFERENT `idBase` — e.g. a scope
   *  selector that re-renders the section panel below it rather than its own. */
  panelId?: string;
  /** Extra class appended to the `.tabs` container (e.g. `'u-mb-4'`). */
  className?: string;
}

/** The tablist row. Render `<TabPanel>` (or a conditional sibling) for the body. */
export function Tabs<T extends string = string>({ items, value, onChange, label, idBase = 'tabs', panelId, className }: TabsProps<T>): JSX.Element {
  const controls = panelId ?? `${idBase}-panel`;
  return (
    <div
      className={className ? `tabs ${className}` : 'tabs'}
      role="tablist"
      aria-label={label}
      onKeyDown={handleTablistKeyDown}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${idBase}-tab-${item.id}`}
            aria-selected={selected}
            aria-controls={controls}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            className="tab"
            onClick={() => onChange(item.id)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** The labelled region for the active tab. Pair `idBase` + the active `tabId`
 *  with the matching `<Tabs idBase>` so the panel is `aria-labelledby` its tab. */
export function TabPanel({
  idBase = 'tabs',
  tabId,
  children,
}: {
  idBase?: string;
  tabId: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div id={`${idBase}-panel`} role="tabpanel" aria-labelledby={`${idBase}-tab-${tabId}`}>
      {children}
    </div>
  );
}

/**
 * Bind the active tab id to a URL search param (`?tab=…`), the dominant pattern
 * (ProjectDetailPage). Returns `[value, setValue]`: `value` is the param when it
 * names a valid tab, else `fallback`; `setValue` writes the param with
 * `replace` (no history spam). Absent/invalid params fall back silently.
 */
export function useUrlTab<T extends string>(
  param: string,
  validIds: readonly T[],
  fallback: T,
): [T, (id: T) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get(param);
  const value = (validIds as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;
  const setValue = (id: T): void => {
    setSearchParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set(param, id);
        return next;
      },
      { replace: true },
    );
  };
  return [value, setValue];
}
