/**
 * ADR 1015 — the tenant site visitor runtime, loaded by the prerendered page on a
 * workspace's custom domain (the server injects
 * `<script type="module" src="…/_rt/main-….js" data-owp-org="…">` only when the
 * workspace turned it on).
 *
 * It runs the SAME visitor modules the SPA's FrontPage runs, against the public
 * routes on this same hostname (base `''`): the consent posture, a pageview and
 * the web vitals once the visitor's decision allows analytics, heat capture where
 * the site collects it, and session recording only on an explicit, server-recorded
 * yes. Nothing here decides consent: the core does, and the server enforces it
 * again on every write.
 *
 * Eager graph: no React, no SPA config or session code. The banner is a lazy
 * chunk (`mountBanner.tsx`), so a visitor who never needs it never loads React.
 */
import { setVisitorApiBase } from '../features/site/visitorApi.js';
import {
  getVisitorKey, loadPosture, replayAllowedFor, storedChoice, subscribeVisitorConsent,
} from '../features/site/visitorConsent.js';
import { sendPageview } from '../features/site/visitorBeacon.js';
import { reportWebVitals } from '../features/site/webVitalsBeacon.js';

/** The CMS slug of the page this document shows, as the custom-domain rewrite
 *  maps paths (`/` → home, `/p/:slug`, `/blog/:slug`, `/pricing`); null elsewhere. */
export function pageSlugOf(pathname: string): string | null {
  if (pathname === '/') return 'home';
  if (pathname === '/pricing') return 'pricing';
  const m = /^\/(?:p|blog)\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  try { return decodeURIComponent(m[1]!); } catch { return null; }
}

export interface RuntimeTarget { orgId: string; privacyHref: string | null }

/** The org (and privacy page) the server stamped on our own script tag. */
export function readTarget(doc: Document = document): RuntimeTarget | null {
  const el = doc.querySelector<HTMLScriptElement>('script[data-owp-org]');
  const orgId = el?.dataset.owpOrg?.trim();
  if (!orgId) return null;
  const privacy = el?.dataset.owpPrivacy?.trim();
  return { orgId, privacyHref: privacy && privacy.startsWith('/') && !privacy.startsWith('//') ? privacy : null };
}

/** Start everything for `target`. Resolves to a stop function (tests). */
export async function startSiteRuntime(target: RuntimeTarget, opts: { mountBanner?: (t: RuntimeTarget) => Promise<void> } = {}): Promise<() => void> {
  setVisitorApiBase('');
  const { orgId } = target;
  const stops: Array<() => void> = [];
  let measured = false;
  let recording = false;

  // Each capture starts once, the first time the decision allows it (on load,
  // or later when the visitor answers the banner).
  const apply = (): void => {
    const vk = getVisitorKey(orgId);
    if (vk && !measured) {
      measured = true;
      sendPageview(orgId, vk);
      reportWebVitals(orgId, vk);
      const page = pageSlugOf(window.location.pathname);
      if (page) {
        void import('../features/site/heatCapture.js')
          .then((m) => m.startHeatCapture({ orgId, visitorKey: vk, page }))
          .then((stop) => { stops.push(stop); })
          .catch(() => undefined);
      }
    }
    if (vk && !recording && replayAllowedFor(orgId)) {
      recording = true;
      void import('../features/site/replayCapture.js')
        .then((m) => m.startReplayCapture({ orgId, visitorKey: vk }))
        .then((stop) => { stops.push(stop); })
        .catch(() => undefined);
    }
  };

  const regime = await loadPosture(orgId);
  stops.push(subscribeVisitorConsent(apply));
  apply();
  // The banner is needed when the lane answered (to ask, or to offer "Privacy
  // choices") or when a choice is already stored (withdrawal stays one click away).
  if (regime !== null || storedChoice(orgId)) {
    const mount = opts.mountBanner ?? ((t: RuntimeTarget) => import('./mountBanner.js').then((m) => m.mountBanner(t)));
    await mount(target).catch(() => undefined);
  }
  return () => { for (const s of stops) s(); };
}

// Boot: only in a real page that carries our tag (never on import in tests).
if (typeof document !== 'undefined' && !import.meta.env.VITEST) {
  const target = readTarget();
  if (target) void startSiteRuntime(target);
}
