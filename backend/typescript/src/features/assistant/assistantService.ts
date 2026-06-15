/**
 * Executive-Assistant memory graph (ADR 0023 — host-extension, best-effort).
 *
 * The ONE new owned concept of the assistant feature: a structured entity graph
 * (Project / Commitment / Decision / Meeting / StakeholderProfile / PendingAction)
 * layered OVER the existing owners — people resolve to CRM contacts (PersonRef),
 * action items project onto the host.kanban board, and unstructured sources live
 * in the `kb` feature (SourceRef.kbDocumentId). This module owns the graph only.
 *
 * Storage follows the CSM precedent: one `DurableCollection` per entity keyed by
 * the entity id, every accessor tenant-GUARDED (CTI-1 — a cross-tenant id reads
 * as not-found, never an existence leak). Tenant = the caller's active workspace
 * (ADR 0015); entities carry `tenantId` so `reassignTenant` auto-rekeys them on
 * anon→personal adoption.
 */

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createCard, getCard, getPersonalBoard, type KanbanCard } from '../../host/kanbanService.js';
import { deadlineProximityOf, priorityScore, scoreToCardPriority, PRIORITY_PROFILES } from './prioritization.js';

// ─── value objects (embedded, never stored standalone) ──────────────────────

/** Who a commitment/decision is about. People are owned by CRM, not here. */
export type PersonRef =
  | { kind: 'crm-contact'; orgId: string; contactId: string }
  | { kind: 'self' }
  | { kind: 'email'; address: string };

/** The cross-layer link: a graph entity → the unstructured source it came from. */
export interface SourceRef {
  kind: 'drive' | 'gmail' | 'calendar' | 'transcript' | 'kb-doc' | 'manual';
  externalId: string;
  /** → the chunked document in the `kb` feature (ADR 0011), if ingested. */
  kbDocumentId?: string;
  url?: string;
  /** Idempotency key for re-ingest — same hash ⇒ no duplicate graph write. */
  contentHash: string;
  capturedAt: string;
  /** ADR 0027 — the RFC 0021 trust vocabulary, NOT a new enum. Perception
   *  loops stamp `'untrusted'` on everything provider-derived (Drive, Gmail,
   *  Calendar, transcripts); absent ⇒ `'trusted'` (manual/internal,
   *  back-compat). Taint propagates onto derived entities and is never
   *  cleared by re-extraction or edits. */
  contentTrust?: 'trusted' | 'untrusted';
}

// ─── entities ───────────────────────────────────────────────────────────────

export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived';

export interface Project {
  projectId: string;
  tenantId: string;
  name: string;
  status: ProjectStatus;
  priority: number; // 0..100
  summary?: string;
  boardId?: string; // → host.kanban board (tactical surface)
  kbCollectionId?: string; // → kb collection (document corpus)
  stakeholderIds: string[];
  createdAt: string;
  updatedAt: string;
}

export type CommitmentStatus = 'open' | 'in-progress' | 'blocked' | 'done' | 'dropped';

