/**
 * CC-CHAT-2 — a REJECTED approval gate's decision record says "Rejected".
 *
 * Observed live on app.openwop.dev (build 373d4863a, 2026-11-12 ~01:57Z): the
 * DeckTalk messaging-kernel gate was rejected from the chat card; the run ended
 * `approval_rejected`, the brief kept no kernel — and the thread's decision
 * record read `aria-label="HITL decision: Approved"`, also after a reload
 * (the snapshot persisted it).
 *
 * Mechanism: on `interrupt.resolved` the subscription took the decision from
 * `nodeOutputs[node]`, i.e. the gate's `node.completed` output. A rejected gate
 * FAILS its node (RFC 0223, `approval_rejected`) — there is no node.completed,
 * so the entry got `resumeValue: undefined`, and HitlDecisionCard's default verb
 * for an approval is "Approved". The event itself says what happened: the host
 * writes `decision: 'rejected', action: 'reject'` on every rejection
 * (`routes/interrupts.ts`, the v2 `action` MUST).
 *
 * Pins: a rejection with NO node output reads Rejected; the comment the gate
 * output carried is kept; an approval still reads Approved; a node output that
 * already says reject still reads Rejected.
 *
 * Sabotage witness: make `resolvedResumeValue` ignore the event payload ⇒
 * "a rejected gate with no node output" goes red ("Approved").
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { resolvedResumeValue } from '../resolvedDecision.js';
import { HitlDecisionCard } from '../../HitlDecisionCard.js';

afterEach(cleanup);

const entry = (resumeValue: unknown) => ({ interruptId: 'i1', nodeId: 'approve', kind: 'approval', openedAt: '2026-11-12T01:55:00Z', resolvedAt: '2026-11-12T01:57:00Z', resumeValue });
const verb = () => screen.getByLabelText(/HITL decision:/).getAttribute('aria-label') ?? '';

describe('CC-CHAT-2 — the decision record of a resolved gate', () => {
  it('a rejected gate with no node output (the live shape) reads Rejected', () => {
    const value = resolvedResumeValue(undefined, { interruptId: 'i1', kind: 'approval', decision: 'rejected', action: 'reject' });
    render(<HitlDecisionCard entry={entry(value)} />);
    expect(verb()).toMatch(/Rejected/);
    expect(verb()).not.toMatch(/Approved/);
  });

  it('a rejection keeps the comment the gate output carried', () => {
    const value = resolvedResumeValue({ output: { comment: 'Headline must name the forwarded deck.' } }, { decision: 'rejected', action: 'reject' });
    expect(value).toMatchObject({ action: 'reject', comment: 'Headline must name the forwarded deck.' });
  });

  it('control: an approval reads Approved (node output carries the resume value)', () => {
    const value = resolvedResumeValue({ output: { action: 'approve' } }, { decision: 'granted', action: 'approve' });
    render(<HitlDecisionCard entry={entry(value)} />);
    expect(verb()).toMatch(/Approved/);
  });

  it('control: a node output that already says reject stays a rejection', () => {
    expect(resolvedResumeValue({ output: { action: 'reject' } }, {})).toMatchObject({ action: 'reject' });
  });
});
