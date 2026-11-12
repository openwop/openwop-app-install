/**
 * ADR 1092 D2 — memory writes a person approves. An agent proposes a project
 * memory fact (`openwop:projects.memory.propose`); it is not memory until a
 * person with write access approves it on the Memory tab, which adds it as a
 * project note. Proposals are a project's dependents (deleted with it) and
 * name people, so they have a subject eraser.
 *
 * Follows the propose → review → apply shape of ADR 0473: nothing an agent
 * writes reaches durable project memory without a person.
 */

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { addSubjectNote } from '../../host/subjectMemory.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { ERASED, ERASED_USER_REF, subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { registerSubjectDependent } from '../../host/subjectDependents.js';
import { projectSubject, type Project } from './projectsService.js';

export const PROPOSAL_TEXT_MAX = 1000;
/** Pending proposals a project holds at once; older ones must be decided first. */
export const PROPOSALS_PENDING_CAP = 20;
/** Decided proposals kept for the record. */
export const PROPOSALS_DECIDED_KEPT = 50;

export type ProposalStatus = 'pending' | 'approved' | 'dismissed';
export interface MemoryProposal {
  key: string; tenantId: string; projectId: string; proposalId: string;
  text: string;
  /** The person whose turn proposed it (`user:<id>`), and the agent or run that wrote it. */
  createdBy: string; proposer: string;
  proposedAt: string; status: ProposalStatus;
  decidedBy?: string; decidedAt?: string;
}

const store = new DurableCollection<MemoryProposal>('projects:memory-proposal', (r) => r.key, undefined, (r) => r.tenantId);
const prefixOf = (tenantId: string, projectId: string): string => createHash('sha256').update(`${tenantId}\n${projectId}`).digest('hex').slice(0, 24);
const bad = (message: string, field: string): OpenwopError => new OpenwopError('validation_error', message, 400, { field });

async function listFor(tenantId: string, projectId: string): Promise<MemoryProposal[]> {
  return (await store.listByPrefix(`${prefixOf(tenantId, projectId)}:`))
    .filter((r) => r.tenantId === tenantId && r.projectId === projectId)
    .sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
}

/** Pending first, then the most recent decided, for the Memory tab. Call behind the project read gate. */
export async function listMemoryProposals(tenantId: string, projectId: string): Promise<MemoryProposal[]> {
  const all = await listFor(tenantId, projectId);
  return [...all.filter((r) => r.status === 'pending'), ...all.filter((r) => r.status !== 'pending').slice(0, PROPOSALS_DECIDED_KEPT)];
}

/** D2 — file a proposal. Call behind the project read gate, for the acting person. */
export async function proposeProjectMemory(args: { tenantId: string; project: Project; text: unknown; createdBy: string; proposer: string }): Promise<MemoryProposal> {
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  if (!text) throw bad('Write the fact to remember.', 'text');
  if (text.length > PROPOSAL_TEXT_MAX) throw bad(`A memory is at most ${PROPOSAL_TEXT_MAX} characters.`, 'text');
  const all = await listFor(args.tenantId, args.project.id);
  // Keep the record bounded: decided proposals past PROPOSALS_DECIDED_KEPT are dropped (newest kept).
  for (const r of all.filter((x) => x.status !== 'pending').slice(PROPOSALS_DECIDED_KEPT)) await store.delete(r.key);
  const pending = all.filter((r) => r.status === 'pending');
  if (pending.some((r) => r.text === text)) return pending.find((r) => r.text === text)!; // the same fact once
  if (pending.length >= PROPOSALS_PENDING_CAP) throw new OpenwopError('conflict', `This project already has ${PROPOSALS_PENDING_CAP} memory proposals waiting for review.`, 409, { reason: 'pending_cap' });
  const proposalId = randomUUID().slice(0, 12);
  const row: MemoryProposal = {
    key: `${prefixOf(args.tenantId, args.project.id)}:${proposalId}`, tenantId: args.tenantId, projectId: args.project.id, proposalId,
    text, createdBy: args.createdBy, proposer: args.proposer.slice(0, 120), proposedAt: new Date().toISOString(), status: 'pending',
  };
  await store.put(row);
  return row;
}

/** D2 — approve (adds the project note) or dismiss. Call behind the project WRITE gate. */
export async function decideMemoryProposal(args: { tenantId: string; projectId: string; proposalId: string; decision: 'approve' | 'dismiss'; actor: string }): Promise<MemoryProposal> {
  const key = `${prefixOf(args.tenantId, args.projectId)}:${args.proposalId}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await store.get(key);
    if (!cur || cur.tenantId !== args.tenantId || cur.projectId !== args.projectId) throw new OpenwopError('not_found', 'There is no such memory proposal on this project.', 404, { proposalId: args.proposalId });
    if (cur.status !== 'pending') throw new OpenwopError('conflict', `This proposal was already ${cur.status}.`, 409, { reason: 'already_decided', status: cur.status });
    const next: MemoryProposal = { ...cur, status: args.decision === 'approve' ? 'approved' : 'dismissed', decidedBy: args.actor, decidedAt: new Date().toISOString() };
    if (await store.compareAndSwap(cur, next)) {
      // The note is written only after the decision is recorded, so a retry can't add it twice.
      // If the note fails, the decision is undone so the proposal isn't left "approved" with no memory.
      if (next.status === 'approved') {
        try { await addSubjectNote(args.tenantId, projectSubject(args.projectId), cur.text); }
        catch (err) { await store.compareAndSwap(next, cur).catch(() => undefined); throw err; }
      }
      return next;
    }
  }
  throw new OpenwopError('conflict', 'The proposal changed while you were deciding. Try again.', 409, { reason: 'cas_exhausted' });
}

/** Subject erasure: the person behind a proposal or its decision loses their name; an undecided
 *  proposal loses its text and is dismissed, so nobody can approve an erased fact into memory. */
async function eraseMemoryProposals(tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  const { forms } = subjectKeyForms(subjectKey);
  const is = (ref?: string): boolean => !!ref && (forms.has(ref) || (ref.startsWith('user:user:') && forms.has(ref.slice('user:'.length))));
  let touched = 0;
  for (const r of await store.listForTenantIndexed(tenantId)) {
    if (r.tenantId !== tenantId || (!is(r.createdBy) && !is(r.decidedBy))) continue;
    await store.put({ ...r, createdBy: is(r.createdBy) ? ERASED_USER_REF : r.createdBy, ...(r.decidedBy ? { decidedBy: is(r.decidedBy) ? ERASED_USER_REF : r.decidedBy } : {}), ...(is(r.createdBy) && r.status === 'pending' ? { text: ERASED, status: 'dismissed' as const, decidedBy: ERASED_USER_REF, decidedAt: new Date().toISOString() } : {}) });
    touched++;
  }
  return { rowsTouched: touched };
}

export function registerMemoryProposalLifecycle(): void {
  registerSubjectEraser(eraseMemoryProposals);
  // ADR 0839 D2 — a project's proposals go with it.
  registerSubjectDependent('project', 'memoryProposals', {
    count: async (tenantId, subject) => (await listFor(tenantId, subject.id)).length,
    purge: async (tenantId, subject) => {
      let n = 0;
      for (const r of await listFor(tenantId, subject.id)) { await store.delete(r.key); n++; }
      return n;
    },
  });
}
