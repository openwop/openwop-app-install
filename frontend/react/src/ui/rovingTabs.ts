/**
 * WAI-ARIA roving keyboard navigation for a hand-rolled `role="tablist"`.
 *
 * The app has no single <Tabs> primitive — each surface composes its own
 * `role="tablist"` + `role="tab"` buttons (agent workspace + drawer, runs,
 * strategy, priority-matrix, CRM, projects, profiles, CMS locales, kanban,
 * library …). Most hand-rolled the markup but forgot the keyboard nav; this is
 * the shared home for it. (Two surfaces — chat `LeftRail` and `ArtifactWorkbench`
 * — predate this and use the equally-valid *selection-follows-focus* variant
 * inline; both WAI-ARIA tab patterns are allowed, so they're left as-is.)
 *
 * Attach to the tablist container's `onKeyDown`; it reads the `[role="tab"]`
 * children straight off the event target, so it needs no per-tab ids or state.
 * Arrow/Home/End move FOCUS between tabs (the "tabs with manual activation"
 * pattern — Enter/Space then activate via each tab's own `onClick`). Manual
 * activation is deliberate: it keeps expensive tab switches (e.g. a board that
 * refetches) off the arrow keys. Pair each tab with a roving
 * `tabIndex={active ? 0 : -1}` so the whole tablist is a single tab stop and
 * Tab lands on the selected tab.
 */
import type { KeyboardEvent } from 'react';

const NAV_KEYS = new Set(['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End']);

export function handleTablistKeyDown(e: KeyboardEvent<HTMLElement>): void {
  if (!NAV_KEYS.has(e.key)) return;
  const tabs = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])'),
  );
  if (tabs.length === 0) return;
  e.preventDefault();
  const cur = tabs.findIndex((el) => el === document.activeElement);
  let next: number;
  switch (e.key) {
    case 'Home': next = 0; break;
    case 'End': next = tabs.length - 1; break;
    case 'ArrowRight':
    case 'ArrowDown': next = cur < 0 ? 0 : (cur + 1) % tabs.length; break;
    default: next = cur < 0 ? tabs.length - 1 : (cur - 1 + tabs.length) % tabs.length;
  }
  tabs[next]?.focus();
}

/**
 * WAI-ARIA roving keyboard navigation for a hand-rolled `role="radiogroup"` of
 * `role="radio"` buttons (star ratings, single-select chip clusters).
 *
 * Unlike a tablist, a radiogroup uses SELECTION-FOLLOWS-FOCUS: an arrow key
 * moves focus AND selects the newly-focused radio (WAI-ARIA APG). So this
 * focuses the next radio and `.click()`s it, firing that radio's own `onClick`
 * — no per-site selection callback needed, the same DOM-driven shape as
 * `handleTablistKeyDown`. Pair each radio with a roving
 * `tabIndex={checked ? 0 : -1}` (and `0` on the first when none is checked) so
 * the group is a single tab stop.
 */
export function handleRadiogroupKeyDown(e: KeyboardEvent<HTMLElement>): void {
  if (!NAV_KEYS.has(e.key)) return;
  const radios = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled])'),
  );
  if (radios.length === 0) return;
  e.preventDefault();
  const cur = radios.findIndex((el) => el === document.activeElement);
  let next: number;
  switch (e.key) {
    case 'Home': next = 0; break;
    case 'End': next = radios.length - 1; break;
    case 'ArrowRight':
    case 'ArrowDown': next = cur < 0 ? 0 : (cur + 1) % radios.length; break;
    default: next = cur < 0 ? 0 : (cur - 1 + radios.length) % radios.length;
  }
  const el = radios[next];
  if (!el) return;
  el.focus();
  el.click(); // selection follows focus
}
