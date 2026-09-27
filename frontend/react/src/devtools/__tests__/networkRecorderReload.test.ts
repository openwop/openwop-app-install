/**
 * grade-ux F3 / grade-code #3 — a request still open when the page unloaded is
 * restored as ENDED-UNKNOWN, not "still running" forever. SSE rows now stay open until
 * their stream ends, and an app with a live notifications stream always has one open.
 */
import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  window.sessionStorage.setItem('openwop.networkRecorder.v1', JSON.stringify([
    { id: 'a', method: 'GET', url: 'http://h/v1/events', path: '/v1/events', startedAt: 1, kind: 'sse', status: 200, ok: true },
    { id: 'b', method: 'GET', url: 'http://h/v1/runs', path: '/v1/runs', startedAt: 1, finishedAt: 5, durationMs: 4, kind: 'rest', status: 200, ok: true },
  ]));
});

describe('rehydrating the network recorder after a reload', () => {
  it('marks an unfinished row unfinishedAtReload and leaves finished rows alone', async () => {
    const rec = await import('../networkRecorder.js');
    rec.installNetworkRecorder();
    const byId = (id: string) => rec.listNetworkEntries().find((e) => e.id === id)!;
    expect(byId('a').unfinishedAtReload).toBe(true);
    expect(byId('b').unfinishedAtReload).toBeUndefined();
  });
});
