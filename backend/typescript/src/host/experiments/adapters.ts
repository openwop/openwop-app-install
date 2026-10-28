/**
 * ADR 0949 D1 — the surface adapter registry. A feature that runs experiments on
 * its own surface (CMS pages, funnel steps; later email, ads, social) registers an
 * adapter here; the engine never imports a feature, and no feature imports
 * another (the `experimentStampResolver` registry pattern, generalised).
 *
 * The adapter owns everything that is the SURFACE's business: whether the target
 * and the arm references exist in the org, the surface's own launch rules and
 * lock (one running experiment per CMS page, the content-review gate), and where
 * exposure and outcome events live. The engine owns the model, the plan and the
 * statistics.
 */
import type { Arm, Experiment, UnitKind } from './types.js';
import type { UnitObservation } from './rollup.js';
import type { ContentCheck } from './gates.js';

export interface ExperimentObservation {
  units: UnitObservation[];
  /** `partial`: the event source purged events from the experiment's life. */
  coverage: 'complete' | 'partial';
  sourceRetainedSince: string | null;
}

export interface ExperimentSurfaceAdapter {
  /** The `surface.kind` this adapter owns, e.g. `cms.page`. */
  kind: string;
  /** ADR 0949 P3 — the binary per-unit metrics `observe` reports beyond
   *  `conversion` (e.g. `unsubscribe`, `complaint`). A plan may name these, and
   *  only these, as guardrails. */
  supportedMetrics?: readonly string[];
  /** ADR 0949 P3b — what one unit is on this surface (default `visitor`):
   *  `contact` for run-based surfaces (journeys, email). */
  unit?: UnitKind;
  /** Refuse (typed 4xx) when the target or an arm reference does not exist in
   *  the org. Called on create and on every arm edit. */
  validateTarget(tenantId: string, orgId: string, ref: string, arms: readonly Arm[]): Promise<void>;
  /** Make the experiment live under the surface's own lock and start checks;
   *  returns the stored row (status `running`, `startedAt` set). */
  launch(experiment: Experiment, actor: string): Promise<Experiment>;
  /** Stop serving it; returns the stored row (status `stopped`). */
  stop(experiment: Experiment, actor: string): Promise<Experiment>;
  /** Every exposed unit, with its arm, first exposure and outcome. */
  observe(experiment: Experiment): Promise<ExperimentObservation>;
  /** ADR 0950 G8 — may this arm's content be published NOW (the surface's own
   *  publish rules)? Read-only. Absent ⇒ G8 is `not_evaluable`, never a pass. */
  checkPromotable?(experiment: Experiment, armKey: string): Promise<ContentCheck>;
  /** ADR 0950 P1 — ship the winner's content as the surface's own (CMS: the
   *  winner version becomes the page; funnel: the winner page becomes the step)
   *  and return what it replaced, so a rollback can put it back. `pendingApproval`
   *  when the surface's own gate queued it (CMS `cms-approval-gate`). */
  finalize?(experiment: Experiment, winner: string, actor: string): Promise<{ baselineRef: string | null; pendingApproval?: boolean }>;
  /** ADR 0950 P1 — put the recorded baseline back. */
  restoreBaseline?(experiment: Experiment, baselineRef: string | null, actor: string): Promise<void>;
}

const adapters = new Map<string, ExperimentSurfaceAdapter>();

/** Keyed: a repeated boot overwrites the same slot. */
export function registerExperimentSurface(adapter: ExperimentSurfaceAdapter): void {
  adapters.set(adapter.kind, adapter);
}

export function experimentSurface(kind: string): ExperimentSurfaceAdapter | null {
  return adapters.get(kind) ?? null;
}

export function registeredExperimentSurfaces(): string[] {
  return [...adapters.keys()].sort();
}
