/**
 * `summarizeProvenance` — the pure event-log → provenance aggregator behind
 * `RunProvenancePanel` (models used, reasoning/decision counts, confidence
 * range, timing, human gates, substitution). No React, no fetch.
 *
 * CORRECTED (w49 grade pass): this header used to say the frontend "ships no
 * test runner" and that this file is excluded from type-checking. Both were
 * false: vitest runs it in the frontend lane, and `tsconfig.test.json`
 * type-checks it. Fixtures are therefore fully typed (`RunEventDoc`,
 * `RunSnapshot`) with no casts.
 *
 * Fixtures are ASYMMETRIC on purpose: confidences [0.4, 0.8, 0.6] (neither
 * extreme is the last value), an exact duration, an open interrupt with NO
 * `interrupt.requested` event (so the count floor is the only source of 1).
 *
 * What turns it red: calls not summed per model; min/max confidence taken from
 * the last decision; engineVersion/causationId dropped; duration not computed;
 * resumes not counted; the open-interrupt read or snapshot ignored; the
 * interrupt floor dropped; `substituted` defaulting true or never set.
 */

import { describe, it, expect } from 'vitest';
import type { RunEventDoc, RunSnapshot } from '@openwop/openwop';
import { summarizeProvenance } from '../RunProvenancePanel.js';

const OWNER: RunSnapshot['owner'] = {
  tenant: 't1', subject: { issuer: 'urn:openwop:test', subjectId: 'u1', tenant: 't1', lane: 'session', kind: 'user' },
};
function snap(over: Pick<RunSnapshot, 'status'> & Partial<RunSnapshot>): RunSnapshot {
  return { runId: 'run-1', workflowId: 'wf', owner: OWNER, eventLogSchemaVersion: 3, ...over };
}

let seq = 0;
function ev(type: string, payload: unknown, extra: Partial<RunEventDoc> = {}): RunEventDoc {
  seq += 1;
  return {
    eventId: `e${seq}`,
    runId: 'run-1',
    schemaVersion: 3,
    type,
    payload,
    timestamp: new Date(Date.UTC(2026, 5, 2, 12, 0, seq)).toISOString(),
    sequence: seq,
    ...extra,
  };
}

describe('summarizeProvenance', () => {
  it('returns an empty summary for no events', () => {
    seq = 0;
    const p = summarizeProvenance([]);
    expect(p.eventCount).toBe(0);
    expect(p.models).toEqual([]);
    expect(p.human.open).toBe(false);
    expect(p.human.interrupts).toBe(0);
  });

  it('derives models, decisions, confidence, and timing from the event log', () => {
    seq = 0;
    const events: RunEventDoc[] = [
      ev('run.started', { inputs: { topic: 'x' } }, { causationId: 'trigger-9', engineVersion: 7 }),
      ev('agent.reasoned', { reasoning: 'thinking' }),
      ev('provider.usage', { provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 10, outputTokens: 5 }),
      ev('provider.usage', { provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 20, outputTokens: 7 }),
      ev('agent.decided', { decision: 'route:a', confidence: 0.4 }),
      ev('agent.decided', { decision: 'route:b', confidence: 0.8 }),
      ev('agent.decided', { decision: 'route:c', confidence: 0.6 }),
      ev('run.completed', { output: { ok: true } }),
    ];
    const snapshot = snap({ workflowId: 'wf.demo', status: 'completed' });
    const p = summarizeProvenance(events, snapshot);

    expect(p.workflowId).toBe('wf.demo');
    // The wire type is a number; the summary carries it as a display string.
    expect(p.engineVersion).toBe('7');
    expect(p.causationId).toBe('trigger-9');
    expect(p.models).toEqual([{ provider: 'anthropic', model: 'claude-haiku-4-5', calls: 2 }]);
    expect(p.reasoningSteps).toBe(1);
    expect(p.decisions).toBe(3);
    expect(p.confidence).toEqual({ min: 0.4, max: 0.8 });
    expect(p.inputs).toEqual({ topic: 'x' });
    expect(p.output).toEqual({ ok: true });
    // run.started at seq 1 (12:00:01) → run.completed at seq 8 (12:00:08).
    expect(p.durationMs).toBe(7000);
    expect(p.human.interrupts).toBe(0);
    expect(p.substituted).toBe(false);
  });

  it('counts human gates: an interrupt that was resumed', () => {
    seq = 0;
    const events: RunEventDoc[] = [
      ev('run.started', {}),
      ev('interrupt.requested', { kind: 'approval' }),
      ev('run.resumed', {}),
      ev('run.completed', {}),
    ];
    const p = summarizeProvenance(events, snap({ status: 'completed' }));
    expect(p.human.interrupts).toBe(1);
    expect(p.human.kinds).toContain('approval');
    expect(p.human.resumes).toBe(1);
    expect(p.human.open).toBe(false);
  });

  it('flags an open interrupt from the snapshot as awaiting human', () => {
    seq = 0;
    const events: RunEventDoc[] = [ev('run.started', {}), ev('interrupt.requested', { kind: 'approval' })];
    const snapshot = snap({
      status: 'waiting-approval',
      interrupt: { kind: 'approval', nodeId: 'n1', interruptToken: 't' },
    });
    const p = summarizeProvenance(events, snapshot);
    expect(p.human.open).toBe(true);
    // One gate: the requested event and the open snapshot interrupt are the SAME gate.
    expect(p.human.interrupts).toBe(1);
  });

  it('ADR 0812 — flags an open interrupt from the page\'s open-interrupt read when the major-2 snapshot carries none', () => {
    seq = 0;
    const events: RunEventDoc[] = [ev('run.started', {})];
    // The closed v2 snapshot has no `interrupt`, which is what the SPA receives.
    const snapshot = snap({ status: 'waiting-approval' });
    expect(summarizeProvenance(events, snapshot).human.open, 'without the read, nothing marks it open').toBe(false);
    const p = summarizeProvenance(events, snapshot, 'approval');
    expect(p.human.open).toBe(true);
    expect(p.human.kinds).toContain('approval');
    // No interrupt.requested event here: the count of 1 comes only from the open read.
    expect(p.human.interrupts).toBe(1);
  });

  it('marks model substitution when model.capability.substituted fired', () => {
    seq = 0;
    const events: RunEventDoc[] = [
      ev('run.started', {}),
      ev('model.capability.substituted', { from: 'reasoning', to: 'standard' }),
      ev('run.completed', {}),
    ];
    const p = summarizeProvenance(events);
    expect(p.substituted).toBe(true);
  });
});
