/**
 * Public booking route matchers (ADR 0402 §a) — pure `match*(pathname)` guards
 * for the two unauthed pages mounted in App.tsx above the auth gate:
 *   /book/manage/:token  → the reschedule/cancel page
 *   /book/:slug          → the booking page
 * Match `manage` BEFORE `slug` (the slug regex would otherwise capture `manage`).
 */

export function matchBookManage(pathname: string): { token: string } | null {
  const m = pathname.match(/^\/book\/manage\/([A-Za-z0-9%_-]+)$/);
  if (!m) return null;
  try { return { token: decodeURIComponent(m[1]!) }; } catch { return null; }
}

export function matchBookSlug(pathname: string): { slug: string } | null {
  const m = pathname.match(/^\/book\/([A-Za-z0-9%_-]+)$/);
  if (!m) return null;
  const slug = m[1]!;
  if (slug === 'manage') return null; // reserved for the manage sub-route
  try { return { slug: decodeURIComponent(slug) }; } catch { return null; }
}
