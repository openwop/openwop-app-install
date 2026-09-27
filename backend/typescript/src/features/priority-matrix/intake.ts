/**
 * Idea intake, evidence, merge, and promotion (ADR 0232). All data lands as
 * PM-owned OVERLAY rows keyed `${listId}::${cardId}` — the established
 * IdeaScore/IdeaSchedule pattern; the `host.kanban` card schema is never
 * extended (the Phase C architect boundary ruling).
 *
 * Evidence rows are POINTERS (document/kb/url refs), never copies. Promotion
 * stamps provenance BOTH ways: the idea's intake overlay gains `promotedTo`,
 * and (for initiatives) the target strategy gains the existing
 * `{kind:'priority-idea'}` link — canonical on the strategy (ADR 0079).
 */
import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { cleanString, cleanOpaqueToken } from '../../host/boundedStrings.js';
import { getCard } from '../../host/kanbanService.js';
import { getList } from './priorityMatrixService.js';
import { priorityMutated } from './emit.js';

/**
 * The card-exists guard (code-review STRAT-PM1): an intake/evidence overlay row
 * for a ghost card is garbage data. Enforced in the SERVICE (single owner) so
 * BOTH the routes AND the run-driven surface verbs inherit it — a point lookup
 * (`getCard` + boardId match), cheaper than the route's former full re-rank.
 */
async function assertIdeaOnList(tenantId: string, listId: string, cardId: string): Promise<void> {
  const list = await getList(tenantId, listId);
  const card = list ? await getCard(cardId) : null;
  if (!list || !card || card.boardId !== list.boardId) {
    throw new OpenwopError('not_found', 'Idea not found in this list.', 404, { cardId });
  }
}

export type IntakeSourceChannel = 'form' | 'chat' | 'api' | 'manual';
const SOURCE_CHANNELS: readonly IntakeSourceChannel[] = ['form', 'chat', 'api', 'manual'];

export interface IdeaIntake {
  listId: string;
  cardId: string;
  requester?: string;
  sourceChannel?: IntakeSourceChannel;
  estimatedValue?: number;
  estimatedValueUnit?: string;
  notes?: string;
  /** ADR 0247 OQ-5 — the form submission this idea was auto-filed from (the
   *  forms→intake bridge); an opaque `sub:` id linking a triaged idea to its
   *  raw submission. */
  sourceSubmissionId?: string;
  /** Set when this idea was merged INTO another (the canonical card). */
  mergedInto?: string;
  /** Set when this idea was promoted to funded work. */
  promotedTo?: { kind: 'initiative' | 'project'; id: string; strategyId?: string };
  updatedBy: string;
  updatedAt: string;
}

export type EvidenceKind = 'document' | 'kb' | 'url';
const EVIDENCE_KINDS: readonly EvidenceKind[] = ['document', 'kb', 'url'];

export interface IdeaEvidence {
  evidenceId: string;
  listId: string;
  cardId: string;
  kind: EvidenceKind;
  /** documentId | kb collectionId | https URL — a pointer, never content. */
  ref: string;
  label?: string;
  addedBy: string;
  addedAt: string;
}

const intakes = new DurableCollection<IdeaIntake>('priority:intake', (r) => `${r.listId}::${r.cardId}`);
const evidence = new DurableCollection<IdeaEvidence>('priority:evidence', (r) => r.evidenceId);

const EVIDENCE_CAP_PER_IDEA = 50;

export async function getIdeaIntake(listId: string, cardId: string): Promise<IdeaIntake | null> {
  return intakes.get(`${listId}::${cardId}`);
}