export interface Commitment {
  commitmentId: string;
  tenantId: string;
  projectId?: string;
  owner: PersonRef;
  description: string;
  dueAt?: string;
  status: CommitmentStatus;
  confidence: number; // 0..1 extraction confidence
  source: SourceRef;
  kanbanCardId?: string; // back-ref to the projected card (Loop 3)
  /** ADR 0023 §11 Q4 — true when the projected card has diverged from this
   *  source (the human hand-edited the card, or the source was re-extracted) and
   *  the two no longer agree. The card is principal-owned (manual edits win); the
   *  projection only FLAGS the drift, never overwrites. */
  driftsFromSource?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Decision {
  decisionId: string;
  tenantId: string;
  projectId?: string;
  statement: string;
  decidedAt: string;
  decidedBy: PersonRef;
  rationale?: string;
  source: SourceRef;
  supersedesDecisionId?: string;
  createdAt: string;
}

export interface Meeting {
  meetingId: string;
  tenantId: string;
  calendarEventId: string;
  title: string;
  startAt: string;
  endAt?: string;
  attendees: PersonRef[];
  prepBriefRef?: string;
  transcriptKbDocId?: string;
  decisionIds: string[];
  commitmentIds: string[];
  createdAt: string;
}

export interface StakeholderProfile {
  stakeholderId: string;
  tenantId: string;
  person: PersonRef;
  importance: number; // 0..100
  intendedCadenceDays?: number;
  lastMeaningfulContactAt?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export type PendingActionKind = 'email.send' | 'calendar.invite' | 'calendar.reschedule' | 'nudge';
export type PendingActionStatus = 'pending' | 'approved' | 'rejected' | 'sent' | 'failed';

export type ActionRiskLevel = 'low' | 'medium' | 'high';

/** A typed draft attached to the EXISTING approval loop (ADR 0025 §4) — not a
 *  parallel approval system. §12 T4 makes that wiring literal: enqueueing an
 *  action also creates a `host/approvalService.PendingApproval` (back-linked
 *  via `approvalId`), so the approvals inbox, Notifications, and the "Waiting
 *  on me" lane are the ONE decision surface; this row is the assistant's
 *  domain record (draft + provenance + risk metadata) whose `status` projects
 *  the approval act. */
export interface PendingAction {
  actionId: string;
  tenantId: string;
  kind: PendingActionKind;
  payload: Record<string, unknown>;
  draft: string;
  status: PendingActionStatus;
  sourceCommitmentId?: string;
  createdBy: 'assistant';
  approvedByUserId?: string;
  createdAt: string;
  updatedAt: string;
  // ── action-card metadata (ADR 0023 §12 T4, all additive) ──
  /** → the PendingApproval carrying the approval act (ADR 0025 §4). */
  approvalId?: string;
  riskLevel?: ActionRiskLevel;
  /** Provider scopes the eventual execution needs (rendered on the card;
   *  enforced at the T6/T7 toolHooks seam). */
  requiredScopes?: string[];
  /** Why the assistant recommends this action. */
  reason?: string;
  /** The sources the draft was derived from (citations on the card). */
  sourceRefs?: SourceRef[];
  /** Recipient/attendee change, when the action mutates one. */
  recipientDiff?: { before: string[]; after: string[] };
  /** ADR 0027 — OR over sourceRefs[].contentTrust: derived from connected
   *  (untrusted) content. Never cleared by edits or re-extraction; tainted
   *  actions are never eligible for auto-allow and carry a card banner. */
  derivedFromUntrusted?: boolean;
  /** Set when the principal edits the draft (the card shows it; an edited
   *  draft always faces the approver again before any execution). */
  editedAt?: string;
  editedByUserId?: string;
  /** §12 T6 — the run the winning approval claim dispatched (absent for
   *  internal kinds like `nudge` and for never-approved actions). The run is
   *  the single execution; `status` projects its terminal state. */
  executionRunId?: string;
}

// ─── stores ─────────────────────────────────────────────────────────────────

const projects = new DurableCollection<Project>('assistant:project', (p) => p.projectId);
const commitments = new DurableCollection<Commitment>('assistant:commitment', (c) => c.commitmentId);
const decisions = new DurableCollection<Decision>('assistant:decision', (d) => d.decisionId);
const meetings = new DurableCollection<Meeting>('assistant:meeting', (m) => m.meetingId);
const stakeholders = new DurableCollection<StakeholderProfile>('assistant:stakeholder', (s) => s.stakeholderId);
const pendingActions = new DurableCollection<PendingAction>('assistant:pending-action', (a) => a.actionId);

// ─── commitment secondary indexes (ADR 0029, pulled forward with T2) ────────
//
// Commitment ids are content-hash digests (NOT tenant-prefixed), so the list
// hot paths — the board projection, the briefing, the ingestion dedup sweep —
// were full cross-tenant scans filtered in memory. These write-through index
// collections embed the query dimensions in their row ids, turning both list
// paths into bounded `listByPrefix` scans. Maintained by every commitment
// write below; `backfillCommitmentIndexes()` (called at feature boot) indexes
// rows that predate this change. The by-source dedup path needs no index: the
// commitmentId is already DERIVED from (tenant, source hash, description).

interface CommitmentIndexRow {
  ixId: string;
  commitmentId: string;
}

const commitmentsByTenant = new DurableCollection<CommitmentIndexRow>('assistant:commitment:by-tenant', (r) => r.ixId);
const commitmentsByStatus = new DurableCollection<CommitmentIndexRow>('assistant:commitment:by-status', (r) => r.ixId);

const tenantIxIdOf = (tenantId: string, commitmentId: string): string => `${tenantId}:${commitmentId}`;
const statusIxIdOf = (tenantId: string, status: CommitmentStatus, commitmentId: string): string =>
  `${tenantId}:${status}:${commitmentId}`;

async function indexCommitment(next: Commitment, prevStatus?: CommitmentStatus): Promise<void> {
  await commitmentsByTenant.put({ ixId: tenantIxIdOf(next.tenantId, next.commitmentId), commitmentId: next.commitmentId });
  if (prevStatus !== undefined && prevStatus !== next.status) {
    await commitmentsByStatus.delete(statusIxIdOf(next.tenantId, prevStatus, next.commitmentId));
  }
  await commitmentsByStatus.put({ ixId: statusIxIdOf(next.tenantId, next.status, next.commitmentId), commitmentId: next.commitmentId });
}

async function unindexCommitment(c: Commitment): Promise<void> {
  await commitmentsByTenant.delete(tenantIxIdOf(c.tenantId, c.commitmentId));
  await commitmentsByStatus.delete(statusIxIdOf(c.tenantId, c.status, c.commitmentId));
}

/** One-time boot sweep: index commitment rows written before the indexes
 *  existed. Idempotent (puts are upserts); cheap relative to the per-request
 *  scans it retires. */
export async function backfillCommitmentIndexes(): Promise<number> {
  const all = await commitments.list();
  for (const c of all) await indexCommitment(c);
  return all.length;
}

// ─── helpers ────────────────────────────────────────────────────────────────

const now = (): string => new Date().toISOString();
const clamp = (n: unknown, lo: number, hi: number, dflt: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : dflt;
  return Math.max(lo, Math.min(hi, v));
};

/** Deterministic content hash for idempotent re-ingest (SourceRef.contentHash). */
export function contentHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** Stable key for commitment dedup across runs: (tenant + source hash + desc).
 *  MUST include `tenantId` — otherwise two tenants sharing a source contentHash +
 *  description derive the same id and one overwrites the other (CTI-1 violation),
 *  matching how `meetingId`/`stakeholderId` are tenant-scoped. */
function commitmentDedupKey(tenantId: string, source: SourceRef, description: string): string {
  const norm = description.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(`${tenantId}:${source.contentHash}:${norm}`).digest('hex').slice(0, 24);
}

// ─── Projects ───────────────────────────────────────────────────────────────

export async function listProjects(tenantId: string): Promise<Project[]> {
  return (await projects.list())
    .filter((p) => p.tenantId === tenantId)
    .sort((a, b) => b.priority - a.priority);
}

export async function getProject(tenantId: string, projectId: string): Promise<Project | null> {
  const p = await projects.get(projectId);
  return p && p.tenantId === tenantId ? p : null;
}

export async function createProject(
  tenantId: string,
  input: { name: string; priority?: number; summary?: string; status?: ProjectStatus; boardId?: string; kbCollectionId?: string },
): Promise<Project> {
  const ts = now();
  const project: Project = {
    projectId: `prj:${randomUUID()}`,
    tenantId,
    name: input.name,
    status: input.status ?? 'active',
    priority: clamp(input.priority, 0, 100, 50),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.boardId !== undefined ? { boardId: input.boardId } : {}),
    ...(input.kbCollectionId !== undefined ? { kbCollectionId: input.kbCollectionId } : {}),
    stakeholderIds: [],
    createdAt: ts,
    updatedAt: ts,
  };
  await projects.put(project);
  return project;
}

export async function updateProject(
  tenantId: string,
  projectId: string,
  patch: Partial<Pick<Project, 'name' | 'status' | 'priority' | 'summary' | 'boardId' | 'kbCollectionId' | 'stakeholderIds'>>,
): Promise<Project | null> {
  const existing = await getProject(tenantId, projectId);
  if (!existing) return null;
  const next: Project = { ...existing, updatedAt: now() };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.priority !== undefined) next.priority = clamp(patch.priority, 0, 100, existing.priority);
  if (patch.summary !== undefined) next.summary = patch.summary;
  if (patch.boardId !== undefined) next.boardId = patch.boardId;
  if (patch.kbCollectionId !== undefined) next.kbCollectionId = patch.kbCollectionId;
  if (patch.stakeholderIds !== undefined) next.stakeholderIds = patch.stakeholderIds;
  await projects.put(next);
  return next;
}

