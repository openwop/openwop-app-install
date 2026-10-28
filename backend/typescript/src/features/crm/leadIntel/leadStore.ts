/**
 * ADR 0954 D2/D3 — the lead's client binding (`LeadProfile`) and its grade
 * projection (`LeadGrade`).
 *
 * A contact row is tenant-wide (gap L1), so a lead belongs to a client only
 * through its profile, keyed `tenant::orgId::contactId`. A contact belongs to AT
 * MOST ONE client: a reverse row keyed `tenant::contactId`, inserted with
 * compare-and-swap, refuses a second binding (409), so one person's lead can
 * never be graded under two clients' models.
 *
 * The grade row is a sortable PROJECTION of a grading run (the run is the
 * provenance). It is written only through `recordLeadGrade`, which applies the
 * ADR 0837 A7 rule: the dispatch stamps `pendingRunId` first, and only the run it
 * names may write, so an older run or a `:fork` (a run id nobody stamped) is
 * `superseded` and changes nothing. Every row carries `orgId` (deleteOrg sees it).
 */
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import type { Band } from './model.js';
import type { SignalId } from './signals.js';
import type { RoutingDecision } from './routing.js';
import type { LeadAssessment } from './assessment.js';
import type { StatedSubmission } from './statedAnswers.js';
import type { EvidenceItem } from './evidence.js';
import { getContact } from '../contactsService.js';
import { randomUUID } from 'node:crypto';
import { ERASED, subjectKeyForms } from '../../../host/subjectErasureRedaction.js';
import { currentErasureRequest } from '../../../host/subjectErasure.js';
import { isErasureTombstoned, tombstoneId, tombstoneKeyForms, writeErasureTombstone } from '../../consent/consentService.js';

export interface GradeReservationPin {
  /** The same primary reservation may admit the trusted qualification chain. */
  qualification?: true;
  bindingId: string;
  modelId: string;
  modelVersion: number;
  modelHash: string;
  definitionHash: string;
  /** Tenant-salted requester receipt, not a raw subject. */
  requesterHash: string;
  /** A distinct keyed request may not adopt another request's in-flight run. */
  requestKeyHash?: string;
  /** Present only for the client routing chain; freezes its exact round. */
  routingEpoch?: number;
  parentRoutingEpoch?: number;
  parentRunId?: string;
  excludeOwnerHashes?: string[];
}

export type LeadStatus = 'new' | 'working' | 'closed';
export const LEAD_SOURCES = ['form', 'funnel', 'widget', 'campaign', 'import', 'manual'] as const;
export type LeadSource = typeof LEAD_SOURCES[number];

export interface LeadProfile {
  tenantId: string;
  orgId: string;
  contactId: string;
  source: LeadSource;
  status: LeadStatus;
  boundBy: string;
  /** ADR 0954 D5 — the assigned owner (an opaque subject), set by routing. */
  owner?: string;
  /** True when routing found no eligible owner: the client's unassigned queue. */
  unassigned?: boolean;
  /** Bumped by each routing dispatch; the routing ledger keys on it. */
  routingEpoch?: number;
  /** Last round whose decision and assignment committed on this primary. */
  assignedRoutingEpoch?: number;
  createdAt: string;
  updatedAt: string;
}

export interface LeadGrade {
  tenantId: string;
  orgId: string;
  contactId: string;
  modelId?: string;
  modelVersion?: number;
  modelHash?: string;
  score?: number;
  band?: Band;
  parts?: Partial<Record<SignalId, { raw: number; weighted: number }>>;
  /** sha256 of the signal inputs the grade was computed from. */
  inputsDigest?: string;
  truncated?: boolean;
  /** ADR 0954 P4 — the assessment run whose answers fed `qualifier.*` signals. */
  assessmentRunId?: string;
  /** The run that WROTE the current grade. */
  runId?: string;
  computedAt?: string;
  /** The run the latest dispatch stamped; only it may write (ADR 0837 A7). */
  pendingRunId?: string;
  pendingAt?: string;
}

const key = (tenantId: string, orgId: string, contactId: string): string => `${tenantId}::${orgId}::${contactId}`;

interface AttributionReceipt { operation: string; subjectHashes: string[] }
type StoredProfile = LeadProfile & {
  bindingId?: string; closed?: true; attributionPending?: AttributionReceipt; routingHistory?: RoutingDecision[];
  routingReservation?: { runId: string; pin: GradeReservationPin };
  routingAttributionPending?: AttributionReceipt;
};
interface LeadOwner { tenantId: string; contactId: string; orgId?: string; bindingId?: string; closed?: true; statedSubmissions?: StatedSubmission[] }
const profiles = new DurableCollection<StoredProfile>('crm:lead-profile', (p) => key(p.tenantId, p.orgId, p.contactId), undefined, (p) => p.tenantId);
const owners = new DurableCollection<LeadOwner>(
  'crm:lead-profile-of', (o) => `${o.tenantId}::${o.contactId}`, undefined, (o) => o.tenantId,
);
export interface QualificationRead { runId: string; pin: GradeReservationPin; evidence: EvidenceItem[]; createdAt: string }
type StoredGrade = LeadGrade & { pendingPin?: GradeReservationPin; closed?: true; assessments?: LeadAssessment[]; qualificationReads?: QualificationRead[] };
const grades = new DurableCollection<StoredGrade>('crm:lead-grade', (g) => key(g.tenantId, g.orgId, g.contactId), undefined, (g) => g.tenantId);

