/**
 * COS-1 — subject erasure for the assistant memory graph.
 *
 * Before this, `features/assistant/` registered ZERO erasers over eight durable
 * namespaces holding `PersonRef`s (CRM contactIds AND raw addresses), free-text
 * extracted from the subject's own mail/transcripts, and — worst — a literal
 * outbound message body plus recipient addresses on `assistant:pending-action`.
 * `eraseSubject` reported `{failed: 0}` and consent wrote `erasure_complete`
 * over all of it.
 *
 * The cases below assert the per-store SPLIT, not a blanket sweep. A sweep that
 * deleted everything would pass an "is the PII gone?" test and destroy the org's
 * decision log, its task history and a live kanban card's back-reference — which
 * is why each store is asserted on BOTH halves: what went, and what stayed.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import {
  __resetAssistantStore,
  getCommitment,
  getMeeting,
  getPendingAction,
  getProject,
  listCommitments,
  listDecisions,
  listStakeholders,
  logDecision,
  recordMeeting,
  updateProject,
  upsertCommitmentBySource,
  upsertStakeholder,
  createProject,
  projectCommitmentToBoard,
  type SourceRef,
} from '../src/features/assistant/assistantService.js';
import { createBoard, deleteCard, getCard, __resetKanbanStore } from '../src/host/kanbanService.js';
import { enqueueActionWithApproval, decideActionViaApproval } from '../src/features/assistant/actionApproval.js';
import { eraseAssistantSubject, ERASED_VALUE } from '../src/features/assistant/erasure.js';
import { eraseSubject } from '../src/host/subjectErasure.js';

const TENANT = 'default';
const OTHER = 'other-tenant';
const SUBJECT_EMAIL = 'dana@example.com';
const SUBJECT_CONTACT = 'crm:contact-dana';

const commit = async (tenant: string, input: Parameters<typeof upsertCommitmentBySource>[1]) => (await upsertCommitmentBySource(tenant, input)).commitment;

const src = (id: string): SourceRef => ({ kind: 'gmail', externalId: id, contentHash: `h-${id}`, capturedAt: '2026-01-01T00:00:00.000Z' });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 18993, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
});

beforeEach(async () => {
  await __resetAssistantStore();
  await __resetKanbanStore();
});

describe('COS-1 — what erasure means, per store', () => {
  it('stakeholder: the row is DELETED and its id leaves every project (the row IS the person)', async () => {
    const mine = await upsertStakeholder(TENANT, { person: { kind: 'email', address: SUBJECT_EMAIL }, importance: 90, notes: 'Prefers Tuesday calls.' });
    const other = await upsertStakeholder(TENANT, { person: { kind: 'email', address: 'sam@example.com' }, importance: 40 });
    const project = await createProject(TENANT, { name: 'Q3 launch' });
    await updateProject(TENANT, project.projectId, { stakeholderIds: [mine.stakeholderId, other.stakeholderId] });

    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);

    const left = await listStakeholders(TENANT);
    expect(left.map((s) => s.stakeholderId)).toEqual([other.stakeholderId]);
    // The cascade: a dangling id would resolve to null on every project read.
    expect((await getProject(TENANT, project.projectId))?.stakeholderIds).toEqual([other.stakeholderId]);
  });

  /**
   * ADR 0662 D6 (`COSX-5`) — born red.
   *
   * The loops stamp `owner:{kind:'self'}` on everything ingested from the principal's own
   * calendar, and the third party's data lands in the DERIVED TEXT (`Prepare for "<title>"`)
   * and the provider URL. Leg 0 reached a commitment only via `personMatches(c.owner, …)`,
   * so a DSAR from that third party erased nothing while `eraseSubject` reported success.
   */
  it('an ingested commitment that MENTIONS the subject by email is erased, even though it is owned by self', async () => {
    const mentions = await commit(TENANT, {
      owner: { kind: 'self' }, // exactly what the ingest loops stamp
      description: `Prepare for "Budget sync with ${SUBJECT_EMAIL}"`,
      source: src('mention'),
      confidence: 0.9,
    });
    const unrelated = await commit(TENANT, {
      owner: { kind: 'self' },
      description: 'Prepare for "Team retro"',
      source: src('unrelated'),
      confidence: 0.9,
    });

    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);

    const rows = await listCommitments(TENANT);
    const erased = rows.find((c) => c.commitmentId === mentions.commitmentId);
    expect(erased?.description, 'the third party is named in this text — it must go').not.toContain(SUBJECT_EMAIL);
    // …and a bystander row is untouched: this must not become a tenant-wide sweep.
    const kept = rows.find((c) => c.commitmentId === unrelated.commitmentId);
    expect(kept?.description).toBe('Prepare for "Team retro"');
  });

  it('a NAME-only mention is deliberately NOT matched — over-erasure is not the safer failure', async () => {
    // The stated residual. Matching a person's name inside free text would erase other
    // people's rows on a common surname, so this leg matches email addresses only. The
    // limitation is recorded in ADR 0662 D6 rather than papered over.
    const nameOnly = await commit(TENANT, {
      owner: { kind: 'self' },
      description: 'Prepare for "Budget sync with Dana"',
      source: src('name-only'),
      confidence: 0.9,
    });
    await eraseAssistantSubject(TENANT, 'Dana');
    const row = (await listCommitments(TENANT)).find((c) => c.commitmentId === nameOnly.commitmentId);
    expect(row?.description, 'documented residual, asserted so a future change is deliberate').toBe('Prepare for "Budget sync with Dana"');
  });

  it('commitment: the OWNER and description go, the row and its kanban back-ref STAY', async () => {
    const mine = await commit(TENANT, {
      owner: { kind: 'crm-contact', orgId: 'org-1', contactId: SUBJECT_CONTACT },
      description: 'Send Dana the Q3 numbers',
      source: src('a'),
      confidence: 0.9,
    });
    const theirs = await commit(TENANT, {
      owner: { kind: 'self' },
      description: 'Draft the board deck',
      source: src('b'),
      confidence: 0.9,
    });

    await eraseAssistantSubject(TENANT, SUBJECT_CONTACT);

    const erased = await getCommitment(TENANT, mine.commitmentId);
    // KEPT — deleting it would destroy the org's own task history and strand
    // the projected card.
    expect(erased, 'the commitment row must survive').toBeTruthy();
    expect(erased!.description).toBe(ERASED_VALUE);
    expect(JSON.stringify(erased!.owner)).not.toContain(SUBJECT_CONTACT);
    // …and someone else's work is untouched.
    const kept = await getCommitment(TENANT, theirs.commitmentId);
    expect(kept!.description).toBe('Draft the board deck');
    // The redacted row is still enumerable — redaction must not orphan the
    // ADR 0029 index the way a delete would.
    expect((await listCommitments(TENANT)).map((c) => c.commitmentId).sort()).toEqual([mine.commitmentId, theirs.commitmentId].sort());
  });

  it('decision: WHO is redacted, WHAT was decided survives (the org keeps its decision log)', async () => {
    const d = await logDecision(TENANT, {
      statement: 'We ship the EU region in Q3.',
      rationale: 'Regulatory window closes in Q4.',
      decidedBy: { kind: 'email', address: SUBJECT_EMAIL },
      source: src('c'),
    });

    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);

    const after = (await listDecisions(TENANT)).find((x) => x.decisionId === d.decisionId);
    expect(after, 'the decision row must survive').toBeTruthy();
    expect(after!.statement).toBe('We ship the EU region in Q3.');
    expect(after!.rationale).toBe('Regulatory window closes in Q4.');
    expect(JSON.stringify(after!.decidedBy)).not.toContain(SUBJECT_EMAIL);
  });

  it('meeting: ONE attendee is removed; the meeting and the other attendees stay', async () => {
    const m = await recordMeeting(TENANT, {
      calendarEventId: 'evt-1',
      title: 'Pipeline review',
      startAt: '2026-03-01T09:00:00.000Z',
      attendees: [
        { kind: 'email', address: SUBJECT_EMAIL },
        { kind: 'email', address: 'sam@example.com' },
        { kind: 'self' },
      ],
    });

    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);

    const after = await getMeeting(TENANT, m.meetingId);
    expect(after, 'other attendees participated — the meeting must survive').toBeTruthy();
    expect(after!.title).toBe('Pipeline review');
    expect(after!.attendees).toHaveLength(2);
    expect(JSON.stringify(after!.attendees)).not.toContain(SUBJECT_EMAIL);
    expect(JSON.stringify(after!.attendees)).toContain('sam@example.com');
  });

  it('pending action: the draft/recipients/deciders go, the row + status stay, and a PENDING one is CANCELLED', async () => {
    const pending = await enqueueActionWithApproval(TENANT, {
      kind: 'email.send',
      payload: { to: [SUBJECT_EMAIL], subject: 'Q3' },
      draft: 'Hi Dana — the Q3 numbers are attached.',
      recipientDiff: { before: [], after: [SUBJECT_EMAIL] },
    });

    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);

    const after = await getPendingAction(TENANT, pending.actionId);
    // KEPT — the row's existence is the audit record that an action was drafted.
    expect(after, 'the audit row must survive').toBeTruthy();
    expect(after!.draft).toBe(ERASED_VALUE);
    expect(after!.payload).toEqual({});
    expect(after!.recipientDiff).toBeUndefined();
    // THE LOAD-BEARING HALF: a pending action is executable, so it is cancelled.
    expect(after!.status).toBe('rejected');
    expect(after!.erasedAt).toBeTruthy();
  });

  it('commitment: the PROJECTED KANBAN CARD is redacted too — the back-ref is followed, not just cited', async () => {
    // REGRESSION (adversarial review, 2026-08-19). Leg 2 cites `kanbanCardId` as
    // the reason to KEEP the commitment row, then never followed it.
    // `projectCommitmentToBoard` copies `title: commitment.description`
    // VERBATIM, so the redacted string survived on a workspace-visible card.
    //
    // The kanban eraser cannot reach it — proved below rather than asserted:
    // `eraseSubjectKanban` derives `mine` from `assigneeId`/`createdBy`, and the
    // projection sets NEITHER, so no widening of that predicate could match.
    // Nor does it self-heal: the projection flags drift and returns the card
    // "WITHOUT mutating" it.
    const board = await createBoard({ tenantId: TENANT, name: 'Work' });
    const mine = await commit(TENANT, {
      owner: { kind: 'email', address: SUBJECT_EMAIL },
      description: 'Send Dana the Q3 numbers',
      source: src('k'),
      confidence: 0.9,
    });
    const projected = await projectCommitmentToBoard(TENANT, mine.commitmentId, { boardId: board.id });
    expect(projected?.status, 'the fixture must really project, or this test is inert').toBe('created');
    const cardId = projected!.card!.id;
    expect(await getCard(cardId).then((c) => c!.title)).toBe('Send Dana the Q3 numbers');
    // The premise: this card carries NO field the kanban lane can match on.
    const beforeCard = (await getCard(cardId))!;
    expect(beforeCard.assigneeId, 'if this ever gains an assignee the cure may belong in the kanban lane').toBeUndefined();
    expect(beforeCard.createdBy).toBeUndefined();

    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);

    const card = await getCard(cardId);
    expect(card, 'the card is the org\'s work item — redacted, not deleted').toBeTruthy();
    expect(card!.title).toBe(ERASED_VALUE);
    // The commitment's back-ref still resolves; a stranded ref is the failure
    // mode leg 2 exists to avoid.
    expect((await getCommitment(TENANT, mine.commitmentId))!.kanbanCardId).toBe(cardId);
  });

  it('commitment: a card belonging to someone ELSE\'s commitment is untouched', async () => {
    const board = await createBoard({ tenantId: TENANT, name: 'Work' });
    const theirs = await commit(TENANT, {
      owner: { kind: 'self' },
      description: 'Draft the board deck',
      source: src('l'),
      confidence: 0.9,
    });
    const projected = await projectCommitmentToBoard(TENANT, theirs.commitmentId, { boardId: board.id });
    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);
    expect((await getCard(projected!.card!.id))!.title).toBe('Draft the board deck');
  });

  it('commitment: the card hop is IDEMPOTENT and survives a human DELETING the card', async () => {
    const board = await createBoard({ tenantId: TENANT, name: 'Work' });
    const mine = await commit(TENANT, {
      owner: { kind: 'email', address: SUBJECT_EMAIL },
      description: 'Send Dana the Q3 numbers',
      source: src('m'),
      confidence: 0.9,
    });
    const projected = await projectCommitmentToBoard(TENANT, mine.commitmentId, { boardId: board.id });
    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);
    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);
    expect((await getCard(projected!.card!.id))!.title).toBe(ERASED_VALUE);
    // A back-ref to a card the human deleted must not throw — the eraser runs on
    // a compliance path where a throw is reported as a failed erasure.
    await deleteCard(projected!.card!.id);
    await expect(eraseAssistantSubject(TENANT, SUBJECT_EMAIL)).resolves.toBeUndefined();
  });

  it('pending action: a SCALAR `payload.to` is matched and cancelled, not just an array one', async () => {
    // REGRESSION (adversarial review, 2026-08-19). `payload.to` is a union —
    // `string[]` OR a bare `string` — and BOTH are sendable (the pack's
    // `email.send` leg, its missing-fields validator and `actionApproval.ts
    // summarize` all coerce a scalar). `actionAddresses` was written with a
    // dangling `else` that bound to the INNER `if`, parking the scalar arm
    // inside the array loop where a non-array `to` could never reach it.
    // Measured on the pre-fix code: array -> ["dana@…"], scalar -> [].
    //
    // The other two predicates cannot save this row, which is why the fixture
    // is built to defeat them: no `sourceCommitmentId` (so `bySource` is
    // false) and no decider (so `byDecider` is false). Every existing fixture
    // in this file passes an ARRAY — which is exactly why the bug was green.
    const pending = await enqueueActionWithApproval(TENANT, {
      kind: 'email.send',
      payload: { to: SUBJECT_EMAIL, subject: 'Q3' },
      draft: 'Hi Dana — the Q3 numbers are attached.',
    });

    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);

    const after = await getPendingAction(TENANT, pending.actionId);
    expect(after, 'the audit row must survive').toBeTruthy();
    expect(after!.payload, 'the raw address must not survive on the payload').toEqual({});
    expect(after!.draft).toBe(ERASED_VALUE);
    // The load-bearing half: without this the row stays `pending` with its
    // draft and recipient, and a later approval mails the erased person.
    expect(after!.status, 'a scalar-recipient action is just as executable').toBe('rejected');
    expect(after!.erasedAt, 'the erasedAt guard is what makes executeApprovedAction refuse').toBeTruthy();
  });

  it('pending action: case- and whitespace-folded scalar recipients still match', async () => {
    // `fold()` is applied on both sides; assert it survives the brace fix rather
    // than assuming it (the scalar arm never ran before, so it was never tested).
    const pending = await enqueueActionWithApproval(TENANT, {
      kind: 'email.send',
      payload: { to: `  ${SUBJECT_EMAIL.toUpperCase()} ` },
      draft: 'Hi Dana.',
    });
    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);
    expect((await getPendingAction(TENANT, pending.actionId))!.status).toBe('rejected');
  });

  it('SEND/ERASE symmetry: approving the SURVIVING approval row after an erasure does not dispatch', async () => {
    // The mirrored host approval is deliberately left alone (approvalService made
    // its own argued call), so it stays decidable. Without the `erasedAt` guard,
    // `decideActionViaApproval` flips the action back to `approved` and executes
    // it — the erasure's cancel would look like it held while the send fired.
    const action = await enqueueActionWithApproval(TENANT, {
      kind: 'email.send',
      payload: { to: [SUBJECT_EMAIL] },
      draft: 'Hi Dana.',
    });
    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);

    await decideActionViaApproval(TENANT, action.approvalId!, 'approved', { decidedByUserId: 'u-approver' });

    const after = await getPendingAction(TENANT, action.actionId);
    expect(after!.status, 'the erasure cancel must not be undoable by a later approval').toBe('rejected');
    expect(after!.executionRunId, 'nothing may be dispatched for an erased action').toBeUndefined();
  });
});

