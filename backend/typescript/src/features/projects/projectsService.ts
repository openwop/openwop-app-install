/**
 * Projects (ADR 0046 / ADR 0045 Phase 3) — a `kind:'project'` Subject: a bare
 * work container that OWNS the same surfaces an agent/person does (board, memory,
 * assigned workflows) over the unified subject model. A project does NOT think
 * (no cognition) and has NO authority of its own (ADR 0045 boundary): it is an
 * org-scoped container; a *person* with `workspace:write` in its org acts on it.
 *
 * Composition, not new infrastructure:
 *   - board  → `ensureSubjectBoard(tenantId, {kind:'project', id})` (kanban, generic owner)
 *   - memory → the `project:<id>` scope (subjectMemory — free; ADR 0041)
 *   - workflows → an entity-local array (like `RosterEntry.workflows`)
 *
 * @see docs/adr/0046-project-subject.md
 */

import { randomUUID } from 'node:crypto';
import { assertNoRetentionHold } from '../../host/retentionHold.js';
import { purgeNamespaceVectors } from '../../host/vector/vectorTenantPurge.js';
import { createLogger } from '../../observability/logger.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { notifyShareableKbSourceChanged } from '../../host/shareableKb.js';
import { OpenwopError } from '../../types.js';
import { cleanString, cleanOpaqueToken } from '../../host/boundedStrings.js';
import { scrubSecretShaped } from '../../host/redactSecrets.js';
import { ensureSubjectBoard, subjectBoardId, deleteBoard } from '../../host/kanbanService.js';
import { clearSubjectNotes } from '../../host/subjectMemory.js';
import { clearSubjectKnowledge, getSubjectKnowledge } from '../../host/subjectKnowledge.js';
import { listAllTenantCollections, releaseCollectionBoundSubject } from '../kb/kbService.js';
import { PREAUTHORIZED_CALLER } from '../../host/subjectAccess.js'; // KBC-1 (ADR 0643 D2 precondition) — an in-process lane that owns these rows / gates at its own door
import { listJobsForSubject, deleteJob } from '../../host/schedulingService.js';
import { clearMemoryScope } from '../../host/inMemorySurfaces.js';
import { resolveEffectiveAccess, type EffectiveAccess } from '../../host/accessControlService.js';
import { getRosterEntry } from '../../host/rosterService.js';
import { parseTurnPolicy, type TurnPolicy } from '../../host/turnPolicy.js';
import type { AccessLevel } from '../../host/subjectAccess.js';
import { subjectScope, type Subject } from '../../host/subject.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { subjectKeyForms, ERASED_USER_REF } from '../../host/subjectErasureRedaction.js';


const log = createLogger('features.projects');
/** ADR 0054 D1 — the project's definition (a single optional sub-object). */
export interface ProjectMilestone { id: string; title: string; dueDate?: string; done: boolean }
export type ProjectStatus = 'planning' | 'active' | 'paused' | 'done' | 'archived';
export type ProjectHealth = 'on-track' | 'at-risk' | 'off-track';
export interface ProjectCharter {
  goal?: string;            // the one-line outcome
  objectives?: string[];    // measurable sub-goals
  brief?: string;           // free-text charter / context (markdown)
  startDate?: string;       // ISO-8601
  endDate?: string;         // ISO-8601 (target)
  status?: ProjectStatus;
  health?: ProjectHealth;
  milestones?: ProjectMilestone[];
}

/** ADR 0054 D2 — a project's descriptive membership. `ref` is `user:<userId>` or
 *  `agent:<rosterId>` (ADR 0043 vocab). `role` is a LABEL, never an RBAC scope. */
export type ProjectRole = 'lead' | 'contributor' | 'observer';
export type ProjectVisibility = 'org' | 'private';
export interface ProjectMember { ref: string; role: ProjectRole; addedAt: string }

export interface Project {
  id: string;
  tenantId: string;
  /** The owning org (RBAC scope; ADR 0045 — a project has no authority itself). */
  orgId: string;
  name: string;
  /** ADR 0084 — an optional sub-type marker. A project with `facet:'notebook'` IS
   *  a Research Notebook (the notebooks feature is a project + a bound KB collection
   *  + subject memory — no parallel container). Absent ⇒ a plain project. Purely
   *  additive: every existing project path is unchanged when it is undefined. */
  facet?: 'notebook';
  /** R3 — the KB collection the NOTEBOOK SURFACE provisioned exclusively for this
   *  project (createNotebook / ensureNotebookForProject). Deleting the notebook may
   *  delete THIS collection and no other: the binding list's position 0 is not a
   *  fact about ownership — the Knowledge tab can bind a SHARED collection there. */
  notebookCollectionId?: string;
  /** ADR 0045 — entity-local assigned workflows (mirrors `RosterEntry.workflows`). */
  workflows: string[];
  /** ADR 0054 D1 — the project's charter/definition (absent ⇒ unchanged). */
  charter?: ProjectCharter;
  /** ADR 0054 D2 — descriptive roster of people + agents (default empty). */
  members?: ProjectMember[];
  /** ADR 0054 D5 — read-visibility. `'org'` (default): any org reader sees it.
   *  `'private'`: only members (+ org writers). WRITE is always org-scoped. */
  visibility?: ProjectVisibility;
  /** ADR 0054 D6 — the project group chat's cadence. `moderatorRosterId` (the
   *  chair/synthesizer) MUST be a project AGENT member; `turnPolicy` is the shared
   *  `TurnPolicy` primitive the advisory board uses. Both absent ⇒ no structured
   *  cadence (the chat is a plain group conversation). */
  moderatorRosterId?: string;
  turnPolicy?: TurnPolicy;
  createdAt: string;
  updatedAt: string;
}