const publicGrade = ({ pendingPin: _pin, closed: _closed, assessments: _assessments, qualificationReads: _reads, ...row }: StoredGrade): LeadGrade => row;
const publicProfile = ({ bindingId: _binding, closed: _closed, attributionPending: _receipt, routingHistory: _routing, routingReservation: _start, routingAttributionPending: _subjects, ...row }: StoredProfile): LeadProfile => row;
const MAX_ROUTING_ROUNDS = 256;
const MAX_ROUTING_HISTORY_BYTES = 1024 * 1024;
const routingSubjects = (decision: RoutingDecision): string[] => [...new Set([
  ...(decision.chosen ? [decision.chosen] : []), ...decision.candidates, ...decision.skipped.map((skip) => skip.subject),
])].filter((subject) => subject !== ERASED);

async function liveContact(tenantId: string, contactId: string): Promise<boolean> {
  const contact = await getContact(contactId);
  return !!contact && contact.tenantId === tenantId && !contact.mergedInto && !(await isErasureTombstoned(tenantId, contactId));
}

const nowIso = (): string => new Date().toISOString();

async function storedLeadProfile(tenantId: string, orgId: string, contactId: string): Promise<StoredProfile | null> {
  const p = await profiles.get(key(tenantId, orgId, contactId));
  const owner = await owners.get(`${tenantId}::${contactId}`);
  return p && !p.closed && p.tenantId === tenantId && p.orgId === orgId && p.contactId === contactId
    && owner?.tenantId === tenantId && !owner.closed && p.bindingId === owner.bindingId
    && owner.contactId === contactId && owner.orgId === orgId && await liveContact(tenantId, contactId) ? p : null;
}

/** Public projection never becomes an expected row for a primary CAS. */
export async function getLeadProfile(tenantId: string, orgId: string, contactId: string): Promise<LeadProfile | null> {
  const row = await storedLeadProfile(tenantId, orgId, contactId);
  return row ? publicProfile(row) : null;
}

async function storedProfilesForOrg(tenantId: string, orgId: string): Promise<StoredProfile[]> {
  const out: StoredProfile[] = [];
  for (const p of await profiles.listByPrefix(`${tenantId}::${orgId}::`)) {
    const live = await storedLeadProfile(tenantId, orgId, p.contactId);
    if (live) out.push(live);
  }
  return out;
}

export async function listLeadProfiles(tenantId: string, orgId: string): Promise<LeadProfile[]> {
  return (await storedProfilesForOrg(tenantId, orgId)).map(publicProfile);
}

/** Internal capacity view includes whether the primary still authorizes a
 * pending assignment, without exposing its reservation or private history. */
export async function listLeadRoutingCapacityProfiles(tenantId: string, orgId: string): Promise<Array<Pick<LeadProfile, 'contactId' | 'owner' | 'status' | 'routingEpoch' | 'assignedRoutingEpoch'> & { pending: boolean }>> {
  return (await storedProfilesForOrg(tenantId, orgId)).map((row) => ({
    contactId: row.contactId, owner: row.owner, status: row.status, routingEpoch: row.routingEpoch,
    assignedRoutingEpoch: row.assignedRoutingEpoch, pending: !!row.routingReservation && row.routingReservation.pin.routingEpoch === row.routingEpoch,
  }));
}

/** Bind a contact to a client. Idempotent for the same client; 409 when the
 *  contact already belongs to another client. */
