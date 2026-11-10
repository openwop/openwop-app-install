/**
 * ADR 0992 D9 — the import half of `useConversationActions`.
 *
 * Stubbed at the FETCH level: the real `importConversation` builds the request
 * and maps the server's refusal to a `ChatImportError`, so both run under test.
 * Only `fileDigest` is mocked (a fixed digest keeps the key a literal).
 *
 * Claims, and what turns each red (witnessed, wave 78):
 * - A ChatGPT archive (an array of every conversation) opens the picker instead of
 *   being posted whole. Posting it was a guaranteed failure. Red if `isChatGptArchive`
 *   is not consulted.
 * - The chosen conversation alone is sent: `POST /chat-export/import` with body
 *   `{ format, data, idempotencyKey: '<file digest>:<index>' }`. Red if the index or
 *   the key is dropped.
 * - A failure says WHY: too large (413) / unsupported (400) / empty (400 + reason
 *   `empty`) / conflict (409) / anything else, never one generic line. Red if
 *   `failureCopy` collapses, or the client maps a status to the wrong failure.
 * - A replay says the conversation was already imported and opens it. Red if a
 *   replay reads as a fresh import.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { config } from '../../../client/config.js';
import type { ImportResult } from '../../../client/chatExportClient.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (o?.count !== undefined ? `${k}:${o.count}` : k) }) }));
const toastCalls = vi.hoisted(() => [] as Array<[string, string]>);
vi.mock('../../../ui/toast.js', () => ({
  toast: {
    success: (m: string) => toastCalls.push(['success', m]),
    error: (m: string) => toastCalls.push(['error', m]),
    // The in-progress toast is `info` with a TTL of 0; it must be dismissed when the import settles.
    info: (m: string) => { toastCalls.push(['info', m]); return toastCalls.length; },
    warning: (m: string) => toastCalls.push(['warning', m]),
  },
  dismiss: (id: number) => toastCalls.push(['dismiss', String(id)]),
}));
vi.mock('../../../client/chatExportClient.js', async (orig) => {
  const m = await orig<typeof import('../../../client/chatExportClient.js')>();
  return { ...m, fileDigest: async () => 'd'.repeat(64) };
});

import { useConversationActions } from '../useConversationActions.js';

const IMPORT_URL = `${config.baseUrl}/host/openwop-app/chat-export/import`;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const ok = (r: ImportResult): void => { fetchMock.mockResolvedValue(json(200, r)); };
/** Every call this file's fetch saw, as `[url, method, parsed body]`. */
const requests = (): Array<[string, string | undefined, unknown]> =>
  fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body ? JSON.parse(String(init.body)) : undefined]);

/** jsdom's File has no `text()`; browsers do, and the hook reads the file through it. */
const fileOf = (data: unknown): File => {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return Object.assign(new File([body], 'x.json', { type: 'application/json' }), { text: async () => body });
};
const tree = (title: string) => ({ title, create_time: 1_700_000_000, mapping: { a: { message: { author: { role: 'user' }, content: { parts: ['hi'] } } } }, current_node: 'a' });
const OPENWOP_FILE = { version: 'openwop-v1', messages: [] };

function setup() {
  const onOpenConversation = vi.fn();
  const refreshList = vi.fn();
  const hook = renderHook(() => useConversationActions({ sessionId: 's', refreshList, onOpenConversation }));
  return { hook, onOpenConversation };
}

beforeEach(() => {
  toastCalls.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('useConversationActions — import (ADR 0992 D9)', () => {
  it('an archive opens the picker; the pick sends ONE conversation under <digest>:<index>', async () => {
    ok({ sessionId: 'new', imported: 1, skipped: 0, truncated: 0, replayed: false });
    const { hook, onOpenConversation } = setup();
    const archive = [tree('A'), tree('B')];
    await act(async () => { await hook.result.current.onImport(fileOf(archive)); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hook.result.current.archiveEntries?.map((e) => e.title).sort()).toEqual(['A', 'B']);
    await act(async () => { await hook.result.current.onPickArchiveConversation(1); });
    expect(requests()).toEqual([[IMPORT_URL, 'POST', { format: 'chatgpt', data: tree('B'), idempotencyKey: `${'d'.repeat(64)}:1` }]]);
    expect(hook.result.current.archiveEntries).toBeNull();
    expect(onOpenConversation).toHaveBeenCalledWith('new');
    expect(toastCalls).toEqual([['info', 'importInProgress'], ['dismiss', '1'], ['success', 'importDone:1']]);
  });

  it('reports what was skipped or cut beside what was imported', async () => {
    ok({ sessionId: 'n', imported: 4, skipped: 2, truncated: 1, replayed: false });
    const { hook } = setup();
    await act(async () => { await hook.result.current.onImport(fileOf(OPENWOP_FILE)); });
    expect(requests()).toEqual([[IMPORT_URL, 'POST', { format: 'openwop', data: OPENWOP_FILE, idempotencyKey: 'd'.repeat(64) }]]);
    expect(toastCalls.slice(2)).toEqual([['success', 'importDone:4 · importSkipped:2 · importTruncated:1']]);
  });

  it('a replay says it was already imported, and opens it', async () => {
    ok({ sessionId: 'same', imported: 2, skipped: 0, truncated: 0, replayed: true });
    const { hook, onOpenConversation } = setup();
    await act(async () => { await hook.result.current.onImport(fileOf(OPENWOP_FILE)); });
    expect(toastCalls.slice(2)).toEqual([['info', 'importAlreadyImported']]);
    expect(onOpenConversation).toHaveBeenCalledWith('same');
  });

  // Each failure is the server's real answer: the client maps it, the hook words it.
  it.each([
    ['too_large', 'importTooLarge', 413, { error: 'payload_too_large', message: 'too big' }],
    ['unsupported', 'importUnsupported', 400, { error: 'validation_error', message: 'bad format' }],
    ['empty', 'importEmpty', 400, { error: 'validation_error', message: 'empty', details: { reason: 'empty' } }],
    ['conflict', 'importConflict', 409, { error: 'conflict', message: 'key reused' }],
    ['failed', 'importFailed', 500, { error: 'internal', message: 'boom' }],
  ] as const)('a %s failure says so (%s)', async (_failure, key, status, body) => {
    fetchMock.mockResolvedValue(json(status, body));
    const { hook } = setup();
    await act(async () => { await hook.result.current.onImport(fileOf(OPENWOP_FILE)); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // the in-progress toast is dismissed before the error says why
    expect(toastCalls).toEqual([['info', 'importInProgress'], ['dismiss', '1'], ['error', key]]);
  });

  it('a file that is not JSON is named as such, and nothing is sent', async () => {
    const { hook } = setup();
    await act(async () => { await hook.result.current.onImport(fileOf('not json {')); });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toastCalls).toEqual([['error', 'importNotJson']]);
  });
});
