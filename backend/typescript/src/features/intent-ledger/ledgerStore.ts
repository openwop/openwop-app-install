/**
 * ADR 0136 Phase 2 — the per-conversation intent-ledger store + input validation.
 *
 * One active ledger per conversation (keyed tenantId:conversationId). Validation is
 * fail-closed (a malformed draft/approval is rejected). The model-authored draft is
 * NEVER auto-approved — approval is a user action via the P3 REST route.
 *
 * @see docs/adr/0136-intent-ledger.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { ERASED, subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { OpenwopError } from '../../types.js';
import type { IntentLedger } from './types.js';

// CGOV-5: the ledger `goal` is model-summarized user text (also copied into each
// run's `run.metadata.intentLedgerApprovals[…].goal` + the work-graph `sampleGoal`). Declare both field
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
// CORRECTION 2026-10-15 (ADR 0896 D7b) — age USED TO BE `createdAt`, on the
// reasoning that the surface is replay-adjacent. But a run's stamp is a COPY (the
// gate never reads the ledger back from it), so nothing about replay needed a
// frozen timestamp — and the agent's draft tool carried `createdAt` from the first
// draft across every redraft, so a mission approved minutes ago could be purged as
// "old", silently dropping a narrowing in force. Age is now the last write
// (`updatedAt`), falling back to `createdAt` on rows written before it existed.
// Fail-closed on a falsy tenant / non-PII classification.
//
// IL2CD-1 — an `approved` or `expired` mission is NEVER purged: it is a narrowing
// in force (expired = "talk, don't act"), and deleting it hands the agent back every
// tool the mission withheld. It ages out once revoked or redrafted. The delete
// re-reads the row first, so a mission approved between the list and the delete is
// kept (there is no conditional delete on this collection; the window left is the
// one between that re-read and the delete itself).
const governs = (l: IntentLedger | null): boolean => l?.status === 'approved' || l?.status === 'expired';
registerRetentionPurger({
  feature: 'intent-ledger',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    const rows = (await store.listByPrefix(`${tenantId}:`)).filter((l) => !governs(l));
    return purgeRowsByAge('intent-ledger', rows, tenantId, cutoffIso,
      (l) => ({ tenantId: l.tenantId, updatedAt: l.updatedAt ?? l.createdAt, id: `${l.tenantId}:${l.conversationId}` }),
      async (id) => (governs(await store.get(id)) ? false : store.delete(id)));
  },
});

/**
 * CONS-16 — the DSAR eraser. REDACTS the approver (and, ADR 0896, revoker)
 * attribution; it does not
 * delete the ledger, and it does not touch `goal`.
 *
 * WHY REDACT AND NOT DELETE. ADR 0464's taxonomy sends a subject's OWN data to
 * DELETE and a structurally-needed row to ANONYMIZE IN PLACE. A mission ledger
 * is the ORG's governance record of what a conversation was permitted to do —
 * its `allowed`/`forbidden`/`requireApproval` project onto the ADR 0132
 * capability scope, and the gate reads it LIVE on every turn (a run's stamp is a
 * copy that only carries its TTL anchor — ADR 0896 D9). Deleting it because one participant left would destroy the record of
 * a decision that governed other people's work.
 *
 * WHAT THIS DOES NOT REACH, stated rather than implied — and the reason it is
 * not simply "also delete ledgers for the subject's conversations":
 *
 * ADR 0896 D7b — the redaction is a CAS that bumps the revision, never a
 * list-then-put: a put of a row listed before the owner revoked would resurrect
 * the approved mission (and send the revision backwards).
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
  const names = (l: IntentLedger): boolean => (l.approvedBy !== undefined && forms.has(l.approvedBy)) || (l.rejectedBy !== undefined && forms.has(l.rejectedBy));
  for (const listed of await store.listByPrefix(`${tenantId}:`)) {
    if (listed.tenantId !== tenantId) continue;
    let l: IntentLedger | null = listed;
    for (let attempt = 0; l && names(l); attempt++) {
      const redacted: IntentLedger = { ...l };
      if (l.approvedBy !== undefined && forms.has(l.approvedBy)) redacted.approvedBy = ERASED;
      if (l.rejectedBy !== undefined && forms.has(l.rejectedBy)) redacted.rejectedBy = ERASED;
      if (await writeLedger(l, redacted)) break;
      // IL2CD-9 — a DSAR never reports success over a row it could not redact.
      if (attempt === 2) throw new Error(`intent-ledger erasure lost the write race 3 times for ${l.conversationId}`);
      l = await getLedger(l.tenantId, l.conversationId);
    }
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

/** A raw put — fixtures and seeding only. Every production write goes through
 *  `writeLedger` (ADR 0896 D1). */
export async function saveLedger(ledger: IntentLedger): Promise<IntentLedger> {
  await store.put(ledger);
  return ledger;
}

/** ADR 0896 D1 — the revision a row carries (rows written before ADR 0896 read 0). */
export function ledgerRevision(l: IntentLedger | null): number {
  return typeof l?.revision === 'number' ? l.revision : 0;
}

/** ADR 0896 D1 — the digest of the CONTRACT a person is shown (goal, the three tool
 *  lists, criteria, TTL): a revision proves nothing changed since the read; the
 *  digest proves WHAT was read (the ADR 0894 G-A pattern). Canonical: fixed key
 *  order, absent TTL as null. Returned with every ledger, required on a decision. */
export function ledgerDigest(l: Pick<IntentLedger, 'goal' | 'allowed' | 'forbidden' | 'requireApproval' | 'successCriteria' | 'expiresAtRelMs'>): string {
  const canonical = JSON.stringify([l.goal, l.allowed, l.forbidden, l.requireApproval, l.successCriteria, l.expiresAtRelMs ?? null]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** ADR 0896 D1 — a fresh ledger id. Random, so `(ledgerId, revision)` never repeats
 *  even after a row is deleted and a new one starts at revision 1. */
export function newLedgerId(): string {
  return `il-${randomUUID()}`;
}

/** ADR 0896 D1 — THE production write: a compare-and-swap against the row exactly
 *  as it was read (`null` = must be absent), bumping `revision` and `updatedAt`.
 *  Returns the written row, or null when the row changed since it was read. Never
 *  pass a normalised copy as `expected` — it would not byte-match the stored row. */
export async function writeLedger(expected: IntentLedger | null, next: IntentLedger): Promise<IntentLedger | null> {
  const row: IntentLedger = { ...next, revision: ledgerRevision(expected) + 1, updatedAt: new Date().toISOString() };
  return (await store.compareAndSwap(expected, row)) ? row : null;
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