export async function bindLead(input: { tenantId: string; orgId: string; contactId: string; source: LeadSource; boundBy: string }): Promise<{ profile: LeadProfile; created: boolean }> {
  const { tenantId, orgId, contactId } = input;
  if (!(await liveContact(tenantId, contactId))) throw new OpenwopError('not_found', 'Contact not found.', 404, { contactId });
  // A missing legacy reverse marker cannot grant a second client ownership.
  for (const p of await profiles.listByPrefix(`${tenantId}::`)) {
    if (p.tenantId === tenantId && p.contactId === contactId && (p.closed || p.orgId !== orgId)) {
      throw new OpenwopError('conflict', 'This contact is already a lead of another client.', 409, { reason: 'lead_bound_to_other_client' });
    }
  }
  let owner: LeadOwner | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = (await owners.get(`${tenantId}::${contactId}`)) ?? null;
    if (existing && (existing.closed || existing.tenantId !== tenantId || existing.contactId !== contactId || (existing.orgId !== undefined && existing.orgId !== orgId))) {
      throw new OpenwopError('conflict', 'This contact is already a lead of another client.', 409, { reason: 'lead_bound_to_other_client' });
    }
    if (existing?.orgId === orgId) { owner = existing; break; }
    const next: LeadOwner = { ...existing, tenantId, contactId, orgId, bindingId: existing?.bindingId ?? randomUUID() };
    if (await owners.compareAndSwap(existing, next)) { owner = next; break; }
    // A failed claim with no recorded winner is uncertainty, not authority to
    // manufacture another binding. Preserve the P1 fail-closed contract.
    if (!(await owners.get(`${tenantId}::${contactId}`))) throw new OpenwopError('conflict', 'Lead ownership could not be confirmed. Retry.', 409, { contactId });
  }
  if (!owner) throw new OpenwopError('conflict', 'Lead ownership changed. Retry.', 409, { contactId });
  // Adopt a legacy receipt by CAS; a lost claim or erased receipt grants nothing.
  if (!owner.bindingId) {
    const adopted = { ...owner, bindingId: randomUUID() };
    if (!(await owners.compareAndSwap(owner, adopted))) throw new OpenwopError('conflict', 'Lead binding changed. Retry.', 409, { contactId });
    owner = adopted;
  }
  const current = await profiles.get(key(tenantId, orgId, contactId));
  if (current) {
    if (current.closed || (current.bindingId !== undefined && current.bindingId !== owner.bindingId)) throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
    if (!current.bindingId && !(await profiles.compareAndSwap(current, { ...current, bindingId: owner.bindingId }))) {
      throw new OpenwopError('conflict', 'Lead binding changed. Retry.', 409, { contactId });
    }
    const live = await getLeadProfile(tenantId, orgId, contactId);
    if (!live) throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
    return { profile: live, created: false };
  }
  const ts = nowIso();
  // The initial primary publication carries hashes only. Erasure can fence this
  // exact receipt before any delayed CAS can publish the binder's raw subject.
  const receipt: AttributionReceipt = { operation: randomUUID(), subjectHashes: tombstoneKeyForms(input.boundBy).map((form) => tombstoneId(tenantId, form)) };
  const profile: StoredProfile = { tenantId, orgId, contactId, bindingId: owner.bindingId, source: input.source, status: 'new', boundBy: ERASED, createdAt: ts, updatedAt: ts, attributionPending: receipt };
  const created = await profiles.compareAndSwap(null, profile);
  if (created) {
    let attributable = true;
    for (const form of tombstoneKeyForms(input.boundBy)) {
      if (await isErasureTombstoned(tenantId, form)) attributable = false;
    }
    if (attributable) {
      const { attributionPending: _pending, ...attributed } = profile;
      await profiles.compareAndSwap(profile, { ...attributed, boundBy: input.boundBy });
    }
  }
  const winner = await getLeadProfile(tenantId, orgId, contactId);
  if (!winner) throw new OpenwopError('conflict', 'Lead binding could not be confirmed. Retry.', 409, { contactId });
  return { profile: winner, created };
}

/** The client org a contact is bound to as a lead (ADR 0954 D3), if any. */
export async function leadOrgOf(tenantId: string, contactId: string): Promise<string | null> {
  const o = await owners.get(`${tenantId}::${contactId}`);
  return o && o.tenantId === tenantId ? o.orgId ?? null : null;
}

export async function getLeadGrade(tenantId: string, orgId: string, contactId: string): Promise<LeadGrade | null> {
  const g = await grades.get(key(tenantId, orgId, contactId));
  return g && !g.closed && g.tenantId === tenantId && g.orgId === orgId && await getLeadProfile(tenantId, orgId, contactId) ? publicGrade(g) : null;
}

/** Visitor claims remain separate immutable submissions; knowing an email
 * cannot overwrite another visitor's statements. The same closure CAS erases
 * them even when the contact has not yet been bound to any client. */
export async function readLeadStatedSubmissions(tenantId: string, contactId: string): Promise<StatedSubmission[]> {
  const owner = await owners.get(`${tenantId}::${contactId}`);
  return owner && !owner.closed && owner.tenantId === tenantId && await liveContact(tenantId, contactId) ? owner.statedSubmissions ?? [] : [];
}

