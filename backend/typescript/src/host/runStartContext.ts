/**
 * ADR 0099 — core IoC seam: resolve a cross-cutting decision ONCE per run at
 * creation and freeze it into `run.metadata`, read verbatim on `:fork` (the
 * `trustBoundary` read-side precedent generalized to a write-side resolver, for
 * features that own no run-creation route).
 *
 * Applied at the two run constructors — `startWorkflowRun` (host/runStarter.ts,
 * covering its scheduled/trigger/heartbeat/approval/agent/webhook callers) and
 * the `buildRunRecord` callers (routes/runs.ts, features/workflow-author). A
 * contributor returns a metadata patch that is merged (never overwriting an
 * existing key, so `:fork`-copied values win on replay).
 *
 * Contributors MUST be fail-soft: a throw is swallowed (logged) and that
 * contributor simply contributes nothing — run creation never fails on this.
 */

import { createLogger } from '../observability/logger.js';

const log = createLogger('host.runStartContext');

export interface RunStartContext {
  tenantId: string;
  /** The dispatched/owning agent, when a run is agent-attributed (for per-agent config). */
  agentId?: string;
  /**
   * ADR 0604 (TOCWF-1) — TRUE when this run's `metadata` is a VERBATIM COPY of
   * an existing run's (the `:fork`/replay lane), rather than a fresh blob.
   *
   * WHY A CONTRIBUTOR NEEDS THIS, AND WHY THE MERGE RULE IS NOT ENOUGH. The
   * "never overwrite an existing key" rule below preserves a decision the
   * source WAS born with — but it is silent on the source that was born
   * WITHOUT one. Absence is not a hole to fill: on a copied blob it is
   * INHERITED STATE, and re-resolving it hands the fork a decision the source
   * never had. A run born while a toggle was off, forked after that toggle
   * flips on, acquired live compaction it was never created under — which is
   * exactly the replay non-determinism the freeze exists to prevent.
   *
   * A contributor that freezes a PER-RUN DECISION (compaction, and any future
   * sibling) MUST therefore contribute NOTHING when this is set: the copied
   * metadata is authoritative in both directions, present and absent.
   *
   * A contributor that mints per-CALLER facts (the authority block, which the
   * `:fork` route re-derives against the FORKING caller's scopes) deliberately
   * ignores this flag — re-deriving is the point there. The flag is advisory
   * per contributor, never applied by this module.
   */
  derivedFromRun?: boolean;
}

/**
 * Resolve a metadata patch to freeze into the new run's `run.metadata`.
 *
 * Contributors MUST be PURE resolvers: read-only, no side effects, and no
 * assumption that a run actually exists. They are invoked at run creation AND
 * for runless decision resolution (ADR 0099 wires `/agents/:id/dispatch` by
 * calling `stampRunStartContext({}, {...})` purely to compute its decision). A
 * contributor that mutates state or requires a real run would break that reuse.
 */
export type RunStartContributor = (ctx: RunStartContext) => Promise<Record<string, unknown>>;

const contributors: RunStartContributor[] = [];

/** Feature registration seam — called once at boot. */
export function registerRunStartContributor(fn: RunStartContributor): void {
  contributors.push(fn);
}

/** Test/reset hook. */
export function __resetRunStartContributors(): void {
  contributors.length = 0;
}

/**
 * Run every registered contributor and merge their patches into `base`, WITHOUT
 * overwriting keys already present (so a `:fork`-copied decision is preserved).
 * Returns a NEW object; never mutates `base`. Fail-soft per contributor.
 */
export async function stampRunStartContext(
  base: Record<string, unknown> | undefined,
  ctx: RunStartContext,
): Promise<Record<string, unknown>> {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  if (contributors.length === 0) return merged;
  for (const contribute of contributors) {
    let patch: Record<string, unknown> = {};
    try {
      patch = await contribute(ctx);
    } catch (err) {
      log.warn('run_start_contributor_failed', { error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in merged)) merged[k] = v; // fork-copied values win
    }
  }
  return merged;
}
