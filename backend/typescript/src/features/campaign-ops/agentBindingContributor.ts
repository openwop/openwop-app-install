/**
 * ADR 0943 D2.3 — freeze a client's agent bindings into a campaign run at start.
 *
 * For every agent-runner node of the run's definition, the node's pin
 * (`node.agent.agentId`, else `config.agentId` — chain packs cannot author
 * `node.agent` until the RFC 0013 revision ADR 0941 D9 owns) is looked up in the
 * client's bindings; the most specific match wins (node > workflow > pin only).
 * The result is `run.metadata['openwop-app.agentBindings'] = { [nodeId]: … }`.
 *
 * Cheap on the common path: a run with no client stamp, or with no agent-runner
 * node, returns before any read. A `:fork`/replay contributes nothing (ADR 0604
 * TOCWF-1): the copied metadata is authoritative, present or absent.
 *
 * The client comes from the host-written run stamps, both caller-stripped
 * (`CAMPAIGN_ATTRIBUTION_KEYS`): the ADR 0941 D2b run tag
 * (`campaignOrchestration.orgId`) or the ADR 0921 campaign-ops stamp. Two
 * stamps naming different clients bind nothing. The stamp only SELECTS which of
 * this tenant's bindings apply; it authorizes nothing.
 */
import { createLogger } from '../../observability/logger.js';
import { registerRunStartContributor, type RunStartContext } from '../../host/runStartContext.js';
import { RUN_AGENT_BINDINGS_KEY } from '../../host/runAgentBindings.js';
import { AGENT_RUNNER_TYPE_ID } from '../../host/agentRunnerNode.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { CAMPAIGN_OPS_RUN_STAMP } from './surface.js';
import { listAgentBindings } from './agentBindingService.js';
import type { ClientAgentBinding, FrozenAgentBinding } from './types.js';
import type { WorkflowDefinition } from '../../executor/types.js';

const log = createLogger('campaign-ops.agentBindings');
const TOGGLE_ID = 'campaign-ops';

function orgOf(stamp: unknown): string | undefined {
  const v = stamp && typeof stamp === 'object' ? (stamp as { orgId?: unknown }).orgId : undefined;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** The client a run is for, from its host-written stamps; `null` on a mismatch. */
export function runClientOrg(metadata: Readonly<Record<string, unknown>> | undefined): string | null | undefined {
  const fromTag = orgOf(metadata?.campaignOrchestration);
  const fromOps = orgOf(metadata?.[CAMPAIGN_OPS_RUN_STAMP]);
  if (fromTag && fromOps && fromTag !== fromOps) return null;
  return fromTag ?? fromOps;
}

/**
 * The chain-authored node id of an expanded node. `expandChain` prefixes every
 * node `<chainId with dots as _>_<hex expansionId>_<authored id>`, and the
 * expansion id changes with the params, so a client who narrows a binding to a
 * node names the id the CHAIN authored. Undefined for a definition that is not a
 * chain expansion (its ids are already the authored ones).
 */
export function authoredNodeId(def: Pick<WorkflowDefinition, 'metadata'>, nodeId: string): string | undefined {
  const from = (def.metadata as { expandedFrom?: { chainId?: unknown } } | undefined)?.expandedFrom;
  if (typeof from?.chainId !== 'string') return undefined;
  const m = new RegExp(`^${from.chainId.replace(/\./g, '_').replace(/[$()*+.?[\\\]^{|}-]/g, '\\$&')}_[0-9a-f]+_(.+)$`).exec(nodeId);
  return m?.[1];
}

/** The most specific binding for one node, or undefined. A node binding matches
 *  the expanded id or the chain-authored one. */
export function bindingForNode(all: readonly ClientAgentBinding[], pin: string, workflowId: string, nodeId: string, authoredId?: string): ClientAgentBinding | undefined {
  const forPin = all.filter((b) => b.pinnedAgentId === pin);
  return forPin.find((b) => b.workflowId === workflowId && b.nodeId !== undefined && (b.nodeId === nodeId || b.nodeId === authoredId))
    ?? forPin.find((b) => b.workflowId === workflowId && b.nodeId === undefined)
    ?? forPin.find((b) => b.workflowId === undefined && b.nodeId === undefined);
}

export async function agentBindingContributor(ctx: RunStartContext): Promise<Record<string, unknown>> {
  if (ctx.derivedFromRun || !ctx.definition) return {};
  const orgId = runClientOrg(ctx.metadata);
  if (orgId === undefined) return {};
  const pinned: Array<{ nodeId: string; pin: string }> = [];
  for (const node of ctx.definition.nodes ?? []) {
    if (node.typeId !== AGENT_RUNNER_TYPE_ID) continue;
    const cfgPin = (node.config as Record<string, unknown> | undefined)?.agentId;
    const pin = node.agent?.agentId ?? (typeof cfgPin === 'string' ? cfgPin : undefined);
    if (pin) pinned.push({ nodeId: node.nodeId, pin });
  }
  if (pinned.length === 0) return {};
  if (orgId === null) {
    log.warn('agent_binding_wrong_client', { tenantId: ctx.tenantId, workflowId: ctx.definition.workflowId });
    return {};
  }
  // A fault reading the toggle or the bindings is NOT "no binding": record it, so
  // the runner refuses the pinned nodes instead of running the default agent for a
  // client who replaced it (contributors may not fail run creation).
  let all: ClientAgentBinding[];
  try {
    const access = await resolveOne(TOGGLE_ID, { tenantId: ctx.tenantId });
    if (access?.blockedBy === 'unresolved') throw new Error('campaign-ops access could not be resolved');
    if (!access?.enabled) return {};
    all = await listAgentBindings(ctx.tenantId, orgId);
  } catch (err) {
    log.warn('agent_binding_read_failed', { tenantId: ctx.tenantId, workflowId: ctx.definition.workflowId, error: err instanceof Error ? err.message : String(err) });
    return { [RUN_AGENT_BINDINGS_KEY]: Object.fromEntries(pinned.map(({ nodeId }) => [nodeId, { unresolved: true }])) };
  }
  if (all.length === 0) return {};
  const frozen: Record<string, FrozenAgentBinding> = {};
  for (const { nodeId, pin } of pinned) {
    const b = bindingForNode(all, pin, ctx.definition.workflowId, nodeId, authoredNodeId(ctx.definition, nodeId));
    if (b) frozen[nodeId] = { agentId: b.agentId, bindingId: b.bindingId, ...(b.model ? { model: { ...b.model } } : {}) };
  }
  return Object.keys(frozen).length > 0 ? { [RUN_AGENT_BINDINGS_KEY]: frozen } : {};
}

let wired = false;
/** Register once per process (the `wireRunAiDefaultStamping` shape). */
export function wireAgentBindingStamping(): void {
  if (wired) return;
  wired = true;
  registerRunStartContributor(agentBindingContributor);
}
