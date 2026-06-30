/**
 * ADR 0139 — per-browser section-collapse state for the nav rails.
 *
 * Which header sections are collapsed is a per-BROWSER UI preference (not part of
 * the shared/per-user `MenuConfig`), so it lives in a cookie — as specified by
 * the feature request. Distinct from the existing localStorage icon-rail collapse
 * (`openwop.sidebar.collapsed`). The value is a comma-joined list of collapsed
 * header ids — no PII, size-bounded by the number of headers.
 *
 * Kept separate from the pure `resolveNav` (which never touches the DOM) so both
 * stay independently testable.
 */

const COOKIE = 'openwop.nav.collapsed';
const ONE_YEAR = 60 * 60 * 24 * 365;
/** Defensive cap — a cookie should never carry more than this many ids. */
const MAX_IDS = 64;

function hasDocument(): boolean {
  return typeof document !== 'undefined';
}

/** The set of header ids the user has collapsed (empty when no cookie / no DOM). */
export function readCollapsedHeaders(): Set<string> {
  if (!hasDocument()) return new Set();
  const match = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${COOKIE}=`));
  if (!match) return new Set();
  const raw = decodeURIComponent(match.slice(COOKIE.length + 1));
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** Persist the collapsed set (SameSite=Lax, path=/, 1y). No-op without a DOM. */
export function writeCollapsedHeaders(ids: Set<string>): void {
  if (!hasDocument()) return;
  const value = [...ids].slice(0, MAX_IDS).join(',');
  document.cookie = `${COOKIE}=${encodeURIComponent(value)}; path=/; max-age=${ONE_YEAR}; SameSite=Lax`;
}

/** Toggle one header's collapsed state and persist; returns the new set. */
export function toggleCollapsedHeader(id: string): Set<string> {
  const ids = readCollapsedHeaders();
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  writeCollapsedHeaders(ids);
  return ids;
}
