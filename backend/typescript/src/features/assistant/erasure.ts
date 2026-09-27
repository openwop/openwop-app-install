/**
 * COS-1 — subject erasure + PII declaration for the assistant memory graph.
 *
 * WHAT WAS WRONG. `features/assistant/` registered ZERO `registerSubjectEraser`,
 * ZERO `registerSubjectKeyResolver`, ZERO `declarePiiFields` and ZERO retention
 * across all EIGHT of its durable namespaces, while those namespaces hold a
 * `PersonRef` (a CRM contactId *or a raw email address*) on `Commitment.owner`,
 * `Decision.decidedBy`, `Meeting.attendees[]` and `StakeholderProfile.person`,
 * plus `PendingAction.draft` — a literal outbound message body — and
 * `payload.to` / `recipientDiff` (raw addresses). Because `SubjectEraser`
 * returns `void`, `eraseSubject` reported `{failed: 0}` and
 * `consentService.ts` wrote `reason: 'erasure_complete'`: failure rendered as
 * success, on a compliance path.
 *
 * There is no retention backstop to fall back on either.
 * `GovernancePolicy.retention.assistantGraphDays` is settable and read by
 * nothing (COS-2), which is exactly why "retention will reclaim it" is not
 * available as an argument here.
 *
 * ── PER-STORE DECISIONS, AND WHY EACH IS NOT THE OTHER ─────────────────────
 *
 * The governing precedent is `features/crm/erasure.ts` (anonymize-don't-delete,
 * tombstone sentinel `erased:subject`) and the ADR 0584 / `FORM-1` overturning
 * of "it's a business record the tenant holds ABOUT someone else, retention is
 * the honest lifecycle". Neither is applied wholesale: the six stores split
 * three ways and the split is the point.
 *
 *  • `assistant:stakeholder` — DELETE THE ROW. This is the one store that is
 *    unambiguously a record about the data subject and nothing else:
 *    `stakeholderId` is literally `sha256(tenantId:JSON(person))`, and
 *    `importance` / `intendedCadenceDays` / `lastMeaningfulContactAt` / `notes`
 *    are all assertions about that person. Redacting `person` would leave a row
 *    KEYED BY A STABLE PSEUDONYM OF THE ERASED PERSON whose remaining fields
 *    profile them — strictly worse than deletion. Cascade: the id is cleared
 *    from every `Project.stakeholderIds`.
 *
 *  • `assistant:commitment` — REDACT `owner`, KEEP the row. The row is the
 *    workspace's record of a piece of WORK and is load-bearing for records that
 *    are not the subject's: it back-refs a live kanban card (`kanbanCardId`),
 *    the board projection and the briefing read it, and Project/Meeting point at
 *    it. Deleting it would destroy the org's own task history and strand the
 *    card. `description` is redacted ONLY on an owner match, because a one-line
 *    imperative commitment is usually *about* its owner ("send Dana the Q3
 *    numbers") — not blanket-redacted, which is the disproportionate move
 *    `crm/erasure.ts` declines for timeline bodies. AND — because this leg's
 *    whole argument for keeping the row is the live `kanbanCardId` — the leg
 *    FOLLOWS that ref and redacts the projected card's `title`/`description`
 *    too. The projection copies `description` into `title` verbatim, and the
 *    kanban eraser's `mine` predicate (assigneeId/createdBy) can never match an
 *    assistant-projected card because the projection sets neither. Citing the
 *    ref as the reason to keep a row and then not following it is how a
 *    redacted string survives, workspace-visible, past a successful DSAR.
 *
 *  • `assistant:decision` — REDACT `decidedBy`, KEEP `statement` and
 *    `rationale`. Who decided is the subject's data; WHAT was decided is the
 *    organisation's decision log, chained by `supersedesDecisionId` and read by
 *    the meeting minutes. Erasing a person must not erase the company's record
 *    of its own decisions. This is exactly the split `crm/erasure.ts` uses.
 *
 *  • `assistant:meeting` — REMOVE THE ELEMENT from `attendees[]`. `attendees` is
 *    a LIST, so erasure here is element-level: the honest operation is removing
 *    one person's presence, not deleting a meeting other people attended and
 *    whose `decisionIds`/`commitmentIds` anchor other rows. `title` and
 *    `calendarEventId` stay (a calendar id is a provider ref, not a subject id).
 *
 *  • `assistant:pending-action` — REDACT `payload`/`recipientDiff`/`draft`/the
 *    two `*ByUserId`s, KEEP the row and its `status`; and if it is still
 *    `pending`, CANCEL it. The row's EXISTENCE is the audit record that an
 *    action was drafted and how it was decided ("rejected, not deleted — the
 *    audit trail is the point"). The cancel is the load-bearing half: a pending
 *    action is EXECUTABLE, and approving it after the subject's erasure would
 *    send a message to a person who asked to be forgotten. That is the
 *    `anon-surface-write` `onSubjectMatch:'cancel'` precedent, and redaction
 *    alone would not have been enough.
 *
 *  • `assistant:project` — DELIBERATELY NOT ERASED, and stated here rather than
 *    left to be inferred from its absence. `name`/`summary`/`status`/`priority`
 *    carry no PersonRef and no address. Free text *could* name someone, but
 *    that is the settled `crm:*` timeline-body case (`crm/erasure.ts`):
 *    declare it PII so log masking and retention see it, do not erase it. The
 *    project IS touched by the stakeholder cascade — an erased stakeholder's id
 *    is removed from `stakeholderIds` — which is a reference repair, not an
 *    erasure of the project's own content.
 *
 *  • `assistant:commitment:by-tenant` / `:by-status` — DELIBERATELY NOT ERASED.
 *    `CommitmentIndexRow = {ixId, commitmentId}` holds no subject data. The real
 *    hazard runs the other way: `statusIxIdOf` embeds the status, so any erasure
 *    that DELETED a commitment would have to unindex it or strand index rows
 *    that `listCommitments` then resolves to `null`. Choosing REDACT for
 *    commitments (above) sidesteps that entirely — one more reason it is the
 *    right call there.
 *
 *  • `Commitment.source` / `Decision.source` (`SourceRef`) and
 *    `Meeting.transcriptKbDocId` — DECLARED PII, DELIBERATELY NOT ERASED. Added
 *    because this header's own standard is to STATE a non-erasure rather than
 *    leave it inferred from absence, and these three were the fields left in
 *    neither column. They do carry subject-adjacent data: `externalId` is a
 *    Gmail message id / Drive file id for a message the subject may have sent,
 *    `url` is a provider link that can embed a filename, and
 *    `transcriptKbDocId` points at a `kb` document of a meeting they attended.
 *    They are NOT erased for two reasons that point the same way. (1) They are
 *    PROVIDER REFERENCES into a system this eraser cannot reach — nulling the
 *    ref here deletes the app's ability to FIND the upstream record without
 *    deleting the record, which is the worst of both. The `kb` document itself
 *    is a `kb`-owned row and is that feature's erasure decision to make, not
 *    one to pre-empt from here; `calendarEventId` is already kept on the same
 *    "a provider ref is not a subject id" grounds one bullet up. (2)
 *    `SourceRef` is LOAD-BEARING for idempotence: `commitmentDedupKey` folds
 *    `source` in, so redacting it would make the next perception tick mint a
 *    NEW commitment instead of updating the redacted one — RESIDUAL 1 below,
 *    made strictly worse. Declaring them (entity-aware) is what closes the gap
 *    that IS closable here: masking and retention now see them. This is the
 *    same posture as `assistant:project`.
 *
 * ── WHAT THIS DOES NOT DO, named so it is not implied ───────────────────────
 *
 * RESIDUAL 1 — RE-INGESTION. The perception loops read Google Calendar/Drive
 * through the Connections broker on a cron. An erasure cannot reach the SOURCE,
 * so if the subject still appears in a connected calendar the next tick can
 * mint a fresh commitment about them. Redacting `description` even changes the
 * `commitmentDedupKey`, so the re-ingested row is a NEW row rather than an
 * update of the redacted one. This is the same shape `crm/erasure.ts` answers by
 * deleting the gmail syncs; the assistant has no per-subject equivalent (the
 * loops are tenant-wide), so the honest operator action is to disable the loop
 * or remove the person at the source. Recorded here, not papered over.
 *
 * RESIDUAL 2 — the mirrored host APPROVAL row. `approvalService` made an
 * explicit, argued decision for `assistant-action` (empty field map, "KNOWN
 * RESIDUAL … out of this seam's reach"); re-litigating it here would be the
 * over-erasure the ledger exists to prevent. What this module DOES do is make
 * that residual safe: the `erasedAt` stamp makes `executeApprovedAction` refuse,
 * so a later approval of the surviving approval row cannot undo the cancel.
 *
 * NO SubjectKeyResolver is registered. The assistant holds no authoritative
 * identity index of its own — `PersonRef` is a REFERENCE into CRM's — so a
 * resolver here could only guess, and a heuristic resolver is how over-erasure
 * happens. CRM's `resolveCrmSubjectKeys` (email/phone → contactId) already
 * expands the key set, and both PersonRef arms are matched below, so a DSAR
 * arriving as either an address or a contactId reaches these rows.
 *
 * IDEMPOTENT BY CONSTRUCTION (the contract requires it — the eraser runs once
 * per linked identity key): every write sets a field to the tombstone or removes
 * an element, which is a no-op the second time.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { getCard, updateCardFields } from '../../host/kanbanService.js';
import { createLogger } from '../../observability/logger.js';
import { isCommitmentRow } from './assistantService.js';
import type {
  Commitment,
  Decision,
  Meeting,
  PendingAction,
  PersonRef,
  Project,
  StakeholderProfile,
} from './assistantService.js';

const log = createLogger('features.assistant.erasure');

/** What an erased identifier becomes. Not `''` — an empty owner reads as
 *  "nobody set it", which is a different fact from "erased on request".
 *  Deliberately the SAME literal `crm/erasure.ts` and `documents/erasure.ts`
 *  use, so one grep finds every tombstone in the app. */
