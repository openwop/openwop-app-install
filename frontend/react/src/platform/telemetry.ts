/**
 * Frontend observability — a small, pluggable reporter.
 *
 * The app emits three signal kinds (errors, metrics, events) to whatever sink
 * the deployment installs via setReporter(). The default is a no-op so nothing
 * leaves the browser unless explicitly wired up; a console reporter is provided
 * for dev. This is the seam the enterprise review asked for (production error
 * reporting + API timing + web-vitals) without committing the reference app to
 * a specific vendor.
 *
 * Namespacing: metric/event names use the vendor `app.*` namespace, NEVER
 * `openwop.*` (reserved for protocol-tier OTel signals per observability.md).
 */

export interface TelemetryContext {
  [key: string]: string | number | boolean | undefined;
}

export interface Reporter {
  reportError(error: unknown, context?: TelemetryContext): void;
  /** Numeric measurement, e.g. app.api.duration_ms, app.web_vital.lcp. */
  reportMetric(name: string, value: number, context?: TelemetryContext): void;
  /** Discrete occurrence, e.g. app.route.view. */
  reportEvent(name: string, context?: TelemetryContext): void;
}

const noopReporter: Reporter = {
  reportError() {},
  reportMetric() {},
  reportEvent() {},
};

/** Dev reporter: logs to the console (the only allowed console levels). */
export const consoleReporter: Reporter = {
  reportError(error, context) {
    console.error('[telemetry] error', error, context ?? {});
  },
  reportMetric(name, value, context) {
    console.warn(`[telemetry] ${name}=${value}`, context ?? {});
  },
  reportEvent(name, context) {
    console.warn(`[telemetry] ${name}`, context ?? {});
  },
};

/**
 * Beacon reporter: POSTs signals to a collector endpoint via
 * navigator.sendBeacon (falls back to fetch+keepalive), batched per tick so a
 * burst of metrics is one request. Opt-in — installed by initObservability only
 * when VITE_TELEMETRY_ENDPOINT is set. Errors are swallowed (telemetry must
 * never break the app).
 */
export function beaconReporter(endpoint: string): Reporter {
  type Signal = { kind: 'error' | 'metric' | 'event'; name: string; value?: number; ctx?: TelemetryContext };
  let queue: Signal[] = [];
  let scheduled = false;
  const flush = (): void => {
    scheduled = false;
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    try {
      const body = JSON.stringify({ signals: batch });
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
      } else if (typeof fetch === 'function') {
        void fetch(endpoint, { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {});
      }
    } catch { /* never throw from telemetry */ }
  };
  const enqueue = (s: Signal): void => {
    queue.push(s);
    if (!scheduled) { scheduled = true; queueMicrotask(flush); }
  };
  return {
    reportError(error, ctx) {
      enqueue({ kind: 'error', name: error instanceof Error ? error.message : String(error), ...(ctx ? { ctx } : {}) });
    },
    reportMetric(name, value, ctx) { enqueue({ kind: 'metric', name, value, ...(ctx ? { ctx } : {}) }); },
    reportEvent(name, ctx) { enqueue({ kind: 'event', name, ...(ctx ? { ctx } : {}) }); },
  };
}

let reporter: Reporter = noopReporter;
export function setReporter(next: Reporter | null): void {
  reporter = next ?? noopReporter;
}
export function getReporter(): Reporter {
  return reporter;
}

export const telemetry: Reporter = {
  reportError: (e, c) => reporter.reportError(e, c),
  reportMetric: (n, v, c) => reporter.reportMetric(n, v, c),
  reportEvent: (n, c) => reporter.reportEvent(n, c),
};

/**
 * Capture Core Web Vitals + navigation timing using native PerformanceObserver
 * (no web-vitals dependency). Emits app.web_vital.* metrics. Safe no-op where
 * the APIs are unavailable. Call once at boot.
 */
export function initWebVitals(): void {
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return;

  // TTFB from the navigation entry.
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav) telemetry.reportMetric('app.web_vital.ttfb', Math.round(nav.responseStart), { kind: 'ttfb' });
  } catch { /* ignore */ }

  const observe = (type: string, cb: (entries: PerformanceEntryList) => void): void => {
    try {
      const po = new PerformanceObserver((list) => cb(list.getEntries()));
      // buffered: catch entries that fired before this observer attached.
      po.observe({ type, buffered: true } as PerformanceObserverInit);
    } catch { /* entry type unsupported in this browser */ }
  };

  // Largest Contentful Paint — keep the latest reported value.
  let lcp = 0;
  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1];
    if (last) lcp = last.startTime;
  });

  // Cumulative Layout Shift — sum shifts not caused by recent input.
  let cls = 0;
  observe('layout-shift', (entries) => {
    for (const e of entries as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
      if (!e.hadRecentInput) cls += e.value;
    }
  });

  // Report final values when the page is hidden/unloaded (when vitals settle).
  const flush = (): void => {
    if (lcp > 0) telemetry.reportMetric('app.web_vital.lcp', Math.round(lcp), { kind: 'lcp' });
    telemetry.reportMetric('app.web_vital.cls', Math.round(cls * 1000) / 1000, { kind: 'cls' });
  };
  let flushed = false;
  const flushOnce = (): void => { if (!flushed) { flushed = true; flush(); } };
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushOnce(); }, { once: false });
  window.addEventListener('pagehide', flushOnce, { once: true });
}

/** Record a route view + the time since the last view (route-load proxy). */
let lastRouteAt = 0;
export function reportRouteView(path: string): void {
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  const sinceMs = lastRouteAt ? Math.round(now - lastRouteAt) : 0;
  lastRouteAt = now;
  telemetry.reportEvent('app.route.view', { path, ...(sinceMs ? { since_prev_ms: sinceMs } : {}) });
}
