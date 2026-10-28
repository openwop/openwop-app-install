/**
 * ADR 0951 P1 D2 — heat capture for public pages: clicks, scroll depth and
 * attention, as AGGREGATE-ONLY events.
 *
 * Loaded with a dynamic `import()` only after the visitor's analytics decision
 * allows it (FrontPage), and it asks the site whether heat maps are on before
 * attaching a single listener — nothing is captured before consent or on a site
 * that does not collect.
 *
 * What leaves the browser: page-relative click coordinates (fractions of the
 * document), an author-given element id when the click landed on one
 * (`data-owx-id`, else `id`, in a markup-safe alphabet), the deepest scroll
 * fraction, and visible time per section (`data-owx-section`, else a `section`'s
 * id). Never text, input values, keystrokes, URLs with queries or the visitor's
 * screen contents. The session key and consent token ride along only so the
 * server can re-check consent; the server stores neither.
 *
 * The visitor withdrawing analytics stops capture: every flush re-reads the
 * decision, and a non-`allowed` decision drops the queue and detaches.
 */
import { config } from '../../client/config.js';
import { consentTokenFor, decisionFor } from './visitorConsent.js';

const FLUSH_MS = 10_000;
const BATCH_MAX = 50;
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

type HeatEvent = { t: 'click'; x: number; y: number; sel?: string } | { t: 'scroll'; depth: number } | { t: 'attn'; section: string; ms: number };

export interface HeatCaptureOptions { orgId: string; visitorKey: string; page: string; experimentId?: string }

function deviceClass(): 'mobile' | 'tablet' | 'desktop' {
  const w = window.innerWidth;
  return w < 768 ? 'mobile' : w < 1024 ? 'tablet' : 'desktop';
}

function stableId(el: Element | null): string | undefined {
  const hit = el?.closest('[data-owx-id], [id]');
  if (!hit) return undefined;
  const id = hit.getAttribute('data-owx-id') ?? hit.id;
  return id && ID_RE.test(id) ? id : undefined;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

async function heatmapsOn(orgId: string): Promise<boolean> {
  try {
    const r = await fetch(`${config.baseUrl}/host/openwop-app/public-analytics/${encodeURIComponent(orgId)}/capture-config`);
    if (!r.ok) return false;
    return ((await r.json()) as { heatmaps?: unknown }).heatmaps === true;
  } catch { return false; }
}

/** Start capture. Resolves to a stop function (a no-op when heat maps are off). */
export async function startHeatCapture(opts: HeatCaptureOptions): Promise<() => void> {
  if (decisionFor(opts.orgId) !== 'allowed' || !(await heatmapsOn(opts.orgId))) return () => undefined;
  // Re-read after the await: the visitor may have refused while the config loaded.
  if (decisionFor(opts.orgId) !== 'allowed') return () => undefined;

  const doc = document.documentElement;
  const queue: HeatEvent[] = [];
  let maxDepth = 0;
  let stopped = false;
  const visibleSince = new Map<Element, number>();
  const attentionMs = new Map<string, number>();
  const sectionOf = (el: Element): string | undefined => {
    const id = el.getAttribute('data-owx-section') ?? el.id;
    return id && ID_RE.test(id) ? id : undefined;
  };

  const send = (events: HeatEvent[]): void => {
    if (events.length === 0) return;
    for (let i = 0; i < events.length; i += BATCH_MAX) {
      const token = consentTokenFor(opts.orgId);
      void fetch(`${config.baseUrl}/host/openwop-app/public-analytics/${encodeURIComponent(opts.orgId)}/heat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          sessionKey: opts.visitorKey,
          ...(token ? { consentToken: token } : {}),
          page: opts.page,
          device: deviceClass(),
          ...(opts.experimentId ? { experiment: { id: opts.experimentId } } : {}),
          ...(navigator.webdriver ? { automation: true } : {}),
          events: events.slice(i, i + BATCH_MAX),
        }),
      }).catch(() => undefined); // measurement never breaks the page
    }
  };

  const stillAllowed = (): boolean => {
    if (stopped) return false;
    if (decisionFor(opts.orgId) === 'allowed') return true;
    stop(); // withdrawn mid-visit: drop what is queued and detach
    return false;
  };

  const flush = (): void => {
    if (!stillAllowed()) return;
    send(queue.splice(0, queue.length));
  };

  const accrueVisible = (now: number): void => {
    for (const [el, since] of visibleSince) {
      const id = sectionOf(el);
      if (id) attentionMs.set(id, (attentionMs.get(id) ?? 0) + (now - since));
      visibleSince.set(el, now);
    }
  };

  /** Page-view end: the scroll reach and the attention totals, once. */
  let ended = false;
  const endView = (): void => {
    if (ended || !stillAllowed()) return;
    ended = true;
    accrueVisible(performance.now());
    queue.push({ t: 'scroll', depth: clamp01(maxDepth) });
    for (const [section, ms] of attentionMs) if (ms > 0) queue.push({ t: 'attn', section, ms: Math.round(ms) });
    flush();
  };

  const onClick = (e: MouseEvent): void => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('.visitor-consent')) return; // the consent banner is not the page
    const sel = stableId(target);
    const w = Math.max(doc.scrollWidth, 1);
    const h = Math.max(doc.scrollHeight, 1);
    queue.push({ t: 'click', x: clamp01(e.pageX / w), y: clamp01(e.pageY / h), ...(sel ? { sel } : {}) });
    if (queue.length >= BATCH_MAX) flush();
  };
  const onScroll = (): void => {
    const depth = (window.scrollY + window.innerHeight) / Math.max(doc.scrollHeight, 1);
    if (depth > maxDepth) maxDepth = depth;
  };
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') { accrueVisible(performance.now()); visibleSince.clear(); endView(); }
  };

  const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
    const now = performance.now();
    for (const en of entries) {
      if (en.isIntersecting && document.visibilityState === 'visible') { if (!visibleSince.has(en.target)) visibleSince.set(en.target, now); }
      else if (visibleSince.has(en.target)) {
        const id = sectionOf(en.target);
        if (id) attentionMs.set(id, (attentionMs.get(id) ?? 0) + (now - visibleSince.get(en.target)!));
        visibleSince.delete(en.target);
      }
    }
  }, { threshold: 0.5 });
  document.querySelectorAll('[data-owx-section], main section[id]').forEach((el) => { if (sectionOf(el)) io?.observe(el); });

  document.addEventListener('click', onClick, { capture: true, passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', endView);
  onScroll();
  const timer = window.setInterval(flush, FLUSH_MS);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    queue.length = 0;
    io?.disconnect();
    document.removeEventListener('click', onClick, { capture: true });
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', endView);
    window.clearInterval(timer);
  }

  // Navigating away inside the SPA ends this page view like a real unload does.
  return () => { endView(); stop(); };
}