export const ERASED_VALUE = 'erased:subject';

/**
 * The tombstone a redacted `PersonRef` becomes.
 *
 * WHY NOT A NEW `{kind:'erased'}` UNION ARM, which would be more honest as a
 * type: widening the union creates a state every existing reader must handle,
 * and `surface.ts personRefOf` — the node-facing coercer — falls back to
 * `{kind:'self'}` for anything it does not recognise. A node round-tripping an
 * erased row through the surface would therefore have silently RE-ATTRIBUTED
 * the erased person's work to the principal, which is a worse lie than the one
 * this avoids. `{kind:'email', address:'erased:subject'}` is handled by every
 * reader today, is not a syntactically valid address (so
 * `prepare-action-request`'s recipient validation rejects it rather than
 * mailing it), and greps identically to every other tombstone in the app.
 */
const ERASED_PERSON: PersonRef = { kind: 'email', address: ERASED_VALUE };

// The SAME namespaces + key + tenant functions as `assistantService.ts` — this
// module reads and writes the SAME rows. Declared here rather than exported from
// the service so the erasure seam does not widen six public surfaces (the
// `features/crm/erasure.ts` precedent). `test/assistant-erasure.test.ts` asserts
// the two declarations stay identical.
const projects = new DurableCollection<Project>('assistant:project', (p) => p.projectId, undefined, (p) => p.tenantId);
const commitments = new DurableCollection<Commitment>('assistant:commitment', (c) => c.commitmentId, isCommitmentRow, (c) => c.tenantId);
const decisions = new DurableCollection<Decision>('assistant:decision', (d) => d.decisionId, undefined, (d) => d.tenantId);
const meetings = new DurableCollection<Meeting>('assistant:meeting', (m) => m.meetingId, undefined, (m) => m.tenantId);
const stakeholders = new DurableCollection<StakeholderProfile>('assistant:stakeholder', (s) => s.stakeholderId, undefined, (s) => s.tenantId);
const pendingActions = new DurableCollection<PendingAction>('assistant:pending-action', (a) => a.actionId, undefined, (a) => a.tenantId);

