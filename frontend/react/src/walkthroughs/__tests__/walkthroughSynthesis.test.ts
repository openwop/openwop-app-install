/**
 * ADR 0368 Phase 6b — deterministic synthesis: a recording becomes a
 * transient `ui.walkthrough.step` DAG; fill/select steps are HITL; a Tier-2 step
 * makes the draft non-promotable (flagged) but still saves.
 *
 * w51 r2 (/grade-tests): three steps (a two-step chain cannot show the second edge),
 * the `metadata.walkthrough` flag (ADR 0440 — the ctx surface detects walkthroughs by
 * it, the page by the `walkthrough.` id prefix; both must hold), and the HITL rule
 * for every verb (fill, select → HITL; click → not). Each was a vacuous probe.
 */
import { describe, it, expect } from 'vitest';
import { synthesizeWalkthrough } from '../walkthroughSynthesis.js';
import type { WalkthroughRecording } from '../walkthroughRecorder.js';

const rec = (steps: WalkthroughRecording['steps']): WalkthroughRecording => ({ startedAt: '2026-07-15T00:00:00.000Z', steps });

describe('tour synthesis (ADR 0368 P6b)', () => {
  it('chains matched steps into a ui.walkthrough.step DAG with transient lifecycle', () => {
    const tour = synthesizeWalkthrough(rec([
      { actionId: 'campaign-studio.new-brief.click', route: '/campaign-studio', verb: 'click' },
      { actionId: 'campaign-studio.create-brief.click', route: '/campaign-studio', verb: 'click' },
      { actionId: 'campaign-studio.campaigns-tab.click', route: '/campaign-studio', verb: 'click' },
    ]), 'My Flow');

    expect(tour.metadata.lifecycle).toEqual({ transient: true, generatedBy: 'guided-tours.recorder' });
    expect(tour.metadata.name).toBe('My Flow');
    expect(tour.metadata.walkthrough).toBe(true); // ADR 0440 — the ctx surface's detection rule
    expect(tour.workflowId).toMatch(/^walkthrough\.recorded\.my-flow\./); // …and the page's
    expect(tour.nodes.map((n) => n.typeId)).toEqual(['ui.walkthrough.step', 'ui.walkthrough.step', 'ui.walkthrough.step']);
    expect(tour.nodes[0]!.config.actionId).toBe('campaign-studio.new-brief.click');
    expect(tour.nodes[0]!.config.narration).toBe('New Brief'); // derived from actionId
    expect(tour.nodes[0]!.config.hitl).toBeUndefined(); // a click is scripted, not HITL
    expect(tour.edges).toEqual([
      { edgeId: 'e1', sourceNodeId: 's1', targetNodeId: 's2' },
      { edgeId: 'e2', sourceNodeId: 's2', targetNodeId: 's3' },
    ]);
    expect(tour.hasUnregisteredSteps).toBe(false);
  });

  it('marks fill/select steps HITL (only the real user types)', () => {
    const tour = synthesizeWalkthrough(rec([
      { actionId: 'x.name.fill', route: '/x', verb: 'fill' },
      { actionId: 'x.plan.select', route: '/x', verb: 'select' },
      { actionId: 'x.go.click', route: '/x', verb: 'click' },
    ]), 'F');
    expect(tour.nodes.map((n) => n.config.hitl)).toEqual([true, true, undefined]);
  });

  it('a Tier-2 (unmatched) step flags the draft non-promotable but still synthesizes', () => {
    const tour = synthesizeWalkthrough(rec([
      { actionId: 'x.a.click', route: '/x', verb: 'click' },
      { route: '/x', verb: 'click', describe: 'link · [data-walkthrough=nav] · Somewhere' },
    ]), 'Partial');
    expect(tour.hasUnregisteredSteps).toBe(true);
    expect(tour.nodes[1]!.config.needsRegistration).toBe(true);
    expect(tour.nodes[1]!.config.actionId).toBe('unregistered.2'); // no registration resolves it → non-promotable
    expect(tour.nodes[1]!.config.describe).toContain('data-walkthrough=nav');
  });
});
