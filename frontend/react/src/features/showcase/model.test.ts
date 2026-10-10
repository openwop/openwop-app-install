import { describe, expect, it } from 'vitest';
import type { RunEventDoc } from '@openwop/openwop';
import { graphOf, mergeEvents, projectSteps, stageOutput } from './model.js';
const event = (sequence:number,type:string,nodeId='strategy', payload:unknown={}) => ({ runId:'r', sequence,type,nodeId,payload,timestamp:'2026-09-27T00:00:00Z',eventId:String(sequence),schemaVersion:1 } as RunEventDoc);
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
  it('animates only dependencies with a completed source and running target', () => {
    const idle=graphOf(null,{}); expect(idle.edges.some(e=>e.animated)).toBe(false);
    const live=graphOf(null,{strategy:{status:'completed'},website:{status:'running'}});
    expect(live.edges.filter(e=>e.animated).map(e=>e.to)).toEqual(['website']);
  });
  it('stops motion when a run terminates and keeps completed drafts', () => {
    const steps = projectSteps([event(1,'node.completed','strategy',{outputs:{data:{product:'draft'}}}),event(2,'node.started','website'),event(3,'run.cancelled','')]);
    expect(steps.website?.status).toBe('cancelled');
    expect(stageOutput(steps,'strategy')).toEqual({product:'draft'});
    expect(graphOf(null,steps,true).edges.some(e=>e.animated)).toBe(false);
    expect(graphOf(null,steps,true).nodes.find(n=>n.id==='emails')?.data).toMatchObject({status:'skipped'});
  });
});
