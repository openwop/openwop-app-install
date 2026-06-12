import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { subscribeToNotifications } from '../notificationsClient.js';
import type { Notification } from '../types.js';

/** A well-formed notification wire object (passes `isNotification`). */
const NOTIF: Notification = {
  notificationId: 'n1',
  type: 'run.completed',
  title: 'Done',
  message: 'Run finished',
  createdAt: '2026-06-10T00:00:00.000Z',
  status: 'unread',
  priority: 'normal',
};

/** One-shot SSE body: emits a single `notification` frame, then closes —
 *  modeling a server that delivers an event and then the connection drops
 *  (instance recycle / proxy hangup), which must trigger a reconnect. */
function oneNotificationThenClose(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        controller.enqueue(enc.encode(`event: notification\ndata: ${JSON.stringify(NOTIF)}\n\n`));
        sent = true;
      } else {
        controller.close();
      }
    },
  });
}

describe('subscribeToNotifications (fetch-stream reconnect)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => new Response(oneNotificationThenClose(), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('connects, delivers frames, and reconnects after the stream drops', async () => {
    const onNotification = vi.fn();
    const onOpen = vi.fn();
    const onError = vi.fn();

    const stop = subscribeToNotifications({ onNotification, onOpen, onError });

    // Flush the initial connect + read + clean-close.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith(NOTIF);
    // Clean close → transient error flip → entering backoff.
    expect(onError).toHaveBeenCalledTimes(1);

    // Backoff for attempt 1 is ≤ 1000ms; advancing past it reconnects.
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenCalledTimes(2);

    // Cleanup aborts the loop — no further reconnects.
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps retrying when the endpoint returns a terminal non-2xx (e.g. 410)', async () => {
    fetchMock.mockImplementation(async () => new Response('gone', { status: 410 }));
    const onOpen = vi.fn();
    const onError = vi.fn();

    const stop = subscribeToNotifications({ onNotification: vi.fn(), onOpen, onError });

    await vi.advanceTimersByTimeAsync(0);
    // 410 → never opens, surfaces a transient error, schedules a retry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);

    // Unlike native EventSource, a non-2xx is NOT terminal here — it retries.
    await vi.advanceTimersByTimeAsync(1100);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    stop();
  });
});
