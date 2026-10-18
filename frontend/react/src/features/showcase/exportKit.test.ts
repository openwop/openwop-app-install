/**
 * ADR 0759 — the launch-showcase approval card and the Markdown handoff.
 *
 * `approvalPreview` may show launch-kit evidence on the approval gate ONLY when the
 * persisted definition has a direct `<source>.data → gate.artifact` edge AND that
 * source step is `completed` AND its output carries a `website` (a real kit). Each
 * guard has its own case below, with a fixture that reaches only that guard:
 *   - status guard   (`source?.status !== 'completed'`) — a RUNNING step that still
 *     carries a stale kit from an earlier attempt;
 *   - website guard  (`!record(kit).website`) — a completed step with no website;
 *   - targetInput    (`e.targetInput === 'artifact'`) — a kit wired to `context`;
 *   - sourceOutput   (`edge.sourceOutput !== 'data'`) — a kit wired from `meta`.
 * Sabotage any one guard → its case reds (w52g3-kit-*-r2).
 * `kitMarkdown` must carry every deliverable and every human check; dropping a
 * section (emails, checks) reds the export case.
 */
import { describe, expect, it } from 'vitest';
import { approvalPreview, kitMarkdown } from './exportKit.js';
import type { Step } from './model.js';

const gateData = { actions: ['approve', 'reject'] };
const kit = { website: { headline: 'Recorded headline' } };
const artifactEdge = { sourceNodeId: 'editor', sourceOutput: 'data', targetNodeId: 'gate', targetInput: 'artifact' };
const def = { edges: [artifactEdge] };

describe('approved launch kit export', () => {
  it('shows the recorded kit on the gate wired to it by a direct artifact edge', () => {
    const steps: Record<string, Step> = { editor: { status: 'completed', output: { data: kit } } };
    expect(approvalPreview(def, steps, 'gate', gateData)).toMatchObject({
      actions: ['approve', 'reject'],
      options: [{ key: 'recorded-launch-kit', content: expect.stringContaining('### Recorded headline') }],
    });
    // A gate with no edge from the kit gets its own data back, unchanged.
    expect(approvalPreview(def, steps, 'different-gate', gateData)).toBe(gateData);
  });

  it('shows nothing from a step that is not completed, even if it still carries an older kit', () => {
    const steps: Record<string, Step> = { editor: { status: 'running', output: { data: kit } } };
    expect(approvalPreview(def, steps, 'gate', gateData)).toBe(gateData);
  });

  it('shows nothing when the completed output is not a launch kit (no website)', () => {
    const steps: Record<string, Step> = { editor: { status: 'completed', output: { data: { strategy: { product: 'X' } } } } };
    expect(approvalPreview(def, steps, 'gate', gateData)).toBe(gateData);
  });

  it('shows nothing when the kit reaches the gate on a non-artifact input or from a non-data output', () => {
    const steps: Record<string, Step> = { editor: { status: 'completed', output: { data: kit } } };
    const viaContext = { edges: [{ ...artifactEdge, targetInput: 'context' }] };
    expect(approvalPreview(viaContext, steps, 'gate', gateData)).toBe(gateData);
    const fromMeta = { edges: [{ ...artifactEdge, sourceOutput: 'meta' }] };
    expect(approvalPreview(fromMeta, steps, 'gate', gateData)).toBe(gateData);
  });

  it('exports all deliverables and human checks as usable Markdown', () => {
    const output = kitMarkdown({ strategy:{product:'Fieldnote',audience:'Consultants'}, website:{headline:'A clear promise',benefits:[{title:'Benefit',body:'Body'}]}, emails:{sequence:[{subject:'Hello',body:'Email draft'}]}, campaign:{concept:'Campaign concept',posts:[{channel:'LinkedIn',hook:'Hook',body:'Social draft'}]}, changes:['Removed unsupported claims'], checksBeforeLaunch:['Confirm availability'] });
    for (const expected of ['# Fieldnote', '### A clear promise', '### 1. Hello', 'Email draft', '### LinkedIn — Hook', 'Social draft', '- Removed unsupported claims']) expect(output).toContain(expected);
    expect(output).toContain('## Checks before launch\n\n- Confirm availability');
  });
});