/**
 * PII declaration — the CLASSIFICATION seam, which is a different seam from
 * erasure and was equally empty. Without it `classificationOf` reads these
 * entities as plain `internal` while they hold addresses and outbound message
 * bodies, and nothing is masked in logs.
 *
 * THE SPLIT (the ANL-3 R2 precedent, and it matters): distinctive names go into
 * the app-wide log-mask union; GENERIC ones (`owner`, `person`, `description`,
 * `statement`, `title`, `payload`, `draft`, `notes`) are declared
 * entity-AWARE-only via `maskGloballyByFieldName: false`. Adding `title` or
 * `owner` to the global union would rewrite unrelated operational log keys
 * across the app to `pii_<sha>`, making those logs actively misleading — the
 * exact trade the analytics declaration records. Entity-aware callers (erasure,
 * export, retention, masked reads) are unaffected by the split.
 */
// `source` / `transcriptKbDocId` are DECLARED but NOT erased — see the
// `SourceRef` bullet in the header for why the two are a deliberate pair rather
// than an oversight.
declarePiiFields('assistant.commitment', ['owner', 'description', 'source'], { maskGloballyByFieldName: false });
declarePiiFields('assistant.decision', ['decidedBy', 'statement', 'rationale', 'source'], { maskGloballyByFieldName: false });
declarePiiFields('assistant.meeting', ['attendees', 'title', 'transcriptKbDocId'], { maskGloballyByFieldName: false });
declarePiiFields('assistant.stakeholder', ['person', 'notes'], { maskGloballyByFieldName: false });
declarePiiFields('assistant.pendingAction', ['payload', 'draft', 'recipientDiff', 'approvedByUserId', 'editedByUserId'], { maskGloballyByFieldName: false });
// `assistant:project` is exempt from ERASURE (see the header) but NOT from
// classification — that is precisely the `crm:*` timeline-body posture: declare
// the free text so masking and retention see it, do not erase it.
declarePiiFields('assistant.project', ['name', 'summary'], { maskGloballyByFieldName: false });