export async function deleteProject(tenantId: string, projectId: string): Promise<boolean> {
  const existing = await getProject(tenantId, projectId);
  if (!existing) return false;
  return projects.delete(projectId);
}

// ─── Commitments (the PM core) ──────────────────────────────────────────────

export async function listCommitments(
  tenantId: string,
  filter?: { status?: CommitmentStatus; projectId?: string },
): Promise<Commitment[]> {
  // Indexed read (ADR 0029): a bounded prefix scan of the matching index
  // slice → point gets, instead of a full cross-tenant collection scan.
  const ixRows = filter?.status
    ? await commitmentsByStatus.listByPrefix(`${tenantId}:${filter.status}:`)
    : await commitmentsByTenant.listByPrefix(`${tenantId}:`);
  const fetched = await Promise.all(ixRows.map((r) => commitments.get(r.commitmentId)));
  return fetched
    // Tolerate stale index rows (e.g. a delete raced) — the row read is the
    // source of truth; tenant + status re-checked, never trusted from the index.
    .filter((c): c is Commitment => c !== null && c.tenantId === tenantId)
    .filter((c) => (filter?.status ? c.status === filter.status : true))
    .filter((c) => (filter?.projectId ? c.projectId === filter.projectId : true))
    .sort((a, b) => (a.dueAt ?? '~').localeCompare(b.dueAt ?? '~'));
}

