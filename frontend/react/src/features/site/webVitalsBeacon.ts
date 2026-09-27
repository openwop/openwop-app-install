/**
 * ADR 0018 CWV fold-in — report real-user Core Web Vitals from a PUBLIC published
 * page to the analytics beacon. Rides the EXISTING beacon contract (same
 * `sessionKey`, keepalive fetch, server-side consent gate — a non-consented
 * visitor's samples are dropped 202, the client never implements a second consent
 * rule) exactly like `sendExperimentPageview`. Each vital is one
 * `{ type:'event', name:'web-vital', props:{ metric, value } }` — no new event
 * type, no backend schema change; `summarize()` computes the p75 + rating.
 */
import { config } from '../../client/config.js';
import { measureWebVitals, type VitalSample } from '../../platform/measureWebVitals.js';

function sendVital(orgId: string, sessionKey: string, sample: VitalSample): void {
  try {
    // Round to a sane precision: CLS is a small unitless float, the rest are ms.
    const value = sample.metric === 'CLS' ? Math.round(sample.value * 1000) / 1000 : Math.round(sample.value);
    const url = `${config.baseUrl}/host/openwop-app/public-analytics/${encodeURIComponent(orgId)}/collect`;
    void fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ type: 'event', name: 'web-vital', sessionKey, props: { metric: sample.metric, value } }),
    }).catch(() => undefined);
  } catch { /* never break the page for measurement */ }
}

// Web Vitals are a per-DOCUMENT measurement, so report at most ONCE per document
// load — even if the SPA navigates between published slugs (which re-runs the
// caller's effect). Without this, each navigation would attach another observer
// set and re-report the same visitor's vitals, inflating the sample count.
let reported = false;

/** Measure this page's Core Web Vitals and report each to the beacon when they
 *  settle (page hidden/unloaded). Fire-and-forget; safe no-op without a key or
 *  the PerformanceObserver API, and idempotent per document. */
export function reportWebVitals(orgId: string, sessionKey: string): void {
  if (!orgId || !sessionKey || reported) return;
  reported = true;
  measureWebVitals((samples) => {
    for (const s of samples) sendVital(orgId, sessionKey, s);
  });
}