export async function upsertIdeaIntake(input: {
  tenantId: string; orgId: string; listId: string; cardId: string; actor: string;
  patch: Record<string, unknown>;
}): Promise<IdeaIntake> {
  const { tenantId, orgId, listId, cardId, actor, patch } = input;
  await assertIdeaOnList(tenantId, listId, cardId);
  const existing = await getIdeaIntake(listId, cardId);
  const next: IdeaIntake = existing ? { ...existing } : { listId, cardId, updatedBy: actor, updatedAt: '' };
  if (patch.requester !== undefined) {
    const v = cleanString(patch.requester, 200);
    if (v) next.requester = v; else delete next.requester;
  }
  if (patch.sourceChannel !== undefined) {
    if (patch.sourceChannel === null) delete next.sourceChannel;
    else if (typeof patch.sourceChannel === 'string' && (SOURCE_CHANNELS as readonly string[]).includes(patch.sourceChannel)) next.sourceChannel = patch.sourceChannel as IntakeSourceChannel;
    else throw new OpenwopError('validation_error', `sourceChannel must be one of: ${SOURCE_CHANNELS.join(', ')}.`, 400, {});
  }
  if (patch.estimatedValue !== undefined) {
    if (patch.estimatedValue === null) delete next.estimatedValue;
    else {
      const n = typeof patch.estimatedValue === 'number' ? patch.estimatedValue : Number(patch.estimatedValue);
      if (!Number.isFinite(n)) throw new OpenwopError('validation_error', 'estimatedValue must be a finite number.', 400, {});
      next.estimatedValue = n;
    }
  }
  if (patch.estimatedValueUnit !== undefined) {
    const v = cleanString(patch.estimatedValueUnit, 40);
    if (v) next.estimatedValueUnit = v; else delete next.estimatedValueUnit;
  }
  if (patch.notes !== undefined) {
    const v = cleanString(patch.notes, 2000);
    if (v) next.notes = v; else delete next.notes;
  }
  // ADR 0247 OQ-5 — provenance back to the originating form submission (set by
  // the forms→intake bridge chain; opaque id, no PII). PMX-5 (ADR 0590): this
  // is a REFERENCE lane — `cleanOpaqueToken` (charset-validated, NOT the
  // secret-shaped scrub that would corrupt any 40+-char id at save), with a
  // loud 400 for a non-token value instead of a silent mangle-or-drop.
  if (patch.sourceSubmissionId !== undefined) {
    const raw = String(patch.sourceSubmissionId ?? '').trim();
    if (!raw) delete next.sourceSubmissionId;
    else {
      const v = cleanOpaqueToken(raw, 128);
      if (!v) throw new OpenwopError('validation_error', 'sourceSubmissionId must be an opaque submission id.', 400, { field: 'sourceSubmissionId' });
      next.sourceSubmissionId = v;
    }
  }
  next.updatedBy = actor;
  next.updatedAt = new Date().toISOString();
  await intakes.put(next);
  priorityMutated({ entity: 'idea', verb: 'intake-updated', tenantId, actor, listId, entityId: cardId, orgId });
  return next;
}

