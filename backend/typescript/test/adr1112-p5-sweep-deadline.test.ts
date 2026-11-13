/**
 * ADR 1112 P5 — the submit-time auto-translate sweep has a deadline.
 *
 * The sweep runs inside the submit request, behind the hosting proxy's 60 s. Pins:
 *  - past AUTO_TRANSLATE_DEADLINE_MS it starts no new pair, aborts the call in flight, keeps
 *    what it drafted and reports `timedOut` (never `errored`, never a throw);
 *  - a sweep that finishes in time reports `timedOut: false`;
 *  - the caller's signal reaches a one-part translation too, so the call in flight stops.
 *
 * Sabotage, each restored, each red: drop the per-pair deadline check (the late-answer case); do not pass the signal
 * to translateSectionData; drop the single-part signal (`batches.length > 1 || outer`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/headlessAi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/headlessAi.js')>();
  return { ...actual, resolveHeadlessAi: vi.fn() };
});

import { resolveHeadlessAi, type HeadlessDispatch } from '../src/host/headlessAi.js';
import { AUTO_TRANSLATE_DEADLINE_MS, autoTranslateMissingOverlays, translateSectionData } from '../src/features/cms/translate.js';

const mockResolve = vi.mocked(resolveHeadlessAi);
afterEach(() => { vi.useRealTimers(); mockResolve.mockReset(); });

const hero = (i: number) => ({ sectionId: `s${i}`, type: 'hero' as const, data: { heading: `Hello ${i}` } });

/** A model that answers after `ms`, or rejects when its signal aborts. */
function slowModel(ms: number) {
  const signals: (AbortSignal | undefined)[] = [];
  const dispatch = vi.fn<HeadlessDispatch>((messages, opts) => {
    signals.push(opts.signal);
    const heading = /"heading": "([^"]+)"/.exec(String(messages[1]?.content))?.[1] ?? '';
    return new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => resolve(JSON.stringify({ heading: `ES ${heading}` })), ms);
      opts.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    });
  });
  mockResolve.mockResolvedValue(dispatch);
  return { dispatch, signals };
}

describe('ADR 1112 P5 — the sweep deadline', () => {
  it('stops at the deadline, keeps what it drafted, and reports timedOut', async () => {
    vi.useFakeTimers();
    // Each call takes 15 s: two finish inside 40 s, the third is in flight at the deadline.
    const { dispatch, signals } = slowModel(15_000);
    const pending = autoTranslateMissingOverlays('t1', [hero(1), hero(2), hero(3), hero(4)], ['es']);
    await vi.advanceTimersByTimeAsync(AUTO_TRANSLATE_DEADLINE_MS + 1);
    const r = await pending;
    expect(r).toMatchObject({ timedOut: true, errored: false, capped: false });
    expect([...r.overlays.keys()]).toEqual(['s1', 's2']);
    expect(dispatch).toHaveBeenCalledTimes(3); // the fourth never started
    expect(signals[2]?.aborted).toBe(true); // the third was aborted, not left running
  });
  it('starts no new pair after the deadline, even when the call in flight ignored the abort', async () => {
    vi.useFakeTimers();
    // A provider that does not honour the abort and answers after 41 s.
    const dispatch = vi.fn<HeadlessDispatch>((messages) => new Promise<string>((resolve) => {
      const heading = /"heading": "([^"]+)"/.exec(String(messages[1]?.content))?.[1] ?? '';
      setTimeout(() => resolve(JSON.stringify({ heading: `ES ${heading}` })), 41_000);
    }));
    mockResolve.mockResolvedValue(dispatch);
    const pending = autoTranslateMissingOverlays('t1', [hero(1), hero(2), hero(3)], ['es']);
    await vi.advanceTimersByTimeAsync(45_000);
    const r = await pending;
    expect(r.timedOut).toBe(true);
    expect([...r.overlays.keys()]).toEqual(['s1']); // its late answer is kept
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('reports timedOut: false when it finishes in time', async () => {
    vi.useFakeTimers();
    slowModel(1_000);
    const pending = autoTranslateMissingOverlays('t1', [hero(1), hero(2)], ['es', 'fr']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ timedOut: false, errored: false, translated: { es: 2, fr: 2 } });
  });
  it("passes the caller's signal to a one-part translation", async () => {
    const { signals } = slowModel(60_000);
    const stop = new AbortController();
    const pending = translateSectionData('t1', 'hero', { heading: 'Hello' }, 'es', { signal: stop.signal });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    stop.abort();
    await expect(pending).rejects.toBeDefined();
    expect(signals[0]?.aborted).toBe(true);
  });
});
