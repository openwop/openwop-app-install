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
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { ERASED, subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { OpenwopError } from '../../types.js';
import type { IntentLedger } from './types.js';

// CGOV-5: the ledger `goal` is model-summarized user text (also copied into
// run.metadata.intentLedger.goal + the work-graph `sampleGoal`). Declare both field
// names as PII so they're masked in logs — the same global field-name masking posture
// as strategy/insights (defence-in-depth).
declarePiiFields('intentLedger.entry', ['goal', 'sampleGoal']);

const store = new DurableCollection<IntentLedger>('intent-ledger:ledgers', (l) => `${l.tenantId}:${l.conversationId}`);
const MAX_ITEMS = 50;

// ADR 0077/0081 P5 — time-based retention for mission ledgers (the `goal` is
// model-summarized user text, declared PII above).
//
// CORRECTION 2026-08-19 (CONS-16) — THIS BLOCK USED TO SAY the store is
// "DELIBERATELY NOT a `registerSubjectEraser` consumer: rows key
// `${tenantId}:${conversationId}` and carry no subject key, so a principal-keyed
// DSAR cannot address them". The first half is true of the KEY and FALSE of the
// ROW: `IntentLedger.approvedBy` (types.ts) is set to `actingUserOf(req)` when a
// human approves a mission (routes.ts), i.e. a `User.userId` — precisely the key
// shape a principal-keyed DSAR arrives with. So the row WAS addressable, and the
// exemption was resting on a claim nobody had re-checked since `approvedBy` was
// added. An eraser is registered below; see `eraseIntentLedgerSubject` for what
// it does and, more importantly, what it deliberately does not.
//
// Age is on `createdAt` — the ledger
// surface is replay-adjacent (`IntentLedgerStamp` is read verbatim on `:fork`),
// so we purge on the existing timestamp rather than widening the type with a
// mutable `updatedAt`; a mission ledger is conversation-scoped and short-lived,
// so create-age is the honest retention key. Fail-closed on a falsy tenant /
// non-PII classification.
registerRetentionPurger({
  feature: 'intent-ledger',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    return purgeRowsByAge('intent-ledger', await store.list(), tenantId, cutoffIso,
      (l) => ({ tenantId: l.tenantId, updatedAt: l.createdAt, id: `${l.tenantId}:${l.conversationId}` }),
      (id) => store.delete(id));
  },
});

/**
 * CONS-16 — the DSAR eraser. REDACTS the approver attribution; it does not
 * delete the ledger, and it does not touch `goal`.
 *
 * WHY REDACT AND NOT DELETE. ADR 0464's taxonomy sends a subject's OWN data to
 * DELETE and a structurally-needed row to ANONYMIZE IN PLACE. A mission ledger
 * is the ORG's governance record of what a conversation was permitted to do —
 * its `allowed`/`forbidden`/`requireApproval` project onto the ADR 0132
 * capability scope, and a run stamped `IntentLedgerStamp` reads it verbatim on
 * `:fork`. Deleting it because one participant left would destroy the record of
 * a decision that governed other people's work.
 *
 * WHAT THIS DOES NOT REACH, stated rather than implied — and the reason it is
 * not simply "also delete ledgers for the subject's conversations":
 *
 *   `goal` is model-summarised text from a conversation that may have several
 *   participants, so it is not unambiguously the erased subject's own data. The
 *   obvious cascade — resolve the subject's conversations, then delete their
 *   ledgers — CANNOT be done safely from inside this eraser, because the
 *   sibling `eraseSubjectConversations` REDACTS the very `ownerUserId` /
 *   `participants[].subjectRef` fields that lookup would read, and eraser order
 *   within one fan-out is registration order, not a guarantee. Whichever ran
 *   first would silently decide whether the ledger was found. A cascade that
 *   works or no-ops depending on registration order is worse than a stated gap,
 *   so the gap is stated. The ADR 0288 `onConversationDeleted` hook does not
 *   help either: the conversation eraser redacts, it never deletes, so that hook
 *   never fires on a DSAR.
 *
 *   Closing it properly needs a subject->conversation closure computed UPFRONT
 *   (the `SubjectKeyResolver` phase, which runs before any eraser for exactly
 *   this reason) — but conversationIds are not subject keys, and feeding UUIDs
 *   into the shared key set would hand them to all 78 erasers, which is the
 *   over-erasure hazard `identityLinkService`'s namespace guard exists to stop.
 *   That is a seam change, not an eraser.
 */
export async function eraseIntentLedgerSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const forms = subjectKeyForms(subjectKey).forms;
  for (const l of await store.list()) {
    if (l.tenantId !== tenantId) continue;
    if (l.approvedBy === undefined || !forms.has(l.approvedBy)) continue;
    await store.put({ ...l, approvedBy: ERASED });
  }
}

/** Registered from the feature's boot path via a MODULE-LEVEL named reference —
 *  `registerSubjectEraser` dedupes BY REFERENCE, so an inline closure would
 *  re-register as a duplicate on every boot. */
export function registerIntentLedgerErasure(): void {
  registerSubjectEraser(eraseIntentLedgerSubject);
}

export async function getLedger(tenantId: string, conversationId: string): Promise<IntentLedger | null> {
  return store.get(`${tenantId}:${conversationId}`);
}

/** ADR 0288 P2 consumer — a mission ledger for a DELETED conversation is
 *  meaningless: point-delete it (the run-stamped copy in `run.metadata` is the
 *  replay-honest historical record and is untouched). Idempotent. */
export async function deleteLedgerForConversation(tenantId: string, conversationId: string): Promise<boolean> {
  return store.delete(`${tenantId}:${conversationId}`);
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