/** Case-folded comparison key for an address-shaped subject key. */
const fold = (v: string): string => v.trim().toLowerCase();

/**
 * Does this `PersonRef` name the subject? Both arms are matched, because a DSAR
 * arrives as either a CRM `contactId` (the ADR 0381 fan-out's key) or a raw
 * address (what the extractor writes when the person is not a contact).
 * `{kind:'self'}` is the workspace principal, never a third-party subject, and
 * an already-tombstoned ref must not re-match (idempotence).
 */
/**
 * ADR 0662 D6 (`COSX-5`) — a commitment can carry a THIRD PARTY's data without being
 * owned by them.
 *
 * The loops stamp `owner: {kind:'self'}` on everything they ingest from the principal's own
 * calendar/Drive (`packs/feature.assistant.nodes/index.mjs`), and the third-party PII lands
 * in the derived free text: `description` is `Prepare for "<event title>"`, and `source.url`
 * is the provider link. Leg 0 reached a commitment only through `personMatches(c.owner, …)`,
 * so a DSAR from someone named in an ingested event title erased nothing — while
 * `eraseSubject` reported success. Success over a no-op, on the erasure lane.
 *
 * Matching is deliberately EMAIL-ONLY and exact-substring on the folded text. An email
 * address is a deterministic identifier; a person's NAME is not, and matching names inside
 * free text would erase other people's rows on a common surname. **Stated residual: a
 * subject who appears in an event title by name only is still not reached by this leg.**
 * That is recorded rather than papered over, because the alternative is over-erasure —
 * silently destroying a third party's data is not a safer failure than missing some.
 */
function mentionsSubject(c: { description?: string; source?: { url?: string } }, subjectKey: string): boolean {
  const needle = fold(subjectKey);
  if (!needle.includes('@')) return false; // names are not deterministic enough to match on
  const haystack = `${fold(c.description ?? '')} ${fold(c.source?.url ?? '')}`;
  return haystack.includes(needle);
}

function personMatches(person: PersonRef | undefined, subjectKey: string): boolean {
  if (!person) return false;
  if (person.kind === 'crm-contact') return person.contactId === subjectKey;
  if (person.kind === 'email') return person.address !== ERASED_VALUE && fold(person.address) === fold(subjectKey);
  return false;
}

