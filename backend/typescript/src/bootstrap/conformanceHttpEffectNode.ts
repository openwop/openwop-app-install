/**
 * `core.conformance.http-effect` — a conformance-RESERVED node that performs
 * ONE real outbound HTTP request to a URL the conformance suite owns (RFC 0158
 * §C `duplicate-delivery`, ADR 0739 D4 / P2b).
 *
 * WHY IT EXISTS. From suite 2.32.0 that row counts the effect WHERE IT LANDS:
 * the suite starts a receiver, hands the durability seam an `effectUrl`, and
 * asserts exactly one arrival after the same accepted work is delivered twice.
 * (The earlier row counted `/effects` rows per identity, and a ledger keyed on
 * effect identity admits one row per identity whatever the effect did.) So the
 * staged work needs a node whose effect is an HTTP request to an ARBITRARY url —
 * and no shipped node offers that without a connection + credential.
 *
 * THE EGRESS IS THE REAL ONE, ON PURPOSE. It calls `ctx.http.safeFetch` — the
 * single host-mediated egress every `core.openwop.http.*` pack node uses — and
 * adds NOTHING to it: no dedup of its own, no claim, no memo. Whatever stops a
 * second delivery from landing a second request must be the host's, or the row
 * would be witnessing this file. If this node double-fires under duplicate
 * delivery, that is the finding (see ADR 0739 D4: the ADR 0618 claim has one
 * production call site, and it is not on this path).
 *
 * `sideEffecting: true` — so a replay short-circuits it (ADR 0341) like any
 * other effect node. Gated behind `conformanceNodesEnabled()`, which fails
 * CLOSED in the auth deploy posture: never registered on a real deployment.
 */
import type { NodeModule, NodeContext, NodeOutcome } from '../executor/types.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { conformanceNodesEnabled } from './conformanceMockAgent.js';

export const CONFORMANCE_HTTP_EFFECT_TYPE_ID = 'core.conformance.http-effect';

export const httpEffectNode: NodeModule = {
  typeId: CONFORMANCE_HTTP_EFFECT_TYPE_ID,
  version: '1.0.0',
  sideEffecting: true,
  async execute(ctx: NodeContext): Promise<NodeOutcome> {
    const url = (ctx.config as { url?: unknown } | undefined)?.url;
    if (typeof url !== 'string' || url.length === 0) {
      return { status: 'failure', error: { code: 'validation_error', message: 'core.conformance.http-effect requires config.url' } };
    }
    if (!ctx.http) {
      // Typed failure, never a silent success: a run that "completed" without
      // sending anything would read, at the receiver, exactly like dedup.
      return { status: 'failure', error: { code: 'host_capability_missing', message: 'ctx.http.safeFetch is not available to this node' } };
    }
    const res = await ctx.http.safeFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: ctx.runId, nodeId: ctx.nodeId }),
    });
    await res.arrayBuffer().catch(() => undefined);
    return { status: 'success', outputs: { httpStatus: res.status } };
  },
};

let registered = false;

export function registerConformanceHttpEffectNode(): void {
  if (registered) return;
  if (!conformanceNodesEnabled()) return;
  getNodeRegistry().register(httpEffectNode);
  registered = true;
}
