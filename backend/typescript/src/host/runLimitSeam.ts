/**
 * ADR 0821 D6 / P5 follow-up — ONE hook for the plan's monthly run limit at every
 * run-minting site that does NOT route through `host/runStarter.ts`
 * `startWorkflowRun`.
 *
 * The limit itself (the durable per-tenant monthly counter, `reservePlanRun` in
 * `host/planRunLimit.ts`) is ADR 0821 P5's, and lives with that work (PR #4422,
 * workstream E), which calls it inside `startWorkflowRun`. This module is the
 * seam the OTHER start sites call, so the count covers every new run without
 * each site re-implementing the check:
 *
 *   - `POST /v1/runs` (and v2, one handler), `:fork`, the debug run, redrive;
 *   - trigger ingress (`host/triggerIngestionService.ts`, `routes/triggerBridge.ts`);
 *   - kanban triggers (`host/kanbanTriggerDelivery.ts`);
 *   - MCP `tools/call` (`host/mcpSemantics.ts`);
 *   - CRM launch, workflow-author and creative-briefs routes.
 *
 * NOT counted (by design): `core.subWorkflow` children (one unit of work with
 * their parent), eval runs (`workflowEvalRunner`, `workforceEval`), conformance
 * and test seams, and the historical records `workforceService` seeds. The canvas
 * cross-canvas invoke (`host/canvasSurface.ts`) is a known residual left to its
 * owner.
 *
 * WIRING. Default is a no-op (nothing counted, nothing refused). The billing
 * feature registers the real reserver at boot (`features/billing/feature.ts`
 * `registerRoutes`: `registerRunLimitReserver(reservePlanRun)`), so a host
 * without billing keeps the no-op; with billing, an unset `workflowRuns` limit
 * is still a no-op inside `reservePlanRun`. Pinned through the real app boot by
 * `test/adr0821-p5-run-limit-wired.test.ts`. `startWorkflowRun` keeps its own direct call, so
 * it must NOT also call this seam (a run would count twice).
 *
 * ORDER at each site: AFTER the launch funnel resolves (ADR 0823 ownership +
 * ADR 0820 §7 owning-feature gate) and after every other refusal, immediately
 * before the insert; a failed insert releases the reservation. So a refused,
 * foreign or missing workflow never consumes a run.
 */

/** A reservation the caller releases if the run it was taken for never lands. */
export interface RunLimitReservation { release: () => Promise<void> }

/** Reserve one run for `tenantId`, or throw the typed refusal (429). */
export type RunLimitReserver = (tenantId: string) => Promise<RunLimitReservation>;

const NOOP: RunLimitReservation = { release: async () => undefined };

let reserver: RunLimitReserver | null = null;

/** Wire the run-limit reserver (ADR 0821 P5, at boot). Last wins; `null` unwires. */
export function registerRunLimitReserver(fn: RunLimitReserver | null): void {
  reserver = fn;
}

/** Reserve one run against the tenant's plan limit. A no-op when none is wired. */
export async function reserveRunLimit(tenantId: string): Promise<RunLimitReservation> {
  return reserver ? reserver(tenantId) : NOOP;
}

/**
 * Reserve, then run `insert`; release the reservation when `insert` throws (the
 * run never landed, or a peer's identical deterministic run did and that peer
 * counted it). The reserver's own refusal propagates before `insert` runs.
 */
export async function withRunLimit<T>(tenantId: string, insert: () => Promise<T>): Promise<T> {
  const reservation = await reserveRunLimit(tenantId);
  try {
    return await insert();
  } catch (err) {
    await reservation.release().catch(() => undefined);
    throw err;
  }
}
