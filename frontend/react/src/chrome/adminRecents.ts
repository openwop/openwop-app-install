/**
 * Bounded, presentation-only recents for the Admin home.
 *
 * Only canonical top-level manifest paths are passed to this module. Query
 * strings, record identifiers, labels, and user data are never persisted. The
 * Admin home intersects the result with today's effective nav projection, so a
 * hidden or newly-forbidden destination cannot leak through recents.
 */
const STORAGE_KEY = 'openwop.admin.recent-destinations';
const LIMIT = 5;

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function readRecentAdminDestinations(): string[] {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.startsWith('/')).slice(0, LIMIT);
  } catch {
    return [];
  }
}

export function recordRecentAdminDestination(path: string): void {
  if (path === '/admin' || !path.startsWith('/')) return;
  const next = [path, ...readRecentAdminDestinations().filter((item) => item !== path)].slice(0, LIMIT);
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* private mode / quota: recents are optional */ }
}
