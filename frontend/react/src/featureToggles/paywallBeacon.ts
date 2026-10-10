/**
 * Nav-telemetry beacon + paywall funnel (ADR 0512, monetization strategy §8) —
 * ONE lazy module, so the entry chunk carries a single dynamic import of it
 * (from `NavTelemetry`) and nothing else.
 *
 * `view()` is called by `NavTelemetry` on every route change while
 * `workspace-nav-telemetry` is ON, and never while it is off. It
 *  - posts the ADR 0512 nav count (route PATTERN × source), as `NavTelemetry`
 *    used to do inline;
 *  - ACTIVATES the paywall funnel. Until the first `view()`, events from the
 *    lazy lock surfaces are held (bounded), never sent: telemetry OFF ⇒ nothing
 *    leaves the browser. The server re-checks both toggles and 404s when off;
 *  - counts the Sidebar's locks as impressions by READING THE DOM (its locked
 *    links point at `/marketplace/bundles?feature=<id>`), and counts a click on
 *    one through a delegated listener — so the entry-chunk Sidebar carries no
 *    funnel code at all.
 *
 * Events are `(metric, featureId, surface)`: no URL, no user id, no free text;
 * the bundle is resolved server-side. Impressions are deduped once per feature
 * PER SURFACE per page view (pathname): the Sidebar shows the same lock on every
 * page, and a feature-only key would starve the locked-page impression. One
 * batched request per tick; never throws.
 */
import { config, fetchOpts, authedHeaders } from '../client/config.js';

export type PaywallSurface = 'locked-page' | 'sidebar' | 'palette' | 'admin-rail' | 'admin-overview' | 'chat-picker';
export type PaywallMetric = 'impression' | 'click';
interface PaywallEvent { metric: PaywallMetric; featureId: string; surface: PaywallSurface }

/** The Sidebar's locked links (desktop rail, Agents row, mobile quick access). */
const SIDEBAR_LOCK = 'a.app-nav-link[href^="/marketplace/bundles?feature="], a.app-mobile-nav__item[href^="/marketplace/bundles?feature="]';
const HELD_MAX = 100;

let active = false;
let listening = false;
let view_: string | null = null;
const seen = new Set<string>();
let queue: PaywallEvent[] = [];
let scheduled = false;

const post = (path: string, body: unknown): void => {
  try {
    void fetch(`${config.baseUrl}/host/openwop-app/analytics/${path}`, fetchOpts({
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authedHeaders() },
      keepalive: true,
      body: JSON.stringify(body),
    })).catch(() => undefined); // measurement never breaks the page
  } catch { /* never throw from telemetry */ }
};

const featureOfLink = (a: Element): string | undefined =>
  new URLSearchParams((a.getAttribute('href') ?? '').split('?')[1] ?? '').get('feature') ?? undefined;

/** Queue one event. Returns whether it was queued (false = deduped / no feature). */
export function notePaywall(metric: PaywallMetric, featureId: string | undefined, surface: PaywallSurface): boolean {
  if (!featureId) return false;
  if (metric === 'impression') {
    const v = typeof window !== 'undefined' ? window.location.pathname : '';
    if (v !== view_) { view_ = v; seen.clear(); }
    const key = `${featureId}|${surface}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  if (queue.length >= HELD_MAX) return false;
  queue.push({ metric, featureId, surface });
  if (!scheduled) { scheduled = true; setTimeout(flush, 0); }
  return true;
}

function flush(): void {
  scheduled = false;
  if (!active || queue.length === 0) return; // not activated: hold, send nothing
  const events = queue;
  queue = [];
  post('paywall', { events });
}

function onClick(e: MouseEvent): void {
  const a = e.target instanceof Element ? e.target.closest(SIDEBAR_LOCK) : null;
  if (a) notePaywall('click', featureOfLink(a), 'sidebar');
}

/**
 * A page view while nav telemetry is ON (called by `NavTelemetry` only then).
 * `route` is the matched manifest pattern; an unmatched route posts no nav count.
 */
export function view(route: string | undefined, source: string): void {
  active = true;
  if (route) post('nav', { route, source });
  if (typeof document === 'undefined') return;
  if (!listening) { listening = true; document.addEventListener('click', onClick, true); }
  for (const a of document.querySelectorAll(SIDEBAR_LOCK)) notePaywall('impression', featureOfLink(a), 'sidebar');
  flush();
}

/** Test-only: reset every piece of module state. */
export function __resetPaywallBeacon(): void {
  active = false; view_ = null; seen.clear(); queue = []; scheduled = false;
  if (listening && typeof document !== 'undefined') document.removeEventListener('click', onClick, true);
  listening = false;
}
