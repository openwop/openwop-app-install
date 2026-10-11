/**
 * RFC 0037 multi-agent execution model: the phase gates, and the version this
 * host may claim (ADR 0858 P4, spec-steward ruling openwop-e2 2026-10-10).
 *
 * ONE owner for "which phase is on". The runtime sites read these gates
 * (`bootstrap/nodes.ts` core.dispatch, `executor/executor.ts` refusal
 * divergence, `routes/runs.ts` getRunAncestry), and the v2 advert derives
 * `multiAgent.executionModel.version` from the SAME gates, so the claim cannot
 * run ahead of the behaviour.
 *
 * The ruling: claim the highest N for which EVERY phase 1..N is implemented.
 * v1 computed the version from a separate, more generous ladder (PHASE_5
 * implied phases 4..2 in the advert while the runtime gates still read their
 * own flags), so a PHASE_5-only host claimed `version: 5` with no escalation,
 * no refusal-divergence emission and no ancestry endpoint behind it.
 *
 * Level 6 (the verifier turn) is NOT claimable: `runVerifier`
 * (`host/agentDispatch.ts`) only runs when a `verifier` is injected, and the
 * only injector is the `agents/verify-run` conformance seam. No production
 * dispatch path emits `agent.verified`.
 */

const env = (k: string): boolean => process.env[k] === 'true';

/**
 * RFC 0040 phase-3 gate (getRunAncestry, `crossHostCausation`). Additive: a
 * PHASE_4 or PHASE_5 host implements phase 3 too.
 *
 * CORRECTED 2026-10-10 (ADR 0858 P4): this ignored PHASE_5, so a phase-5 host
 * served no ancestry endpoint while v1 advertised version 5.
 */
export function isPhase3Enabled(): boolean {
  return env('OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_3')
    || env('OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_4')
    || env('OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_5');
}

/** The runtime gate of each phase, read exactly as the runtime sites read it. */
export interface MultiAgentPhaseGates {
  /** Phase 1: handoff state-machine events from core.dispatch (`nodes.ts`). */
  readonly phase1: boolean;
  /** Phase 2: confidence-floor escalation before dispatch (`nodes.ts`). */
  readonly phase2: boolean;
  /** Phase 3: getRunAncestry (`routes/runs.ts`); trace context is propagated unconditionally (`host/mcpClient.ts`, `host/a2aSurface.ts`). */
  readonly phase3: boolean;
  /** Phase 4: `replay.divergedAtRefusal` on a replay fork (`executor/executor.ts`). */
  readonly phase4: boolean;
  /** Phase 5: `runOrchestrator.decided.iteration`, persisted across passes and resume (`nodes.ts`). */
  readonly phase5: boolean;
}

export function multiAgentPhaseGates(): MultiAgentPhaseGates {
  return {
    phase1: env('OPENWOP_MULTI_AGENT_EXECUTION_MODEL'),
    phase2: env('OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2'),
    phase3: isPhase3Enabled(),
    phase4: env('OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_4'),
    phase5: env('OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_5'),
  };
}

/** The highest N with every phase 1..N on; 0 means "do not advertise `executionModel`". */
export function multiAgentExecutionModelVersion(): 0 | 1 | 2 | 3 | 4 | 5 {
  const g = multiAgentPhaseGates();
  const ladder = [g.phase1, g.phase2, g.phase3, g.phase4, g.phase5];
  let n = 0;
  while (n < ladder.length && ladder[n]) n += 1;
  return n as 0 | 1 | 2 | 3 | 4 | 5;
}

/** RFC 0039 §A floor: `OPENWOP_MULTI_AGENT_CONFIDENCE_FLOOR`, else the spec floor 0.5; out-of-range values fall back to 0.5. */
export function confidenceEscalationFloor(): number {
  const raw = process.env.OPENWOP_MULTI_AGENT_CONFIDENCE_FLOOR;
  const parsed = raw === undefined ? 0.5 : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 1.0) return 0.5;
  return parsed;
}