describe('COS-1 — the eraser contract', () => {
  it('is IDEMPOTENT (the seam invokes it once per linked identity key)', async () => {
    await commit(TENANT, { owner: { kind: 'email', address: SUBJECT_EMAIL }, description: 'Ping Dana', source: src('d'), confidence: 0.5 });
    await upsertStakeholder(TENANT, { person: { kind: 'email', address: SUBJECT_EMAIL } });
    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);
    const first = JSON.stringify(await listCommitments(TENANT));
    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);
    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);
    expect(JSON.stringify(await listCommitments(TENANT))).toBe(first);
    expect(await listStakeholders(TENANT)).toEqual([]);
  });

  it('FAILS CLOSED on an empty tenant or subject — never a tenant-wide sweep', async () => {
    await commit(TENANT, { owner: { kind: 'email', address: SUBJECT_EMAIL }, description: 'Ping Dana', source: src('e'), confidence: 0.5 });
    await eraseAssistantSubject('', SUBJECT_EMAIL);
    await eraseAssistantSubject(TENANT, '');
    expect((await listCommitments(TENANT))[0]!.description).toBe('Ping Dana');
  });

  it('never crosses a tenant boundary', async () => {
    await commit(TENANT, { owner: { kind: 'email', address: SUBJECT_EMAIL }, description: 'Ours', source: src('f'), confidence: 0.5 });
    await commit(OTHER, { owner: { kind: 'email', address: SUBJECT_EMAIL }, description: 'Theirs', source: src('g'), confidence: 0.5 });
    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL);
    expect((await listCommitments(OTHER))[0]!.description).toBe('Theirs');
  });

  it('matches BOTH PersonRef arms — a DSAR arrives as an address OR a contactId', async () => {
    await upsertStakeholder(TENANT, { person: { kind: 'crm-contact', orgId: 'org-1', contactId: SUBJECT_CONTACT } });
    await eraseAssistantSubject(TENANT, SUBJECT_EMAIL); // wrong identity space — a harmless no-op
    expect(await listStakeholders(TENANT)).toHaveLength(1);
    await eraseAssistantSubject(TENANT, SUBJECT_CONTACT);
    expect(await listStakeholders(TENANT)).toHaveLength(0);
  });

  it('is reached by the HOST fan-out, not only by direct call (mechanism vs wiring)', async () => {
    // The WF-CONS-2 state this guards: an eraser whose module is never imported
    // contributes to neither `total` nor `failed`, so a never-registered feature
    // reads exactly like a cleanly-erased one.
    await upsertStakeholder(TENANT, { person: { kind: 'email', address: SUBJECT_EMAIL } });
    const result = await eraseSubject(TENANT, SUBJECT_EMAIL);
    expect(result.missing, 'no expected eraser may be unregistered').toEqual([]);
    expect(await listStakeholders(TENANT)).toHaveLength(0);
  });

  it('the erasure handles are byte-identical to the service handles (two declarations, one behaviour)', () => {
    // `erasure.ts` re-declares the six namespaces (the crm/erasure.ts precedent).
    // A drift in the key or tenant function there would silently erase nothing —
    // the collection would simply address different rows.
    const root = join(__dirname, '..', 'src', 'features', 'assistant');
    const decls = (file: string): string[] =>
      [...readFileSync(join(root, file), 'utf8').matchAll(/new DurableCollection<\w+>\('(assistant:[^']+)',\s*(.*?)\);/g)]
        .map((m) => `${m[1]}|${m[2]!.replace(/\s+/g, ' ').trim()}`)
        .sort();
    const service = decls('assistantService.ts').filter((d) => !d.startsWith('assistant:commitment:by-'));
    expect(service.length, 'six entity stores — a zero here would make this vacuous').toBe(6);
    expect(decls('erasure.ts')).toEqual(service);
  });
});
