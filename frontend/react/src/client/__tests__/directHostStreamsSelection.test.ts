/**
 * ADR 1158 — the long-lived streams that go straight to the backend host carry the
 * active workspace's selection header: the kanban board feed, the notification feed,
 * channel presence, channel messages and voice transcripts. Each backend route
 * resolves its tenant from the request (`tenantOf` / `resolveTenantFromReq`), and the
 * direct host never sees this origin's session cookie, so without the header a
 * signed-in caller in a shared workspace streamed their PERSONAL workspace.
 *
 * Sabotage: dropping the `directHostSelectionHeaders()` spread from any one caller
 * reds its row; the "no selection" row reds if a caller invents a header. When the
 * selection cannot be read the helper throws, and each caller must take its
 * failed-fetch path (back off and retry) WITHOUT opening the stream: moving the call
 * out of the caller's `try`, or catching it to `{}`, reds the fail-closed rows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const selection = vi.hoisted(() => ({ headers: {} as Record<string, string>, fail: false, calls: 0 }));
vi.mock('../directHostSelection.js', () => ({
  directHostSelectionHeaders: async () => {
    selection.calls += 1;
    if (selection.fail) throw new Error('The active workspace could not be confirmed. Retrying.');
    return selection.headers;
  },
}));

import { subscribeBoardEvents } from '../../kanban/kanbanClient.js';
import { subscribeToNotifications } from '../../notifications/notificationsClient.js';
import { subscribeChannelPresence, subscribeChannelMessages } from '../channelsClient.js';
import { subscribeVoiceTranscripts } from '../../chat/voice/voiceClient.js';

const SEL = 'x-openwop-workspace-selection';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); selection.headers = {}; selection.fail = false; selection.calls = 0; });

/** Open one subscription, capture the init of its first stream fetch, then unsubscribe. */
async function firstStreamInit(open: () => () => void, path: string): Promise<RequestInit> {
  let captured: RequestInit | undefined;
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes(path)) captured = init;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }));
  const unsubscribe = open();
  await vi.waitFor(() => expect(captured).toBeDefined());
  unsubscribe();
  return captured!;
}

const CALLERS: Array<{ label: string; open: () => () => void; path: string }> = [
  { label: 'kanban board feed', open: () => subscribeBoardEvents('b1', () => undefined), path: '/kanban/boards/b1/events' },
  { label: 'notification feed', open: () => subscribeToNotifications({ onNotification: () => undefined }), path: '/notifications/stream' },
  { label: 'channel presence', open: () => subscribeChannelPresence('c1', () => undefined), path: '/channels/c1/presence' },
  { label: 'channel messages', open: () => subscribeChannelMessages('c1', () => undefined), path: '/channels/c1/stream' },
  { label: 'voice transcripts', open: () => subscribeVoiceTranscripts('conv1', () => undefined), path: '/voice/realtime/messages/stream' },
];

describe('ADR 1158 — direct-host streams carry the workspace selection', () => {
  it.each(CALLERS)('$label sends the selection header', async ({ open, path }) => {
    selection.headers = { [SEL]: 'ws1.tok' };
    const init = await firstStreamInit(open, path);
    expect(new Headers(init.headers).get(SEL)).toBe('ws1.tok');
  });

  it.each(CALLERS)('$label sends none when no shared workspace is active', async ({ open, path }) => {
    const init = await firstStreamInit(open, path);
    expect(new Headers(init.headers).has(SEL)).toBe(false);
  });
});

describe('ADR 1158 — an unreadable selection fails closed', () => {
  const FAIL_CALLERS: Array<{ label: string; path: string; open: (seen: { errors: number }) => () => void }> = [
    { label: 'kanban board feed', path: '/kanban/boards/b1/events', open: () => subscribeBoardEvents('b1', () => undefined) },
    { label: 'notification feed', path: '/notifications/stream', open: (seen) => subscribeToNotifications({ onNotification: () => undefined, onError: () => { seen.errors += 1; } }) },
    { label: 'channel presence', path: '/channels/c1/presence', open: (seen) => subscribeChannelPresence('c1', (snap) => { if (!snap.connected) seen.errors += 1; }) },
    { label: 'channel messages', path: '/channels/c1/stream', open: () => subscribeChannelMessages('c1', () => undefined) },
    { label: 'voice transcripts', path: '/voice/realtime/messages/stream', open: () => subscribeVoiceTranscripts('conv1', () => undefined) },
  ];

  it.each(FAIL_CALLERS)('$label never opens the stream, and backs off and retries', async ({ label, path, open }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(Math, 'random').mockReturnValue(0);
    selection.fail = true;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const seen = { errors: 0 };
    const unsubscribe = open(seen);
    await vi.advanceTimersByTimeAsync(0);
    expect(selection.calls).toBe(1);
    // Not a tight loop: no second attempt before the caller's backoff.
    await vi.advanceTimersByTimeAsync(400);
    expect(selection.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(selection.calls).toBeGreaterThan(1);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes(path))).toHaveLength(0);
    // The two feeds with a designed "reconnecting" state report it.
    if (label === 'notification feed' || label === 'channel presence') expect(seen.errors).toBeGreaterThan(0);
    unsubscribe();
  });
});
