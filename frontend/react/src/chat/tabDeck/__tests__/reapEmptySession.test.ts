/**
 * reapEmptySession — the abandoned-empty-chat reap (deck close / re-key).
 * Pins the guards that keep it safe: only deck-minted ids, never mid-stream,
 * never a conversation with messages, and every failure path no-ops (a
 * lingering empty row is the pre-existing state, a wrong delete is data loss).
 */
import { describe, it, expect, vi } from 'vitest';
import { reapEmptySession } from '../TabChatDeck.js';

const deps = (over: Partial<Parameters<typeof reapEmptySession>[0]> = {}) => ({
  sessionId: 's1',
  isFresh: true,
  isStreaming: false,
  countMessages: vi.fn(async () => 0),
  remove: vi.fn(async () => undefined),
  ...over,
});

describe('reapEmptySession', () => {
  it('deletes a deck-minted, idle, empty session', async () => {
    const d = deps();
    await expect(reapEmptySession(d)).resolves.toBe(true);
    expect(d.remove).toHaveBeenCalledWith('s1');
  });

  it('never touches a conversation the deck did not mint (rail/library opens)', async () => {
    const d = deps({ isFresh: false });
    await expect(reapEmptySession(d)).resolves.toBe(false);
    expect(d.countMessages).not.toHaveBeenCalled();
    expect(d.remove).not.toHaveBeenCalled();
  });

  it('never deletes while a turn is streaming (the send→persist race)', async () => {
    const d = deps({ isStreaming: true });
    await expect(reapEmptySession(d)).resolves.toBe(false);
    expect(d.remove).not.toHaveBeenCalled();
  });

  it('keeps a session that has messages server-side', async () => {
    const d = deps({ countMessages: vi.fn(async () => 3) });
    await expect(reapEmptySession(d)).resolves.toBe(false);
    expect(d.remove).not.toHaveBeenCalled();
  });

  it('no-ops when the count probe fails (e.g. the row was never created — 404)', async () => {
    const d = deps({ countMessages: vi.fn(async () => { throw new Error('not_found: nope'); }) });
    await expect(reapEmptySession(d)).resolves.toBe(false);
    expect(d.remove).not.toHaveBeenCalled();
  });

  it('no-ops when the delete itself fails', async () => {
    const d = deps({ remove: vi.fn(async () => { throw new Error('offline'); }) });
    await expect(reapEmptySession(d)).resolves.toBe(false);
  });
});