/**
 * Addresses a pending action would egress to, folded.
 *
 * `payload.to` is a UNION — `string[]` OR a bare `string`. Both arms are
 * SENDABLE: the pack's `email.send` leg coerces a scalar
 * (`packs/feature.assistant.nodes/index.mjs`, the `Array.isArray(payload.to) ?
 * … : typeof payload.to === 'string' ? [payload.to] : []` ladder), the
 * missing-fields validator accepts it, and `actionApproval.ts summarize`
 * renders it. So the scalar arm is not a hypothetical shape.
 *
 * BRACES ARE LOAD-BEARING HERE. This was written unbraced —
 * `if (Array.isArray(to)) for (…) if (…) push; else if (typeof to === 'string')
 * push` — and the `else` bound to the INNER `if`, parking the scalar arm inside
 * the `for` body where a non-array `to` can never reach it. Measured: array →
 * `["dana@x.com"]`, scalar → `[]`. The consequence was not cosmetic: a `pending`
 * `email.send` drafted to a bare-string recipient matched NONE of the three
 * predicates in leg 1 (`byAddress` false from this bug, `byDecider` false
 * because the subject is the recipient not the approver, `bySource` false
 * because the linked commitment's owner is the principal), so it kept its
 * `draft`, its `payload.to` and its `status:'pending'`, and took no `erasedAt` —
 * which is also the key `executeApprovedAction` refuses on. A later approval
 * would have mailed the person who asked to be forgotten.
 * `test/assistant-erasure.test.ts` covers BOTH arms; a fixture set that uses
 * only arrays is green over this bug, which is exactly how it shipped.
 */
function actionAddresses(a: PendingAction): string[] {
  const out: string[] = [];
  const to = (a.payload as { to?: unknown }).to;
  if (Array.isArray(to)) {
    for (const v of to) {
      if (typeof v === 'string') out.push(fold(v));
    }
  } else if (typeof to === 'string') {
    out.push(fold(to));
  }
  for (const v of a.recipientDiff?.before ?? []) out.push(fold(v));
  for (const v of a.recipientDiff?.after ?? []) out.push(fold(v));
  return out;
}

/**
 * The registered eraser. `subjectKey` is a CANDIDATE identifier from any
 * identity space: one that matches nothing is the harmless no-op the contract
 * describes.
 *
 * LEG ORDER. Unlike `crm/erasure.ts` there is no derived key-set here — every
 * leg matches on the incoming `subjectKey` directly — so a partial failure
 * cannot leave a retry unable to re-derive what to match. The one ordering
 * constraint that IS load-bearing is stated at its leg: pending actions are
 * matched against the commitment ids BEFORE those commitments are redacted,
 * because redaction removes the evidence that linked them.
 */
