/**
 * ADR 0949 D3 — assignment. One function for every web-unit experiment, built on
 * the shared `host/variantAssignment.ts` hash (no second hash). In Decide mode the
 * weights are the configured arm weights, so an experiment migrated from the CMS
 * or a funnel step assigns byte-identically (witnessed over 100,000 keys).
 */
import { assignWeightedVariant } from '../variantAssignment.js';
import type { Arm, Experiment } from './types.js';

export function assignArm(experiment: Pick<Experiment, 'experimentId' | 'salt' | 'arms' | 'assignmentScope'>, unitKey: string): Arm | null {
  const key = assignWeightedVariant(unitKey, experiment.assignmentScope ?? experiment.experimentId, experiment.salt, experiment.arms);
  return key ? experiment.arms.find((a) => a.key === key) ?? null : null;
}