export async function getCommitment(tenantId: string, commitmentId: string): Promise<Commitment | null> {
  const c = await commitments.get(commitmentId);
  return c && c.tenantId === tenantId ? c : null;
}

/**
 * Upsert a commitment keyed by its source — the idempotency invariant Loop 2/3
 * depend on. The commitmentId is DERIVED deterministically from (tenant, source
 * hash, normalized description), so re-extracting a changed source UPDATES in
 * place and a fork/replay never duplicates. Returns {commitment, created}.
 */
export async function upsertCommitmentBySource(
  tenantId: string,
  input: {
    owner: PersonRef;
    description: string;
    source: SourceRef;
    dueAt?: string;
    confidence?: number;
    projectId?: string;
    status?: CommitmentStatus;
  },
): Promise<{ commitment: Commitment; created: boolean }> {
  const commitmentId = `cmt:${commitmentDedupKey(tenantId, input.source, input.description)}`;
  const existing = await commitments.get(commitmentId);
  const ts = now();
  if (existing && existing.tenantId === tenantId) {
    const next: Commitment = {
      ...existing,
      owner: input.owner,
      description: input.description,
      source: input.source,
      confidence: clamp(input.confidence, 0, 1, existing.confidence),
      updatedAt: ts,
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    };
    await commitments.put(next);
    await indexCommitment(next, existing.status);
    return { commitment: next, created: false };
  }
  const commitment: Commitment = {
    commitmentId,
    tenantId,
    owner: input.owner,
    description: input.description,
    status: input.status ?? 'open',
    confidence: clamp(input.confidence, 0, 1, 0.5),
    source: input.source,
    createdAt: ts,
    updatedAt: ts,
    ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
  };
  await commitments.put(commitment);
  await indexCommitment(commitment);
  return { commitment, created: true };
}

export async function updateCommitment(
  tenantId: string,
  commitmentId: string,
  patch: Partial<Pick<Commitment, 'status' | 'dueAt' | 'projectId' | 'kanbanCardId' | 'owner' | 'description' | 'driftsFromSource'>>,
): Promise<Commitment | null> {
  const existing = await getCommitment(tenantId, commitmentId);
  if (!existing) return null;
  const next: Commitment = { ...existing, updatedAt: now() };
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.dueAt !== undefined) next.dueAt = patch.dueAt;
  if (patch.projectId !== undefined) next.projectId = patch.projectId;
  if (patch.kanbanCardId !== undefined) next.kanbanCardId = patch.kanbanCardId;
  if (patch.owner !== undefined) next.owner = patch.owner;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.driftsFromSource !== undefined) next.driftsFromSource = patch.driftsFromSource;
  await commitments.put(next);
  await indexCommitment(next, existing.status);
  return next;
}