export async function commitLeadStatedSubmission(tenantId: string, contactId: string, submission: StatedSubmission): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await liveContact(tenantId, contactId))) return;
    const owner = (await owners.get(`${tenantId}::${contactId}`)) ?? null;
    if (owner?.closed) return;
    const existing = owner?.statedSubmissions?.find((s) => s.submissionId === submission.submissionId);
    if (existing) {
      if (JSON.stringify(existing.answers) !== JSON.stringify(submission.answers)) throw new OpenwopError('conflict', 'This visitor submission is already recorded.', 409, { reason: 'submission_immutable' });
      return;
    }
    const statedSubmissions = [...owner?.statedSubmissions ?? [], submission];
    if (statedSubmissions.length > 64 || Buffer.byteLength(JSON.stringify(statedSubmissions)) > 256 * 1024) {
      throw new OpenwopError('conflict', 'The visitor submission history is full. Existing submissions were retained.', 409, { reason: 'submission_history_full' });
    }
    if (await owners.compareAndSwap(owner, { ...owner, tenantId, contactId, statedSubmissions })) return;
  }
  throw new OpenwopError('conflict', 'The contact changed while its answers were saved. Retry.', 409, {});
}

export async function deleteLeadStatedSubmissions(tenantId: string, contactId: string): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const owner = await owners.get(`${tenantId}::${contactId}`);
    if (!owner?.statedSubmissions?.length) return 0;
    const { statedSubmissions, ...next } = owner;
    if (await owners.compareAndSwap(owner, next)) return statedSubmissions.length;
  }
  throw new Error('lead_stated_answers_erasure_conflict');
}

export async function listLeadGrades(tenantId: string, orgId: string): Promise<LeadGrade[]> {
  const out: LeadGrade[] = [];
  for (const g of await grades.listByPrefix(`${tenantId}::${orgId}::`)) {
    const live = await getLeadGrade(tenantId, orgId, g.contactId);
    if (live) out.push(live);
  }
  return out;
}

/** Assessments share the grade primary and its permanent closure fence. A
 * delayed publication cannot recreate erased content in a companion store. */
export async function readLeadAssessments(tenantId: string, orgId: string, contactId: string): Promise<LeadAssessment[]> {
  const grade = await grades.get(key(tenantId, orgId, contactId));
  return grade && !grade.closed && grade.tenantId === tenantId && grade.orgId === orgId
    && await getLeadProfile(tenantId, orgId, contactId) ? grade.assessments ?? [] : [];
}

const sameGradePin = (a: GradeReservationPin, b: GradeReservationPin): boolean => Object.keys(a).length === Object.keys(b).length
  && Object.entries(a).every(([field, value]) => JSON.stringify(b[field as keyof GradeReservationPin]) === JSON.stringify(value));
const qualificationBytes = (grade: StoredGrade): number => Buffer.byteLength(JSON.stringify({ reads: grade.qualificationReads ?? [], assessments: grade.assessments ?? [] }));

export async function getQualificationRead(tenantId: string, orgId: string, contactId: string, runId: string): Promise<QualificationRead | null> {
  const grade = await grades.get(key(tenantId, orgId, contactId));
  if (!grade || grade.closed || !(await getLeadProfile(tenantId, orgId, contactId))) return null;
  const read = grade.qualificationReads?.find((r) => r.runId === runId);
  return read && read.pin.bindingId === await getLeadBindingId(tenantId, orgId, contactId) ? read : null;
}

/** Freeze raw evidence on an erasable primary; events contain hashes only. */
export async function freezeQualificationRead(tenantId: string, orgId: string, contactId: string, runId: string, pin: GradeReservationPin, evidence: EvidenceItem[]): Promise<QualificationRead | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await getLeadProfile(tenantId, orgId, contactId))) return null;
    const grade = await grades.get(key(tenantId, orgId, contactId));
    if (!grade || grade.closed || grade.pendingRunId !== runId || !grade.pendingPin?.qualification || !sameGradePin(grade.pendingPin, pin)) return null;
    const existing = grade.qualificationReads?.find((r) => r.runId === runId);
    if (existing) return sameGradePin(existing.pin, pin) ? existing : null;
    const read: QualificationRead = { runId, pin, evidence, createdAt: nowIso() };
    const next: StoredGrade = { ...grade, qualificationReads: [...grade.qualificationReads ?? [], read] };
    if (next.qualificationReads!.length > 256 || qualificationBytes(next) > 1024 * 1024) {
      throw new OpenwopError('conflict', 'The qualification history is full. Existing records were retained.', 409, { reason: 'qualification_history_full' });
    }
    if (await grades.compareAndSwap(grade, next)) return read;
  }
  throw new OpenwopError('conflict', 'The lead changed while its evidence was frozen. Retry.', 409, {});
}

