/**
 * Deterministic tour synthesis (ADR 0368 Phase 6b) — a `WalkthroughRecording` becomes
 * an ordinary `ui.walkthrough.step`/`ui.walkthrough.checkpoint` workflow definition, then a
 * TRANSIENT draft via the SAME `POST /host/openwop-app/workflows` path the
 * builder uses (ADR 0369 P4) — no parallel registration path, no LLM.
 *
 * Narration is a plain deterministic placeholder derived from the actionId;
 * the user edits it in review, or Phase 6c's Walkthrough Author agent enriches it.
 * A Tier-2 (unmatched) step synthesizes a `ui.walkthrough.step` whose actionId is a
 * placeholder that no registered action resolves → the player `needs-update`s
 * on it → the run can't complete → OQ5 blocks promotion. That is the DESIGNED
 * guard against shipping a broken recorded tour; the draft still saves so the
 * author can see what needs a registration.
 */
import { authedHeaders, config, fetchOpts } from '../client/config.js';
import type { WalkthroughRecording } from './walkthroughRecorder.js';

interface WalkthroughNode {
  nodeId: string;
  typeId: 'ui.walkthrough.step';
  config: { actionId: string; narration: string; hitl?: boolean; needsRegistration?: boolean; describe?: string };
}
interface WalkthroughEdge { edgeId: string; sourceNodeId: string; targetNodeId: string }
export interface SynthesizedWalkthrough {
  workflowId: string;
  metadata: { name: string; walkthrough: true; lifecycle: { transient: true; generatedBy: 'guided-tours.recorder' } };
  nodes: WalkthroughNode[];
  edges: WalkthroughEdge[];
  /** True when any step is Tier-2 (unmatched) — the draft cannot promote until
   *  a developer registers the action(s). Surfaced to the author. */
  hasUnregisteredSteps: boolean;
}

/** A readable default narration from an actionId ('a.b.click' → "B"). */
function defaultNarration(actionId: string): string {
  const part = (actionId.split('.').slice(1, -1).join(' ') || actionId).replace(/[-_]+/g, ' ');
  return part.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

export function synthesizeWalkthrough(recording: WalkthroughRecording, name: string): SynthesizedWalkthrough {
  const nodes: WalkthroughNode[] = [];
  const edges: WalkthroughEdge[] = [];
  let hasUnregisteredSteps = false;

  recording.steps.forEach((step, i) => {
    const nodeId = `s${i + 1}`;
    if (step.actionId) {
      nodes.push({
        nodeId, typeId: 'ui.walkthrough.step',
        config: { actionId: step.actionId, narration: defaultNarration(step.actionId), ...(step.verb === 'fill' || step.verb === 'select' ? { hitl: true } : {}) },
      });
    } else {
      // Tier-2: a placeholder actionId no registration resolves — non-promotable
      // by design, carried with the describe so the author knows what to add.
      hasUnregisteredSteps = true;
      nodes.push({
        nodeId, typeId: 'ui.walkthrough.step',
        config: { actionId: `unregistered.${i + 1}`, narration: `Needs a registered action — ${step.describe ?? 'unknown target'}`, needsRegistration: true, ...(step.describe ? { describe: step.describe } : {}) },
      });
    }
    if (i > 0) edges.push({ edgeId: `e${i}`, sourceNodeId: `s${i}`, targetNodeId: nodeId });
  });

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'recorded';
  return {
    // Grade-pass: randomUUID (the author-tool idiom) — the Date.now() suffix
    // had a 1ms same-slug collision window that silently OVERWROTE a draft.
    workflowId: `walkthrough.recorded.${slug}.${crypto.randomUUID().slice(0, 8)}`,
    metadata: { name, walkthrough: true, lifecycle: { transient: true, generatedBy: 'guided-tours.recorder' } },
    nodes,
    edges,
    hasUnregisteredSteps,
  };
}

/** Register the synthesized tour as a TRANSIENT draft (the builder's path). */
export async function saveRecordedWalkthrough(tour: SynthesizedWalkthrough): Promise<{ workflowId: string }> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/workflows`, fetchOpts({
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(tour),
  }));
  if (!res.ok) throw new Error(`save_recorded_tour_${res.status}`);
  return { workflowId: tour.workflowId };
}
