/**
 * ADR 1019 D4 — the client follows a new chat's auto-title past its first exchange,
 * because the server names the chat after the exchange's stream has closed.
 *
 * Pins: reports an `auto` title once and stops; stops without reporting on `user` /
 * `given`; keeps reading through `default` / `claimed` and a failed read; gives up
 * silently after the last read; cancel stops it.
 * The `auto` header arrives on the 4th of 5 reads, so a follow that kept going after
 * reporting would show a 5th read.
 * Cancel is a DOUBLE GUARD: the `cancelled` flag and `clearTimeout(timer)` each stop the
 * pending read alone, so dropping either one leaves the cancel case green; dropping both
 * reds it (probe w82g2-fat-cancel-both).
 * Sabotage (2026-10-31, re-measured wave 82): report on any title (not
 * `titleSource === 'auto'`) → the first and `user`/`given` cases red; drop the
 * `user`/`given` stop → those cases red; keep following after the report → the first
 * case reds; treat a failed read as final → the first case reds; read once past the
 * last delay → the give-up case reds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followAutoTitle } from '../lib/followAutoTitle.js';
import type { ChatSessionHeader } from '../../client/chatSessionsClient.js';

type Header = Pick<ChatSessionHeader, 'title' | 'titleSource'>;
const DELAYS = [10, 20, 30, 40, 50];

function reader(seq: Array<Header | Error>) {
  const reads: string[] = [];
  return {
    reads,
    read: async (sid: string): Promise<Header> => {
      reads.push(sid);
      const next = seq[Math.min(reads.length - 1, seq.length - 1)]!;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('followAutoTitle (ADR 1019 D4)', () => {
  it('reads past the placeholder and the claim, then reports the auto title once', async () => {
    const r = reader([
      { title: 'hello', titleSource: 'default' },
      new Error('blip'),
      { title: 'hello', titleSource: 'claimed' },
      { title: 'Trip Planning', titleSource: 'auto' },
    ]);
    const titles: string[] = [];
    followAutoTitle('s1', (t) => titles.push(t), { read: r.read, delaysMs: DELAYS });
    await vi.advanceTimersByTimeAsync(200);
    expect(titles).toEqual(['Trip Planning']);
    expect(r.reads).toEqual(['s1', 's1', 's1', 's1']);
  });

  for (const source of ['user', 'given'] as const) {
    it(`stops without reporting when the title is '${source}'`, async () => {
      const r = reader([{ title: 'Mine', titleSource: source }]);
      const titles: string[] = [];
      followAutoTitle('s1', (t) => titles.push(t), { read: r.read, delaysMs: DELAYS });
      await vi.advanceTimersByTimeAsync(100);
      expect(titles).toEqual([]);
      expect(r.reads).toHaveLength(1);
    });
  }

  it('gives up silently after the last read when the call never landed', async () => {
    const r = reader([{ title: 'hello', titleSource: 'claimed' }]);
    const titles: string[] = [];
    followAutoTitle('s1', (t) => titles.push(t), { read: r.read, delaysMs: DELAYS });
    await vi.advanceTimersByTimeAsync(1000);
    expect(titles).toEqual([]);
    expect(r.reads).toHaveLength(DELAYS.length);
  });

  it('cancel stops further reads and any report', async () => {
    const r = reader([{ title: 'hello', titleSource: 'default' }, { title: 'Late', titleSource: 'auto' }]);
    const titles: string[] = [];
    const cancel = followAutoTitle('s1', (t) => titles.push(t), { read: r.read, delaysMs: DELAYS });
    await vi.advanceTimersByTimeAsync(10);
    cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(titles).toEqual([]);
    expect(r.reads).toHaveLength(1);
  });
});
