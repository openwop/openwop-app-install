/**
 * WF-COS-1 — the one shape adjustment the assistant's chain-backed registrations
 * share.
 *
 * `expandChain` assigns `outputRole: 'primary'` to a chain's terminal node. The
 * six in-tree `WorkflowDefinition` literals this migration retires declared NO
 * `outputRole` on any node, and the field is not decorative: the builder renders
 * it and `host/reviewProjection.ts` reads it when deciding what a run's headline
 * output is. Adding it silently would be a behaviour change smuggled in under a
 * refactor, so it is stripped — the same call `registerLegacyDefsChainBacked`
 * makes for the same reason.
 *
 * Deliberately NOT a blanket "strip every outputRole": if one of these chains
 * ever declares a role in the pack ON PURPOSE, that is an author's choice and
 * this must not quietly undo it. Only the AUTO-assigned terminal `primary` — the
 * one no source declares — is removed, which is decided by asking the pack.
 */

import type { WorkflowDefinition } from '../../executor/types.js';
import { getChain } from '../../host/workflowChainPackLoader.js';

/** Remove `outputRole` from every node whose chain fragment did not declare one. */
export function stripAutoTerminalOutputRole(def: WorkflowDefinition): void {
  const chainId = (def.metadata as { chainId?: unknown } | undefined)?.chainId;
  const entry = typeof chainId === 'string' ? getChain(chainId) : null;
  if (!entry) return; // cannot tell what the pack declared — leave it alone
  const declared = new Set(
    (entry.chain.dag?.nodes ?? [])
      .filter((n) => (n as { outputRole?: unknown }).outputRole !== undefined)
      .map((n) => n.id),
  );
  for (const node of def.nodes) {
    if (node.outputRole === undefined) continue;
    // Expansion prefixes ids as `<chain>_<expansionId>_<fragmentId>`, so a
    // declared id is matched exactly OR as a `_`-delimited suffix.
    //
    // NO LONGEST-MATCH HERE, DELIBERATELY — and the previous comment claimed
    // otherwise. It said "match the LONGEST declared id so a fragment id that is
    // a suffix of another cannot claim it", and tracked a `bestLen` to do it,
    // but the loop's only output is the BOOLEAN `claimed`: once any declared id
    // matches, a longer one cannot change the outcome, so `bestLen` was computed
    // and never read. The tie-break is meaningless when the answer is
    // keep-or-delete rather than which-value-wins. The genuine version is
    // `features/index.ts registerNotebooksWorkflows`, where the winner supplies
    // the ROLE (`primary` vs `secondary`) and picking the wrong id picks the
    // wrong value. Behaviour is unchanged — and unreachable in this pack anyway,
    // since the six retired literals declare no `outputRole`, leaving `declared`
    // empty. Fixing the comment, not the logic: adding a real longest-match here
    // would be dead code dressed as rigour.
    let claimed = false;
    for (const id of declared) {
      if (node.nodeId === id || node.nodeId.endsWith(`_${id}`)) { claimed = true; break; }
    }
    if (!claimed) delete node.outputRole;
  }
}
