import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setReporter, telemetry, getReporter, beaconReporter, type Reporter } from '../telemetry.js';

function makeSpy(): Reporter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    reportError: (e) => calls.push(`error:${e instanceof Error ? e.message : String(e)}`),
    reportMetric: (n, v) => calls.push(`metric:${n}=${v}`),
    reportEvent: (n) => calls.push(`event:${n}`),
  };
}

describe('telemetry reporter seam', () => {
  beforeEach(() => setReporter(null));

  it('defaults to a no-op reporter (no throw, no output)', () => {
    expect(() => telemetry.reportError(new Error('x'))).not.toThrow();
    expect(() => telemetry.reportMetric('app.api.duration_ms', 12)).not.toThrow();
  });

  it('forwards all three signal kinds to the installed reporter', () => {
    const spy = makeSpy();
    setReporter(spy);
    telemetry.reportError(new Error('boom'));
    telemetry.reportMetric('app.web_vital.lcp', 1200);
    telemetry.reportEvent('app.route.view');
    expect(spy.calls).toEqual(['error:boom', 'metric:app.web_vital.lcp=1200', 'event:app.route.view']);
  });

  it('uses only the vendor app.* namespace, never openwop.*', () => {
    const spy = makeSpy();
    setReporter(spy);
    telemetry.reportMetric('app.api.duration_ms', 1);
    expect(spy.calls.every((c) => !c.includes('openwop.'))).toBe(true);
  });

  it('setReporter(null) detaches back to no-op', () => {
    const spy = makeSpy();
    setReporter(spy);
    setReporter(null);
    telemetry.reportEvent('app.route.view');
    expect(spy.calls).toEqual([]);
    expect(getReporter()).toBeTruthy();
  });
});

describe('beaconReporter', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

  it('never throws even if the transport is unavailable', () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', undefined);
    const r = beaconReporter('https://collect.example/t');
    expect(() => r.reportEvent('app.route.view')).not.toThrow();
  });
});