export async function eraseAssistantSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return; // fail-closed — never a tenant-wide sweep
  let touched = 0;

  // ── leg 0: which commitments are the subject's? (READ ONLY) ───────────────
  // Computed first because leg 1 reaches a pending action through
  // `sourceCommitmentId`, and leg 2 destroys the `owner` that proves the link.
  const tenantCommitments = await commitments.listForTenantIndexed(tenantId);
  const subjectCommitmentIds = new Set(
    tenantCommitments.filter((c) => personMatches(c.owner, subjectKey) || mentionsSubject(c, subjectKey)).map((c) => c.commitmentId),
  );

  // ── leg 1: pending actions — redact, and CANCEL anything still executable ──
  for (const a of await pendingActions.listForTenantIndexed(tenantId)) {
    const byAddress = actionAddresses(a).includes(fold(subjectKey));
    const byDecider = a.approvedByUserId === subjectKey || a.editedByUserId === subjectKey;
    const bySource = a.sourceCommitmentId !== undefined && subjectCommitmentIds.has(a.sourceCommitmentId);
    if (!byAddress && !byDecider && !bySource) continue;
    const next: PendingAction = {
      ...a,
      payload: {},
      draft: ERASED_VALUE,
      // The cancel. A `pending` row is executable; every other status is already
      // terminal and must keep its decided value (the audit trail is the point).
      status: a.status === 'pending' ? 'rejected' : a.status,
      erasedAt: a.erasedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    delete next.recipientDiff;
    if (a.approvedByUserId !== undefined) next.approvedByUserId = ERASED_VALUE;
    if (a.editedByUserId !== undefined) next.editedByUserId = ERASED_VALUE;
    await pendingActions.put(next);
    touched += 1;
  }

  // ── leg 2: commitments — redact the owner (and the description on a match) ─
  //
  // …AND the projected kanban card. The header's argument for KEEPING this row
  // rests on its `kanbanCardId` back-ref, so following that ref is part of the
  // same decision, not an extra. `assistantService.ts projectCommitmentToBoard`
  // copies `title: commitment.description` VERBATIM at projection time, and the
  // kanban eraser cannot reach it: `eraseSubjectKanban` derives `mine` from
  // `card.assigneeId` / `card.createdBy` only, and the projection sets NEITHER,
  // so `mine === false` on every assistant-projected card. Nor does it
  // self-heal — the projection detects drift and returns the card "WITHOUT
  // mutating" it (the human owns the card once it exists). Without this hop the
  // redacted description survives verbatim as a workspace-visible card title,
  // permanently, while `eraseSubject` reports success.
  //
  // The cure is HERE and not a widened `mine` predicate: an assistant-projected
  // card carries no subject-shaped field at all, so that lane structurally
  // cannot match it — widening it would only loosen the kanban eraser for rows
  // it already handles correctly. Idempotent: a re-run writes the same
  // tombstone, and a deleted card yields `null` from `updateCardFields`.
  for (const c of tenantCommitments) {
    if (!subjectCommitmentIds.has(c.commitmentId)) continue;
    await commitments.put({ ...c, owner: ERASED_PERSON, description: ERASED_VALUE, updatedAt: new Date().toISOString() });
    touched += 1;
    if (c.kanbanCardId) {
      const card = await getCard(c.kanbanCardId);
      if (card) {
        // `description` only when the card HAS one — patching it unconditionally
        // would mint a tombstone field on a card that never carried the text.
        await updateCardFields(c.kanbanCardId, {
          title: ERASED_VALUE,
          ...(card.description !== undefined ? { description: ERASED_VALUE } : {}),
        });
        touched += 1;
      }
    }
  }

  // ── leg 3: decisions — redact WHO, keep WHAT ──────────────────────────────
  for (const d of await decisions.listForTenantIndexed(tenantId)) {
    if (!personMatches(d.decidedBy, subjectKey)) continue;
    await decisions.put({ ...d, decidedBy: ERASED_PERSON });
    touched += 1;
  }

  // ── leg 4: meetings — element-level removal from attendees[] ──────────────
  for (const m of await meetings.listForTenantIndexed(tenantId)) {
    const kept = (m.attendees ?? []).filter((p) => !personMatches(p, subjectKey));
    if (kept.length === (m.attendees ?? []).length) continue;
    await meetings.put({ ...m, attendees: kept });
    touched += 1;
  }

  // ── leg 5: stakeholders — DELETE, then repair the project references ──────
  const removedStakeholderIds: string[] = [];
  for (const s of await stakeholders.listForTenantIndexed(tenantId)) {
    if (!personMatches(s.person, subjectKey)) continue;
    await stakeholders.delete(s.stakeholderId);
    removedStakeholderIds.push(s.stakeholderId);
    touched += 1;
  }
  if (removedStakeholderIds.length > 0) {
    // Reference repair, not erasure of the project's own content: a dangling
    // stakeholderId would resolve to `null` on every read of the project.
    for (const p of await projects.listForTenantIndexed(tenantId)) {
      const kept = (p.stakeholderIds ?? []).filter((id) => !removedStakeholderIds.includes(id));
      if (kept.length === (p.stakeholderIds ?? []).length) continue;
      await projects.put({ ...p, stakeholderIds: kept, updatedAt: new Date().toISOString() });
      touched += 1;
    }
  }

  if (touched > 0) log.info('assistant_subject_erased', { tenantId, rows: touched });
}
