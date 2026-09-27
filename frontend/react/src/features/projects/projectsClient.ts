/**
 * Projects client (ADR 0046) — drives /host/openwop-app/projects. A project is
 * a `kind:'project'` Subject that owns a board + memory + assigned workflows.
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface ProjectMilestone { id: string; title: string; dueDate?: string; done: boolean }
export type ProjectStatus = 'planning' | 'active' | 'paused' | 'done' | 'archived';
export type ProjectHealth = 'on-track' | 'at-risk' | 'off-track';
export interface ProjectCharter {
  goal?: string; objectives?: string[]; brief?: string;
  startDate?: string; endDate?: string;
  status?: ProjectStatus; health?: ProjectHealth;
  milestones?: ProjectMilestone[];
}
export type ProjectRole = 'lead' | 'contributor' | 'observer';
export type ProjectVisibility = 'org' | 'private';
export interface ProjectMember { ref: string; role: ProjectRole; addedAt: string }
/** ADR 0054 D6 — the group-chat cadence policy (shared with the advisory board). */
export interface TurnPolicy { rounds: number; order: 'declared' | 'round-robin'; synthesize: boolean }
export interface Project { id: string; tenantId: string; orgId: string; name: string; workflows: string[]; charter?: ProjectCharter; members?: ProjectMember[]; visibility?: ProjectVisibility; moderatorRosterId?: string; turnPolicy?: TurnPolicy; boardId: string;
  /** ADR 0084 — a project created via `POST /notebooks` carries this marker. It
   *  is NOT the "does deleting this erase a corpus" question — read
   *  `deletesCorpus` for that. `ensureNotebookForProject` (opening the Sources
   *  tab) provisions a corpus without ever setting `facet`. */
  facet?: 'notebook';
  /** ADR 0601 § Corrections (HIGH-2) — does deleting this project ERASE its
   *  source corpus? Computed SERVER-SIDE from the same predicate the eraser acts
   *  on (`notebookCorpusToDelete`), so the confirm dialog and the delete cannot
   *  disagree. Absent on an older backend → treat as false (the generic warning:
   *  understating a blast radius is bad, but inventing one is worse, and the
   *  receipt still reports what actually happened). */
  deletesCorpus?: boolean;
  /** ADR 0063 — the caller's effective WRITE access (`workspace:write` in the
   *  project's org), projected by the read so the FE can pre-gate write controls.
   *  A UX hint only; the backend re-checks on every write. Absent on responses
   *  that don't carry it → treat absent as "no write" (fail-closed). */
  canWrite?: boolean }
export interface MemoryNote { id: string; content: string; contentTrust: 'trusted' | 'untrusted'; createdAt: string }
export interface Org { orgId: string; name: string }

/**
 * UX_UPGRADE-projects R2 (PRJ2-M5) — the charter caps the backend ACTUALLY
 * enforces. `parseCharter` (`backend/typescript/src/features/projects/
 * projectsService.ts` — the SSoT for these numbers) `.slice()`s and truncates
 * silently on a FULL-REPLACE patch, then returns 200 with the trimmed charter.
 * The editor showed no limit, no counter and no warning, so a pasted 30-line
 * objective list lost 10 lines and a 300-character goal lost 100, and the save
 * reported success. Mirrored here so the loss is refused at the keyboard
 * instead of happening after the write.
 *
 * Pinned in BOTH directions, which takes two tests because neither package can
 * import the other: `backend/typescript/test/projects-charter-caps.test.ts`
 * asserts the truncation behaviourally (a backend cap moving goes red), and
 * `__tests__/charterCapParity.test.ts` parses the caps out of the backend
 * source (a value HERE moving goes red). The first draft shipped only the
 * former while claiming both — so lowering a number in this file would have
 * blocked saves the server accepts, with the whole suite green.
 */
export const CHARTER_LIMITS = {
  goal: 200,
  brief: 8000,
  objectives: 20,
  objectiveLength: 200,
  milestones: 50,
  milestoneTitle: 160,
} as const;

const base = `${config.baseUrl}/host/openwop-app/projects`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    // PROJ-UX-1 — carry the status + parsed error envelope on the thrown error
    // (additive: the message convention is unchanged) so the UI can surface the
    // server's typed reason instead of discarding the body. The cadence editor
    // keys on `status`; `classifyHttpError`/`errorCodeOf` read the rest.
    const body: unknown = await res.json().catch(() => undefined);
    throw Object.assign(new Error(`${ctx} failed (${res.status})`), { status: res.status, ...(body !== undefined ? { body } : {}) });
  }
  return res.json() as Promise<T>;
}

export async function listProjects(): Promise<Project[]> {
  return (await asJson<{ projects: Project[] }>(await fetch(base, fetchOpts({ headers: authedHeaders() })), 'listProjects')).projects;
}

