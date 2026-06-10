/**
 * Boot-time observability wiring (call once from main.tsx).
 *
 * - Installs a Reporter: a console reporter in dev, otherwise no-op unless a
 *   deployment wires its own via setReporter(). (A real network sink is
 *   deployment-specific; the reference app ships the seam, not a vendor.)
 * - Forwards requestJson timing into the reporter as app.api.* metrics.
 * - Starts Core Web Vitals capture.
 *
 * All signals are vendor-namespaced (`app.*`), never `openwop.*`.
 */

import { setReporter, consoleReporter, beaconReporter, telemetry, initWebVitals } from './telemetry.js';
import { setRequestTelemetry } from '../client/requestJson.js';

export function initObservability(): void {
  const env = (import.meta as { env?: Record<string, unknown> }).env ?? {};
  const isDev = env.DEV === true || env.DEV === 'true';
  const endpoint = typeof env.VITE_TELEMETRY_ENDPOINT === 'string' ? env.VITE_TELEMETRY_ENDPOINT : '';

  // Sink selection (pluggable so the white-label template doesn't hard-code a
  // vendor): an explicit collector endpoint wins; else console in dev; else
  // no-op. A deployment can still override at runtime via setReporter().
  if (endpoint) setReporter(beaconReporter(endpoint));
  else if (isDev) setReporter(consoleReporter);

  // API timing/error instrumentation via the requestJson seam.
  setRequestTelemetry({
    onRequest: ({ method, path, status, durationMs, ok }) => {
      telemetry.reportMetric('app.api.duration_ms', durationMs, { method, path, status, ok });
      if (!ok) telemetry.reportEvent('app.api.error', { method, path, status });
    },
  });

  initWebVitals();
}