export async function commitLeadAssessment(assessment: LeadAssessment, pin: GradeReservationPin): Promise<{ outcome: 'recorded' | 'replayed' | 'superseded'; assessment: LeadAssessment | null }> {
  const { tenantId, orgId, contactId, runId } = assessment;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await getLeadProfile(tenantId, orgId, contactId))) return { outcome: 'superseded', assessment: null };
    const grade = await grades.get(key(tenantId, orgId, contactId));
    const owner = await owners.get(`${tenantId}::${contactId}`);
    if (!grade || grade.closed || !owner || owner.closed || owner.bindingId !== pin.bindingId) return { outcome: 'superseded', assessment: null };
    const existing = grade.assessments?.find((a) => a.runId === runId);
    if (existing) return { outcome: 'replayed', assessment: existing };
    const read = grade.qualificationReads?.find((r) => r.runId === runId);
    if (grade.pendingRunId !== runId || !grade.pendingPin?.qualification || !sameGradePin(grade.pendingPin, pin) || !read || !sameGradePin(read.pin, pin)
      || assessment.modelId !== pin.modelId || assessment.modelVersion !== pin.modelVersion || assessment.modelHash !== pin.modelHash) {
      return { outcome: 'superseded', assessment: null };
    }
    const assessments = [...grade.assessments ?? [], assessment];
    if (assessments.length > 256 || qualificationBytes({ ...grade, assessments }) > 1024 * 1024) {
      throw new OpenwopError('conflict', 'The assessment history is full. Existing assessments were retained.', 409, { reason: 'assessment_history_full' });
    }
    if (await grades.compareAndSwap(grade, { ...grade, assessments })) return { outcome: 'recorded', assessment };
  }
  throw new OpenwopError('conflict', 'The lead changed while its assessment was saved. Retry.', 409, { contactId });
}

export async function deleteLeadAssessments(tenantId: string, orgId: string, contactId: string): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const grade = await grades.get(key(tenantId, orgId, contactId));
    if (!grade || grade.closed || !grade.assessments?.length) return 0;
    const { assessments, assessmentRunId: _assessmentRunId, ...next } = grade;
    if (await grades.compareAndSwap(grade, next)) return assessments.length;
  }
  throw new Error('lead_assessment_erasure_conflict');
}

export async function getPendingGrade(tenantId: string, orgId: string, contactId: string): Promise<{ runId: string; pin: GradeReservationPin } | null> {
  if (!(await getLeadProfile(tenantId, orgId, contactId))) return null;
  const row = await grades.get(key(tenantId, orgId, contactId));
  const owner = await owners.get(`${tenantId}::${contactId}`);
  return row && !row.closed && row.tenantId === tenantId && row.orgId === orgId && row.contactId === contactId
    && !owner?.closed && owner?.bindingId === row.pendingPin?.bindingId && row.pendingRunId && row.pendingPin
    ? { runId: row.pendingRunId, pin: row.pendingPin } : null;
}

export async function getLeadBindingId(tenantId: string, orgId: string, contactId: string): Promise<string> {
  const profile = await getLeadProfile(tenantId, orgId, contactId);
  if (!profile) throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
  const current = await owners.get(`${tenantId}::${contactId}`);
  if (current && !current.closed && current.orgId === orgId && current.bindingId) return current.bindingId;
  await bindLead({ tenantId, orgId, contactId, source: profile.source, boundBy: profile.boundBy });
  const owner = await owners.get(`${tenantId}::${contactId}`);
  if (!owner || owner.closed || owner.orgId !== orgId || !owner.bindingId) throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
  return owner.bindingId;
}

/** Persist the complete dispatch pin before starting. The prior projection is
 * kept for display; failed starts only clear their own current reservation. */
export async function stampPendingGrade(tenantId: string, orgId: string, contactId: string, runId: string, pin: GradeReservationPin): Promise<LeadGrade | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!(await getLeadProfile(tenantId, orgId, contactId))) throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
    const owner = await owners.get(`${tenantId}::${contactId}`);
    if (!owner || owner.closed || !pin.bindingId || owner.bindingId !== pin.bindingId) throw new OpenwopError('not_found', 'Lead binding not found.', 404, { contactId });
    const existing = (await grades.get(key(tenantId, orgId, contactId))) ?? null;
    if (existing?.closed) throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
    const next: StoredGrade = { ...(existing ?? { tenantId, orgId, contactId }), pendingRunId: runId, pendingAt: nowIso(), pendingPin: pin };
    if (await grades.compareAndSwap(existing, next)) return existing ? publicGrade(existing) : null;
  }
  throw new OpenwopError('conflict', 'This lead kept changing while its grading was started. Try again.', 409, { contactId });
}

/** Release a definitively unstarted reservation. Never restore older authority. */
export async function restorePendingGrade(tenantId: string, orgId: string, contactId: string, runId: string, _previous?: LeadGrade | null): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await grades.get(key(tenantId, orgId, contactId));
    if (!existing || existing.pendingRunId !== runId) return;
    const { pendingRunId: _run, pendingAt: _at, pendingPin: _pin, ...next } = existing;
    if (await grades.compareAndSwap(existing, next)) return;
  }
  throw new OpenwopError('conflict', 'The pending grade could not be released. Retry.', 409, { contactId });
}

