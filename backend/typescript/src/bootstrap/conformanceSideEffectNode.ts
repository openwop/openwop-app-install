/**
 * `core.conformance.side-effect` — reference-host implementation of the
 * conformance-RESERVED node the RFC 0140 fixture
 * (`conformance-replay-side-effect`) uses.
 *
 * RFC 0140 requires that a `mode:"replay"` fork not re-perform a
 * side-effecting node's effect. The conformance suite cannot ship a node that
 * has a real effect — effect nodes are host/vendor-specific, and `core.*` is
 * orchestration primitives only — so it reserves this typeId (the
 * `core.conformance.mock-agent` precedent) and requires a host advertising
 * `replay.sideEffectSuppression: "recorded-outcome"` to map it to a node its
 * replay classifier genuinely treats as side-effecting.
 *
 * THIS NODE PERFORMS A REAL EFFECT ON PURPOSE. It emits a notification — a
 * durable, user-visible row, the exact seam the #2871 regression escaped
 * through. A stub returning `{ ok: true }` would satisfy the fixture's shape
 * while proving nothing: the scenario asserts that the host REFUSES to run
 * this node during a replay, and that assertion is only meaningful if running
 * it would actually do something.
 *
 * Two host mechanisms therefore cover it, and the scenario exercises both:
 *   - ADR 0341 — the typeId is in `executor/sideEffects.ts`'s classifier, so a
 *     replay short-circuits the node BEFORE `execute` and serves the source
 *     run's recorded outcome, or fails closed with `replay_source_missing`.
 *   - ADR 0531 — were the classifier entry ever removed, the notification seam
 *     itself calls `assertEffectAllowed('notification', …)` and the effect
 *     still cannot fire during a replay; the node fails with the same code by
 *     the backstop path instead of the fast path.
 *
 * Gated behind `conformanceNodesEnabled()` (the shared gate — fails CLOSED in
 * the auth deploy posture), so it is never registered on a real deployment.
 */

import type { NodeModule, NodeContext, NodeOutcome } from '../executor/types.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { getNotificationEmitter } from '../notifications/emitter.js';
import { conformanceNodesEnabled } from './conformanceMockAgent.js';

export const CONFORMANCE_SIDE_EFFECT_TYPE_ID = 'core.conformance.side-effect';

export const sideEffectNode: NodeModule = {
  typeId: CONFORMANCE_SIDE_EFFECT_TYPE_ID,
  version: '1.0.0',
  // Belt-and-braces with the ADR 0341 typeId list: a programmatically
  // registered node can declare itself, so this node stays classified even if
  // the pattern list is edited.
  sideEffecting: true,
  async execute(ctx: NodeContext): Promise<NodeOutcome> {
    // A real, durable, user-visible effect — see the docblock for why this is
    // not a stub. On a replay this line is unreachable: ADR 0341 short-circuits
    // the node first, and ADR 0531's guard inside the emitter is the backstop.
    const record = await getNotificationEmitter().emit({
      tenantId: ctx.tenantId,
      type: 'conformance.side-effect',
      priority: 'normal',
      // UX: this lands in a real person's notification bell whenever conformance
      // nodes are enabled (dev/test/conformance — never the auth posture). The
      // copy therefore has to tell a human who did not run the suite what this
      // is and that ignoring it is correct; "Conformance side effect" alone
      // reads like a defect report.
      title: 'Test notification (conformance suite)',
      message:
        `Sent deliberately by the RFC 0140 replay-suppression check, to prove a replay does NOT re-send it. ` +
        `Nothing is wrong — you can ignore or dismiss this. Run ${ctx.runId}.`,
      ...(ctx.runId ? { runId: ctx.runId } : {}),
    });
    return { status: 'success', outputs: { notificationId: record.notificationId } };
  },
};

let registered = false;

export function registerConformanceSideEffectNode(): void {
  if (registered) return;
  if (!conformanceNodesEnabled()) return;
  getNodeRegistry().register(sideEffectNode);
  registered = true;
}