export async function deleteCommitment(tenantId: string, commitmentId: string): Promise<boolean> {
  const existing = await getCommitment(tenantId, commitmentId);
  if (!existing) return false;
  const deleted = await commitments.delete(commitmentId);
  if (deleted) await unindexCommitment(existing);
  return deleted;
}

/** The outcome of a board projection (ADR 0023 §11 Q4). `created` — a new card;
 *  `reused` — the existing card still matches its source; `drifted` — the card
 *  was kept (principal-owned) but no longer matches its source (flagged, not
 *  overwritten); `dismissed` — the human deleted the card, so it was NOT
 *  resurrected. */
export type BoardProjectionStatus = 'created' | 'reused' | 'drifted' | 'dismissed';

/**
 * Loop 3 — project a commitment onto a kanban card (ADR 0023). IDEMPOTENT across
 * runs via the commitment's `kanbanCardId` back-ref: if a card already exists it
 * is reused (no duplicate on re-run/replay). The target board is an explicit
 * boardId, else the owner's personal board (ADR 0025). Card priority comes from
 * the prioritization scorer (deadline proximity × confidence, balanced profile).
 *
 * §11 Q4 — **the human owns the card once it exists; manual edits win.** A card
 * the principal moved/renamed is never overwritten; if it has diverged from its
 * source the projection sets `driftsFromSource` and reports `'drifted'` so the
 * disagreement is surfaced, not silently clobbered. A card the principal
 * DELETED is not resurrected — the back-ref resolves to nothing, so the
 * projection reports `'dismissed'` and creates no replacement.
 */
export async function projectCommitmentToBoard(
  tenantId: string,
  commitmentId: string,
  opts: { boardId?: string; ownerUserId?: string; nowMs?: number } = {},
): Promise<{ card: KanbanCard | null; created: boolean; commitment: Commitment; status: BoardProjectionStatus } | null> {
  const commitment = await getCommitment(tenantId, commitmentId);
  if (!commitment) return null;

  if (commitment.kanbanCardId) {
    const existing = await getCard(commitment.kanbanCardId);
    if (existing) {
      // The card is now principal-owned (manual edits win). Detect drift — the
      // kept card no longer matches what its source would produce — and FLAG it
      // (persist `driftsFromSource` when it changes) WITHOUT mutating the card.
      const drifted =
        existing.title !== commitment.description ||
        (commitment.dueAt ?? undefined) !== (existing.dueAt ?? undefined);
      let current = commitment;
      if (drifted !== Boolean(commitment.driftsFromSource)) {
        current = (await updateCommitment(tenantId, commitmentId, { driftsFromSource: drifted })) ?? commitment;
      }
      return { card: existing, created: false, commitment: current, status: drifted ? 'drifted' : 'reused' };
    }
    // The back-ref is set but the card is GONE — the principal deleted it.
    // Manual delete wins: do NOT recreate it (the pre-fix code resurrected it).
    return { card: null, created: false, commitment, status: 'dismissed' };
  }

  let boardId = opts.boardId;
  if (!boardId && opts.ownerUserId) {
    const board = await getPersonalBoard(tenantId, opts.ownerUserId);
    boardId = board?.id;
  }
  if (!boardId) return null; // no board to populate — caller decides what to do

  const nowMs = opts.nowMs ?? Date.now();
  const score = priorityScore(
    {
      senderImportance: 0.5,
      deadlineProximity: deadlineProximityOf(commitment.dueAt, nowMs),
      projectPriority: 0.5,
      priorEngagement: commitment.confidence,
    },
    PRIORITY_PROFILES.balanced.weights,
  );

  const card = await createCard({
    boardId,
    columnId: 'todo',
    title: commitment.description,
    source: 'agent',
    sourceLabel: `assistant:commitment:${commitmentId}`,
    priority: scoreToCardPriority(score),
    assignmentReason: `Extracted commitment (${commitment.source.kind} source, confidence ${commitment.confidence.toFixed(2)})`,
    ...(commitment.dueAt ? { dueAt: commitment.dueAt } : {}),
  });
  const updated = await updateCommitment(tenantId, commitmentId, { kanbanCardId: card.id });
  return { card, created: true, commitment: updated ?? commitment, status: 'created' };
}

