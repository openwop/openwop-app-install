/**
 * ADR 0831 P1 — the team intent ledger store.
 *
 * One ledger per project. The version moves ONLY through an accepted delta, and
 * accepts are serialized by compare-and-swap on the ledger row, so the version
 * log is linear. Every accepted delta stores the full resulting state, so "the
 * state at version N" is a lookup (`stateAt`) — the run stamp in P2 depends on it.
 *
 * `goal`/`objectives` are the project CHARTER's (ADR 0054). They are validated
 * with the charter's own `parseCharter` and written back through `updateProject`
 * with `origin: 'ledger'`, so the charter stays their only home.
 *
 * @see docs/adr/0831-team-intent-ledger.md
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { ERASED, subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { cleanOpaqueToken } from '../../host/boundedStrings.js';
import { scrubSecretShaped } from '../../host/redactSecrets.js';
import { OpenwopError } from '../../types.js';
import { getProject, updateProject, type Project } from '../projects/projectsService.js';
import { getDocument } from '../documents/documentsService.js';
import type { LedgerPatch, LedgerState, TeamLedger, TeamLedgerDelta } from './types.js';

declarePiiFields('teamLedger.delta', ['why']);

const ledgers = new DurableCollection<TeamLedger>('team-ledger:ledgers', (l) => `${l.tenantId}:project:${l.scope.id}`, undefined, (l) => l.tenantId);
const deltas = new DurableCollection<TeamLedgerDelta>('team-ledger:deltas', (d) => d.deltaId, undefined, (d) => d.tenantId);

/** ADR 0831 D1 (item 4 groundwork) — the version each person last looked at, per
 *  ledger. Server-side, so "what changed since you last looked" follows the person
 *  across devices, and a re-sync checkpoint can count what each person has not seen. */
export interface LedgerSeen { tenantId: string; ledgerId: string; subject: string; version: number; seenAt: string }
const seenKey = (tenantId: string, ledgerId: string, subject: string): string => `${tenantId}:${ledgerId}:${subject}`;
const seen = new DurableCollection<LedgerSeen>('team-ledger:seen', (r) => seenKey(r.tenantId, r.ledgerId, r.subject), undefined, (r) => r.tenantId);

export const LEDGER_LIMITS = {
  listItems: 50,
  line: 300,
  why: 500,
  // The charter's own caps (ADR 0054 `parseCharter`): goal 200, 20 objectives of 200.
  goal: 200,
  objectives: 20,
  objective: 200,
  /** Proposals waiting for the owner, per ledger (XCH-TL-1: a looping agent must not flood the queue). */
  pending: 50,
} as const;
const MAX_ITEMS = LEDGER_LIMITS.listItems;
const CAS_TRIES = 5;
const nowIso = (): string => new Date().toISOString();

const LIST_FIELDS = ['openQuestions', 'inScope', 'outOfScope'] as const;

