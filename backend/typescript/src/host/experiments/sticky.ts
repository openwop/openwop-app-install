/**
 * ADR 0949 D3 / P4 — Optimize stickiness. Optimize moves the weights between
 * epochs, so pure hashing would move a returning unit between arms. The FIRST
 * exposure is recorded here and every later exposure reads it.
 *
 * - Key `tenant::experimentId::sha256(salt + unitKey)`: the experiment's salt is
 *   in the hash, so rows of two experiments cannot be joined on a unit. Only the
 *   arm, the epoch and the instant are stored. A web visitor reaches this only
 *   after the analytics-consent gate.
 * - No tenant index (a JSON `tenantId` is what teardown matches); rows age out
 *   after `FIRST_EXPOSURE_TTL_DAYS` (the longest an experiment may run).
 * - The per-experiment cap is not a counter on the hot path: the epoch job
 *   counts rows and sets `stickinessCapped` on the experiment; past it, new
 *   units are assigned by hashing at the current epoch, and results say so.
 * - Decide mode never reads or writes this store (its weights never move).
 */
import { createHash } from 'node:crypto';
import { DurableCollection, hostExtStorage } from '../hostExtPersistence.js';
import { registerKvAgeOut } from '../kvAgeOut.js';
import { assignAt, type UnitAssignment } from './runFreeze.js';
import type { Experiment } from './types.js';
import { listTenantExperimentRows } from './store.js';

export const FIRST_EXPOSURE_TTL_DAYS = 180;
export const FIRST_EXPOSURE_CAP = 200_000;

export interface FirstExposure { key: string; tenantId: string; experimentId: string; arm: string; epoch: number; at: string }

const exposures = new DurableCollection<FirstExposure>('experiments:first-exposure', (r) => r.key);

registerKvAgeOut({
  id: 'experiments:first-exposure',
  prefix: 'hostext:experiments:first-exposure:',
  ttlDays: FIRST_EXPOSURE_TTL_DAYS,
  timestampField: 'at',
});

const prefixOf = (e: Pick<Experiment, 'tenantId' | 'experimentId'>): string => `${e.tenantId}::${e.experimentId}::`;
const keyOf = (e: Experiment, unitKey: string): string =>
  `${prefixOf(e)}${createHash('sha256').update(`${e.salt}\n${unitKey}`).digest('hex')}`;

export interface StickyAssignment extends UnitAssignment { sticky: boolean }

/**
 * An Optimize unit's arm: its recorded first exposure if any, else the arm at
 * the epoch in effect at `asOf`, recorded (unless `readOnly`, or the experiment
 * is past its cap). `readOnly` is for the analytics stamp resolver, which must
 * re-derive what was served without writing on the ingest path.
 */
export async function stickyAssign(exp: Experiment, unitKey: string, asOf: string, opts: { readOnly?: boolean } = {}): Promise<StickyAssignment | null> {
  if (!unitKey) return null;
  const key = keyOf(exp, unitKey);
  // A recorded first exposure answers first: the stamp resolver re-derives a
  // stopped experiment's arm from it, and a returning unit never moves.
  const seen = await exposures.get(key);
  if (seen && seen.tenantId === exp.tenantId && seen.experimentId === exp.experimentId) {
    const arm = exp.arms.find((a) => a.key === seen.arm);
    if (arm) return { arm, epoch: seen.epoch, weights: exp.epochs.find((e) => e.epoch === seen.epoch)?.weights ?? {}, sticky: true };
  }
  const fresh = assignAt(exp, unitKey, asOf);
  if (!fresh) return null;
  if (opts.readOnly || exp.stickinessCapped) return { ...fresh, sticky: false };
  const row: FirstExposure = { key, tenantId: exp.tenantId, experimentId: exp.experimentId, arm: fresh.arm.key, epoch: fresh.epoch, at: asOf };
  if (await exposures.putIfAbsent(row)) return { ...fresh, sticky: true };
  // A concurrent first exposure won: honour it.
  const winner = await exposures.get(key);
  const arm = winner ? exp.arms.find((a) => a.key === winner.arm) : undefined;
  return arm && winner ? { arm, epoch: winner.epoch, weights: fresh.weights, sticky: true } : { ...fresh, sticky: false };
}

/** Rows for one experiment (the epoch job's cap count). A storage-level count
 *  where the backend has one; a listing (bounded by the cap and the age-out)
 *  otherwise. */
export async function countFirstExposures(exp: Pick<Experiment, 'tenantId' | 'experimentId'>): Promise<number> {
  const storage = hostExtStorage();
  if (typeof storage.kvCount === 'function') return storage.kvCount(`hostext:experiments:first-exposure:${prefixOf(exp)}`);
  return (await exposures.listByPrefix(prefixOf(exp))).length;
}

/**
 * ADR 0949 P4 — subject erasure. A unit key IS a subject key (a CDP session key,
 * a CRM contact id; the erasure resolvers expand a subject to all of them), so
 * each Optimize experiment's row for the key is recomputed and deleted. Named:
 * the eraser manifest keys on the function name.
 */
export async function eraseExperimentFirstExposures(tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> {
  let rowsTouched = 0;
  if (!tenantId || !subjectKey) return { rowsTouched };
  for (const exp of await listTenantExperimentRows(tenantId)) {
    if (exp.mode !== 'optimize') continue;
    if (await exposures.delete(keyOf(exp, subjectKey))) rowsTouched += 1;
  }
  return { rowsTouched };
}

/** An experiment's rows go with it. */
export async function deleteFirstExposures(exp: Pick<Experiment, 'tenantId' | 'experimentId'>): Promise<number> {
  const rows = await exposures.listByPrefix(prefixOf(exp));
  for (const r of rows) await exposures.delete(r.key);
  return rows.length;
}
