/**
 * ADR 0759 — the live launch-showcase projection renders ONLY from the run's event
 * log (tripwire cited by docs/steward/LLM-EXCHANGE-AUDIT.md: "event-only rendering").
 *
 * Guards and the case that reaches each:
 *   - mergeEvents drops a foreign run's events, de-dupes by sequence and sorts;
 *   - "no fabricated output" is a DOUBLE GUARD: `projectSteps` replaces a step
 *     without its old output on `node.started`/`node.failed`, AND `stageOutput`
 *     returns `{}` for any non-completed step. The original case exercises both at
 *     once (each single sabotage is masked by the other — round-1 probes
 *     w52g3-model-stale-output / -stageguard were vacuous by design); the two
 *     direct cases below reach each guard alone;
 *   - an edge animates only when its source is COMPLETED and its target RUNNING
 *     (fixture: `review` has four sources in the shipped pack, in three states);
 *   - a finished run animates nothing, even from a projection still marked running.
 * Expected edge lists are hand-derived from examples/workflow-chain-packs/launch-showcase/pack.json.
 */
import { describe, expect, it } from 'vitest';
import type { RunEventDoc } from '@openwop/openwop';
import { graphOf, mergeEvents, projectSteps, stageOutput, type Step } from './model.js';

const event = (sequence: number, type: string, nodeId = 'strategy', payload: unknown = {}): RunEventDoc => ({
  runId: 'r', sequence, type, nodeId, payload, timestamp: '2026-09-27T00:00:00Z', eventId: String(sequence), schemaVersion: 1,
});

describe('live showcase projection', () => {
  it('merges replayed/out-of-order events and rejects a foreign run', () => {
    const events=mergeEvents([event(2,'node.completed','strategy',{outputs:{data:{product:'Real output'}}})],[event(0,'run.started'),event(1,'node.started'),event(2,'node.completed','strategy',{outputs:{data:{product:'Real output'}}}),{...event(4,'node.failed'),runId:'foreign'}],'r');
    expect(events.map(e=>e.sequence)).toEqual([0,1,2]);
    const steps=projectSteps(events); expect(steps.strategy?.status).toBe('completed');
    expect(stageOutput(steps,'strategy')).toEqual({product:'Real output'});
  });

  it('does not fabricate output for waiting, failed or restarted attempts', () => {
    const steps=projectSteps([event(1,'node.completed','strategy',{outputs:{data:{old:true}}}),event(2,'node.started'),event(3,'node.failed')]);
    expect(stageOutput(steps,'strategy')).toEqual({});
    expect(projectSteps([event(4,'node.suspended','approval')]).approval?.status).toBe('waiting');
  });

  it('a restarted step drops the earlier attempt\'s output (projectSteps guard alone)', () => {
    const steps = projectSteps([event(1,'node.completed','strategy',{outputs:{data:{old:true}}}), event(2,'node.started')]);
    expect(steps.strategy).toEqual({ status: 'running', at: '2026-09-27T00:00:00Z' });
  });

  it('stageOutput shows nothing for a non-completed step even if it holds output (stageOutput guard alone)', () => {
    expect(stageOutput({ strategy: { status: 'failed', output: { data: { old: true } } } }, 'strategy')).toEqual({});
  });

  it('animates only dependencies with a completed source and running target', () => {
    const idle=graphOf(null,{}); expect(idle.edges.some(e=>e.animated)).toBe(false);
    const live=graphOf(null,{strategy:{status:'completed'},website:{status:'running'}});
    expect(live.edges.filter(e=>e.animated).map(e=>e.to)).toEqual(['website']);
    // review has four sources: strategy + website completed, emails running, campaign queued.
    const fanIn = graphOf(null, { strategy:{status:'completed'}, website:{status:'completed'}, emails:{status:'running'}, review:{status:'running'} });
    expect(fanIn.edges.filter(e=>e.animated).map(e=>`${e.from}->${e.to}`)).toEqual(['strategy->emails', 'strategy->review', 'website->review']);
  });

  it('stops motion when a run terminates and keeps completed drafts', () => {
    const steps = projectSteps([event(1,'node.completed','strategy',{outputs:{data:{product:'draft'}}}),event(2,'node.started','website'),event(3,'run.cancelled','')]);
    expect(steps.website?.status).toBe('cancelled');
    expect(stageOutput(steps,'strategy')).toEqual({product:'draft'});
    expect(graphOf(null,steps,true).edges.some(e=>e.animated)).toBe(false);
    expect(graphOf(null,steps,true).nodes.find(n=>n.id==='emails')?.data).toMatchObject({status:'skipped'});
  });

  it('a finished graph animates nothing even when a step is still projected as running', () => {
    const steps: Record<string, Step> = { strategy: { status: 'completed' }, website: { status: 'running' } };
    expect(graphOf(null, steps, false).edges.filter(e => e.animated)).toHaveLength(1); // control
    expect(graphOf(null, steps, true).edges.some(e => e.animated)).toBe(false);
  });
});
