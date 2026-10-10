/**
 * `core.conformance.hold` — the conformance-RESERVED PURE wait (openwop#1769,
 * conformance/fixtures.md §Reserved typeIds).
 *
 * "Completes after `inputs.delayMs` with its inputs as outputs and performs
 * nothing observable outside the run's own event log. A host advertising a
 * fixture that uses it MUST NOT classify it side-effecting (replay.md
 * §Suppression rule 1) and MUST re-execute it live in a replay."
 *
 * WHY IT EXISTS. `conformance-replay-side-effect` (v1) and
 * `conformance-replay-ordinal-loop` used `core.delay` for their wait, and the
 * registry's flow pack declares `core.delay` `role: "side-effect"`. This host
 * honours that declaration (the ADR 0572 derived floor), so a replay served the
 * wait's recorded outcome instead of re-running it — which is correct for
 * `core.delay` and wrong for the scenario, which needs the wait to run live in
 * the fork. The corpus replaced the wait with this node rather than weaken the
 * delay's role.
 *
 * PURE BY CONSTRUCTION: no pack manifest (so the derived side-effect floor
 * cannot see it), no entry in `executor/sideEffects.ts`'s typeId list, and
 * `sideEffecting: false` declared outright — every arm of `isSideEffectingNode`
 * answers no, so a replay re-executes it. `outputs` are EXACTLY its resolved
 * inputs (corpus 2.44.5 pins that), nothing added.
 *
 * Gated behind `conformanceNodesEnabled()`, like every reserved conformance node.
 */
import type { NodeModule, NodeContext, NodeOutcome } from '../executor/types.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { conformanceNodesEnabled } from './conformanceMockAgent.js';

export const CONFORMANCE_HOLD_TYPE_ID = 'core.conformance.hold';
/** The same ceiling `core.delay` keeps: a conformance wait is not a daemon. */
const MAX_HOLD_MS = 60_000;

export const holdNode: NodeModule = {
  typeId: CONFORMANCE_HOLD_TYPE_ID,
  version: '1.0.0',
  sideEffecting: false,
  async execute(ctx: NodeContext): Promise<NodeOutcome> {
    const inputs = { ...((ctx.inputs ?? {}) as Record<string, unknown>) };
    const raw = typeof inputs.delayMs === 'number' ? inputs.delayMs : Number(inputs.delayMs);
    const ms = Number.isFinite(raw) ? Math.max(0, Math.min(MAX_HOLD_MS, raw)) : 0;
    // Honour the run's abort signal, as `core.delay` does (ADR 0632): a cancel
    // or an `immediate` pause mid-hold stops the wait instead of sitting it out —
    // the replay scenario cancels its source INSIDE this hold.
    const maybe = (ctx as { signal?: unknown }).signal;
    const signal = maybe && typeof (maybe as AbortSignal).addEventListener === 'function' ? (maybe as AbortSignal) : undefined;
    await new Promise<void>((resolve, reject) => {
      if (!signal) { setTimeout(resolve, ms); return; }
      const fail = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      if (signal.aborted) { fail(); return; }
      const onAbort = (): void => { clearTimeout(t); fail(); };
      const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return { status: 'success', outputs: inputs };
  },
};

let registered = false;

export function registerConformanceHoldNode(): void {
  if (registered) return;
  if (!conformanceNodesEnabled()) return;
  getNodeRegistry().register(holdNode);
  registered = true;
}
