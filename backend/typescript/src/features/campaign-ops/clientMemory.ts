/**
 * ADR 0944 D4 — what enters a client's shared agent memory (`org:<orgId>`).
 *
 * Curated client notes are the one TRUSTED lane: a person with `workspace:write`
 * on the client writes them through the subject-memory note seam
 * (`addSubjectNote` on `orgSubject(orgId)`), so they are durable, recalled by
 * every agent working for that client, and never auto-evicted. An agent never
 * writes a trusted fact directly: it PROPOSES one, the proposal waits here
 * (untrusted, outside memory), and only a person's approval turns it into a note.
 *
 * Proposals are keyed `tenant::orgId::proposalId` and carry `orgId`, so
 * `deleteOrg` sees them (ADR 0944 M4). The id is derived from the proposing run
 * node and the text, so a crash-resume re-execution of the same node cannot add
 * a second proposal.
 *
 * @see docs/adr/0944-client-scoped-agent-memory.md
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { orgSubject } from '../../host/subject.js';
import { addSubjectNote, clearSubjectNotes, listSubjectNotes, removeSubjectNote, subjectMemoryScope, type SubjectNote } from '../../host/subjectMemory.js';
import { clearMemoryScope, listMemoryEntries } from '../../host/inMemorySurfaces.js';
import { MEMORY_UNTRUSTED_TAG } from '../../host/agentDispatch.js';
import { NOTE_TAG } from '../../host/subjectMemory.js';
import { purgeNamespaceVectors } from '../../host/vector/vectorTenantPurge.js';
import { deleteClientReadReceipts } from '../../host/memoryReadReceipts.js';
import { assertNoRetentionHold } from '../../host/retentionHold.js';
import { deleteClientContextRows } from './clientContext.js';
import { cleanString } from '../../host/boundedStrings.js';
import { OpenwopError } from '../../types.js';

export type ClientNoteProposalStatus = 'pending' | 'approving' | 'approved' | 'rejected';

export interface ClientNoteProposal {
  proposalId: string;
  tenantId: string;
  orgId: string;
  /** The proposed note text, as the agent wrote it. Untrusted until approved. */
  content: string;
  /** Why the agent proposes it (shown to the reviewer). Untrusted. */
  rationale?: string;
  /** Which run node proposed it. The run's acting person is not recorded here. */
  proposedBy: { agentId?: string; runId: string; nodeId: string };
  status: ClientNoteProposalStatus;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  /** The note the approval wrote. */
  noteId?: string;
}

const MAX_NOTE = 2000;
const MAX_RATIONALE = 1000;
/** Soft cap per client; in-progress approvals still count toward review load. */
export const MAX_PENDING_PROPOSALS = 50;

const keyOf = (tenantId: string, orgId: string, proposalId: string): string => `${tenantId}::${orgId}::${proposalId}`;
const proposals = new DurableCollection<ClientNoteProposal>(
  'campaign-ops:client-note-proposal',
  (p) => keyOf(p.tenantId, p.orgId, p.proposalId),
  undefined,
  (p) => p.tenantId,
);

const nowIso = (): string => new Date().toISOString();

export async function listClientNotes(tenantId: string, orgId: string): Promise<SubjectNote[]> {
  return listSubjectNotes(tenantId, orgSubject(orgId));
}

export async function addClientNote(tenantId: string, orgId: string, content: unknown, authoredBy: string): Promise<{ id: string }> {
  return addSubjectNote(tenantId, orgSubject(orgId), content, { source: 'user', contentTrust: 'trusted', authoredBy });
}

export async function removeClientNote(tenantId: string, orgId: string, noteId: string): Promise<{ removed: boolean; recallCleared: boolean }> {
  return removeSubjectNote(tenantId, orgSubject(orgId), noteId);
}

