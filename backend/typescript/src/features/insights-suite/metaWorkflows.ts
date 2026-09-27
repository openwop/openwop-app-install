/**
 * Insights & Drafting meta-workflows — ADR 0082, MIGRATED to RFC 0013 chain packs
 * (ADR 0472 Phase 2, 2026-07-23). The three pinned WorkflowDefinitions moved OUT of
 * the deprecated `builtinWorkflows` array into
 * `examples/workflow-chain-packs/insights-suite/` and now register CHAIN-BACKED via
 * `registerChainBackedWorkflow` — the chainIds keep the original
 * `openwop-app.insights.*` ids, so scheduler (RFC 0052) / trigger (RFC 0099) / chat
 * ignition + replay resolve unchanged, while the chains are ALSO gallery-editable +
 * `/`-runnable (which a code-pinned builtin never was).
 *
 * Per-node `outputRole` (primary/secondary artifact surfacing) is a WorkflowNode
 * field the portable chain fragment cannot carry, so it is re-applied here at
 * registration via a per-chain post-processor — the same "portable structure + host
 * post-process" split app-builder uses (ADR 0472 Phase 1 `postProcess` hook).
 */

import { registerChainBackedWorkflow, buildChainBackedDefinition } from '../../host/chainBackedWorkflows.js';
import type { WorkflowDefinition } from '../../executor/types.js';

export const WEEKLY_VARIANCE_ID = 'openwop-app.insights.weekly-variance';
export const ANNIVERSARY_DRAFT_ID = 'openwop-app.insights.anniversary-draft';
export const TALENT_PREP_ID = 'openwop-app.insights.talent-prep';

/**
 * Per-chain outputRole maps (a WorkflowNode field the portable fragment can't carry).
 *
 * ── ADR 0600 §4 (`ISU-23`) — WHAT THIS MAP ACTUALLY DID, MEASURED ───────────
 *
 * The audit reported "curation with no consumer". Executing the three expanded
 * definitions showed something sharper, in two different directions:
 *
 * | chain | expandChain's raw roles | after this map | graph terminal |
 * |---|---|---|---|
 * | `weekly-variance`   | `notify=primary` | `notify=primary`   | `notify` |
 * | `anniversary-draft` | `notify=primary` | `emailDraft=primary`, `generate=secondary` | `notify` |
 * | `talent-prep`       | `notify=primary` | `score=primary`    | `notify` |
 *
 * So on `weekly-variance` the post-processor is a **measured no-op** — it
 * re-asserts exactly what the auto-terminal-primary stamp already produced. On
 * the other two it **STRIPPED the primary off the only graph terminal** and put
 * it on a node with outgoing edges, which the SPA's `useTerminalNodes` filtered
 * out by construction. The curation was not merely unread: for two of three
 * chains it REMOVED the one role the completion card could have read.
 *
 * The intent was right and the consumer was wrong. `outputRole:'primary'` means
 * "the canonical deliverable" (RFC 0065), which is a claim about DELIVERABLES,
 * not about graph shape — `emailDraft` (the drafted email) and `score` (the
 * 9-box result) are exactly right, and `notify` (a bell ring) is exactly the
 * wrong thing to hand a user as "the output". So the map stays and the
 * consumer was fixed to honour an explicit role on a non-terminal node
 * (`chat/WorkflowCompletionCard.tsx`).
 *
 * `secondary` is RETIRED, not fixed. Nothing in the SPA reads it: the only
 * consumer tests `outputRole === 'primary'`, and when any primary exists the
 * surfaced list narrows to the primary alone — so a `secondary` tag is dropped
 * by the same code path whether it is present or absent. That is a documented
 * mechanism with no reader, the class ADR 0599 retired `instanceUrlTemplate`,
 * `rejectionPolicy:"block"` and `VARIABLE_DEFAULTS` for, and the honest move is
 * to stop shipping it rather than to invent a consumer inside a feature PR.
 * The app-wide gap it exposes — `secondary` is AUTHORABLE in the Builder
 * Inspector and rendered nowhere — is recorded as a residual in ADR 0600 §9.
 */
const OUTPUT_ROLES: Record<string, Record<string, 'primary' | 'secondary'>> = {
  // WF-DOC-3 (chain 1.1.0): the input-less `render` step was removed — it
  // shipped with no orgId/documentId and could never succeed as authored.
  [WEEKLY_VARIANCE_ID]: { notify: 'primary' },
  [ANNIVERSARY_DRAFT_ID]: { emailDraft: 'primary' },
  [TALENT_PREP_ID]: { score: 'primary' },
};