// ─── Decisions ──────────────────────────────────────────────────────────────

export async function listDecisions(tenantId: string, projectId?: string): Promise<Decision[]> {
  return (await decisions.list())
    .filter((d) => d.tenantId === tenantId)
    .filter((d) => (projectId ? d.projectId === projectId : true))
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
}

/**
 * Log a decision into the graph — IDEMPOTENT by (tenant, source hash, normalized
 * statement), so re-extracting the same transcript/source does not duplicate the
 * decision (a fork/replay re-running Loop 4 is safe). Tenant-scoped key (CTI-1),
 * matching the commitment/meeting/stakeholder convention. An existing decision's
 * immutable facts (decidedAt/createdAt) are preserved; rationale/project/supersedes
 * are updated in place.
 */
export async function logDecision(
  tenantId: string,
  input: { statement: string; decidedBy: PersonRef; source: SourceRef; decidedAt?: string; rationale?: string; projectId?: string; supersedesDecisionId?: string },
): Promise<Decision> {
  const norm = input.statement.trim().toLowerCase().replace(/\s+/g, ' ');
  const decisionId = `dec:${createHash('sha256').update(`${tenantId}:${input.source.contentHash}:${norm}`).digest('hex').slice(0, 24)}`;
  const existing = await decisions.get(decisionId);
  const ts = now();
  if (existing && existing.tenantId === tenantId) {
    const next: Decision = {
      ...existing,
      statement: input.statement,
      decidedBy: input.decidedBy,
      source: input.source,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.supersedesDecisionId !== undefined ? { supersedesDecisionId: input.supersedesDecisionId } : {}),
    };
    await decisions.put(next);
    return next;
  }
  const decision: Decision = {
    decisionId,
    tenantId,
    statement: input.statement,
    decidedAt: input.decidedAt ?? ts,
    decidedBy: input.decidedBy,
    source: input.source,
    createdAt: ts,
    ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.supersedesDecisionId !== undefined ? { supersedesDecisionId: input.supersedesDecisionId } : {}),
  };
  await decisions.put(decision);
  return decision;
}

// ─── Meetings ───────────────────────────────────────────────────────────────

export async function listMeetings(tenantId: string): Promise<Meeting[]> {
  return (await meetings.list())
    .filter((m) => m.tenantId === tenantId)
    .sort((a, b) => b.startAt.localeCompare(a.startAt));
}

export async function getMeeting(tenantId: string, meetingId: string): Promise<Meeting | null> {
  const m = await meetings.get(meetingId);
  return m && m.tenantId === tenantId ? m : null;
}

/** Idempotent by calendarEventId — a re-prep of the same event updates in place. */
export async function recordMeeting(
  tenantId: string,
  input: { calendarEventId: string; title: string; startAt: string; endAt?: string; attendees?: PersonRef[]; prepBriefRef?: string; transcriptKbDocId?: string },
): Promise<Meeting> {
  const meetingId = `mtg:${createHash('sha256').update(`${tenantId}:${input.calendarEventId}`).digest('hex').slice(0, 24)}`;
  const existing = await meetings.get(meetingId);
  if (existing && existing.tenantId === tenantId) {
    const next: Meeting = {
      ...existing,
      title: input.title,
      startAt: input.startAt,
      ...(input.endAt !== undefined ? { endAt: input.endAt } : {}),
      ...(input.attendees !== undefined ? { attendees: input.attendees } : {}),
      ...(input.prepBriefRef !== undefined ? { prepBriefRef: input.prepBriefRef } : {}),
      ...(input.transcriptKbDocId !== undefined ? { transcriptKbDocId: input.transcriptKbDocId } : {}),
    };
    await meetings.put(next);
    return next;
  }
  const meeting: Meeting = {
    meetingId,
    tenantId,
    calendarEventId: input.calendarEventId,
    title: input.title,
    startAt: input.startAt,
    attendees: input.attendees ?? [],
    decisionIds: [],
    commitmentIds: [],
    createdAt: now(),
    ...(input.endAt !== undefined ? { endAt: input.endAt } : {}),
    ...(input.prepBriefRef !== undefined ? { prepBriefRef: input.prepBriefRef } : {}),
    ...(input.transcriptKbDocId !== undefined ? { transcriptKbDocId: input.transcriptKbDocId } : {}),
  };
  await meetings.put(meeting);
  return meeting;
}