/** Validate a proposed patch. Unknown keys are refused, not dropped: a typo must not read as "no change". */
export async function validatePatch(raw: unknown, project: Project): Promise<LedgerPatch> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenwopError('validation_error', '`patch` must be an object.', 400, { field: 'patch' });
  }
  const r = raw as Record<string, unknown>;
  const allowed = new Set(['goal', 'objectives', ...LIST_FIELDS, 'decisionDocumentIds', 'toolPolicy']);
  const unknownKey = Object.keys(r).find((k) => !allowed.has(k));
  if (unknownKey) throw new OpenwopError('validation_error', `\`patch.${unknownKey}\` is not a ledger field.`, 400, { field: `patch.${unknownKey}` });
  const out: LedgerPatch = {};

  // XCH-TL-1 — REFUSE, never rewrite. A silent truncation, coercion, secret
  // scrub or empty-item drop was reported back to the model as success while
  // storing something it never sent; a refusal it can repair is honest.
  if ('goal' in r) out.goal = strictText(r.goal, LEDGER_LIMITS.goal, 'patch.goal');
  if ('objectives' in r) out.objectives = strictList(r.objectives, LEDGER_LIMITS.objectives, LEDGER_LIMITS.objective, 'patch.objectives');
  for (const f of LIST_FIELDS) {
    if (f in r) out[f] = strictList(r[f], LEDGER_LIMITS.listItems, LEDGER_LIMITS.line, `patch.${f}`);
  }
  if ('decisionDocumentIds' in r) {
    const v = r.decisionDocumentIds;
    if (!Array.isArray(v) || v.length > MAX_ITEMS) {
      throw new OpenwopError('validation_error', `\`patch.decisionDocumentIds\` must be an array of at most ${MAX_ITEMS} ids.`, 400, { field: 'patch.decisionDocumentIds' });
    }
    const ids: string[] = [];
    for (const [i, x] of v.entries()) {
      const id = cleanOpaqueToken(x, 128);
      // A reference must resolve to a decision record in THIS project's org (ADR 0233 §C8).
      const doc = id ? await getDocument(project.tenantId, project.orgId, id) : null;
      if (!doc || doc.kind !== 'decision-record') {
        throw new OpenwopError('validation_error', `\`patch.decisionDocumentIds[${i}]\` is not a decision record in this project's workspace.`, 400, { field: 'patch.decisionDocumentIds', index: i });
      }
      ids.push(id);
    }
    out.decisionDocumentIds = [...new Set(ids)];
  }
  if ('toolPolicy' in r) out.toolPolicy = strictToolPolicy(r.toolPolicy);
  if (Object.keys(out).length === 0) throw new OpenwopError('validation_error', '`patch` changes nothing.', 400, { field: 'patch' });
  return out;
}

/** A required, bounded, non-secret string — refused (never rewritten) when it is not. */
/** ADR 0856 D1 — a tool policy: ONLY `forbidden` and `requireApproval` (there is
 *  no allow list, so a ledger can never enable a tool); each a full replacement
 *  list of ADR 0132 tool ids / prefixes, refused (never rewritten) when bad. */
const TOOL_ID = /^[A-Za-z0-9:._*-]{1,128}$/;
function strictToolPolicy(raw: unknown): { forbidden: string[]; requireApproval: string[] } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenwopError('validation_error', '`patch.toolPolicy` must be an object with `forbidden` and `requireApproval` lists.', 400, { field: 'patch.toolPolicy' });
  }
  const p = raw as Record<string, unknown>;
  const extra = Object.keys(p).find((k) => k !== 'forbidden' && k !== 'requireApproval');
  if (extra) throw new OpenwopError('validation_error', `\`patch.toolPolicy.${extra}\` is not allowed: a team ledger can only forbid tools or require approval for them.`, 400, { field: `patch.toolPolicy.${extra}` });
  const list = (x: unknown, f: string): string[] => {
    if (!Array.isArray(x)) throw new OpenwopError('validation_error', `\`${f}\` must be an array of tool ids.`, 400, { field: f });
    if (x.length > MAX_ITEMS) throw new OpenwopError('validation_error', `\`${f}\` has ${x.length} items; the limit is ${MAX_ITEMS}.`, 400, { field: f, limit: MAX_ITEMS });
    return [...new Set(x.map((t, i) => {
      if (typeof t !== 'string' || !TOOL_ID.test(t)) throw new OpenwopError('validation_error', `\`${f}[${i}]\` is not a tool id or prefix.`, 400, { field: `${f}[${i}]` });
      return t;
    }))];
  };
  return { forbidden: list(p.forbidden, 'patch.toolPolicy.forbidden'), requireApproval: list(p.requireApproval, 'patch.toolPolicy.requireApproval') };
}

export function strictText(raw: unknown, max: number, field: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new OpenwopError('validation_error', `\`${field}\` must be a non-empty string.`, 400, { field });
  }
  const t = raw.trim();
  if (t.length > max) throw new OpenwopError('validation_error', `\`${field}\` is ${t.length} characters; the limit is ${max}.`, 400, { field, limit: max });
  if (scrubSecretShaped(t) !== t) {
    throw new OpenwopError('validation_error', `\`${field}\` contains a secret-shaped token (an API key or a 40+ character unbroken blob). Remove or break it up; it will not be stored or rewritten.`, 400, { field });
  }
  return t;
}