const PROJECT_ROLES: ProjectRole[] = ['lead', 'contributor', 'observer'];
const MAX_MEMBERS = 100;

/**
 * CPWF-3 — deterministic convene-cohort ordering, server-side.
 *
 * The advertised `multiPartyConversation.maxParticipants` (8, the backend
 * `MAX_MULTI_PARTY_PARTICIPANTS`) caps the SEATED agent roster of the project
 * group chat. A project may hold up to `MAX_MEMBERS` agent members but seats at
 * most the cap into the convene conversation. This picks WHICH agents fill the
 * seats — moderator-first (the chair, whose member ref is `agent:<moderatorRosterId>`),
 * then declared member order — mirroring the frontend `orderConveneCohort`
 * (`chat/conversations/boardroomCadence.ts`) so client display and server seating
 * agree. `agentRefs` are `agent:<rosterId>` refs (ADR 0043 vocab). Pure +
 * parity-tested; the cap enforcement itself lives at the reconcile choke in
 * `routes.ts` (grandfathering existing >cap rooms — never a 4xx, never an unseat).
 */
export function orderProjectAgentCohort(
  moderatorRosterId: string | undefined,
  agentRefs: readonly string[],
  cap: number,
  moderatorSeatRef?: string,
): string[] {
  // `COLWF-1` — `agentRefs` now carries the chat-callable projection (`agent:<agentRef.agentId>`)
  // so the RFC 0101 speaker rule can match the id that answers, while the moderator is still
  // identified by ROSTER id. Match on either spelling: a caller that has already resolved the
  // chair passes its seat ref, and a caller that has not still matches by rosterId. Without
  // this the chair simply stopped being found and moderator-first silently stopped holding —
  // which is what the cap witness caught when the seat mapping landed.
  const chairCandidates = moderatorRosterId
    ? [`agent:${moderatorRosterId}`, ...(moderatorSeatRef ? [moderatorSeatRef] : [])]
    : [];
  const chair = chairCandidates.find((c) => agentRefs.includes(c));
  return [
    ...(chair ? [chair] : []),
    ...agentRefs.filter((r) => r !== chair),
  ].slice(0, Math.max(0, cap));
}
/** PRJC-7 — the assigned-workflow portfolio caps (matches the profiles lane's
 *  MAX_WORKFLOWS = 50; id length matches the scheduler's `workflowId` bound). */
const MAX_ASSIGNED_WORKFLOWS = 50;
const MAX_WORKFLOW_ID_LENGTH = 200;

const STATUSES: ProjectStatus[] = ['planning', 'active', 'paused', 'done', 'archived'];
const HEALTHS: ProjectHealth[] = ['on-track', 'at-risk', 'off-track'];
const MAX_OBJECTIVES = 20;
const MAX_MILESTONES = 50;

/** R3 (the R2 "not audited" residual) — `cleanString` SCRUBS as well as truncates:
 *  a 40+ char unbroken token (a long URL slug, a hash) in a goal or brief became
 *  `[REDACTED:secret-shaped]` on a 200 — the same silent-server-mutation class
 *  PRJ2-M5 closed for truncation, on a dimension the editor says nothing about.
 *  A field the scrubber would rewrite is now a TYPED REFUSAL naming the field;
 *  the caller keeps their text and decides. (`cleanString` itself is unchanged —
 *  it guards every other caller as defense-in-depth.) */
function refuseSecretShaped(raw: unknown, field: string): void {
  const trimmed = String(raw ?? '').trim();
  if (trimmed && scrubSecretShaped(trimmed) !== trimmed) {
    throw new OpenwopError('validation_error', `\`${field}\` contains a secret-shaped token (an API key, or a 40+ character unbroken blob such as a long hash). The server will not store it, and rewriting it silently would corrupt your text — remove or break up the token.`, 400, { field });
  }
}

