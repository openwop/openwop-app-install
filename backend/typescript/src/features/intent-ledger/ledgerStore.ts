/**
 * ADR 0136 Phase 2 — the per-conversation intent-ledger store + input validation.
 *
 * One active ledger per conversation (keyed tenantId:conversationId). Validation is
 * fail-closed (a malformed draft/approval is rejected). The model-authored draft is
 * NEVER auto-approved — approval is a user action via the P3 REST route.
 *
 * @see docs/adr/0136-intent-ledger.md
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { OpenwopError } from '../../types.js';
import type { IntentLedger } from './types.js';

// CGOV-5: the ledger `goal` is model-summarized user text (also copied into
// run.metadata.intentLedger.goal + the work-graph `sampleGoal`). Declare both field
// names as PII so they're masked in logs — the same global field-name masking posture
// as strategy/insights (defence-in-depth).
declarePiiFields('intentLedger.entry', ['goal', 'sampleGoal']);

const store = new DurableCollection<IntentLedger>('intent-ledger:ledgers', (l) => `${l.tenantId}:${l.conversationId}`);
const MAX_ITEMS = 50;

export async function getLedger(tenantId: string, conversationId: string): Promise<IntentLedger | null> {
  return store.get(`${tenantId}:${conversationId}`);
}

export async function saveLedger(ledger: IntentLedger): Promise<IntentLedger> {
  await store.put(ledger);
  return ledger;
}

function strArray(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new OpenwopError('validation_error', `${where} MUST be a string array.`, 400);
  if (v.length > MAX_ITEMS) throw new OpenwopError('validation_error', `${where} exceeds ${MAX_ITEMS} items.`, 400);
  return v as string[];
}

/** Validate the mutable fields of a ledger draft/edit (shape only; fail-closed). */
export function validateLedgerInput(input: unknown): Pick<IntentLedger, 'goal' | 'allowed' | 'forbidden' | 'requireApproval' | 'successCriteria' | 'expiresAtRelMs'> {
  const o = (input ?? {}) as Record<string, unknown>;
  if (typeof o.goal !== 'string' || !o.goal.trim()) throw new OpenwopError('validation_error', 'goal is required.', 400);
  if (o.expiresAtRelMs !== undefined && (typeof o.expiresAtRelMs !== 'number' || o.expiresAtRelMs <= 0)) {
    throw new OpenwopError('validation_error', 'expiresAtRelMs MUST be a positive number of ms.', 400);
  }
  return {
    goal: o.goal.trim(),
    allowed: strArray(o.allowed, 'allowed'),
    forbidden: strArray(o.forbidden, 'forbidden'),
    requireApproval: strArray(o.requireApproval, 'requireApproval'),
    successCriteria: strArray(o.successCriteria, 'successCriteria'),
    ...(o.expiresAtRelMs !== undefined ? { expiresAtRelMs: o.expiresAtRelMs as number } : {}),
  };
}