export async function listIdeaEvidence(listId: string, cardId: string): Promise<IdeaEvidence[]> {
  return (await evidence.listByPrefix(`ev:${listId}::${cardId}::`)).sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

export async function addIdeaEvidence(input: {
  tenantId: string; orgId: string; listId: string; cardId: string; actor: string;
  kind: unknown; ref: unknown; label?: unknown;
}): Promise<IdeaEvidence> {
  const { tenantId, orgId, listId, cardId, actor } = input;
  await assertIdeaOnList(tenantId, listId, cardId);
  if (typeof input.kind !== 'string' || !(EVIDENCE_KINDS as readonly string[]).includes(input.kind)) {
    throw new OpenwopError('validation_error', `kind must be one of: ${EVIDENCE_KINDS.join(', ')}.`, 400, {});
  }
  // PMX-5 (ADR 0590) — `ref` is a POINTER (documentId / kb id / URL), never
  // free text, so it must not ride the secret-shaped scrub: `cleanString`
  // replaced any bare 40+-char `[A-Za-z0-9_-]` run (every Google Docs/Drive id
  // segment) with `[REDACTED:secret-shaped]` and stored the corrupted pointer
  // as a 201 success. URLs: scheme-checked (http(s) only — no dangerous-scheme
  // exposure) + length-capped, stored VERBATIM. Ids: `cleanOpaqueToken`
  // (charset-validated). Invalid ⇒ loud 400. Free-text `label` below keeps the
  // scrub — that is the correct boundary.
  const rawRef = String(input.ref ?? '').trim();
  if (!rawRef) throw new OpenwopError('validation_error', 'Field `ref` is required.', 400, { field: 'ref' });
  if (rawRef.length > 1000) throw new OpenwopError('validation_error', 'Field `ref` must be at most 1000 characters.', 400, { field: 'ref' });
  let ref: string;
  if (input.kind === 'url') {
    if (!/^https?:\/\//i.test(rawRef)) throw new OpenwopError('validation_error', 'URL evidence must be http(s).', 400, {});
    ref = rawRef;
  } else {
    ref = cleanOpaqueToken(rawRef, 1000);
    if (!ref) throw new OpenwopError('validation_error', 'Field `ref` must be an opaque document/kb id.', 400, { field: 'ref' });
  }
  if ((await listIdeaEvidence(listId, cardId)).length >= EVIDENCE_CAP_PER_IDEA) {
    throw new OpenwopError('validation_error', `This idea already has the maximum ${EVIDENCE_CAP_PER_IDEA} evidence links.`, 400, {});
  }
  const row: IdeaEvidence = {
    evidenceId: `ev:${listId}::${cardId}::${randomUUID().slice(0, 12)}`,
    listId, cardId,
    kind: input.kind as EvidenceKind,
    ref,
    ...(cleanString(input.label, 200) ? { label: cleanString(input.label, 200) } : {}),
    addedBy: actor,
    addedAt: new Date().toISOString(),
  };
  await evidence.put(row);
  // F3 / PMX-D3 (ADR 0590 correction) — the FIFTH pre-check-then-create cap
  // instance, found by the enumerate-the-class sweep the review demanded:
  // same fail-closed post-write re-check (any racer observing overshoot
  // deletes its own row and refuses; the cap invariant always converges).
  if ((await listIdeaEvidence(listId, cardId)).length > EVIDENCE_CAP_PER_IDEA) {
    await evidence.delete(row.evidenceId);
    throw new OpenwopError('validation_error', `This idea already has the maximum ${EVIDENCE_CAP_PER_IDEA} evidence links.`, 400, {});
  }
  priorityMutated({ entity: 'idea', verb: 'evidence-added', tenantId, actor, listId, entityId: cardId, orgId });
  return row;
}

export async function removeIdeaEvidence(tenantId: string, orgId: string, listId: string, cardId: string, evidenceId: string, actor: string): Promise<boolean> {
  const row = await evidence.get(evidenceId);
  if (!row || row.listId !== listId || row.cardId !== cardId) return false;
  await evidence.delete(evidenceId);
  priorityMutated({ entity: 'idea', verb: 'evidence-removed', tenantId, actor, listId, entityId: cardId, orgId });
  return true;
}

/** Merge: the duplicate's intake fields (where the canonical lacks them) and
 *  ALL its evidence move onto the canonical; the duplicate is marked. Scores
 *  and votes are deliberately NOT merged (scoring integrity — re-score). */
export async function mergeIdeaOverlays(input: {
  tenantId: string; orgId: string; listId: string; canonicalCardId: string; duplicateCardId: string; actor: string;
}): Promise<void> {
  const { tenantId, orgId, listId, canonicalCardId, duplicateCardId, actor } = input;
  // Both sides MUST be real ideas on this list before any write — else a
  // bogus/foreign canonicalCardId writes a ghost overlay + re-keys the
  // duplicate's evidence onto it with no rollback (grade-code F1; the merge
  // route was never covered by the retired route guard).
  await assertIdeaOnList(tenantId, listId, canonicalCardId);
  await assertIdeaOnList(tenantId, listId, duplicateCardId);
  const dupIntake = await getIdeaIntake(listId, duplicateCardId);
  const canonical = (await getIdeaIntake(listId, canonicalCardId)) ?? { listId, cardId: canonicalCardId, updatedBy: actor, updatedAt: '' };
  if (dupIntake) {
    if (canonical.requester === undefined && dupIntake.requester !== undefined) canonical.requester = dupIntake.requester;
    if (canonical.sourceChannel === undefined && dupIntake.sourceChannel !== undefined) canonical.sourceChannel = dupIntake.sourceChannel;
    if (canonical.estimatedValue === undefined && dupIntake.estimatedValue !== undefined) canonical.estimatedValue = dupIntake.estimatedValue;
    if (canonical.estimatedValueUnit === undefined && dupIntake.estimatedValueUnit !== undefined) canonical.estimatedValueUnit = dupIntake.estimatedValueUnit;
    if (canonical.notes === undefined && dupIntake.notes !== undefined) canonical.notes = dupIntake.notes;
  }
  canonical.updatedBy = actor;
  canonical.updatedAt = new Date().toISOString();
  await intakes.put(canonical);
  for (const ev of await listIdeaEvidence(listId, duplicateCardId)) {
    await evidence.delete(ev.evidenceId);
    await evidence.put({ ...ev, cardId: canonicalCardId, evidenceId: `ev:${listId}::${canonicalCardId}::${randomUUID().slice(0, 12)}` });
  }
  const dupMark: IdeaIntake = {
    ...(dupIntake ?? { listId, cardId: duplicateCardId, updatedBy: actor, updatedAt: '' }),
    mergedInto: canonicalCardId,
    updatedBy: actor,
    updatedAt: new Date().toISOString(),
  };
  await intakes.put(dupMark);
  priorityMutated({ entity: 'idea', verb: 'merged', tenantId, actor, listId, entityId: duplicateCardId, orgId });
}

/**
 * R2 PM2-M2 (review) — refuse a re-promotion BEFORE the target is minted.
 *
 * My first version checked inside `markPromoted`, which runs AFTER `createProject` /
 * `updateStrategy` — so the 409 fired with the durable row already written and no
 * compensation. MEASURED: two projects after the second promote, the second linked to
 * nothing, and the user told "already promoted" with no mention that a project had just
 * been created. The refusal produced exactly the orphan it was written to prevent.
 *
 * The strategy lane was worse: the initiative was appended, the link written, and a slot
 * consumed against `maxInitiatives`, before the throw.
 *
 * Callers must call this first; `markPromoted` keeps its own check as the durable
 * backstop for any lane that forgets.
 */
export async function assertNotPromoted(listId: string, cardId: string): Promise<void> {
  const existing = await getIdeaIntake(listId, cardId);
  if (existing?.promotedTo) {
    throw new OpenwopError('conflict', `This idea was already promoted to a ${existing.promotedTo.kind}, so it cannot be promoted again.`, 409, { promotedTo: existing.promotedTo });
  }
}

/** R2 PM2-M5 — see `erasure.ts`. */
export function __intakeStoresForErasure(): { intakes: typeof intakes; evidence: typeof evidence } {
  return { intakes, evidence };
}

export async function markPromoted(input: {
  tenantId: string; orgId: string; listId: string; cardId: string; actor: string;
  promotedTo: { kind: 'initiative' | 'project'; id: string; strategyId?: string };
}): Promise<IdeaIntake> {
  const { tenantId, orgId, listId, cardId, actor, promotedTo } = input;
  // R2 PM2-M2 — this overwrote `promotedTo` unconditionally, and the ONLY guard was a
  // disabled button on a client snapshot a second tab does not share. So an idea promoted
  // to a project could later be promoted to a strategy initiative: the project still
  // existed with nothing linking back to the idea that spawned it, and the panel then
  // claimed the idea had become an initiative. The first promotion was unrecoverable from
  // the data. Promotion is a one-way door; a second one is a conflict, not an update.
  // The durable backstop. NOTE (review): the id-equality escape is unreachable from
  // either route — both mint a FRESH target id every call — so an honest idempotent retry
  // cannot be distinguished here. That is exactly why the real guard is `assertNotPromoted`
  // BEFORE the target is minted; this one only ever fires for a lane that skipped it.
  //
  // PMX-2 (ADR 0590) — the stamp is now CAS-GUARDED: the old read-check-put let
  // two CONCURRENT promotes both pass the check and the last write win, so both
  // callers were told they promoted. Now exactly one stamp wins; a CAS lost to a
  // non-promote intake patch re-reads once, a CAS lost to a rival stamp 409s
  // (and the promote route COMPENSATES its freshly-minted project on that 409).
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await getIdeaIntake(listId, cardId);
    if (existing?.promotedTo) {
      throw new OpenwopError('conflict', `This idea was already promoted to a ${existing.promotedTo.kind}, so it cannot be promoted again.`, 409, {
        promotedTo: existing.promotedTo, requested: promotedTo,
      });
    }
    const base: IdeaIntake = existing ?? { listId, cardId, updatedBy: actor, updatedAt: '' };
    const next: IdeaIntake = { ...base, promotedTo, updatedBy: actor, updatedAt: new Date().toISOString() };
    if (await intakes.compareAndSwap(existing ?? null, next)) {
      priorityMutated({ entity: 'idea', verb: 'promoted', tenantId, actor, listId, entityId: cardId, orgId });
      return next;
    }
  }
  throw new OpenwopError('conflict', 'The idea was modified concurrently while promoting; retry.', 409, { cardId });
}

/** R2 PM review — cascade the list's intake + evidence rows. They carry `requester`
 *  (operator-typed names/emails), `updatedBy` and `addedBy`, and once the list is gone
 *  nothing can resolve their tenant, so a tenant-scoped eraser can never reach them. */
export async function deleteIntakeRowsForList(listId: string): Promise<number> {
  let removed = 0;
  for (const r of await intakes.listByPrefix(`${listId}::`)) {
    await intakes.delete(`${r.listId}::${r.cardId}`);
    removed += 1;
  }
  // PMX-D2 / PMXWF-4 (ADR 0590) — evidence ids embed their own prefix lane
  // (`ev:${listId}::…`, minted in `addIdeaEvidence`), so the sweep is
  // prefix-BOUNDED instead of the former cross-tenant `list().filter()`.
  for (const ev of await evidence.listByPrefix(`ev:${listId}::`)) {
    await evidence.delete(ev.evidenceId);
    removed += 1;
  }
  return removed;
}
