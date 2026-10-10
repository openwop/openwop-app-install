import { describe, expect, it } from 'vitest';
import { approvalPreview, kitMarkdown } from './exportKit.js';
describe('approved launch kit export', () => {
  it('shows gate evidence only from the persisted direct artifact dependency', () => {
    const def = { edges:[{sourceNodeId:'editor',sourceOutput:'data',targetNodeId:'gate',targetInput:'artifact'}] };
    const data = {actions:['approve','reject']};
    expect(approvalPreview(def,{editor:{status:'completed',output:{data:{website:{headline:'Recorded headline'}}}}},'gate',data)).toMatchObject({actions:data.actions,options:[{content:expect.stringContaining('Recorded headline')}]});
    expect(approvalPreview(def,{editor:{status:'running'}},'gate',data)).toBe(data);
    expect(approvalPreview(def,{editor:{status:'completed',output:{data:{website:{}}}}},'different-gate',data)).toBe(data);
  });
  it('exports all deliverables and human checks as usable Markdown', () => {
    const output = kitMarkdown({ strategy:{product:'Fieldnote',audience:'Consultants'}, website:{headline:'A clear promise',benefits:[{title:'Benefit',body:'Body'}]}, emails:{sequence:[{subject:'Hello',body:'Email draft'}]}, campaign:{concept:'Campaign concept',posts:[{channel:'LinkedIn',hook:'Hook',body:'Social draft'}]}, changes:['Removed unsupported claims'], checksBeforeLaunch:['Confirm availability'] });
    for (const expected of ['# Fieldnote','A clear promise','Email draft','Social draft','Removed unsupported claims','Confirm availability']) expect(output).toContain(expected);
  });
});