/** Validate + cap a charter patch, dropping unknown/empty fields (full replace). */
function parseCharter(input: unknown): ProjectCharter {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: ProjectCharter = {};
  refuseSecretShaped(raw.goal, 'charter.goal');
  refuseSecretShaped(raw.brief, 'charter.brief');
  const goal = cleanString(raw.goal, 200); if (goal) out.goal = goal;
  const brief = cleanString(raw.brief, 8000); if (brief) out.brief = brief;
  const startDate = cleanString(raw.startDate, 40); if (startDate) out.startDate = startDate;
  const endDate = cleanString(raw.endDate, 40); if (endDate) out.endDate = endDate;
  if (STATUSES.includes(raw.status as ProjectStatus)) out.status = raw.status as ProjectStatus;
  if (HEALTHS.includes(raw.health as ProjectHealth)) out.health = raw.health as ProjectHealth;
  if (Array.isArray(raw.objectives)) {
    const objectives = raw.objectives.slice(0, MAX_OBJECTIVES).map((o, i) => { refuseSecretShaped(o, `charter.objectives[${i}]`); return cleanString(o, 200); }).filter((o): o is string => !!o);
    if (objectives.length) out.objectives = objectives;
  }
  if (Array.isArray(raw.milestones)) {
    const milestones = raw.milestones.slice(0, MAX_MILESTONES).map((m): ProjectMilestone | null => {
      const mm = (m ?? {}) as Record<string, unknown>;
      refuseSecretShaped(mm.title, 'charter.milestones[].title');
      const title = cleanString(mm.title, 160);
      if (!title) return null;
      const due = cleanString(mm.dueDate, 40);
      return { id: typeof mm.id === 'string' && mm.id ? mm.id.slice(0, 64) : `ms-${randomUUID().slice(0, 8)}`, title, done: mm.done === true, ...(due ? { dueDate: due } : {}) };
    }).filter((m): m is ProjectMilestone => m !== null);
    if (milestones.length) out.milestones = milestones;
  }
  return out;
}

// PRJC-2 — `tenantOf` (GOV-1): the collection maintains the tenant secondary
// index, so `listProjects` is a bounded per-tenant read instead of an all-tenant
// scan filtered in memory (183 sibling collections already pass it; the hot list
// route, the agent tool, the create cap-check, and the shareable-KB provider all
// reach `listProjects`). Additive — markers only, no primary re-key; existing
// rows are backfilled once by the sentinel-guarded `ensureTenantIndex` on the
// first indexed read. The DSAR eraser + tenant teardown deliberately stay on the
// FULL raw scan (a compliance miss is a permanent orphan; completeness wins).
const store = new DurableCollection<Project>('projects:project', (p) => p.id, undefined, (p) => p.tenantId);
const PROJECT_CAP = 200;

/**
 * ADR 0601 § Corrections (HIGH-1 / HIGH-2) — THE predicate: which KB collection
 * does deleting this project DESTROY, if any? `undefined` means the delete
 * erases no corpus.
 *
 * It exists as one exported function because the question had two
 * implementations and they disagreed. The eraser asked "is the first bound
 * collection's NAME prefixed `Notebook: ` / `Sources: `" — a guess about a
 * user-chosen string — while the consent dialog asked `facet === 'notebook'`, a
 * field only ONE of the two provisioning lanes ever sets. So the whole
 * ensure-provisioned population got no corpus warning and learned that its
 * sources were gone from the success toast, and a Knowledge-tab-bound SHARED
 * collection that happened to be named `Sources: …` was destroyed for every
 * other project using it.
 *
 * The answer is PROVENANCE, not a heuristic: `notebookCollectionId` is stamped
 * at the two — and only two — sites that provision a corpus exclusively for a
 * project (`createNotebook`, `ensureNotebookForProject`), immediately after
 * minting it. A collection this surface did not mint can never be stamped, so it
 * can never be destroyed here regardless of what it is called.
 *
 * The trade is deliberate and asymmetric: a notebook whose corpus predates the
 * stamp loses AUTO-CLEANUP and leaves an orphaned collection. An orphan is
 * recoverable — it is still listed, still readable, still deletable by hand. A
 * destroyed shared corpus is not. Irreversibility decides it.
 */
export function notebookCorpusToDelete(p: Project): string | undefined {
  return p.notebookCollectionId;
}

/** R3 — stamp the surface-provisioned notebook collection on the row (see the
 *  `notebookCollectionId` doc above). Notebook-surface use only. */
export async function setNotebookCollectionId(tenantId: string, id: string, collectionId: string): Promise<void> {
  const p = await store.get(id);
  if (!p || p.tenantId !== tenantId) return;
  await store.put({ ...p, notebookCollectionId: collectionId, updatedAt: nowIso() });
}

/** The project as a memory/board Subject. */
export const projectSubject = (id: string): Subject => ({ kind: 'project', id });

function nowIso(): string { return new Date().toISOString(); }

/** Create a project + provision its board (idempotent board). Org-scoped. */
export async function createProject(tenantId: string, orgId: string, input: { name?: unknown; facet?: 'notebook' }): Promise<Project> {
  // PRJC-6 — `name` joins the R3 typed-refusal discipline: `cleanString` would
  // scrub a secret-shaped name to `[REDACTED:secret-shaped]` on a 200.
  refuseSecretShaped(input.name, 'name');
  const name = cleanString(input.name, 120);
  if (!name) throw new OpenwopError('validation_error', 'Field `name` is required.', 400, { field: 'name' });
  // Best-effort cap (read-then-write, not CAS): concurrent creates could briefly
  // exceed PROJECT_CAP. Tolerated — a soft workspace guard, not a security boundary.
  if ((await listProjects(tenantId)).length >= PROJECT_CAP) {
    throw new OpenwopError('validation_error', `This workspace already has the maximum ${PROJECT_CAP} projects.`, 400, { cap: PROJECT_CAP });
  }
  const id = `project-${randomUUID().slice(0, 12)}`;
  const ts = nowIso();
  const project: Project = { id, tenantId, orgId, name, workflows: [], members: [], visibility: 'org', createdAt: ts, updatedAt: ts, ...(input.facet ? { facet: input.facet } : {}) };
  await store.put(project);
  await ensureSubjectBoard(tenantId, projectSubject(id), `${name} board`);
  return project;
}