/** A full replacement list of strict strings. `[]` is allowed: it clears the list on purpose. */
function strictList(raw: unknown, maxItems: number, maxLen: number, field: string): string[] {
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', `\`${field}\` must be an array of strings (it replaces the whole list).`, 400, { field });
  if (raw.length > maxItems) throw new OpenwopError('validation_error', `\`${field}\` has ${raw.length} items; the limit is ${maxItems}.`, 400, { field, limit: maxItems });
  return raw.map((x, i) => strictText(x, maxLen, `${field}[${i}]`));
}

export function cleanWhy(raw: unknown): string {
  return strictText(raw, LEDGER_LIMITS.why, 'why');
}

/**
 * XCH-TL-1 — the version the author read. REQUIRED and checked, never filled in:
 * defaulting a missing or forged value to the current version made every
 * proposal look fresh and switched off the stale-base guard in `acceptDelta`.
 */
export function requireBaseVersion(raw: unknown, current: number): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > current) {
    throw new OpenwopError('validation_error', `\`baseVersion\` must be the ledger version you read (an integer from 1 to ${current}). Read the ledger first.`, 400, { field: 'baseVersion', current });
  }
  return raw;
}

/** The current state: the ledger's fields plus the charter's goal/objectives. */
export function currentState(ledger: TeamLedger, project: Project): LedgerState {
  return {
    ...(project.charter?.goal ? { goal: project.charter.goal } : {}),
    objectives: project.charter?.objectives ?? [],
    openQuestions: ledger.openQuestions,
    inScope: ledger.inScope,
    outOfScope: ledger.outOfScope,
    decisionDocumentIds: ledger.decisionDocumentIds,
    ...(ledger.toolPolicy ? { toolPolicy: ledger.toolPolicy } : {}),
  };
}

function applyPatch(state: LedgerState, patch: LedgerPatch): LedgerState {
  return { ...state, ...patch };
}

export async function getLedger(tenantId: string, projectId: string): Promise<TeamLedger | null> {
  const l = await ledgers.get(`${tenantId}:project:${projectId}`);
  return l && l.tenantId === tenantId ? l : null;
}

export async function findLedgerById(tenantId: string, ledgerId: string): Promise<TeamLedger | null> {
  return (await ledgers.listForTenantIndexed(tenantId)).find((l) => l.ledgerId === ledgerId && l.tenantId === tenantId) ?? null;
}

export async function getDelta(tenantId: string, deltaId: string): Promise<TeamLedgerDelta | null> {
  const d = await deltas.get(deltaId);
  return d && d.tenantId === tenantId ? d : null;
}

