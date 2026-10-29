/**
 * ADR 0942 D5 — the covering-grant check for interrupt-lane classes.
 *
 * When a chokepoint's policy outcome is `approve` for a class decided on the
 * interrupt lane (`sms.send`, `social.post`, …), the effect proceeds only if THIS
 * run holds a covering grant: an approved `autonomy-gate` interrupt for the same
 * class whose recorded facts cover the real facts (amounts and audience no larger,
 * no new risk, the same content identity). An unbound approval cannot cover a
 * content-bound effect. Otherwise the chokepoint
 * refuses `autonomy_approval_required` and the chain's gate re-asks with the real
 * facts.
 *
 * Grants are DERIVED, not stored: the run's event log names its resolved
 * interrupts and the interrupt row (the ADR 0068 single owner) carries the
 * `data.autonomy` block the gate wrote. A fork's grants are the fork's own events,
 * so a branch fork never inherits its source's approvals (D10.4).
 */
import type { Storage } from '../../storage/storage.js';
import type { InterruptRecord } from '../../types.js';
import type { ActionClass, RiskFacts } from './types.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const NUMERIC_CEILINGS = ['spendMinor', 'spendDeltaPct', 'audienceSize', 'findingsCritical', 'findingsHigh'] as const;
const RISK_FLAGS = ['regulatedCategory', 'firstForDestination'] as const;

function rejected(v: unknown): boolean {
  return isObj(v) && (v.action === 'reject' || v.action === 'timeout' || v.decision === 'reject' || v.decision === 'rejected' || v.reason === 'timeout' || v.reason === 'quorum-reject');
}

/** Do the approved facts cover the real ones? A fact the approval did not record covers nothing. */
export function factsCovered(approved: RiskFacts, real: RiskFacts): boolean {
  for (const k of NUMERIC_CEILINGS) {
    const r = real[k];
    if (r === undefined) continue;
    const a = approved[k];
    if (typeof a !== 'number' || r > a) return false;
  }
  for (const k of RISK_FLAGS) {
    if (real[k] === true && approved[k] !== true) return false;
  }
  if (real.confidence !== undefined && (approved.confidence === undefined || real.confidence < approved.confidence)) return false;
  return true;
}

export async function findCoveringGrant(
  storage: Pick<Storage, 'listEvents' | 'getInterrupt'>,
  runId: string,
  want: { actionClass: ActionClass; facts: RiskFacts; contentHash?: string },
  // An effect can require stricter evidence without duplicating the event walk.
  // Filter each candidate before returning: an ineligible earlier resolution
  // must not hide a later covering approval from the same run.
  eligible?: (interrupt: Readonly<InterruptRecord>) => boolean,
): Promise<{ interruptId: string } | null> {
  const events = await storage.listEvents(runId);
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.type !== 'interrupt.resolved') continue;
    const id = isObj(ev.payload) && typeof ev.payload.interruptId === 'string' ? ev.payload.interruptId : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const it = await storage.getInterrupt(id);
    if (!it || it.runId !== runId || it.kind !== 'approval' || !it.resolvedAt || rejected(it.resolvedValue)) continue;
    const block = isObj(it.data) && isObj(it.data.autonomy) ? it.data.autonomy : null;
    if (!block || block.actionClass !== want.actionClass) continue;
    if (block.contentHash !== want.contentHash) continue;
    const approvedFacts = isObj(block.facts) ? (block.facts as RiskFacts) : {};
    if (factsCovered(approvedFacts, want.facts) && (!eligible || eligible(it))) return { interruptId: id };
  }
  return null;
}