export async function listClientNoteProposals(tenantId: string, orgId: string, status?: ClientNoteProposalStatus): Promise<ClientNoteProposal[]> {
  const rows = await proposals.listByPrefix(`${tenantId}::${orgId}::`);
  return rows
    .filter((p) => p.tenantId === tenantId && p.orgId === orgId && (!status || p.status === status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getClientNoteProposal(tenantId: string, orgId: string, proposalId: string): Promise<ClientNoteProposal | null> {
  const p = await proposals.get(keyOf(tenantId, orgId, proposalId));
  return p && p.tenantId === tenantId && p.orgId === orgId ? p : null;
}

/** An agent proposes a client note. Idempotent per (run, node, text). */
export async function proposeClientNote(input: {
  tenantId: string;
  orgId: string;
  content: unknown;
  rationale?: unknown;
  proposedBy: { agentId?: string; runId: string; nodeId: string };
}): Promise<{ proposal: ClientNoteProposal; created: boolean }> {
  const raw = typeof input.content === 'string' ? input.content.trim() : '';
  const content = raw.length <= MAX_NOTE ? cleanString(raw, MAX_NOTE) : '';
  if (!content) throw new OpenwopError('validation_error', `\`content\` MUST be a non-empty string of at most ${MAX_NOTE} characters.`, 400, { field: 'content' });
  const rationale = typeof input.rationale === 'string' ? cleanString(input.rationale, MAX_RATIONALE) : '';
  const proposalId = `cnp_${createHash('sha256').update(`${input.proposedBy.runId}\u0000${input.proposedBy.nodeId}\u0000${content}`).digest('hex').slice(0, 24)}`;
  const existing = await getClientNoteProposal(input.tenantId, input.orgId, proposalId);
  if (existing) return { proposal: existing, created: false };
  if ((await listClientNoteProposals(input.tenantId, input.orgId)).filter((p) => p.status === 'pending' || p.status === 'approving').length >= MAX_PENDING_PROPOSALS) {
    throw new OpenwopError('rate_limited', 'This client already has the maximum number of note proposals waiting for review.', 429, { reason: 'too_many_pending_proposals', cap: MAX_PENDING_PROPOSALS });
  }
  const proposal: ClientNoteProposal = {
    proposalId, tenantId: input.tenantId, orgId: input.orgId, content,
    ...(rationale ? { rationale } : {}),
    proposedBy: input.proposedBy,
    status: 'pending',
    createdAt: nowIso(),
  };
  if (await proposals.compareAndSwap(null, proposal)) return { proposal, created: true };
  const winner = await getClientNoteProposal(input.tenantId, input.orgId, proposalId);
  if (!winner) throw new OpenwopError('conflict', 'The client note proposal could not be confirmed. Retry the proposal.', 409);
  return { proposal: winner, created: false };
}

/**
 * A person decides a pending proposal. The decision is claimed with a CAS on the
 * pending row first. The approving state survives a crash or lost write
 * acknowledgement; an authorized approval retry completes the SAME note write.
 * It cannot change the deciding person or turn a started approval into a reject.
 */
export async function decideClientNoteProposal(
  tenantId: string,
  orgId: string,
  proposalId: string,
  decision: 'approve' | 'reject',
  decidedBy: string,
): Promise<ClientNoteProposal> {
  let current = await getClientNoteProposal(tenantId, orgId, proposalId);
  if (!current) throw new OpenwopError('not_found', 'Proposal not found.', 404, { proposalId });
  if (current.status !== 'pending' && !(current.status === 'approving' && decision === 'approve')) {
    throw new OpenwopError('conflict', 'This proposal was already decided.', 409, { reason: 'already_decided', status: current.status });
  }
  if (current.status === 'pending') {
    const claim: ClientNoteProposal = { ...current, status: decision === 'approve' ? 'approving' : 'rejected', decidedBy, decidedAt: nowIso() };
    if (!(await proposals.compareAndSwap(current, claim))) {
      throw new OpenwopError('conflict', 'This proposal was already decided.', 409, { reason: 'already_decided' });
    }
    current = claim;
  }
  if (decision === 'reject') return current;
  if (!current.decidedBy) throw new OpenwopError('conflict', 'This approval has no recorded deciding person.', 409);
  const { id } = await addSubjectNote(tenantId, orgSubject(orgId), current.content, {
    source: 'user', contentTrust: 'trusted', authoredBy: current.decidedBy,
    idempotencyKey: `client-note-proposal:${proposalId}`,
  });
  const withNote: ClientNoteProposal = { ...current, status: 'approved', noteId: id };
  if (await proposals.compareAndSwap(current, withNote)) return withNote;
  const winner = await getClientNoteProposal(tenantId, orgId, proposalId);
  if (winner?.status === 'approved' && winner.noteId === id) return winner;
  throw new OpenwopError('conflict', 'The note was written but its approval needs confirmation. Retry approval.', 409);
}

/** DSAR (ADR 0464 ledger): the proposal is the client's; the decider goes. */
export async function eraseClientNoteProposalDeciders(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let touched = 0;
  for (const p of await proposals.listForTenantIndexed(tenantId)) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await getClientNoteProposal(tenantId, p.orgId, p.proposalId);
      if (!current?.decidedBy || !forms.has(current.decidedBy)) break;
      if (await proposals.compareAndSwap(current, { ...current, decidedBy: tombstone })) { touched += 1; break; }
      if (attempt === 5) throw new Error('Client note proposal decider erasure could not be confirmed.');
    }
  }
  return touched;
}

export interface ClientMemoryPurgeReport {
  notes: number;
  recallEntries: number;
  vectors: { purged: number; failed: string[] };
  receipts: number;
  proposals: number;
  snapshots: number;
  sources: number;
  /** False when a vector backend failed: the recall index may still hold rows. */
  complete: boolean;
}

/**
 * ADR 0944 D8 — client off-boarding: empty all three memory stores of one client
 * (durable notes, the recall working set, the vector namespace) plus its read
 * receipts, note proposals, context snapshots and knowledge designation. Refused
 * under a retention hold. Idempotent: a second run finds nothing. A vector
 * backend that fails is REPORTED (`complete:false`), never folded into success.
 */
export async function purgeClientMemory(tenantId: string, orgId: string): Promise<ClientMemoryPurgeReport> {
  if (!tenantId || !orgId) throw new OpenwopError('validation_error', 'tenant and client are required.', 400);
  await assertNoRetentionHold(tenantId);
  const subject = orgSubject(orgId);
  const scope = subjectMemoryScope(subject);
  const notes = await clearSubjectNotes(tenantId, subject);
  const recallEntries = await clearMemoryScope(tenantId, scope);
  const vec = await purgeNamespaceVectors(tenantId, scope);
  const receipts = await deleteClientReadReceipts(tenantId, orgId);
  let proposalsRemoved = 0;
  for (const p of await listClientNoteProposals(tenantId, orgId)) {
    if (await proposals.delete(keyOf(tenantId, orgId, p.proposalId))) proposalsRemoved += 1;
  }
  const ctx = await deleteClientContextRows(tenantId, orgId);
  return {
    notes, recallEntries, vectors: { purged: vec.purged, failed: vec.failed }, receipts,
    proposals: proposalsRemoved, snapshots: ctx.snapshots, sources: ctx.sources,
    complete: vec.failed.length === 0,
  };
}

/** The client's agent-written memory (turn summaries, never curated notes),
 *  newest first, for the panel's "what the agents remember" list. */
export async function listClientRecall(tenantId: string, orgId: string, limit = 50): Promise<Array<{ id: string; content: string; contentTrust: 'trusted' | 'untrusted'; createdAt: string; expiresAt?: string }>> {
  const rows = await listMemoryEntries(tenantId, subjectMemoryScope(orgSubject(orgId)), { limit: 500 });
  return rows
    .filter((r) => !r.tags.includes(NOTE_TAG))
    .slice(0, limit)
    .map((r) => ({ id: r.id, content: r.content, contentTrust: r.tags.includes(MEMORY_UNTRUSTED_TAG) ? 'untrusted' as const : 'trusted' as const, createdAt: r.createdAt, ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}) }));
}