export async function listDeltas(tenantId: string, ledgerId: string): Promise<TeamLedgerDelta[]> {
  return (await deltas.listForTenantIndexed(tenantId))
    .filter((d) => d.ledgerId === ledgerId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The state a run stamped at `version` acted on. Null when no accepted delta produced it. */
export async function stateAt(tenantId: string, ledgerId: string, version: number): Promise<LedgerState | null> {
  const d = (await listDeltas(tenantId, ledgerId)).find((x) => x.status === 'accepted' && x.resultVersion === version);
  return d?.resultState ?? null;
}

/** Create the project's ledger at version 1 (an accepted creation delta). One per project. */
export async function createLedger(project: Project, owner: string): Promise<TeamLedger> {
  const at = nowIso();
  const ledger: TeamLedger = {
    ledgerId: `tl_${randomUUID()}`, tenantId: project.tenantId, scope: { kind: 'project', id: project.id },
    ownerSubject: owner, version: 1, openQuestions: [], inScope: [], outOfScope: [], decisionDocumentIds: [],
    createdAt: at, updatedAt: at,
  };
  if (!(await ledgers.putIfAbsent(ledger))) {
    throw new OpenwopError('conflict', 'This project already has a team ledger.', 409, { projectId: project.id });
  }
  await deltas.put({
    deltaId: `tld_${randomUUID()}`, ledgerId: ledger.ledgerId, tenantId: project.tenantId, status: 'accepted',
    patch: {}, why: 'Ledger created', author: { kind: 'user', id: owner }, baseVersion: 0,
    resultVersion: 1, resultState: currentState(ledger, project), decidedBy: owner, decidedAt: at, createdAt: at,
  });
  return ledger;
}

export async function proposeDelta(args: {
  ledger: TeamLedger; patch: LedgerPatch; why: string;
  author: TeamLedgerDelta['author']; source?: TeamLedgerDelta['source']; baseVersion?: number;
}): Promise<TeamLedgerDelta> {
  const waiting = (await listDeltas(args.ledger.tenantId, args.ledger.ledgerId)).filter((d) => d.status === 'proposed').length;
  if (waiting >= LEDGER_LIMITS.pending) {
    throw new OpenwopError('conflict', `This ledger already has ${waiting} proposals waiting for the owner. Ask them to review the queue first.`, 409, { pending: waiting, limit: LEDGER_LIMITS.pending });
  }
  const delta: TeamLedgerDelta = {
    deltaId: `tld_${randomUUID()}`, ledgerId: args.ledger.ledgerId, tenantId: args.ledger.tenantId, status: 'proposed',
    patch: args.patch, why: args.why, author: args.author, ...(args.source ? { source: args.source } : {}),
    baseVersion: args.baseVersion ?? args.ledger.version, createdAt: nowIso(),
  };
  await deltas.put(delta);
  await announceLedgerChanged(args.ledger);
  return delta;
}

/**
 * Accept a proposed delta: claim the next version by CAS on the ledger row, then
 * write `goal`/`objectives` to the charter (`origin: 'ledger'`). A stale base is
 * refused unless the owner says `rebased`.
 */
export async function acceptDelta(project: Project, deltaId: string, decidedBy: string, opts: { rebased?: boolean } = {}): Promise<{ ledger: TeamLedger; delta: TeamLedgerDelta }> {
  const delta = await getDelta(project.tenantId, deltaId);
  if (!delta) throw new OpenwopError('not_found', 'Delta not found.', 404, { deltaId });
  if (delta.status !== 'proposed') throw new OpenwopError('conflict', `This change is already ${delta.status}.`, 409, { deltaId, status: delta.status });

  for (let i = 0; i < CAS_TRIES; i++) {
    const ledger = await getLedger(project.tenantId, project.id);
    if (!ledger || ledger.ledgerId !== delta.ledgerId) throw new OpenwopError('not_found', 'Ledger not found.', 404, {});
    const stale = delta.baseVersion < ledger.version;
    if (stale && !opts.rebased) {
      throw new OpenwopError('conflict', 'The ledger changed since this was proposed. Review what changed, then accept with `rebased: true`.', 409, { baseVersion: delta.baseVersion, currentVersion: ledger.version });
    }
    const fresh = await getProject(project.tenantId, project.id);
    if (!fresh) throw new OpenwopError('not_found', 'Project not found.', 404, {});
    const resultState = applyPatch(currentState(ledger, fresh), delta.patch);
    const at = nowIso();
    const next: TeamLedger = {
      ...ledger, version: ledger.version + 1, updatedAt: at,
      openQuestions: resultState.openQuestions, inScope: resultState.inScope,
      outOfScope: resultState.outOfScope, decisionDocumentIds: resultState.decisionDocumentIds,
      ...(resultState.toolPolicy ? { toolPolicy: resultState.toolPolicy } : {}),
    };
    if (!(await ledgers.compareAndSwap(ledger, next))) continue; // a concurrent accept won; re-read
    if ('goal' in delta.patch || 'objectives' in delta.patch) {
      await updateProject(fresh.tenantId, fresh.id, {
        charter: { ...(fresh.charter ?? {}), ...(delta.patch.goal !== undefined ? { goal: delta.patch.goal } : {}), ...(delta.patch.objectives !== undefined ? { objectives: delta.patch.objectives } : {}) },
      }, { actor: decidedBy, origin: 'ledger' });
    }
    const decided: TeamLedgerDelta = {
      ...delta, status: 'accepted', resultVersion: next.version, resultState, decidedBy, decidedAt: at,
      ...(stale ? { rebased: true } : {}),
    };
    await deltas.put(decided);
    await announceLedgerChanged(next);
    return { ledger: next, delta: decided };
  }
  throw new OpenwopError('conflict', 'The ledger is being changed by someone else; try again.', 409, {});
}

export async function rejectDelta(tenantId: string, deltaId: string, decidedBy: string): Promise<TeamLedgerDelta> {
  const delta = await getDelta(tenantId, deltaId);
  if (!delta) throw new OpenwopError('not_found', 'Delta not found.', 404, { deltaId });
  if (delta.status !== 'proposed') throw new OpenwopError('conflict', `This change is already ${delta.status}.`, 409, { deltaId, status: delta.status });
  const decided: TeamLedgerDelta = { ...delta, status: 'rejected', decidedBy, decidedAt: nowIso() };
  await deltas.put(decided);
  return decided;
}

/** Transfer ownership (the current owner only — enforced by the route). */
export async function setOwner(ledger: TeamLedger, owner: string): Promise<TeamLedger> {
  const next = { ...ledger, ownerSubject: owner, updatedAt: nowIso() };
  if (!(await ledgers.compareAndSwap(ledger, next))) throw new OpenwopError('conflict', 'The ledger changed; try again.', 409, {});
  return next;
}

/**
 * A DIRECT charter edit (`PATCH /projects/:id`) that changed goal/objectives is
 * recorded as an accepted delta, so the version never skips a change. Called by
 * the projects charter listener; `origin: 'ledger'` writes never reach here.
 */
export async function recordCharterEdit(project: Project, before: { goal?: string; objectives?: string[] } | undefined, actor: string | undefined): Promise<void> {
  const patch: LedgerPatch = {};
  const after = project.charter;
  if ((before?.goal ?? undefined) !== (after?.goal ?? undefined) && after?.goal) patch.goal = after.goal;
  if (JSON.stringify(before?.objectives ?? []) !== JSON.stringify(after?.objectives ?? [])) patch.objectives = after?.objectives ?? [];
  if (Object.keys(patch).length === 0) return;
  for (let i = 0; i < CAS_TRIES; i++) {
    const ledger = await getLedger(project.tenantId, project.id);
    if (!ledger) return;
    const at = nowIso();
    const next: TeamLedger = { ...ledger, version: ledger.version + 1, updatedAt: at };
    if (!(await ledgers.compareAndSwap(ledger, next))) continue;
    await deltas.put({
      deltaId: `tld_${randomUUID()}`, ledgerId: ledger.ledgerId, tenantId: project.tenantId, status: 'accepted',
      patch, why: 'Edited directly on the project charter', author: { kind: 'user', id: actor ?? 'unknown' },
      source: { kind: 'charter-edit', ref: project.id }, baseVersion: ledger.version,
      resultVersion: next.version, resultState: currentState(next, project), decidedBy: actor ?? 'unknown', decidedAt: at, createdAt: at,
    });
    return;
  }
}

/**
 * DSAR (ADR 0464 taxonomy). The ledger is a shared record and stays; what the
 * subject authored is redacted in place: their deltas' `why`, their identity as
 * author/decider, and ownership. Patch text a subject proposed is redacted too —
 * it is their free text — but an ACCEPTED patch's effect lives on in later
 * states, which belong to the project.
 */
export async function eraseTeamLedgerSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  // The subject's own last-seen rows carry nothing the project needs: delete them.
  for (const r of await seen.listForTenantIndexed(tenantId)) {
    if (r.tenantId === tenantId && forms.has(r.subject)) await seen.delete(seenKey(r.tenantId, r.ledgerId, r.subject));
  }
  for (const l of await ledgers.listForTenantIndexed(tenantId)) {
    if (l.tenantId === tenantId && forms.has(l.ownerSubject)) await ledgers.put({ ...l, ownerSubject: ERASED, updatedAt: nowIso() });
  }
  for (const d of await deltas.listForTenantIndexed(tenantId)) {
    if (d.tenantId !== tenantId) continue;
    const authored = forms.has(d.author.id);
    const decided = d.decidedBy !== undefined && forms.has(d.decidedBy);
    if (!authored && !decided) continue;
    const next: TeamLedgerDelta = { ...d };
    if (authored) {
      next.author = { ...d.author, id: ERASED };
      next.why = ERASED;
      if (d.status !== 'accepted') next.patch = {};
    }
    if (decided) next.decidedBy = ERASED;
    await deltas.put(next);
  }
}

export function registerTeamLedgerErasure(): void {
  registerSubjectEraser(eraseTeamLedgerSubject);
}


/** ADR 0839 D2 — the ledger row plus its deltas for one project (0 when none). */
export async function countLedgerRowsForProject(tenantId: string, projectId: string): Promise<number> {
  const ledger = await getLedger(tenantId, projectId);
  return ledger ? 1 + (await listDeltas(tenantId, ledger.ledgerId)).length + (await seenRows(tenantId, ledger.ledgerId)).length : 0;
}

/** ADR 0839 D2 — delete a project's ledger and every delta of it, as part of the
 *  project delete (registered on the `subjectDependents` seam). Deltas first, so a
 *  failure midway leaves the ledger row — the only handle on them — in place for the
 *  retry. Tenant-qualified throughout. Returns the rows deleted. */
export async function deleteLedgerForProject(tenantId: string, projectId: string): Promise<number> {
  const ledger = await getLedger(tenantId, projectId);
  if (!ledger) return 0;
  let n = 0;
  for (const d of await listDeltas(tenantId, ledger.ledgerId)) { if (await deltas.delete(d.deltaId)) n += 1; }
  for (const r of await seenRows(tenantId, ledger.ledgerId)) { if (await seen.delete(seenKey(r.tenantId, r.ledgerId, r.subject))) n += 1; }
  if (await ledgers.delete(`${tenantId}:project:${projectId}`)) n += 1;
  return n;
}

export async function seenRows(tenantId: string, ledgerId: string): Promise<LedgerSeen[]> {
  return (await seen.listForTenantIndexed(tenantId)).filter((r) => r.tenantId === tenantId && r.ledgerId === ledgerId);
}

/** The version this person last marked seen on this ledger, or null. */
export async function getSeenVersion(tenantId: string, ledgerId: string, subject: string): Promise<number | null> {
  const r = await seen.get(seenKey(tenantId, ledgerId, subject));
  return r && r.tenantId === tenantId ? r.version : null;
}

/** Mark a version seen. Bounded to the ledger's real versions and never moves
 *  backward (a stale tab must not resurface changes the person already saw). */
export async function markSeenVersion(ledger: TeamLedger, subject: string, raw: unknown): Promise<number> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > ledger.version) {
    throw new OpenwopError('validation_error', `\`version\` must be a ledger version (an integer from 1 to ${ledger.version}).`, 400, { field: 'version', current: ledger.version });
  }
  const prior = await getSeenVersion(ledger.tenantId, ledger.ledgerId, subject);
  const version = prior !== null && prior > raw ? prior : raw;
  await seen.put({ tenantId: ledger.tenantId, ledgerId: ledger.ledgerId, subject, version, seenAt: nowIso() });
  return version;
}

/** ADR 0855 D3 — after a proposal or an accept, the re-sync check runs (awaited:
 *  cheap and model-free; fail-soft so it never fails the change itself). */
type LedgerChangeListener = (ledger: TeamLedger) => Promise<void>;
const changeListeners: LedgerChangeListener[] = [];
export function onLedgerChanged(fn: LedgerChangeListener): void { changeListeners.push(fn); }
async function announceLedgerChanged(ledger: TeamLedger): Promise<void> {
  for (const fn of changeListeners) {
    try { await fn(ledger); } catch { /* a listener never fails the change */ }
  }
}
