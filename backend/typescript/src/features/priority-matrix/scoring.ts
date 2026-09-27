/**
 * ADR 0534 P0 — the weighted-scoring engine moved to `host/weightedScoring.ts`.
 *
 * It was never PM-specific: `features/crm/propensityService.ts` and
 * `features/recommendations/recommendationsService.ts` already imported it
 * cross-feature, and `work-selection` (ADR 0534) is the fourth consumer. Core
 * owning it is what lets `host/heartbeatService.ts` rank without importing a
 * feature.
 *
 * This file re-exports the engine so every existing `./scoring.js` import in
 * this feature keeps working unchanged — the hoist is a pure move.
 */
export {
  computePriority,
  rankByPriority,
  scoreCompleteness,
  PRESET_IDS,
} from '../../host/weightedScoring.js';
export type {
  Aggregation,
  CriterionDirection,
  PresetId,
  Criterion,
  CriteriaSet,
  Ranked,
  RankOptions,
  ScoreCompleteness,
} from '../../host/weightedScoring.js';
