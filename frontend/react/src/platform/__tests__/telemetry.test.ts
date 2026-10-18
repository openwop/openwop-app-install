/**
 * Frontend telemetry seam — what leaves the browser.
 *
 * Privacy: the MODULE default sink is a no-op, so nothing leaves the browser (no
 * beacon, no fetch, no console) until a deployment installs a reporter. Namespacing:
 * the product's own emitters (`reportRouteView`, `initWebVitals`) use the vendor `app.*`
 * names, never `openwop.*` (reserved for protocol-tier OTel, observability.md). The
 * beacon batches a burst into one POST carrying an error's MESSAGE (not its stack), and
 * a transport that throws never escapes.
 *
 * Sabotage that turns it red: default to `consoleReporter` (or a beacon); emit
 * `openwop.route.view`; `setReporter(null)` keeping the old sink; flush per signal;
 * send the stack; drop the flush try/catch.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { VitalSample } from '../measureWebVitals.js';

const vitals = vi.hoisted(() => ({ samples: [] as VitalSample[] }));
vi.mock('../measureWebVitals.js', () => ({
  measureWebVitals: (onSettle: (samples: VitalSample[]) => void): void => { onSettle(vitals.samples); },
}));

import {
  setReporter, telemetry, getReporter, beaconReporter, reportRouteView, initWebVitals, type Reporter,
} from '../telemetry.js';

function makeSpy(): Reporter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reportError: (e) => calls.push(`error:${e instanceof Error ? e.message : String(e)}`),
    reportMetric: (n, v) => calls.push(`metric:${n}=${v}`),
    reportEvent: (n) => calls.push(`event:${n}`),
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('telemetry reporter seam', () => {
  beforeEach(() => setReporter(null));

  it('the MODULE default reporter sends nothing anywhere (no beacon, no fetch, no console)', async () => {
    const sendBeacon = vi.fn<(url: string, data?: BodyInit | null) => boolean>(() => true);
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('navigator', { sendBeacon });
    vi.stubGlobal('fetch', fetchSpy);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A FRESH module: the beforeEach above resets the shared instance to the no-op, so only
    // a new instance shows what the module itself defaults to.
    vi.resetModules();
    const fresh = await import('../telemetry.js');
    fresh.telemetry.reportError(new Error('x'));
    fresh.telemetry.reportMetric('app.api.duration_ms', 12);
    fresh.telemetry.reportEvent('app.route.view');
    await Promise.resolve();
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('forwards all three signal kinds to the installed reporter', () => {
    const spy = makeSpy();
    setReporter(spy);
    telemetry.reportError(new Error('boom'));
    telemetry.reportMetric('app.web_vital.lcp', 1200);
    telemetry.reportEvent('app.route.view');
    expect(spy.calls).toEqual(['error:boom', 'metric:app.web_vital.lcp=1200', 'event:app.route.view']);
  });

  it('the product emitters use only the vendor app.* namespace, never openwop.*', () => {
    const spy = makeSpy();
    setReporter(spy);
    vitals.samples = [{ metric: 'LCP', value: 1234.4 }, { metric: 'CLS', value: 0.12345 }];
    reportRouteView('/x');
    initWebVitals();
    expect(spy.calls).toEqual(['event:app.route.view', 'metric:app.web_vital.lcp=1234', 'metric:app.web_vital.cls=0.123']);
    expect(spy.calls.filter((c) => c.includes('openwop.'))).toEqual([]);
  });

  it('setReporter(null) detaches back to no-op', () => {
    const spy = makeSpy();
    setReporter(spy);
    setReporter(null);
    telemetry.reportEvent('app.route.view');
    expect(spy.calls).toEqual([]);
    expect(getReporter()).not.toBe(spy);
  });
});

describe('beaconReporter', () => {
  it('batches a burst of signals into a single POST (fetch fallback path)', async () => {
    // jsdom's Blob/Response interop can't read sendBeacon Blob bodies, so
    // exercise the fetch fallback (no sendBeacon) where the body is a string.
    const sent: { url: string; body: string }[] = [];
    vi.stubGlobal('navigator', {}); // no sendBeacon
    vi.stubGlobal('fetch', (url: string, init?: { body?: string }) => {
      sent.push({ url, body: String(init?.body) });
      return Promise.resolve(new Response('', { status: 204 }));
    });
    const r = beaconReporter('https://collect.example/t');
    r.reportMetric('app.api.duration_ms', 12, { path: '/v1/x' });
    r.reportEvent('app.route.view');
    r.reportError(new Error('boom'));
    await Promise.resolve(); // let queueMicrotask flush

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://collect.example/t');
    const parsed = JSON.parse(sent[0]!.body) as { signals: Array<{ kind: string; name: string }> };
    expect(parsed.signals.map((s) => s.kind)).toEqual(['metric', 'event', 'error']);
    expect(parsed.signals[2]!.name).toBe('boom');
  });

  it('never throws even when the transport itself throws', () => {
    const sendBeacon = vi.fn<(url: string, data?: BodyInit | null) => boolean>(() => { throw new Error('beacon down'); });
    vi.stubGlobal('navigator', { sendBeacon });
    // Run the batch flush INLINE so a throw that escaped it would surface from the
    // report call itself (a throw in a real microtask is only an unattributed error).
    vi.stubGlobal('queueMicrotask', (cb: () => void) => { cb(); });
    const r = beaconReporter('https://collect.example/t');
    expect(() => r.reportEvent('app.route.view')).not.toThrow();
    expect(sendBeacon).toHaveBeenCalledTimes(1); // the transport was reached
  });
});
