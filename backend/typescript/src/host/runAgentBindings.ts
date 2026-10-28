/**
 * ADR 0943 D2 — the frozen per-node agent binding a run carries.
 *
 * A feature that lets a client replace a chain's pinned agent (campaign-ops
 * bindings) freezes the replacement into `run.metadata[RUN_AGENT_BINDINGS_KEY]`
 * at run start, keyed by node id. The agent-runner node reads ONLY this map,
 * never the feature's live store, so an edit after start changes nothing and a
 * `:fork` (a verbatim metadata copy) runs the source's agents. The key is
 * reserved: a caller cannot supply it (`RESERVED_RUN_METADATA_KEYS`).
 */
export const RUN_AGENT_BINDINGS_KEY = 'openwop-app.agentBindings';

export interface RunAgentBinding {
  agentId: string;
  bindingId?: string;
  model?: { provider: string; model: string; credentialRef?: string };
}

/**
 * Written for a pinned node when the contributor could NOT read the client's
 * bindings (a storage or toggle-resolver fault). Contributors must not fail run
 * creation, so the fault is recorded instead, and the runner refuses the node:
 * silently running the chain's default agent for a client who replaced it is
 * the wrong agent. A `:fork` copies the marker, so it acts as its source did.
 */
export interface UnresolvedRunAgentBinding { unresolved: true }

export function isUnresolvedBinding(b: RunAgentBinding | UnresolvedRunAgentBinding | undefined): b is UnresolvedRunAgentBinding {
  return !!b && (b as UnresolvedRunAgentBinding).unresolved === true;
}

/** The frozen binding for `nodeId`, when the run carries a well-formed one. */
export function frozenAgentBindingFor(metadata: Record<string, unknown> | undefined, nodeId: string): RunAgentBinding | UnresolvedRunAgentBinding | undefined {
  const map = metadata?.[RUN_AGENT_BINDINGS_KEY];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return undefined;
  const v = (map as Record<string, unknown>)[nodeId];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  if ((v as { unresolved?: unknown }).unresolved === true) return { unresolved: true };
  const { agentId, bindingId, model } = v as Record<string, unknown>;
  if (typeof agentId !== 'string' || agentId.length === 0) return undefined;
  let m: RunAgentBinding['model'];
  if (model && typeof model === 'object' && !Array.isArray(model)) {
    const { provider, model: name, credentialRef } = model as Record<string, unknown>;
    if (typeof provider === 'string' && provider && typeof name === 'string' && name) {
      m = { provider, model: name, ...(typeof credentialRef === 'string' && credentialRef ? { credentialRef } : {}) };
    }
  }
  return { agentId, ...(typeof bindingId === 'string' ? { bindingId } : {}), ...(m ? { model: m } : {}) };
}
