/**
 * CDP-E — self-advancing timer (ADR 0267). Unit coverage for the replay-critical
 * pieces: the deadline is FROZEN from the persisted createdAt (deterministic on
 * :fork), and the sweep resumes each due timer exactly once (CAS-guarded).
 */
import { describe, expect, it, vi } from 'vitest';
import type { InterruptRecord } from '../src/types.js';
import type { Storage } from '../src/storage/storage.js';
import { timerDeadlineMs, sweepDueTimers } from '../src/executor/timerResume.js';

function timer(data: Record<string, unknown>, createdAt: string, over?: Partial<InterruptRecord>): InterruptRecord {
  return {
    interruptId: `it-${Math.random().toString(36).slice(2)}`,
    runId: 'run-1',
    nodeId: 'wait-1',
    kind: 'timer',
    token: 'tok',
    data,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 86_400_000).toISOString(),
    ...over,
  } as InterruptRecord;
}

const T0 = '2026-07-05T00:00:00.000Z';
const t0 = Date.parse(T0);

describe('CDP-E timerDeadlineMs — frozen, replay-stable', () => {
  it('duration: deadline = createdAt + seconds (independent of wall-clock)', () => {
    const itp = timer({ kind: 'duration', seconds: 3600 }, T0);
    expect(timerDeadlineMs(itp)).toBe(t0 + 3600 * 1000);
    // recomputing later (a :fork replay) yields the SAME deadline — no wall-clock drift
    expect(timerDeadlineMs(itp)).toBe(t0 + 3600 * 1000);
  });
  it('until: deadline = the absolute persisted timestamp', () => {
    const itp = timer({ kind: 'until', timestamp: '2026-07-06T12:00:00.000Z' }, T0);
    expect(timerDeadlineMs(itp)).toBe(Date.parse('2026-07-06T12:00:00.000Z'));
  });
  it('returns null for a non-timer interrupt or a malformed timer', () => {
    expect(timerDeadlineMs(timer({ kind: 'duration', seconds: 60 }, T0, { kind: 'approval' }))).toBeNull();
    expect(timerDeadlineMs(timer({ kind: 'duration' }, T0))).toBeNull();
  });
});

describe('CDP-E sweepDueTimers — resumes each due timer exactly once', () => {
  function stubStorage(open: InterruptRecord[], won: (id: string) => boolean): Storage {
    return {
      listOpenInterruptsAll: vi.fn(async () => open),
      resolveInterrupt: vi.fn(async (id: string) => won(id)),
    } as unknown as Storage;
  }

  it('resumes a due timer and marks it resolved', async () => {
    const due = timer({ kind: 'duration', seconds: 60 }, T0);
    const resume = vi.fn(async () => {});
    const storage = stubStorage([due], () => true);
    const n = await sweepDueTimers(storage, resume, t0 + 61_000);
    expect(n).toBe(1);
    expect(resume).toHaveBeenCalledOnce();
    expect(storage.resolveInterrupt).toHaveBeenCalledOnce();
  });

  it('skips a timer whose deadline has not elapsed', async () => {
    const notDue = timer({ kind: 'duration', seconds: 3600 }, T0);
    const resume = vi.fn(async () => {});
    const n = await sweepDueTimers(stubStorage([notDue], () => true), resume, t0 + 60_000);
    expect(n).toBe(0);
    expect(resume).not.toHaveBeenCalled();
  });

  it('does not resume when the CAS claim is lost (another instance won)', async () => {
    const due = timer({ kind: 'duration', seconds: 60 }, T0);
    const resume = vi.fn(async () => {});
    const n = await sweepDueTimers(stubStorage([due], () => false), resume, t0 + 61_000);
    expect(n).toBe(0);
    expect(resume).not.toHaveBeenCalled();
  });

  it('ignores non-timer and already-resolved interrupts', async () => {
    const resolved = timer({ kind: 'duration', seconds: 60 }, T0, { resolvedAt: T0 });
    const approval = timer({ kind: 'duration', seconds: 60 }, T0, { kind: 'approval' });
    const resume = vi.fn(async () => {});
    const n = await sweepDueTimers(stubStorage([resolved, approval], () => true), resume, t0 + 999_000);
    expect(n).toBe(0);
    expect(resume).not.toHaveBeenCalled();
  });
});
