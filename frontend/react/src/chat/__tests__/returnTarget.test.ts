/**
 * returnTarget seam tests (ADR 0334 5b-2, ADR 1055 D5) — the chat return-handoff:
 * staging a return-target, the subscribable snapshot, the one-shot pending-apply,
 * the non-consuming peek, and the agent binding that decides which replies offer
 * "Apply" (MessageBubble reads `appliesTo`; DocumentEditorSurface peeks first).
 *
 * Sabotage that turns these red (returnTarget.ts): a fresh copy from
 * getReturnTarget, clear without notify, a no-op unsubscribe, take that does not
 * clear, peek that consumes, an agent check that ignores the bound agent, or an
 * unbound target compared by agent id (the last needs a NON-undefined message
 * agent: with `undefined` on both sides the comparison holds anyway).
 */
import { describe, it, expect, beforeEach } from 'vitest';
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
    // Record the snapshot each notification sees: a subscriber must read the NEW
    // state (what useSyncExternalStore re-renders with), not merely be called.
    const seen: (ReturnTarget | null)[] = [];
    const off = subscribeReturnTarget(() => { seen.push(getReturnTarget()); });
    stageReturnTarget(T);
    clearReturnTarget();
    expect(seen).toEqual([T, null]);
    off();
    stageReturnTarget(T);
    expect(seen).toEqual([T, null]);
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
    // An unbound target keeps the old behaviour: every assistant reply offers Apply,
    // including one from a named agent (`undefined` alone cannot tell an id
    // comparison apart, since undefined === undefined).
    expect(appliesTo(T, undefined)).toBe(true);
    expect(appliesTo(T, 'agent.other')).toBe(true);
  });
});

