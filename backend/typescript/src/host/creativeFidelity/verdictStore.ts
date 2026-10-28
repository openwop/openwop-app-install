/**
 * ADR 0945 D3 — the fidelity verdict store, keyed `tenant::org::verdictId`.
 * Its id hashes what it judged AND what it found, so a repeat check with the
 * same result converges on the stored row (`putIfAbsent`) and a changed result
 * is a new row. The P2 model judge adds a
 * run-scoped component to the id, because its answer is not a pure function.
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import type { FidelityVerdict } from './types.js';

const verdicts = new DurableCollection<FidelityVerdict>(
  'creative:fidelity-verdict',
  (v) => `${v.tenantId}::${v.orgId}::${v.verdictId}`,
  undefined,
  (v) => v.tenantId,
);

/** The id hashes the RESULT as well as the inputs: a re-check whose outcome
 *  depends on state outside the asset (the product's current photos, the
 *  render record) must not collapse onto an older verdict that said otherwise.
 *  An identical re-check still converges on one row. */
export function verdictIdFor(input: { assetId: string; assetSha256: string; mode: string; rulesetVersion: string; sources: Array<{ sha256: string }>; outcome: string; checks: Array<{ id: string; status: string; value?: number; threshold?: number; detail?: string }>; judge?: FidelityVerdict['judge']; invocation?: string }): string {
  const result = input.checks.map((c) => [c.id, c.status, c.value ?? null, c.threshold ?? null, c.detail ?? null]);
  const judge = input.judge ? [input.judge.provider, input.judge.model ?? null, input.judge.repaired ?? false,
    input.judge.results.map((r) => JSON.stringify([r.attribute, r.answer, r.evidence])).sort()] : null;
  const key = JSON.stringify([input.assetId, input.assetSha256, input.mode, input.rulesetVersion,
    input.sources.map((s) => s.sha256).sort(), input.outcome, result, judge, input.invocation ?? null]);
  return `fvd:${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

/** Store a verdict, or return the one already stored under its id. */
export async function recordVerdict(v: FidelityVerdict): Promise<FidelityVerdict> {
  if (await verdicts.putIfAbsent(v)) return v;
  const confirmed = await getVerdict(v.tenantId, v.orgId, v.verdictId);
  if (!confirmed || confirmed.assetId !== v.assetId || confirmed.assetSha256 !== v.assetSha256) {
    throw new OpenwopError('conflict', 'The fidelity verdict could not be confirmed. Try the check again.', 409, { reason: 'fidelity_verdict_unconfirmed' });
  }
  return confirmed;
}

/** Org-checked read: another org's or tenant's verdict reads as null. */
export async function getVerdict(tenantId: string, orgId: string, verdictId: string): Promise<FidelityVerdict | null> {
  const v = await verdicts.get(`${tenantId}::${orgId}::${verdictId}`);
  return v && v.tenantId === tenantId && v.orgId === orgId ? v : null;
}

export async function __clearFidelityVerdicts(): Promise<void> { await verdicts.__clear(); }