/** Write a grade, only for the run the row's `pendingRunId` names. */
export async function recordLeadGrade(
  tenantId: string, orgId: string, contactId: string, runId: string,
  grade: Required<Pick<LeadGrade, 'modelId' | 'modelVersion' | 'modelHash' | 'score' | 'band' | 'parts' | 'inputsDigest' | 'truncated'>> & Pick<LeadGrade, 'assessmentRunId'>,
  bindingId: string,
): Promise<'recorded' | 'superseded'> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!(await getLeadProfile(tenantId, orgId, contactId))) return 'superseded';
    const existing = await grades.get(key(tenantId, orgId, contactId));
    const owner = await owners.get(`${tenantId}::${contactId}`);
    if (!existing || existing.closed || !owner || owner.closed || !bindingId || owner.bindingId !== bindingId || existing.pendingPin?.bindingId !== bindingId || existing.pendingRunId !== runId) return 'superseded';
    if (!existing.pendingPin || existing.pendingPin.modelId !== grade.modelId || existing.pendingPin.modelVersion !== grade.modelVersion || existing.pendingPin.modelHash !== grade.modelHash) {
      throw new OpenwopError('forbidden_scope', 'The grade does not match the dispatch model.', 403, { reason: 'model_pin_mismatch' });
    }
    const { pendingRunId: _run, pendingAt: _at, pendingPin: _pin, assessmentRunId: _oldAssessmentRunId, ...settled } = existing;
    // Routing's grading step is not the end of its dispatch. Keep the SAME
    // reservation until routing commits, so a route retry cannot manufacture
    // another epoch after grading but before assignment.
    const next: StoredGrade = {
      ...settled, ...grade, runId, computedAt: nowIso(),
      ...(existing.pendingPin.routingEpoch !== undefined ? { pendingRunId: existing.pendingRunId, pendingAt: existing.pendingAt, pendingPin: existing.pendingPin } : {}),
    };
    if (await grades.compareAndSwap(existing, next)) return 'recorded';
  }
  throw new OpenwopError('conflict', 'This lead kept changing while its grade was recorded. Re-grade it.', 409, { contactId });
}

/** Close admission first, then fence even ABSENT companion rows by primary CAS.
 * The marker is permanent: a delayed writer cannot recreate erased authority. */
export async function closeLeadBinding(tenantId: string, contactId: string): Promise<void> {
  const request = currentErasureRequest();
  const dsarHash = tombstoneId(tenantId, request?.tenantId === tenantId ? request.requestedKey : contactId);
  await writeErasureTombstone(tenantId, contactId, dsarHash);
  let closed: LeadOwner | null = null;
  for (let n = 0; n < 5; n++) {
    const current = (await owners.get(`${tenantId}::${contactId}`)) ?? null;
    if (current?.closed) { closed = current; break; }
    const { statedSubmissions: _stated, ...identity } = current ?? { tenantId, contactId };
    const next: LeadOwner = { ...identity, closed: true, bindingId: current?.bindingId ?? randomUUID() };
    if (await owners.compareAndSwap(current, next)) { closed = next; break; }
  }
  if (!closed) throw new Error('lead_binding_close_conflict');
  const orgs = new Set<string>(closed.orgId ? [closed.orgId] : []);
  for (const store of [profiles, grades] as const) {
    for (const row of await store.listByPrefix(`${tenantId}::`)) {
      if (row.tenantId === tenantId && row.contactId === contactId) orgs.add(row.orgId);
    }
  }
  for (const orgId of orgs) {
    let done = false;
    for (let n = 0; n < 5; n++) {
      const row = (await profiles.get(key(tenantId, orgId, contactId))) ?? null;
      if (row?.closed) { done = true; break; }
      const fence: StoredProfile = { tenantId, orgId, contactId, bindingId: closed.bindingId, closed: true, source: 'manual', status: 'closed', boundBy: ERASED, createdAt: '', updatedAt: '' };
      if (await profiles.compareAndSwap(row, fence)) { done = true; break; }
    }
    if (!done) throw new Error('lead_profile_close_conflict');
    done = false;
    for (let n = 0; n < 5; n++) {
      const row = (await grades.get(key(tenantId, orgId, contactId))) ?? null;
      if (row?.closed) { done = true; break; }
      if (await grades.compareAndSwap(row, { tenantId, orgId, contactId, closed: true })) { done = true; break; }
    }
    if (!done) throw new Error('lead_grade_close_conflict');
  }
}

/** Point receipt first; legacy orphan companions are reached by tenant prefix. */
export async function hasLeadBinding(tenantId: string, contactId: string): Promise<boolean> {
  const owner = await owners.get(`${tenantId}::${contactId}`);
  if (owner?.tenantId === tenantId && owner.contactId === contactId) return true;
  for (const store of [profiles, grades] as const) {
    if ((await store.listByPrefix(`${tenantId}::`)).some((row) => row.tenantId === tenantId && row.contactId === contactId)) return true;
  }
  return false;
}