// ─── Stakeholders (overlay on a CRM contact) ────────────────────────────────

export async function listStakeholders(tenantId: string): Promise<StakeholderProfile[]> {
  return (await stakeholders.list())
    .filter((s) => s.tenantId === tenantId)
    .sort((a, b) => b.importance - a.importance);
}

export async function upsertStakeholder(
  tenantId: string,
  input: { person: PersonRef; importance?: number; intendedCadenceDays?: number; lastMeaningfulContactAt?: string; notes?: string },
): Promise<StakeholderProfile> {
  const stakeholderId = `stk:${createHash('sha256').update(`${tenantId}:${JSON.stringify(input.person)}`).digest('hex').slice(0, 24)}`;
  const existing = await stakeholders.get(stakeholderId);
  const ts = now();
  if (existing && existing.tenantId === tenantId) {
    const next: StakeholderProfile = {
      ...existing,
      updatedAt: ts,
      ...(input.importance !== undefined ? { importance: clamp(input.importance, 0, 100, existing.importance) } : {}),
      ...(input.intendedCadenceDays !== undefined ? { intendedCadenceDays: input.intendedCadenceDays } : {}),
      ...(input.lastMeaningfulContactAt !== undefined ? { lastMeaningfulContactAt: input.lastMeaningfulContactAt } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    };
    await stakeholders.put(next);
    return next;
  }
  const stakeholder: StakeholderProfile = {
    stakeholderId,
    tenantId,
    person: input.person,
    importance: clamp(input.importance, 0, 100, 50),
    createdAt: ts,
    updatedAt: ts,
    ...(input.intendedCadenceDays !== undefined ? { intendedCadenceDays: input.intendedCadenceDays } : {}),
    ...(input.lastMeaningfulContactAt !== undefined ? { lastMeaningfulContactAt: input.lastMeaningfulContactAt } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
  await stakeholders.put(stakeholder);
  return stakeholder;
}

// ─── Pending actions (drafts on the existing approval loop) ─────────────────

export async function listPendingActions(tenantId: string, status?: PendingActionStatus): Promise<PendingAction[]> {
  return (await pendingActions.list())
    .filter((a) => a.tenantId === tenantId)
    .filter((a) => (status ? a.status === status : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getPendingAction(tenantId: string, actionId: string): Promise<PendingAction | null> {
  const a = await pendingActions.get(actionId);
  return a && a.tenantId === tenantId ? a : null;
}

export async function enqueuePendingAction(
  tenantId: string,
  input: {
    kind: PendingActionKind;
    payload: Record<string, unknown>;
    draft: string;
    sourceCommitmentId?: string;
    riskLevel?: ActionRiskLevel;
    requiredScopes?: string[];
    reason?: string;
    sourceRefs?: SourceRef[];
    recipientDiff?: { before: string[]; after: string[] };
    derivedFromUntrusted?: boolean;
  },
): Promise<PendingAction> {
  const ts = now();
  // ADR 0027 — taint is computed from the cited sources unless the caller
  // already knows better; an explicit `true` is never downgraded.
  const tainted =
    input.derivedFromUntrusted === true ||
    (input.sourceRefs ?? []).some((s) => s.contentTrust === 'untrusted');
  const action: PendingAction = {
    actionId: `act:${randomUUID()}`,
    tenantId,
    kind: input.kind,
    payload: input.payload,
    draft: input.draft,
    status: 'pending',
    createdBy: 'assistant',
    createdAt: ts,
    updatedAt: ts,
    ...(input.sourceCommitmentId !== undefined ? { sourceCommitmentId: input.sourceCommitmentId } : {}),
    ...(input.riskLevel !== undefined ? { riskLevel: input.riskLevel } : {}),
    ...(input.requiredScopes !== undefined ? { requiredScopes: input.requiredScopes } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.sourceRefs !== undefined ? { sourceRefs: input.sourceRefs } : {}),
    ...(input.recipientDiff !== undefined ? { recipientDiff: input.recipientDiff } : {}),
    ...(tainted ? { derivedFromUntrusted: true } : {}),
  };
  await pendingActions.put(action);
  return action;
}

/**
 * Edit a still-pending action's draft/payload (ADR 0023 §12 T4). Only the
 * draft surface is editable — kind, sources, and taint are immutable (an edit
 * never launders provenance). Stamps `editedAt`/`editedByUserId` so the card
 * shows the approver they are approving an edited draft. Returns null when
 * the action is missing or no longer pending (a decided action is re-drafted,
 * not edited).
 */
export async function editPendingAction(
  tenantId: string,
  actionId: string,
  patch: { draft?: string; payload?: Record<string, unknown>; recipientDiff?: { before: string[]; after: string[] }; editedByUserId?: string },
): Promise<PendingAction | null> {
  const existing = await getPendingAction(tenantId, actionId);
  if (!existing || existing.status !== 'pending') return null;
  const next: PendingAction = {
    ...existing,
    updatedAt: now(),
    editedAt: now(),
    ...(patch.draft !== undefined ? { draft: patch.draft } : {}),
    ...(patch.payload !== undefined ? { payload: patch.payload } : {}),
    ...(patch.recipientDiff !== undefined ? { recipientDiff: patch.recipientDiff } : {}),
    ...(patch.editedByUserId !== undefined ? { editedByUserId: patch.editedByUserId } : {}),
  };
  await pendingActions.put(next);
  return next;
}

/**
 * ADR 0027 §4 — the ONE auto-allow eligibility predicate. When autonomy
 * expands (T6 execution policy, T7 "always allow under policy"), this is the
 * gate every caller consults: an action derived from untrusted connected
 * content, or rated high-risk, ALWAYS surfaces to a human — no policy can
 * promote it past the approval loop. Encoded here (not at call sites) so the
 * rule cannot drift between the execution and governance seams.
 */
export function isAutoAllowEligible(action: Pick<PendingAction, 'derivedFromUntrusted' | 'riskLevel'>): boolean {
  if (action.derivedFromUntrusted === true) return false;
  if (action.riskLevel === 'high') return false;
  return true;
}

/** Back-link the approval act onto the action row (set once at enqueue). */
export async function setPendingActionApproval(tenantId: string, actionId: string, approvalId: string): Promise<void> {
  const existing = await getPendingAction(tenantId, actionId);
  if (!existing) return;
  await pendingActions.put({ ...existing, approvalId, updatedAt: now() });
}

/** §12 T6 — record the dispatched execution run (set once by the winning claim). */
export async function setPendingActionExecution(tenantId: string, actionId: string, executionRunId: string): Promise<void> {
  const existing = await getPendingAction(tenantId, actionId);
  if (!existing) return;
  await pendingActions.put({ ...existing, executionRunId, updatedAt: now() });
}

/** Decide a pending action. Send/execution is the action layer's concern (later
 *  phase, behind the Connections write scopes); this records the decision only. */
export async function decidePendingAction(
  tenantId: string,
  actionId: string,
  decision: { status: Extract<PendingActionStatus, 'approved' | 'rejected' | 'sent' | 'failed'>; approvedByUserId?: string },
): Promise<PendingAction | null> {
  const existing = await getPendingAction(tenantId, actionId);
  if (!existing) return null;
  const next: PendingAction = {
    ...existing,
    status: decision.status,
    updatedAt: now(),
    ...(decision.approvedByUserId !== undefined ? { approvedByUserId: decision.approvedByUserId } : {}),
  };
  await pendingActions.put(next);
  return next;
}

// ─── test-only ──────────────────────────────────────────────────────────────

export async function __resetAssistantStore(): Promise<void> {
  await Promise.all([
    projects.__clear(),
    commitments.__clear(),
    commitmentsByTenant.__clear(),
    commitmentsByStatus.__clear(),
    decisions.__clear(),
    meetings.__clear(),
    stakeholders.__clear(),
    pendingActions.__clear(),
  ]);
}
