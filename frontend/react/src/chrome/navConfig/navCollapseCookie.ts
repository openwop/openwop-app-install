/**
 * ADR 0139 — per-browser section-collapse state for the nav rails.
 *
 * Which header sections are open is a per-BROWSER UI preference (not part of
 * the shared/per-user `MenuConfig`), so it lives in a cookie — as specified by
 * the feature request. Distinct from the existing localStorage icon-rail collapse
 * (`openwop.sidebar.collapsed`). The value is a comma-joined list of header ids —
 * no PII, size-bounded by the number of headers.
 *
 * Correction (product ruling 2026-07-06): sections are now COLLAPSED by default,
 * so the cookie stores the EXPANDED ids (the exceptions), inverting the original
 * ADR 0139 collapsed-ids encoding. The old `openwop.nav.collapsed` cookie is
 * deliberately ignored rather than migrated — its ids meant the opposite thing,
 * and every browser starts from the new all-collapsed default either way.
 *
 * Kept separate from the pure `resolveNav` (which never touches the DOM) so both
 * stay independently testable.
 */

const COOKIE = 'openwop.nav.expanded';
const ONE_YEAR = 60 * 60 * 24 * 365;
/** Defensive cap — a cookie should never carry more than this many ids. */
const MAX_IDS = 64;
/** Groups open out-of-the-box (no cookie yet): the primary 'Workspace' group
 *  stays expanded so a fresh browser isn't greeted by an all-chevron rail.
 *  Once ANY cookie is written the stored set is fully explicit — collapsing
 *  Workspace writes a set without it, and that sticks. */
const DEFAULT_EXPANDED = ['Workspace'];

function hasDocument(): boolean {
  return typeof document !== 'undefined';
}

/** The set of header ids the user has expanded (the DEFAULT_EXPANDED seed when
 *  no cookie exists yet; empty without a DOM). */
export function readExpandedHeaders(): Set<string> {
  if (!hasDocument()) return new Set();
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${COOKIE}=`));
  if (!match) return new Set(DEFAULT_EXPANDED);
  const raw = decodeURIComponent(match.slice(COOKIE.length + 1));
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** Persist the expanded set (SameSite=Lax, path=/, 1y). No-op without a DOM. */
export function writeExpandedHeaders(ids: Set<string>): void {
  if (!hasDocument()) return;
  const value = [...ids].slice(0, MAX_IDS).join(',');
  document.cookie = `${COOKIE}=${encodeURIComponent(value)}; path=/; max-age=${ONE_YEAR}; SameSite=Lax`;
}

/** Toggle one header's expanded state and persist; returns the new set. */
export function toggleExpandedHeader(id: string): Set<string> {
  const ids = readExpandedHeaders();
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  writeExpandedHeaders(ids);
  return ids;
}