/** Binder attribution is reached independently of contact membership and indexes. */
export async function eraseLeadAttribution(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const forms = [...new Set([...subjectKeyForms(subjectKey).forms].flatMap(tombstoneKeyForms))];
  const hashes = new Set(forms.map((form) => tombstoneId(tenantId, form)));
  const request = currentErasureRequest();
  const dsarHash = tombstoneId(tenantId, request?.tenantId === tenantId ? request.requestedKey : subjectKey);
  for (const form of forms) await writeErasureTombstone(tenantId, form, dsarHash);
  for (const observed of await profiles.listByPrefix(`${tenantId}::`)) {
    if (observed.tenantId !== tenantId) continue;
    let done = false;
    for (let n = 0; n < 5; n++) {
      const row = await profiles.get(key(tenantId, observed.orgId, observed.contactId));
      if (!row || row.closed) { done = true; break; }
      const matches = (subject: string): boolean => tombstoneKeyForms(subject).some((form) => forms.includes(form));
      const binder = matches(row.boundBy) || row.attributionPending?.subjectHashes.some((hash) => hashes.has(hash));
      const routing = (row.owner && matches(row.owner)) || row.routingAttributionPending?.subjectHashes.some((hash) => hashes.has(hash))
        || row.routingHistory?.some((decision) => routingSubjects(decision).some(matches));
      if (!binder && !routing) { done = true; break; }
      const next: StoredProfile = { ...row };
      if (binder) { next.boundBy = ERASED; delete next.attributionPending; }
      if (routing) {
        if (next.owner && matches(next.owner)) { delete next.owner; next.unassigned = true; }
        delete next.routingAttributionPending;
        if (next.routingHistory) next.routingHistory = next.routingHistory.map((decision) => ({
          ...decision, chosen: decision.chosen && matches(decision.chosen) ? ERASED : decision.chosen,
          candidates: decision.candidates.map((subject) => matches(subject) ? ERASED : subject),
          skipped: decision.skipped.map((skip) => matches(skip.subject) ? { ...skip, subject: ERASED } : skip),
        }));
      }
      if (await profiles.compareAndSwap(row, next)) { done = true; break; }
    }
    if (!done) throw new Error('lead_attribution_erase_conflict');
  }
}

/** ADR 0954 D5 — start a new routing round for a lead: its epoch + 1 (CAS). */
export async function getPendingLeadRoute(tenantId: string, orgId: string, contactId: string): Promise<{ runId: string; pin: GradeReservationPin } | null> {
  return (await storedLeadProfile(tenantId, orgId, contactId))?.routingReservation ?? null;
}

/** Reserve one frozen route on the primary that owns the epoch. No independent
 * read/bump/stamp window can replace a newer round with an older start. */
export async function reserveLeadRoute(tenantId: string, orgId: string, contactId: string, runId: string, pin: GradeReservationPin, parent?: { routingEpoch: number; runId: string }): Promise<{ runId: string; pin: GradeReservationPin }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const profile = await storedLeadProfile(tenantId, orgId, contactId);
    if (!profile || profile.bindingId !== pin.bindingId) throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
    if (parent) {
      const source = profile.routingHistory?.find((d) => d.routingEpoch === parent.routingEpoch);
      const excluded = source?.chosen ? [tombstoneId(tenantId, source.chosen)] : [];
      if (!source?.chosen || source.runId !== parent.runId || pin.parentRoutingEpoch !== parent.routingEpoch || pin.parentRunId !== parent.runId
        || JSON.stringify(pin.excludeOwnerHashes ?? []) !== JSON.stringify(excluded)) throw new OpenwopError('conflict', 'The reroute source changed.', 409, { reason: 'routing_superseded' });
      const existing = profile.routingReservation;
      if (existing?.runId === runId && existing.pin.parentRunId === parent.runId && existing.pin.parentRoutingEpoch === parent.routingEpoch
        && existing.pin.requesterHash === pin.requesterHash && JSON.stringify(existing.pin.excludeOwnerHashes ?? []) === JSON.stringify(excluded)) return existing;
      if (profile.routingEpoch !== parent.routingEpoch) throw new OpenwopError('conflict', 'A newer routing round owns this lead.', 409, { reason: 'routing_superseded' });
      if (existing && existing.runId !== parent.runId) throw new OpenwopError('conflict', 'Another routing start owns this lead.', 409, { reason: 'routing_start_pending' });
    } else if (profile.routingReservation) throw new OpenwopError('conflict', 'A routing start for this lead is already pending. Retry.', 409, { reason: 'routing_start_pending' });
    if ((profile.routingHistory?.length ?? 0) >= MAX_ROUTING_ROUNDS) throw new OpenwopError('conflict', 'This lead has reached the routing history limit.', 409, { reason: 'routing_history_full' });
    const routingEpoch = (profile.routingEpoch ?? 0) + 1;
    if (!Number.isSafeInteger(routingEpoch) || routingEpoch <= 0) throw new OpenwopError('conflict', 'The routing epoch cannot advance.', 409, { reason: 'invalid_routing_epoch' });
    const reservation = { runId, pin: { ...pin, routingEpoch } };
    if (await profiles.compareAndSwap(profile, { ...profile, routingEpoch, routingReservation: reservation, updatedAt: nowIso() })) return reservation;
  }
  throw new OpenwopError('conflict', 'This lead kept changing while routing was started. Retry.', 409, { contactId });
}

