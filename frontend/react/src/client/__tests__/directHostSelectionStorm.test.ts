/**
 * ADR 1158 — when `/me/workspaces` is down, every direct-host stream fails at
 * once. The selection read must not become a read storm: the five streams share
 * one in-flight read, and after a failure the helper does not read again for a
 * cool-down of 2 s doubling to 60 s, whatever the streams' own backoff does. No
 * stream may open without the header meanwhile.
 *
 * The REAL helper and the real five stream clients run against a stubbed fetch:
 * `/me/workspaces` answers 503 and anything else is recorded. Jitter is pinned to
 * its minimum so the streams retry as fast as they ever would.
 *
 * Sabotage: removing the cool-down check reds the read bound; removing the shared
 * in-flight read reds the first-2-s bound.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    config: { ...actual.config, baseUrl: '/api', sseBaseUrl: 'https://backend.example.run.app' },
    authedHeaders: (extra?: Record<string, string>) => ({ authorization: 'Bearer t', ...(extra ?? {}) }),
  };
});

import { subscribeBoardEvents } from '../../kanban/kanbanClient.js';
import { subscribeToNotifications } from '../../notifications/notificationsClient.js';
import { subscribeChannelPresence, subscribeChannelMessages } from '../channelsClient.js';
import { subscribeVoiceTranscripts } from '../../chat/voice/voiceClient.js';
import { resetDirectHostSelectionForTests } from '../directHostSelection.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resetDirectHostSelectionForTests(); });

describe('ADR 1158 — /me/workspaces down with all five streams subscribed', () => {
  it('reads on the cool-down schedule, never in a burst, and opens no stream', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const reads: number[] = [];
    const streams: string[] = [];
    const start = Date.now();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/me/workspaces')) {
        reads.push(Date.now() - start);
        return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
      }
      streams.push(url);
      return new Response(null, { status: 200 });
    }));

    const unsubscribers = [
      subscribeBoardEvents('b1', () => undefined),
      subscribeToNotifications({ onNotification: () => undefined }),
      subscribeChannelPresence('c1', () => undefined),
      subscribeChannelMessages('c1', () => undefined),
      subscribeVoiceTranscripts('conv1', () => undefined),
    ];

    // 0 to 2 s: the five concurrent first attempts share ONE read, and the
    // streams' half-second retries hit the cool-down without reading.
    for (let t = 0; t < 1_999; t += 100) await vi.advanceTimersByTimeAsync(100);
    expect(reads).toEqual([0]);

    // Through 130 s, the reads can be no closer than the schedule allows:
    // 0, ≥2, ≥6, ≥14, ≥30, ≥62, ≥122 s, so at most 7.
    for (let t = 2_000; t < 130_000; t += 100) await vi.advanceTimersByTimeAsync(100);
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.length).toBeLessThanOrEqual(7);
    for (let i = 1; i < reads.length; i++) {
      expect(reads[i]! - reads[i - 1]!).toBeGreaterThanOrEqual(Math.min(2_000 * 2 ** (i - 1), 60_000));
    }
    expect(streams).toEqual([]);

    for (const off of unsubscribers) off();
  });
});
