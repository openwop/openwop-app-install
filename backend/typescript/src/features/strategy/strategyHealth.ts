/**
 * Strategy health rollup (ADR 0080 Phase A). A PURE function over a strategy's
 * already-resolved, RBAC-filtered linked entities — no I/O, so it unit-tests
 * without storage. The verdict (`on-track`/`at-risk`/`off-track`) is a derived
 * convenience; the `signals` it carries are the truth, surfaced verbatim so the
 * FE + the Strategy Analyst show WHY (no invented precision — ADR 0080 Open Q1).
 *
 * Fail-soft: with no resolvable links (the `documents`/`priority-matrix`/project
 * data absent or unreadable) it still returns a verdict from whatever is present —
 * objectives declared but nothing executable linked ⇒ `at-risk`.
 */

import type { StrategyContextEntry, StrategyHealth, StrategyHealthSignals } from './types.js';

/** Compute the health rollup for one resolved context entry. */
export function computeStrategyHealth(entry: Pick<StrategyContextEntry, 'objectives' | 'linkedProjects' | 'linkedPriorities'>): StrategyHealth {
  const projects = entry.linkedProjects ?? [];
  const priorities = entry.linkedPriorities ?? [];
  const objectives = entry.objectives ?? [];

  let onTrack = 0, atRisk = 0, offTrack = 0;
  let milestonesDone = 0, milestonesTotal = 0;
  for (const p of projects) {
    if (p.health === 'on-track') onTrack++;
    else if (p.health === 'at-risk') atRisk++;
    else if (p.health === 'off-track') offTrack++;
    milestonesDone += p.milestonesDone ?? 0;
    milestonesTotal += p.milestonesTotal ?? 0;
  }

  const signals: StrategyHealthSignals = {
    linkedProjectCount: projects.length,
    projectsOnTrack: onTrack,
    projectsAtRisk: atRisk,
    projectsOffTrack: offTrack,
    milestonesDone,
    milestonesTotal,
    linkedPriorityCount: priorities.length,
    objectiveCount: objectives.length,
    hasExecution: projects.length > 0 || priorities.length > 0,
  };

  return { health: verdict(signals), signals };
}

/**
 * The verdict bands (a deliberate first cut — ADR 0080 Open Q1):
 *   - off-track: any linked project off-track, OR objectives declared with NO
 *     linked execution at all (a plan with nothing wired to deliver it).
 *   - at-risk:   any linked project at-risk, OR (milestones tracked AND < 40%
 *     complete), OR objectives declared with execution but no milestones tracked
 *     anywhere (no way to see progress).
 *   - on-track:  linked execution present, no off/at-risk projects, and either no
 *     milestones tracked-as-blocking or ≥ 40% milestone completion.
 */
function verdict(s: StrategyHealthSignals): StrategyHealth['health'] {
  const milestonePct = s.milestonesTotal > 0 ? s.milestonesDone / s.milestonesTotal : null;

  if (s.projectsOffTrack > 0) return 'off-track';
  if (s.objectiveCount > 0 && !s.hasExecution) return 'off-track';

  if (s.projectsAtRisk > 0) return 'at-risk';
  if (milestonePct !== null && milestonePct < 0.4) return 'at-risk';

  return 'on-track';
}