export async function releaseLeadRoute(tenantId: string, orgId: string, contactId: string, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const profile = await storedLeadProfile(tenantId, orgId, contactId);
    if (!profile || profile.routingReservation?.runId !== runId) return;
    const { routingReservation: _start, ...next } = profile;
    if (await profiles.compareAndSwap(profile, next)) return;
  }
  throw new OpenwopError('conflict', 'The routing reservation could not be released. Retry.', 409, { contactId });
}

export async function bumpRoutingEpoch(tenantId: string, orgId: string, contactId: string): Promise<number>;
export async function bumpRoutingEpoch(tenantId: string, orgId: string, contactId: string, from: number): Promise<number | null>;
export async function bumpRoutingEpoch(tenantId: string, orgId: string, contactId: string, from?: number): Promise<number | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = await storedLeadProfile(tenantId, orgId, contactId);
    if (!p) throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
    if (from !== undefined && (p.routingEpoch ?? 0) !== from) return null;
    const epoch = (p.routingEpoch ?? 0) + 1;
    if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new OpenwopError('conflict', 'The routing epoch cannot advance.', 409, { reason: 'invalid_routing_epoch' });
    if (await profiles.compareAndSwap(p, { ...p, routingEpoch: epoch, updatedAt: nowIso() })) return epoch;
  }
  throw new OpenwopError('conflict', 'This lead kept changing while it was being routed. Try again.', 409, { contactId });
}

/** History is private to the one live client binding. Closing the profile
 * removes its authority and provenance together, including a delayed CAS. */
export async function getLeadRoutingDecision(tenantId: string, orgId: string, contactId: string, epoch: number): Promise<RoutingDecision | null> {
  const profile = await storedLeadProfile(tenantId, orgId, contactId);
  return profile?.routingHistory?.find((decision) => decision.routingEpoch === epoch) ?? null;
}

/** The chosen owner and the record explaining that owner are ONE primary write.
 * A lost acknowledgement is reconciled from this row, never from a side ledger
 * that could have landed before the assignment. */
export async function commitLeadRoutingDecision(decision: RoutingDecision): Promise<{ decision: RoutingDecision; replayed: boolean }> {
  const { tenantId, orgId, contactId, routingEpoch } = decision;
  for (let attempt = 0; attempt < 4; attempt++) {
    const profile = await storedLeadProfile(tenantId, orgId, contactId);
    if (!profile) throw new OpenwopError('not_found', 'Lead not found.', 404, { contactId });
    const recorded = profile.routingHistory?.find((row) => row.routingEpoch === routingEpoch);
    if (recorded) return { decision: recorded, replayed: true };
    if ((profile.routingEpoch ?? 0) !== routingEpoch || profile.routingReservation?.runId !== decision.runId) {
      throw new OpenwopError('conflict', 'This run no longer owns routing for this lead.', 409, { reason: 'routing_superseded' });
    }
    const history = [...(profile.routingHistory ?? []), decision];
    if (history.length > MAX_ROUTING_ROUNDS || Buffer.byteLength(JSON.stringify(history), 'utf8') > MAX_ROUTING_HISTORY_BYTES) {
      throw new OpenwopError('conflict', 'This lead has reached the routing history limit.', 409, { reason: 'routing_history_full' });
    }
    const subjects = routingSubjects(decision);
    const receipt: AttributionReceipt = { operation: randomUUID(), subjectHashes: [...new Set(subjects.flatMap((subject) => tombstoneKeyForms(subject).map((form) => tombstoneId(tenantId, form))))] };
    const staged: StoredProfile = { ...profile, routingAttributionPending: receipt };
    if (!(await profiles.compareAndSwap(profile, staged))) continue;
    for (const subject of subjects) {
      for (const form of tombstoneKeyForms(subject)) {
        if (await isErasureTombstoned(tenantId, form)) throw new OpenwopError('conflict', 'A routing participant was erased. Refresh the policy and retry.', 409, { reason: 'routing_subject_erased' });
      }
    }
    const { owner: _old, unassigned: _unassigned, routingAttributionPending: _receipt, ...rest } = staged;
    const next: StoredProfile = {
      ...rest,
      ...(decision.chosen ? { owner: decision.chosen, status: profile.status === 'new' ? 'working' : profile.status } : { unassigned: true }),
      assignedRoutingEpoch: routingEpoch,
      routingHistory: history,
      updatedAt: nowIso(),
    };
    if (await profiles.compareAndSwap(staged, next)) return { decision, replayed: false };
  }
  throw new OpenwopError('conflict', 'This lead kept changing while its routing was recorded. Retry.', 409, { contactId });
}
