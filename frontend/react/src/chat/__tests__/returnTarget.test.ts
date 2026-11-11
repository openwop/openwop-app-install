/**
 * returnTarget seam tests (ADR 0334 5b-2) — the chat return-handoff: staging a
 * return-target, the subscribable snapshot, and the one-shot pending-apply.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  stageReturnTarget, getReturnTarget, clearReturnTarget, subscribeReturnTarget,
  stagePendingApply, takePendingApply, peekPendingApply, appliesTo, __resetReturnTarget, type ReturnTarget,
} from '../returnTarget.js';

const T: ReturnTarget = { label: 'My Doc', returnPath: '/document-editor/c1', canvasId: 'c1', from: 3, to: 8 };

describe('returnTarget', () => {
  beforeEach(() => __resetReturnTarget());

  it('stages, reads (stable ref), and clears a return-target', () => {
    expect(getReturnTarget()).toBeNull();
    stageReturnTarget(T);
    expect(getReturnTarget()).toBe(T);
    expect(getReturnTarget()).toBe(T); // stable snapshot for useSyncExternalStore
    clearReturnTarget();
    expect(getReturnTarget()).toBeNull();
  });

  it('notifies subscribers on stage + clear, stops after unsubscribe', () => {
    const fn = vi.fn();
    const off = subscribeReturnTarget(fn);
    stageReturnTarget(T);
    clearReturnTarget();
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    stageReturnTarget(T);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('hands the pending-apply back exactly once (one-shot)', () => {
    expect(takePendingApply()).toBeNull();
    stagePendingApply({ canvasId: 'c1', from: 3, to: 8, text: 'better' });
    expect(takePendingApply()).toEqual({ canvasId: 'c1', from: 3, to: 8, text: 'better' });
    expect(takePendingApply()).toBeNull();
  });

  // ADR 1055 D5 — a launcher that is not ready, or is showing another document,
  // looks without consuming; only a reply from the agent it asked offers Apply.
  it('peek leaves the pending-apply for its owner; take still consumes once', () => {
    stagePendingApply({ canvasId: 'c1', from: 3, to: 8, expectedText: 'old', text: 'better' });
    expect(peekPendingApply()?.canvasId).toBe('c1');
    expect(peekPendingApply()?.canvasId).toBe('c1');
    expect(takePendingApply()?.expectedText).toBe('old');
    expect(peekPendingApply()).toBeNull();
  });

  it('a target bound to an agent offers Apply only on that agent\'s replies', () => {
    const bound: ReturnTarget = { ...T, agentId: 'agent.writer' };
    expect(appliesTo(bound, 'agent.writer')).toBe(true);
    expect(appliesTo(bound, 'agent.other')).toBe(false);
    expect(appliesTo(bound, undefined)).toBe(false);
    expect(appliesTo(T, undefined)).toBe(true); // an unbound target keeps the old behaviour
  });
});