export async function createProject(orgId: string, name: string): Promise<Project> {
  return asJson<Project>(await fetch(base, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ orgId, name }) })), 'createProject');
}

export async function getProject(id: string): Promise<Project> {
  return asJson<Project>(await fetch(`${base}/${encodeURIComponent(id)}`, fetchOpts({ headers: authedHeaders() })), 'getProject');
}

/** PROJ-UX-5 — the backend's honest cleanup counts (PRJ2-R6 fixed the fabricated
 *  count; this client then discarded the body, leaving the receipt with zero
 *  readers repo-wide). Fields absent on older backends are simply omitted. */
export interface DeleteProjectReceipt {
  deleted: boolean;
  memoryEntriesCleared?: number;
  schedulesCleared?: number;
  conversationsDeleted?: number;
  /** Notebook-facet only — the exclusively-provisioned source corpus. */
  notebookCorpusDeleted?: boolean;
}

export async function deleteProject(id: string): Promise<DeleteProjectReceipt> {
  return asJson<DeleteProjectReceipt>(await fetch(`${base}/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })), 'deleteProject');
}

/** Set the project's assigned-workflow portfolio (the pool its schedules + board
 *  trigger lanes draw on). PATCHes `workflows`; returns the updated project. */
export async function updateWorkflows(id: string, workflows: string[]): Promise<Project> {
  return asJson<Project>(await fetch(`${base}/${encodeURIComponent(id)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ workflows }) })), 'updateWorkflows');
}

/** ADR 0054 D1 — set the project's charter (full replace; `null` clears). */
export async function updateCharter(id: string, charter: ProjectCharter | null): Promise<Project> {
  return asJson<Project>(await fetch(`${base}/${encodeURIComponent(id)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ charter }) })), 'updateCharter');
}

/** ADR 0054 D6 — set the project group chat's cadence. `moderatorRosterId` MUST be
 *  a project agent member (server-validated); `null` clears either field. */
export async function updateChatCadence(
  id: string,
  patch: { moderatorRosterId?: string | null; turnPolicy?: TurnPolicy | null },
): Promise<Project> {
  return asJson<Project>(await fetch(`${base}/${encodeURIComponent(id)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) })), 'updateChatCadence');
}

// ── ADR 0054 D2/D5 — membership + visibility (always-on since 2026-06-16) ──
export async function listProjectMembers(id: string): Promise<{ members: ProjectMember[]; visibility: ProjectVisibility }> {
  return asJson<{ members: ProjectMember[]; visibility: ProjectVisibility }>(await fetch(`${base}/${encodeURIComponent(id)}/members`, fetchOpts({ headers: authedHeaders() })), 'listProjectMembers');
}
export async function addProjectMember(id: string, ref: string, role: ProjectRole): Promise<ProjectMember[]> {
  return (await asJson<{ members: ProjectMember[] }>(await fetch(`${base}/${encodeURIComponent(id)}/members`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ ref, role }) })), 'addProjectMember')).members;
}
export async function removeProjectMember(id: string, ref: string): Promise<void> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/members/${encodeURIComponent(ref)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`removeProjectMember failed (${res.status})`);
}
export async function setProjectVisibility(id: string, visibility: ProjectVisibility): Promise<Project> {
  return asJson<Project>(await fetch(`${base}/${encodeURIComponent(id)}/visibility`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify({ visibility }) })), 'setProjectVisibility');
}

/** ADR 0054 D3 — ensure (idempotent) the project's group conversation + seed its
 *  agent members; returns the chat sessionId to open. */
export async function ensureProjectChat(id: string): Promise<{ sessionId: string }> {
  return asJson<{ sessionId: string }>(await fetch(`${base}/${encodeURIComponent(id)}/chat`, fetchOpts({ method: 'POST', headers: jsonHeaders() })), 'ensureProjectChat');
}

export async function listMemory(id: string): Promise<MemoryNote[]> {
  return (await asJson<{ notes: MemoryNote[] }>(await fetch(`${base}/${encodeURIComponent(id)}/memory`, fetchOpts({ headers: authedHeaders() })), 'listMemory')).notes;
}

export async function addMemory(id: string, content: string): Promise<MemoryNote[]> {
  return (await asJson<{ notes: MemoryNote[] }>(await fetch(`${base}/${encodeURIComponent(id)}/memory`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ content }) })), 'addMemory')).notes;
}

export async function deleteMemory(id: string, noteId: string): Promise<void> {
  const res = await fetch(`${base}/${encodeURIComponent(id)}/memory/${encodeURIComponent(noteId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`deleteMemory failed (${res.status})`);
}

export async function listOrgs(): Promise<Org[]> {
  return (await asJson<{ orgs: Org[] }>(await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() })), 'listOrgs')).orgs;
}
