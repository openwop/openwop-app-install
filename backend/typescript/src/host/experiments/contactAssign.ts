/**
 * ADR 0949 P3b — a contact's arm OUTSIDE a run (an email broadcast, which sends
 * in passes across a batch resume and warm-up days). Shapes agreed with ADR 0955
 * P3b (build-0905-email):
 *
 *   assignContactArm(tenantId, { orgId, experimentId, contactId, epoch? })
 *
 * PURE: a function of (contactId, experimentId's assignment scope, salt, the
 * band layout or weights of ONE epoch). No store write, no clock, no status
 * check: the caller freezes `epoch` (the email campaign freezes it at approval)
 * and passes it on every pass, so a pass re-run after a crash, or on a later
 * day, or after the experiment was re-weighted or stopped, derives the same arm.
 * Without `epoch`, the launch epoch. Whether to SEND under a stopped experiment
 * is the caller's decision; `status` is returned so it can make it.
 *
 * Inside a run, use `ctx.features.experiments.assign` instead: it resolves the
 * epoch from the run's frozen start instant (`runFreeze.assignAt`).
 */
import { assignWeightedVariant } from '../variantAssignment.js';
import { getExperimentRow } from './store.js';
import type { Arm, Experiment, ExperimentStatus } from './types.js';

export interface ContactArm { arm: string; ref: string | null; control: boolean; epoch: number; status: ExperimentStatus }

/** The pure core: the arm for `contactId` under epoch `epoch` (else launch). */
export function contactArmAt(exp: Experiment, contactId: string, epoch?: number): ContactArm | null {
  if (!contactId) return null;
  const e = epoch === undefined ? exp.epochs.find((x) => x.reason === 'launch') : exp.epochs.find((x) => x.epoch === epoch);
  if (!e) return null;
  // A ramp epoch carries its band layout (ADR 0950 D3); the layout, not the
  // per-arm totals, decides the band, exactly as `runFreeze.assignAt` reads it,
  // so a contact gets the same arm outside a run as inside one.
  const bands = e.layout ?? exp.arms.map((a) => ({ key: a.key, weight: e.weights[a.key] ?? 0 })).filter((a) => a.weight > 0);
  if (bands.length === 0) return null;
  const key = assignWeightedVariant(contactId, exp.assignmentScope ?? exp.experimentId, exp.salt, bands);
  const arm: Arm | undefined = exp.arms.find((a) => a.key === key);
  return arm ? { arm: arm.key, ref: arm.ref, control: arm.key === exp.arms[0]?.key, epoch: e.epoch, status: exp.status } : null;
}

/** Read the experiment (tenant + org keyed) and assign. Null when it does not
 *  exist in that org, never launched, or the epoch is unknown. */
export async function assignContactArm(tenantId: string, input: { orgId: string; experimentId: string; contactId: string; epoch?: number }): Promise<ContactArm | null> {
  const exp = await getExperimentRow(tenantId, input.orgId, input.experimentId);
  return exp ? contactArmAt(exp, input.contactId, input.epoch) : null;
}
