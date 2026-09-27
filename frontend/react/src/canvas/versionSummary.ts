/**
 * Chassis version-history diff helpers (ADR 0334 / ADR 0328 C9).
 *
 * The History-Compare modal shows a change summary per version. A canvas type
 * MAY supply a rich `summarizeVersions`; when it doesn't, the chassis provides a
 * default — a frames diff for frames-trait types, and this generic shallow
 * structural diff for every other type (elements/flow/none), so no type ships a
 * blank Compare. The summary is deliberately coarse (a rich-text document
 * reports "content changed"); a type wanting finer detail supplies its own.
 */

/** ADR 0344 2d — the structured diff shape. `summarizeVersions` may return the
 *  legacy `string[]` OR a `VersionDiff` whose `entries` give the History modal
 *  a navigable, kind-tagged list. `path` uses the validateAppDoc address
 *  grammar (`screens[id]…`) so diff rows, validator messages, and (Phase 6)
 *  source maps share one address space. */
export interface VersionDiffEntry {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  label: string;
}
export interface VersionDiff {
  lines: string[];
  entries?: VersionDiffEntry[];
}
export type VersionSummary = string[] | VersionDiff;

export const summaryLines = (s: VersionSummary): string[] => (Array.isArray(s) ? s : s.lines);
export const summaryEntries = (s: VersionSummary): VersionDiffEntry[] => (Array.isArray(s) ? [] : s.entries ?? []);

/** The top-level doc keys whose (JSON-serialized) value differs between two
 *  snapshots, sorted for stable output. Pure — no i18n, no React. */
export function changedTopLevelKeys(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): string[] {
  const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  return keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}
