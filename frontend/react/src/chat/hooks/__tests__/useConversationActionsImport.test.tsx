/**
 * ADR 0992 D9 — the import half of `useConversationActions`.
 *
 * Claims, and what turns each red:
 * - A ChatGPT archive (an array of every conversation) opens the picker instead of
 *   being posted whole. Posting it was a guaranteed failure. Red if `isChatGptArchive`
 *   is not consulted.
 * - The chosen conversation alone is sent, under the key `<file digest>:<index>`.
 *   Red if the index or the digest is dropped from the key.
 * - A failure says WHY: too large / unsupported / empty / not JSON, never one generic
 *   line. Red if `failureCopy` collapses to `importFailed`.
 * - A replay says the conversation was already imported and opens it. Red if a
 *   replay reads as a fresh import.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

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
const importMock = vi.hoisted(() => vi.fn());
vi.mock('../../../client/chatExportClient.js', async (orig) => {
  const m = await orig<typeof import('../../../client/chatExportClient.js')>();
  return { ...m, importConversation: importMock, fileDigest: async () => 'd'.repeat(64) };
});

import { useConversationActions } from '../useConversationActions.js';
import { ChatImportError } from '../../../client/chatExportClient.js';

/** jsdom's File has no `text()`; browsers do, and the hook reads the file through it. */
const fileOf = (data: unknown): File => {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return Object.assign(new File([body], 'x.json', { type: 'application/json' }), { text: async () => body });
};
const tree = (title: string) => ({ title, create_time: 1_700_000_000, mapping: { a: { message: { author: { role: 'user' }, content: { parts: ['hi'] } } } }, current_node: 'a' });

function setup() {
  const onOpenConversation = vi.fn();
  const refreshList = vi.fn();
  const hook = renderHook(() => useConversationActions({ sessionId: 's', refreshList, onOpenConversation }));
  return { hook, onOpenConversation };
}

beforeEach(() => {
  toastCalls.length = 0;
  importMock.mockReset();
});

describe('useConversationActions — import (ADR 0992 D9)', () => {
  it('an archive opens the picker; the pick sends ONE conversation under <digest>:<index>', async () => {
    importMock.mockResolvedValue({ sessionId: 'new', imported: 1, skipped: 0, truncated: 0, replayed: false });
    const { hook, onOpenConversation } = setup();
    const archive = [tree('A'), tree('B')];
    await act(async () => { await hook.result.current.onImport(fileOf(archive)); });
    expect(importMock).not.toHaveBeenCalled();
    expect(hook.result.current.archiveEntries?.map((e) => e.title).sort()).toEqual(['A', 'B']);
    await act(async () => { await hook.result.current.onPickArchiveConversation(1); });
    expect(importMock).toHaveBeenCalledWith('chatgpt', archive[1], `${'d'.repeat(64)}:1`);
    expect(hook.result.current.archiveEntries).toBeNull();
    expect(onOpenConversation).toHaveBeenCalledWith('new');
    expect(toastCalls).toEqual([['info', 'importInProgress'], ['dismiss', '1'], ['success', 'importDone:1']]);
  });

  it('reports what was skipped or cut beside what was imported', async () => {
    importMock.mockResolvedValue({ sessionId: 'n', imported: 4, skipped: 2, truncated: 1, replayed: false });
    const { hook } = setup();
    await act(async () => { await hook.result.current.onImport(fileOf({ version: 'openwop-v1', messages: [] })); });
    expect(toastCalls.slice(2)).toEqual([['success', 'importDone:4 · importSkipped:2 · importTruncated:1']]);
  });

  it('a replay says it was already imported, and opens it', async () => {
    importMock.mockResolvedValue({ sessionId: 'same', imported: 2, skipped: 0, truncated: 0, replayed: true });
    const { hook, onOpenConversation } = setup();
    await act(async () => { await hook.result.current.onImport(fileOf({ version: 'openwop-v1', messages: [] })); });
    expect(toastCalls.slice(2)).toEqual([['info', 'importAlreadyImported']]);
    expect(onOpenConversation).toHaveBeenCalledWith('same');
  });

  it.each([
    ['too_large', 'importTooLarge'],
    ['unsupported', 'importUnsupported'],
    ['empty', 'importEmpty'],
    ['conflict', 'importConflict'],
    ['failed', 'importFailed'],
  ] as const)('a %s failure says so (%s)', async (failure, key) => {
    importMock.mockRejectedValue(new ChatImportError(failure));
    const { hook } = setup();
    await act(async () => { await hook.result.current.onImport(fileOf({ version: 'openwop-v1', messages: [] })); });
    // the in-progress toast is dismissed before the error says why
    expect(toastCalls).toEqual([['info', 'importInProgress'], ['dismiss', '1'], ['error', key]]);
  });

  it('a file that is not JSON is named as such, and nothing is sent', async () => {
    const { hook } = setup();
    await act(async () => { await hook.result.current.onImport(fileOf('not json {')); });
    expect(importMock).not.toHaveBeenCalled();
    expect(toastCalls).toEqual([['error', 'importNotJson']]);
  });
});