/**
 * REMOVED (ADR 0599 §5) — `VARIABLE_DEFAULTS`.
 *
 * It carried a `{workdayResource:'serviceDates'}` restore justified by the claim that
 * "deferred expansion materializes a `parameter` into a `variables[]` entry but does NOT
 * propagate the JSON-Schema `default` to `defaultValue` without a passed value."
 *
 * That claim is FALSE, and it was falsified by measurement, not by re-reading it:
 * `workflowChainPackLoader.ts` resolves each param as
 * `providedParams[name] !== undefined ? providedParams[name] : spec.default` and then
 * emits `defaultValue` from the resolved value — so a no-params deferred expansion of
 * `anniversary-draft` already yields `{name:'workdayResource', defaultValue:'serviceDates'}`.
 * The restore loop was guarded on `v.defaultValue === undefined` and was therefore a
 * no-op every time it ran. Harmless, but it documented the loader incorrectly for the
 * next reader — and this feature's whole failure mode was trusting a documented
 * mechanism instead of grepping for its reader.
 *
 * This ALSO matters to the wiring: because schema defaults DO reach `variables[].defaultValue`,
 * and `seedRunVariables` falls back to `defaultValue` when a run supplies no input, a chain
 * parameter with a default is genuinely resolvable on a scheduler-started run. That is what
 * makes `sql` / `exemplarQuery` / `draftSubject` deliverable without run inputs.
 */

/** Build a migrated meta-workflow's expanded definition from its chain (requires the
 *  vendored pack loaded). Exposed so governance/structure tests validate the MIGRATED
 *  form, not a now-deleted raw def. */
export function buildInsightsMetaWorkflow(id: string): WorkflowDefinition {
  return buildChainBackedDefinition(id, { postProcess: insightsPostProcess(id) });
}

/** The per-chain post-process: re-apply the outputRole map expansion cannot carry.
 *  EXPORTED so `PROBE-IS-8` can drive the REAL post-processor over a synthetic
 *  definition (the `ISWF-18` suffix-collision case has no instance in the shipped
 *  chains, so the only way to witness the guard is to construct one). Testing an
 *  extracted copy would prove the copy works. */
export function insightsPostProcess(id: string) {
  return withOutputRoles(OUTPUT_ROLES[id] ?? {});
}

/** Build a post-processor that re-applies the EXACT per-node `outputRole` set after
 *  expansion. Matches the ORIGINAL fragment node id by suffix — `expandChain` prefixes
 *  ids (`<chain>_<expansionId>_<id>`), so a registered node id ends with `_<origId>`.
 *  CLEARS any role expansion set that the source map doesn't declare — `expandChain`
 *  auto-marks the TERMINAL node `primary`, which would otherwise add a spurious second
 *  primary (e.g. `notify`) alongside the intended one (`emailDraft`/`score`).
 *
 *  ADR 0600 §4 (`ISWF-18`) — SUFFIX-COLLISION GUARD. `endsWith('_' + origId)` collides
 *  when one node id is a `_`-suffix of another: a chain adding `re_score` beside `score`
 *  would have BOTH match `score` and take the first `Object.entries` hit, i.e. insertion
 *  order. The parameter un-prefixing path four files over hit this exact bug and fixed it
 *  with longest-first + consume-once (`chainBackedWorkflows.ts`); the role matcher never
 *  got the same treatment and was only VACUOUSLY safe (no current id collides). Same cure
 *  here, so it is safe by construction rather than by the current corpus. An exact-id
 *  match always wins over a suffix match — a node literally named `score` is `score`. */
function withOutputRoles(roles: Record<string, 'primary' | 'secondary'>) {
  // Longest-first: `retry_score` must claim its node before `score` looks at it.
  const origIds = Object.keys(roles).sort((a, b) => b.length - a.length);
  return (def: WorkflowDefinition): void => {
    const claimed = new Map<string, 'primary' | 'secondary'>();
    for (const origId of origIds) {
      const candidates = def.nodes
        .map((n) => n.nodeId)
        .filter((id) => !claimed.has(id) && (id === origId || id.endsWith(`_${origId}`)));
      if (candidates.length === 0) continue;
      // Exact id wins outright; otherwise the SHORTEST id is the tightest suffix
      // boundary — `<pfx>_score` over `<pfx>_re_score` — so an unmapped `re_score`
      // node can never absorb `score`'s role. Deterministic either way: no
      // dependence on `def.nodes` insertion order, which is what made the old
      // `Object.entries(...).find(...)` shape unsafe.
      const exact = candidates.find((id) => id === origId);
      const winner = exact ?? [...candidates].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0]!;
      claimed.set(winner, roles[origId]!);
    }
    for (const node of def.nodes) {
      const role = claimed.get(node.nodeId);
      if (role) node.outputRole = role;
      else if (node.outputRole !== undefined) delete node.outputRole; // drop auto-terminal-primary
    }
  };
}

/** Boot registration — the standard features-push-into-core inversion. ADR 0472
 *  Phase 1/2: chainId-only, resolve-by-id under the stable original id, with the
 *  per-chain outputRole post-processor. Soft-fails per chain (the API logs + swallows
 *  so one pack drift never aborts the boot loop). */
export function registerInsightsMetaWorkflows(): void {
  for (const id of [WEEKLY_VARIANCE_ID, ANNIVERSARY_DRAFT_ID, TALENT_PREP_ID]) {
    registerChainBackedWorkflow(id, { postProcess: insightsPostProcess(id) });
  }
}