/** A project by id, tenant-scoped (IDOR — a foreign-tenant project reads null). */
export async function getProject(tenantId: string, id: string): Promise<Project | null> {
  const p = await store.get(id);
  return p && p.tenantId === tenantId ? p : null;
}

export async function listProjects(tenantId: string): Promise<Project[]> {
  // PRJC-2 — bounded per-tenant read via the tenant index (the filter stays as a
  // guard against a stale marker whose row was re-tenanted; it is cheap).
  return (await store.listForTenantIndexed(tenantId)).filter((p) => p.tenantId === tenantId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Rename / set workflows / set the charter. Tenant-scoped. (Charter is a full
 *  replace: PATCH `{ charter: {...} }` overwrites; `{ charter: null }` clears.) */
export async function updateProject(tenantId: string, id: string, patch: { name?: unknown; workflows?: unknown; charter?: unknown; moderatorRosterId?: unknown; turnPolicy?: unknown }): Promise<Project> {
  const current = await getProject(tenantId, id);
  if (!current) throw new OpenwopError('not_found', 'Project not found.', 404, { id });
  const next: Project = { ...current, updatedAt: nowIso() };
  if ('name' in patch && patch.name !== undefined) {
    refuseSecretShaped(patch.name, 'name'); // PRJC-6 — same discipline as create
    const name = cleanString(patch.name, 120);
    if (!name) throw new OpenwopError('validation_error', 'Field `name` must be a non-empty string.', 400, { field: 'name' });
    next.name = name;
  }
  if ('workflows' in patch && patch.workflows !== undefined) {
    if (!Array.isArray(patch.workflows) || patch.workflows.some((w) => typeof w !== 'string')) {
      throw new OpenwopError('validation_error', 'Field `workflows` must be an array of workflow ids.', 400, { field: 'workflows' });
    }
    // PRJC-7 — bounded + element-validated, by TYPED REFUSAL rather than the
    // silent slice/rewrite `cleanString` alone would do: these are IDS, and an
    // id the server mutates is an id left dangling (the feature's own caps
    // discipline — MAX_MEMBERS 100, MAX_MILESTONES 50 — finally applied here).
    //
    // Adversarial-review F1 — ids ride `cleanOpaqueToken` (charset-validated,
    // NOT secret-scrubbed), never the free-TEXT scrub oracle: `scrubSecretShaped`'s
    // `[A-Za-z0-9_-]{40,}` blob arm is not broken by hyphens, so validating via
    // `cleanString` rejected the platform's OWN `agent-wf-<uuid>` ids (45 chars,
    // minted at `workflowComposeTool.ts`) — a portfolio containing one could
    // never be PATCHed again. Same class as the CMS serve-token destruction that
    // motivated `cleanOpaqueToken` (ADR 0206); ids are never rendered as free
    // text, so the paste-a-credential threat model does not apply.
    const ids = patch.workflows as string[];
    if (ids.length > MAX_ASSIGNED_WORKFLOWS) {
      throw new OpenwopError('validation_error', `Field \`workflows\` holds ${ids.length} ids — the maximum is ${MAX_ASSIGNED_WORKFLOWS}.`, 400, { field: 'workflows', cap: MAX_ASSIGNED_WORKFLOWS });
    }
    const cleaned = ids.map((w) => cleanOpaqueToken(w, MAX_WORKFLOW_ID_LENGTH));
    const bad = cleaned.findIndex((c) => !c);
    if (bad >= 0) {
      throw new OpenwopError('validation_error', `\`workflows[${bad}]\` is not a valid workflow id (empty, longer than ${MAX_WORKFLOW_ID_LENGTH} characters, or not id-shaped — letters, digits, \`.\`, \`_\`, \`:\`, \`-\`).`, 400, { field: 'workflows', index: bad });
    }
    next.workflows = cleaned;
  }
  if ('charter' in patch && patch.charter !== undefined) {
    if (patch.charter === null) delete next.charter;
    else {
      const charter = parseCharter(patch.charter);
      if (Object.keys(charter).length) next.charter = charter; else delete next.charter;
    }
  }
  // ADR 0054 D6 — the group-chat cadence. `turnPolicy` rides the shared validator
  // (clamped for cost); `moderatorRosterId` MUST be a project AGENT member (the
  // chair speaks in the room, so it has to be IN the room — `members[]` stays the
  // single source of truth for who is on the project). `null` clears either.
  if ('turnPolicy' in patch && patch.turnPolicy !== undefined) {
    if (patch.turnPolicy === null) delete next.turnPolicy;
    else next.turnPolicy = parseTurnPolicy(patch.turnPolicy);
  }
  if ('moderatorRosterId' in patch && patch.moderatorRosterId !== undefined) {
    if (patch.moderatorRosterId === null) {
      delete next.moderatorRosterId;
    } else {
      const modId = cleanString(patch.moderatorRosterId, 200);
      if (!modId) throw new OpenwopError('validation_error', '`moderatorRosterId` must be a non-empty roster id.', 400, { field: 'moderatorRosterId' });
      const entry = await getRosterEntry(tenantId, modId);
      if (!entry) throw new OpenwopError('not_found', 'Moderator not found in this workspace.', 404, { moderatorRosterId: modId });
      // This member check races a concurrent member removal, but that's benign: the
      // convene consumer re-validates `moderator ∈ members` and `removeProjectMember`
      // clears the moderator on removal.
      //
      // ADR 0608 D9 (`CPWF-4`) — CORRECTED 2026-08-24. This used to say the consumer
      // "falls back to no chair". It did not: `chairAgentId ??= routed`
      // (`chat/conversations/convene.ts`) promoted whichever agent resolved FIRST,
      // and the chair both frames and synthesizes — so a dropped moderator silently
      // handed the seat to advisor #2. The false sentence sat in the file that owns
      // the invariant, which is why nobody checked the consumer. The consumer now
      // REFUSES the convene with a typed system line; this comment describes what it
      // does, not what it was assumed to do.
      if (!(next.members ?? []).some((m) => m.ref === `agent:${modId}`)) {
        throw new OpenwopError('validation_error', 'The moderator MUST be a project agent member — add it on the Members tab first.', 422, { moderatorRosterId: modId });
      }
      next.moderatorRosterId = modId;
    }
  }
  await store.put(next);
  return next;
}

// ── ADR 0054 D2/D5 — membership + visibility + the access resolver ──

const userMemberRef = (userId: string): string => `user:${userId}`;

/** The ONE visibility ≠ authority rule (ADR 0054 D5), factored so the per-id
 *  door (`resolveProjectAccess`) and the list scan (`listVisibleProjects`)
 *  apply the IDENTICAL rule to an already-resolved org access — never a second
 *  copy of the predicate (the RBAC composition the three-lane pass verified
 *  strong). */
function levelFor(p: Project, access: EffectiveAccess, callerSubject: string | undefined): AccessLevel {
  if (access.scopes.includes('workspace:write')) return 'write';
  const visibility = p.visibility ?? 'org';
  if (visibility === 'org' && access.scopes.includes('workspace:read')) return 'read';
  if (visibility === 'private' && callerSubject && (p.members ?? []).some((m) => m.ref === userMemberRef(callerSubject))) return 'read';
  return 'none';
}

/** The caller's access LEVEL for a project (ADR 0054 D5 — the ONE place the
 *  visibility ≠ authority rule lives; the `subjectAccess` seam wraps this for
 *  kanban). WRITE ⟺ `workspace:write` in the project's org (membership NEVER
 *  grants write). READ = write OR (`org`-visible && org-read) OR (`private` &&
 *  the caller is a people-member). Fail-closed: unknown project ⇒ `'none'`. */
export async function resolveProjectAccess(tenantId: string, projectId: string, callerSubject: string | undefined): Promise<AccessLevel> {
  const p = await getProject(tenantId, projectId);
  if (!p) return 'none';
  const access = await resolveEffectiveAccess(tenantId, { subject: callerSubject, orgId: p.orgId });
  return levelFor(p, access, callerSubject);
}

/**
 * PRJC-3 / WF-PRJ-4 — the ONE list-visible scan the list route and the agent
 * tool share (they used to hand-roll the same loop separately, and each
 * iteration re-fetched the row inside `resolveProjectAccess` AND re-ran
 * `resolveEffectiveAccess` — which full-scans members/customRoles/groups — per
 * project: worst case ~PROJECT_CAP(200) × 3 host-collection scans per request,
 * the `host_ext_kv` prefix-scan incident's exact class).
 *
 * Access is resolved ONCE per (caller, org) — most projects share one org —
 * and the in-hand row is passed to the shared `levelFor` rule, skipping the
 * re-`getProject`. Rows the caller cannot read are dropped (no existence leak;
 * the same fail-closed filter as before, via the same rule).
 */
export async function listVisibleProjects(
  tenantId: string,
  callerSubject: string | undefined,
): Promise<{ project: Project; level: Exclude<AccessLevel, 'none'> }[]> {
  const accessByOrg = new Map<string, EffectiveAccess>();
  const out: { project: Project; level: Exclude<AccessLevel, 'none'> }[] = [];
  for (const p of await listProjects(tenantId)) {
    let access = accessByOrg.get(p.orgId);
    if (access === undefined) {
      access = await resolveEffectiveAccess(tenantId, { subject: callerSubject, orgId: p.orgId });
      accessByOrg.set(p.orgId, access);
    }
    const level = levelFor(p, access, callerSubject);
    if (level !== 'none') out.push({ project: p, level });
  }
  return out;
}

/** Add (or re-role) a member. Validates the ref: a `user:` ref MUST be an org
 *  member of the project's org (can't add a stranger); an `agent:` ref MUST be a
 *  tenant roster entry. Caller authority is enforced at the route (write). */
export async function addProjectMember(tenantId: string, projectId: string, ref: unknown, role: unknown): Promise<Project> {
  const current = await getProject(tenantId, projectId);
  if (!current) throw new OpenwopError('not_found', 'Project not found.', 404, { id: projectId });
  const r = cleanString(ref, 200);
  const m = /^(user|agent):(.+)$/.exec(r);
  if (!m) throw new OpenwopError('validation_error', '`ref` must be `user:<userId>` or `agent:<rosterId>`.', 400, { field: 'ref' });
  const projectRole: ProjectRole = PROJECT_ROLES.includes(role as ProjectRole) ? (role as ProjectRole) : 'contributor';
  const [, kind, id] = m;
  if (kind === 'user') {
    const access = await resolveEffectiveAccess(tenantId, { subject: id, orgId: current.orgId });
    if (access.basis === 'none') throw new OpenwopError('validation_error', 'That person is not a member of this project’s org.', 400, { ref: r });
  } else {
    const entry = await getRosterEntry(tenantId, id);
    if (!entry) throw new OpenwopError('validation_error', 'That agent is not in this workspace’s roster.', 400, { ref: r });
  }
  const members = (current.members ?? []).filter((x) => x.ref !== r);
  if (members.length >= MAX_MEMBERS) throw new OpenwopError('validation_error', `This project already has the maximum ${MAX_MEMBERS} members.`, 400, { cap: MAX_MEMBERS });
  members.push({ ref: r, role: projectRole, addedAt: nowIso() });
  const next: Project = { ...current, members, updatedAt: nowIso() };
  await store.put(next);
  return next;
}

/** Remove a member (descriptive only — never revokes org authority). */
export async function removeProjectMember(tenantId: string, projectId: string, ref: string): Promise<Project> {
  const current = await getProject(tenantId, projectId);
  if (!current) throw new OpenwopError('not_found', 'Project not found.', 404, { id: projectId });
  const next: Project = { ...current, members: (current.members ?? []).filter((m) => m.ref !== ref), updatedAt: nowIso() };
  // ADR 0054 D6 — keep `moderatorRosterId ∈ members`: removing the moderator agent
  // clears the now-stale chair (else it would point outside the room).
  if (current.moderatorRosterId && ref === `agent:${current.moderatorRosterId}`) delete next.moderatorRosterId;
  await store.put(next);
  return next;
}

/** Set the project's read-visibility (ADR 0054 D5). */
export async function setProjectVisibility(tenantId: string, projectId: string, visibility: unknown): Promise<Project> {
  const current = await getProject(tenantId, projectId);
  if (!current) throw new OpenwopError('not_found', 'Project not found.', 404, { id: projectId });
  if (visibility !== 'org' && visibility !== 'private') {
    throw new OpenwopError('validation_error', '`visibility` must be `org` or `private`.', 400, { field: 'visibility' });
  }
  const next: Project = { ...current, visibility, updatedAt: nowIso() };
  await store.put(next);
  // ADR 0608 D5 (`CPC-3`) — the carve-out that keeps a `private` project's KB out
  // of an advisory board was applied at SHARE TIME ONLY. Nothing re-ran it, so
  // `org` -> `private` left every advisor still bound to the collection —
  // retrieving the now-private corpus on every turn, for any user who can chat
  // with that agent — while the board's panel reported `shared:true, exists:false,
  // count:0`. Announce the change so the consumer re-applies it. AFTER the put
  // (the reconciler re-resolves through the provider and must see the new state),
  // and only when the value actually moved. Fault-isolated inside the seam: a
  // visibility flip must land even if a board is unreachable.
  if ((current.visibility ?? 'org') !== visibility) {
    await notifyShareableKbSourceChanged(tenantId, current.orgId, 'project');
  }
  return next;
}

/** Delete a project + cascade its owned surfaces (board + memory + knowledge
 *  binding + schedules). Returns the cleanup counts. Tenant-scoped fail-closed. */
export async function deleteProject(tenantId: string, id: string): Promise<{ deleted: boolean; memoryEntriesCleared: number; schedulesCleared: number }> {
  const current = await getProject(tenantId, id);
  if (!current) return { deleted: false, memoryEntriesCleared: 0, schedulesCleared: 0 };
  // `PRJWF-1` — assert the retention hold BEFORE anything is destroyed.
  //
  // This cascade destroys NINE kinds of durable state: the kanban board and its cards, every
  // cron job the project subject owns, every durable curated note, the in-memory recall set,
  // the `boundSubject` stamps on each bound collection, the knowledge binding, the row itself —
  // and, at the route, the entire group conversation and (for a notebook) a whole ingested
  // corpus. It ran under a legal hold without a word.
  //
  // It is the `AGKM-11` exposure class on a lane with a WIDER destruction set than the roster
  // cascade that class was named for, and one rung worse: the roster cascade at least appears in
  // the destructive-lane census as a named GAP, while this one appeared NOWHERE. The census
  // derives from storage-level deletes plus seam runners, and a `DurableCollection.delete()` is
  // neither — so nothing could see it. `PKWF-9` already named `deleteProject` as one of the two
  // bulk lanes; this closes the project half.
  //
  // Inline rather than behind a helper, deliberately: the census scans a lane's OWN text for the
  // consult, so extracting it would make the lane unverifiable by the instrument that now
  // tracks it.
  await assertNoRetentionHold(tenantId);
  // Board first (so its cards are unreachable), then schedules (so they stop
  // firing), then memory + knowledge binding, then the record. (The bound KB
  // collections are shared — not deleted.)
  await deleteBoard(subjectBoardId(tenantId, projectSubject(id)));
  // Schedules: delete every job the project subject owns (the ONE scheduler; host
  // functions only — avoids a feature→feature cycle with projectScheduleService).
  const ownedJobs = await listJobsForSubject(tenantId, projectSubject(id));
  for (const j of ownedJobs) await deleteJob(j.jobId);
  const schedulesCleared = ownedJobs.length;
  const durableNotes = await clearSubjectNotes(tenantId, projectSubject(id));
  const memoryEntriesCleared = (await clearMemoryScope(tenantId, subjectScope(projectSubject(id)))) + durableNotes;
  // `PRJWF-2` — and the VECTOR namespace, which neither clear above touches. Third lane to get
  // this: agents (ADR 0664 D1) and the DSAR eraser (ADR 0666 D2) already had it.
  //
  // The consequence here is NARROWER than on those two lanes, and saying so is the point.
  // There, ids are deterministic (`host:<slug(persona)>`, `sha256(tenant:principal)`), so a
  // re-created subject inherited the namespace and the deleted subject's notes were served to
  // its namesake — a live cross-subject recall. A project id is `project-<random>`
  // (`createProject` is the only mint path), so re-creation CANNOT collide and that defect does
  // not transfer.
  //
  // What remains is real but different: orphaned vector rows whose metadata carries the note
  // text VERBATIM, in a namespace no living subject owns, reachable by no namespace purger, no
  // retention purger (structurally impossible — the note store passes no `tenantOf`) and no
  // age-out. They survive until the whole tenant is torn down. That is a retention and
  // erasure-completeness gap, not a leak — filed and fixed as such rather than inflated.
  const vectorPurge = await purgeNamespaceVectors(tenantId, subjectScope(projectSubject(id)));
  if (vectorPurge.failed.length > 0) {
    log.error('project_delete_vector_purge_partial', {
      tenantId, projectId: id, failed: vectorPurge.failed, purged: vectorPurge.purged,
    });
  }
  // ADR 0608 D4 (`CPC-2`) — RELEASE this project's KB scoping stamp BEFORE the
  // binding is cleared (afterwards there is nothing left to enumerate). A stamp
  // names a Subject that is about to stop existing, and `resolveSubjectAccess`
  // cannot distinguish "this project denies you" from "this project is gone" —
  // both are `'none'`. Leaving it would turn the collection into unreachable dead
  // data for everyone, which is the gate-with-no-exit shape and strictly worse
  // than the leak the stamp closes. `releaseCollectionBoundSubject` only clears a
  // stamp that names THIS project, so a collection scoped by another one is safe.
  // Best-effort: a KB read failure must not block the delete.
  try {
    const bound = (await getSubjectKnowledge(tenantId, projectSubject(id))).collectionIds ?? [];
    if (bound.length > 0) {
      const byId = new Map((await listAllTenantCollections(tenantId, PREAUTHORIZED_CALLER)).map((c) => [c.collectionId, c])); // KBC-1 — teardown of the project's OWN bindings
      for (const collectionId of bound) {
        const col = byId.get(collectionId);
        if (col) await releaseCollectionBoundSubject(tenantId, col.orgId, collectionId, projectSubject(id));
      }
    }
  } catch { /* best-effort — the delete must still land */ }
  await clearSubjectKnowledge(tenantId, projectSubject(id));
  // R2 PRJ2-M1 — the project's group conversation is cascaded by the ROUTE, not
  // here: the full cascade needs `storage` (the session row + its messages),
  // which this service has no handle on. The first attempt cascaded the only
  // part reachable from here — `deleteConversationMeta` — and that was WORSE
  // than leaving the conversation alone: the meta is what makes an owned thread
  // private, so dropping it while the session survived published a private
  // project's chat history to every member of the tenant. See
  // `host/conversationCascade.ts`; a caller that cannot run the whole cascade
  // must run none of it.
  await store.delete(id);
  return { deleted: true, memoryEntriesCleared, schedulesCleared };
}

/**
 * A static "Project context" block for a Board of Advisors (ADR 0079/0100) — the
 * project counterpart of `buildStrategyContextBlock`. Given selected project ids +
 * the convener subject, returns a compact charter summary (goal / status / health /
 * objectives / milestones) for the readable projects, or `null` if none resolve.
 *
 * RBAC: each project is gated by `resolveProjectAccess` — a project the convener
 * cannot read (e.g. a `private` project they're not a member of) is silently
 * omitted, mirroring how the strategy block filters unreadable strategies.
 *
 * M4 — `droppedNonAuthz` counts refs that VANISHED (the project was deleted),
 * never refs withheld from this caller: the count travels to a caller-neutral
 * degradation ledger, so an authz-derived number there would leak. The existence
 * check therefore runs BEFORE the access check — `resolveProjectAccess` returns
 * `'none'` for a missing project too, which conflated the two.
 */
export async function buildProjectContextBlock(tenantId: string, projectIds: string[], subject: string | undefined): Promise<{ block: string | null; droppedNonAuthz: number }> {
  const blocks: string[] = [];
  let droppedNonAuthz = 0;
  for (const id of projectIds) {
    const p = await getProject(tenantId, id);
    if (!p) { droppedNonAuthz += 1; continue; } // gone — reportable
    if ((await resolveProjectAccess(tenantId, id, subject)) === 'none') continue; // RBAC filter — SILENT
    const c = p.charter ?? {};
    const parts = [`### Project: ${p.name}`];
    if (c.goal) parts.push(`Goal: ${c.goal}`);
    if (c.status || c.health) parts.push(`Status: ${c.status ?? 'unset'}${c.health ? ` · Health: ${c.health}` : ''}`);
    if (c.objectives && c.objectives.length > 0) parts.push(`Objectives:\n${c.objectives.map((o) => `- ${o}`).join('\n')}`);
    if (c.milestones && c.milestones.length > 0) {
      parts.push(`Milestones:\n${c.milestones.map((m) => `- ${m.title}${m.dueDate ? ` (due ${m.dueDate})` : ''}${m.done ? ' [done]' : ''}`).join('\n')}`);
    }
    if (c.brief) parts.push(c.brief);
    blocks.push(parts.join('\n'));
  }
  if (blocks.length === 0) return { block: null, droppedNonAuthz };
  // "Projects" (not "Active projects") — the block carries every SELECTED project
  // regardless of status; each line states its own status, so the heading must not
  // imply they're all active.
  return { block: `## Projects\n\n${blocks.join('\n\n')}`, droppedNonAuthz };
}

// ── ADR 0464 / D2 (chat-first port) — subject erasure ──
//
// A project is an ORG-owned work container (ADR 0045 — no `ownerSubject`, no
// per-subject authored fields). The ONLY data-subject reference it holds is a
// `user:`-tagged entry in `members[]` (ADR 0054 D2). So a DSAR ANONYMIZES that
// membership IN PLACE — the person's ref becomes the `[erased]` sentinel while the
// role/addedAt shape survives — rather than deleting the whole project (which is
// other people's work, the ADR 0464 over-erasure guard). The charter (goal /
// objectives / brief) is org-authored project content with no subject attribution,
// so it is deliberately NOT blanked — doing so would destroy legitimate org data.
// Agent members (`agent:` refs) are never data subjects and are left untouched, so
// the `moderator ∈ members` invariant (ADR 0054 D6) can't be broken by an erasure.

/** DSAR eraser — anonymize the erased person's `user:` membership on every project
 *  in the tenant. Idempotent (a re-run matches the sentinel, not the id, so it
 *  no-ops); tenant-scoped; fail-closed on falsy input; no notifications.
 *  Returns `{ rowsTouched }` (WF-PRJ-3) so the erasure seam's wrong-tenant
 *  `foundNothing` tell can see a fan-out that reached nothing. */
export async function eraseSubjectProjects(tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  const { forms } = subjectKeyForms(subjectKey);
  // PRJC-1 — stored member refs are DOUBLE-prefixed: `User.userId` is ITSELF
  // `user:<hash>` (`usersService.userIdFor`) and `userMemberRef` prefixes it
  // again — the org-membership check in `addProjectMember` forces exactly that
  // shape — so a row holds `user:user:<hash>` while `subjectKeyForms` strips one
  // tag and adds one scope, never a double form. A DSAR keyed by `User.userId`
  // (the natural admin key) therefore matched ZERO real member refs and the
  // fan-out reported success. Match the ONCE-STRIPPED stored form too — the
  // identical class GEN-TWIN-4 fixed for personal memory (`host/subjectMemory.ts`:
  // "PERSONAL MEMORY WAS NEVER ERASED BY A DSAR").
  //
  // Adversarial-review F2 — the strip arm is restricted to the exact production
  // double-prefix shape (`user:user:…`): `subjectKeyForms('agent:X')` contains
  // the bare raw `X`, so peeling one `user:` tag off ANY `user:`-prefixed ref
  // would let an agent-keyed DSAR bridge tag types and redact the UNRELATED
  // member ref `user:X`. With the `user:user:` guard, the once-stripped form is
  // itself still `user:`-scoped, so a stripped match can only ever be a
  // user-tagged subject — exact string forms beyond that one peel, never a
  // prefix/substring match.
  const matchesSubject = (ref: string): boolean =>
    forms.has(ref) || (ref.startsWith('user:user:') && forms.has(ref.slice('user:'.length)));
  let rowsTouched = 0;
  for (const p of await store.list()) {
    if (p.tenantId !== tenantId) continue;
    const members = p.members ?? [];
    let changed = false;
    const redacted = members.map((m) => {
      if (m.ref.startsWith('user:') && m.ref !== ERASED_USER_REF && matchesSubject(m.ref)) {
        changed = true; return { ...m, ref: ERASED_USER_REF };
      }
      return m;
    });
    if (!changed) continue;
    rowsTouched += 1; // F5 — count ROWS (the unit the report claims), not refs
    await store.put({ ...p, members: redacted, updatedAt: nowIso() });
  }
  return { rowsTouched };
}

/** Register the projects DSAR eraser (idempotent — the seam dedupes by reference).
 *  Called from `feature.ts` `registerRoutes` (runs for every feature regardless of
 *  toggle, so a tenant that used projects then turned it off is still erasable). */
export function registerProjectsErasure(): void {
  registerSubjectEraser(eraseSubjectProjects);
}
