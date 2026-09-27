/**
 * ADR 0018 CWV fold-in — the shared Core Web Vitals MEASUREMENT core (no
 * `web-vitals` dep; native PerformanceObserver). Extracted so BOTH consumers use
 * ONE observer: the SPA telemetry sink (`platform/telemetry.ts`) and the public
 * analytics beacon reporter (`features/site/webVitalsBeacon.ts`). Calls `onSettle`
 * ONCE with the collected samples when the page first goes hidden/unloaded (when
 * the vitals have settled). Safe no-op where the APIs are unavailable.
 *
 * Measures LCP, CLS, TTFB, FCP. INP (event-timing + interaction bucketing) is a
 * documented follow-on — it needs more than a one-liner and is easy to get subtly
 * wrong; staging it keeps this fold-in honest.
 */

export type VitalMetric = 'LCP' | 'CLS' | 'TTFB' | 'FCP';
export interface VitalSample { metric: VitalMetric; value: number }

export function measureWebVitals(onSettle: (samples: VitalSample[]) => void): void {
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return;

  let ttfb = 0;
  let lcp = 0;
  let cls = 0;
  let fcp = 0;

  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav) ttfb = nav.responseStart;
  } catch { /* ignore */ }

  const observe = (type: string, cb: (entries: PerformanceEntryList) => void): void => {
    try {
      const po = new PerformanceObserver((list) => cb(list.getEntries()));
      po.observe({ type, buffered: true } as PerformanceObserverInit); // buffered: pre-attach entries
    } catch { /* entry type unsupported in this browser */ }
  };

  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1];
    if (last) lcp = last.startTime;
  });
  observe('layout-shift', (entries) => {
    for (const e of entries as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
      if (!e.hadRecentInput) cls += e.value;
    }
  });
  observe('paint', (entries) => {
    for (const p of entries) if (p.name === 'first-contentful-paint') fcp = p.startTime;
  });

  const flush = (): void => {
    const out: VitalSample[] = [];
    if (ttfb > 0) out.push({ metric: 'TTFB', value: ttfb });
    if (fcp > 0) out.push({ metric: 'FCP', value: fcp });
    if (lcp > 0) out.push({ metric: 'LCP', value: lcp });
    out.push({ metric: 'CLS', value: cls }); // CLS of 0 is a real, good measurement
    onSettle(out);
  };
  let flushed = false;
  const flushOnce = (): void => { if (!flushed) { flushed = true; flush(); } };
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushOnce(); });
  window.addEventListener('pagehide', flushOnce, { once: true });
}
