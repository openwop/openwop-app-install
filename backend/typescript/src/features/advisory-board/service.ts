/**
 * Board of Advisors service (ADR 0040) — the board ENTITY store: a named, ordered
 * cohort of advisor rosterIds (+ moderator, visibility, persona kind). It adds NO
 * persona store, NO RAG store, and NO transcript/convene runtime — the boardroom
 * conversation runs in the AI chat over the existing `chat.turn` infra (ADR 0040
 * § Correction 2026-06-15); this service only resolves a board so the chat can
 * expand its cohort into the active-agents lineup. Visibility (`private`/`shared`)
 * is server-authoritative; the route layer enforces toggle + RBAC + org scope
 * BEFORE any method here runs.
 *
 * @see docs/adr/0040-board-of-advisors.md
 */

import { randomBytes } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { getRosterEntry } from '../../host/rosterService.js';
import { parseTurnPolicy } from '../../host/turnPolicy.js';
// ADR 0079 Phase 5 — strategy context (one-directional import; strategy never
// imports advisory-board, so no cycle).
import { getStrategy, canSubjectReadStrategy, buildStrategyContextBlock, resolveStrategyEntriesByIds } from '../strategy/strategyService.js';
import { getProject, resolveProjectAccess, buildProjectContextBlock } from '../projects/projectsService.js';
import type { StrategyContextEntry } from '../strategy/types.js';
import type { AdvisoryBoard, AdvisoryContextRef, BoardVisibility, PersonaKind } from './types.js';

const PERSONA_KINDS: readonly PersonaKind[] = ['historical', 'fictional', 'original', 'living'];
const VISIBILITIES: readonly BoardVisibility[] = ['private', 'shared'];

const LIMITS = {
  name: 120,
  handle: 60,
  advisors: 8,          // cohort cap (cost; ADR 0040 § Open questions)
  contextRefs: 20,      // strategy context cap (ADR 0079 Phase 5)
} as const;

const boards = new DurableCollection<AdvisoryBoard>('advisory:board', (b) => `${b.tenantId}:${b.boardId}`);

const now = (): string => new Date().toISOString();
const shortId = (): string => randomBytes(5).toString('hex');

function str(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  const s = v.trim();
  if (s.length > max) throw new OpenwopError('validation_error', `Field \`${field}\` MUST be ${max} characters or fewer.`, 400, { field });
  return s;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, LIMITS.handle) || 'board';
}

/** A simulated-persona disclaimer surfaced in the projection so the UI always
 *  shows "not the real person" (ADR 0040 § "Legal / likeness governance"). */
export function disclaimerFor(personaKind: PersonaKind): string | null {
  if (personaKind === 'original' || personaKind === 'fictional') return null;
  return 'Advisors are simulated personas for ideation only — not the real individuals, and not endorsed by them.';
}

/** Validate + normalize the advisor cohort: each must be a roster agent in this
 *  tenant (no cross-tenant ids; no shadow KanbanBoard ids). De-duped, order kept. */
async function resolveCohort(tenantId: string, raw: unknown): Promise<string[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new OpenwopError('validation_error', 'Field `advisors` is required and MUST be a non-empty array of roster ids.', 400, { field: 'advisors' });
  }
  if (raw.length > LIMITS.advisors) {
    throw new OpenwopError('validation_error', `A board MUST have ${LIMITS.advisors} advisors or fewer.`, 400, { field: 'advisors' });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new OpenwopError('validation_error', 'Each advisor MUST be a non-empty roster id.', 400, { field: 'advisors' });
    }
    const rosterId = id.trim();
    if (seen.has(rosterId)) continue;
    const entry = await getRosterEntry(rosterId);
    if (!entry || entry.tenantId !== tenantId) {
      throw new OpenwopError('not_found', `Advisor not found in this workspace: ${rosterId}`, 404, { rosterId });
    }
    seen.add(rosterId);
    out.push(rosterId);
  }
  return out;
}

function projectBoard(b: AdvisoryBoard): AdvisoryBoard & { disclaimer: string | null } {
  return { ...b, disclaimer: disclaimerFor(b.personaKind) };
}

/** A board the caller may SEE: `shared` ⇒ any workspace member (RBAC already
 *  checked `workspace:read`); `private` ⇒ only the creator. */
function canRead(b: AdvisoryBoard, userId: string | undefined): boolean {
  return b.visibility === 'shared' || (b.createdBy === userId && !!userId);
}

export async function listBoards(tenantId: string, userId: string | undefined): Promise<Array<AdvisoryBoard & { disclaimer: string | null }>> {
  const all = await boards.listByPrefix(`${tenantId}:`);
  return all.filter((b) => canRead(b, userId)).sort((a, b) => a.name.localeCompare(b.name)).map(projectBoard);
}

/** Load a board the caller may read, or 404 (a private board the caller doesn't
 *  own is indistinguishable from a missing one — no existence leak). */
export async function getBoard(tenantId: string, userId: string | undefined, boardId: string): Promise<AdvisoryBoard> {
  const b = await boards.get(`${tenantId}:${boardId}`);
  if (!b || !canRead(b, userId)) throw new OpenwopError('not_found', 'Board not found.', 404, { boardId });
  return b;
}

export async function getBoardView(tenantId: string, userId: string | undefined, boardId: string): Promise<AdvisoryBoard & { disclaimer: string | null }> {
  return projectBoard(await getBoard(tenantId, userId, boardId));
}

interface BoardInput {
  name?: unknown; handle?: unknown; advisors?: unknown; moderatorRosterId?: unknown;
  visibility?: unknown; personaKind?: unknown; livingPersonaAck?: unknown;
  contextRefs?: unknown;
  turnPolicy?: { rounds?: unknown; order?: unknown; synthesize?: unknown };
}

/**
 * Validate the selected strategy context refs (ADR 0079 Phase 5). Each ref MUST
 * be a strategy the SETTING USER can read (404 on an unreadable/absent strategy —
 * a board can't carry context its author can't see); deduped + capped. The
 * convene-time resolution RBAC-filters AGAIN for the convener (defense in depth).
 */
async function resolveContextRefs(tenantId: string, actor: string | undefined, raw: unknown): Promise<AdvisoryContextRef[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new OpenwopError('validation_error', '`contextRefs` MUST be an array.', 400, { field: 'contextRefs' });
  const out: AdvisoryContextRef[] = [];
  const seen = new Set<string>();
  for (const r of raw.slice(0, LIMITS.contextRefs)) {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    if (o.kind === 'strategy') {
      const strategyId = str(o.strategyId, 'contextRefs.strategyId', 128);
      if (seen.has(`strategy:${strategyId}`)) continue;
      seen.add(`strategy:${strategyId}`);
      const s = await getStrategy(tenantId, strategyId);
      if (!s || !(await canSubjectReadStrategy(tenantId, actor, s))) {
        throw new OpenwopError('not_found', 'Strategy not found or not readable.', 404, { strategyId });
      }
      out.push({ kind: 'strategy', strategyId });
    } else if (o.kind === 'project') {
      const projectId = str(o.projectId, 'contextRefs.projectId', 128);
      if (seen.has(`project:${projectId}`)) continue;
      seen.add(`project:${projectId}`);
      // RBAC: the convener must be able to READ the project (a `private` project
      // they're not a member of is rejected — mirrors the strategy readability gate).
      if (!(await getProject(tenantId, projectId)) || (await resolveProjectAccess(tenantId, projectId, actor)) === 'none') {
        throw new OpenwopError('not_found', 'Project not found or not readable.', 404, { projectId });
      }
      out.push({ kind: 'project', projectId });
    } else {
      throw new OpenwopError('validation_error', '`contextRefs[].kind` MUST be "strategy" or "project".', 400, { field: 'contextRefs.kind' });
    }
  }
  return out;
}

function readPersonaKind(v: unknown): PersonaKind {
  if (v === undefined) return 'historical';
  if (typeof v !== 'string' || !PERSONA_KINDS.includes(v as PersonaKind)) {
    throw new OpenwopError('validation_error', `Field \`personaKind\` MUST be one of: ${PERSONA_KINDS.join(', ')}.`, 400, { field: 'personaKind' });
  }
  return v as PersonaKind;
}

function readVisibility(v: unknown): BoardVisibility {
  if (v === undefined) return 'private';
  if (typeof v !== 'string' || !VISIBILITIES.includes(v as BoardVisibility)) {
    throw new OpenwopError('validation_error', `Field \`visibility\` MUST be one of: ${VISIBILITIES.join(', ')}.`, 400, { field: 'visibility' });
  }
  return v as BoardVisibility;
}

/** A living-persona board MUST carry the acknowledgement (right-of-publicity /
 *  defamation guard). Fail-closed at create AND convene. */
function assertLivingAck(personaKind: PersonaKind, ack: unknown): boolean | undefined {
  if (personaKind !== 'living') return ack === true ? true : undefined;
  if (ack !== true) {
    throw new OpenwopError(
      'validation_error',
      'A board that simulates living individuals requires `livingPersonaAck: true` — an acknowledgement that these are non-endorsed simulations.',
      422,
      { field: 'livingPersonaAck' },
    );
  }
  return true;
}

async function uniqueHandle(tenantId: string, desired: string, exceptBoardId?: string): Promise<string> {
  const existing = await boards.listByPrefix(`${tenantId}:`);
  const taken = new Set(existing.filter((b) => b.boardId !== exceptBoardId).map((b) => b.handle));
  if (!taken.has(desired)) return desired;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${desired}-${i}`.slice(0, LIMITS.handle);
    if (!taken.has(candidate)) return candidate;
  }
  return `${desired}-${shortId()}`.slice(0, LIMITS.handle);
}

export async function createBoard(tenantId: string, orgId: string, actor: string, input: BoardInput): Promise<AdvisoryBoard & { disclaimer: string | null }> {
  const name = str(input.name, 'name', LIMITS.name);
  const personaKind = readPersonaKind(input.personaKind);
  const livingAck = assertLivingAck(personaKind, input.livingPersonaAck);
  const advisors = await resolveCohort(tenantId, input.advisors);
  const moderatorRosterId = input.moderatorRosterId === undefined ? undefined : str(input.moderatorRosterId, 'moderatorRosterId', LIMITS.handle);
  if (moderatorRosterId) {
    const mod = await getRosterEntry(moderatorRosterId);
    if (!mod || mod.tenantId !== tenantId) throw new OpenwopError('not_found', 'Moderator not found in this workspace.', 404, { moderatorRosterId });
  }
  const desiredHandle = input.handle === undefined ? slugify(name) : slugify(str(input.handle, 'handle', LIMITS.handle));
  const handle = await uniqueHandle(tenantId, desiredHandle);
  const contextRefs = await resolveContextRefs(tenantId, actor, input.contextRefs);

  const ts = now();
  const board: AdvisoryBoard = {
    boardId: `host:advisory:${slugify(name)}-${shortId()}`,
    tenantId,
    orgId,
    name,
    handle,
    advisors,
    ...(moderatorRosterId ? { moderatorRosterId } : {}),
    ...(contextRefs.length ? { contextRefs } : {}),
    visibility: readVisibility(input.visibility),
    personaKind,
    ...(livingAck ? { livingPersonaAck: true } : {}),
    turnPolicy: parseTurnPolicy(input.turnPolicy),
    createdBy: actor,
    createdAt: ts,
    updatedAt: ts,
  };
  await boards.put(board);
  return projectBoard(board);
}

export async function updateBoard(tenantId: string, userId: string | undefined, boardId: string, input: BoardInput): Promise<AdvisoryBoard & { disclaimer: string | null }> {
  const board = await getBoard(tenantId, userId, boardId);
  if (board.createdBy !== userId) throw new OpenwopError('forbidden_scope', 'Only the board owner can edit it.', 403, { boardId });

  const next: AdvisoryBoard = { ...board, updatedAt: now() };
  if (input.name !== undefined) next.name = str(input.name, 'name', LIMITS.name);
  if (input.personaKind !== undefined) next.personaKind = readPersonaKind(input.personaKind);
  if (input.visibility !== undefined) next.visibility = readVisibility(input.visibility);
  if (input.turnPolicy !== undefined) next.turnPolicy = parseTurnPolicy(input.turnPolicy);
  if (input.advisors !== undefined) next.advisors = await resolveCohort(tenantId, input.advisors);
  if (input.contextRefs !== undefined) {
    const refs = await resolveContextRefs(tenantId, userId, input.contextRefs);
    if (refs.length) next.contextRefs = refs; else delete next.contextRefs;
  }
  if (input.moderatorRosterId !== undefined) {
    if (input.moderatorRosterId === null) { delete next.moderatorRosterId; }
    else {
      const moderatorRosterId = str(input.moderatorRosterId, 'moderatorRosterId', LIMITS.handle);
      const mod = await getRosterEntry(moderatorRosterId);
      if (!mod || mod.tenantId !== tenantId) throw new OpenwopError('not_found', 'Moderator not found in this workspace.', 404, { moderatorRosterId });
      next.moderatorRosterId = moderatorRosterId;
    }
  }
  if (input.handle !== undefined) next.handle = await uniqueHandle(tenantId, slugify(str(input.handle, 'handle', LIMITS.handle)), boardId);
  // Re-assert the living-persona ack against the resolved final state.
  const ack = input.livingPersonaAck !== undefined ? input.livingPersonaAck : next.livingPersonaAck;
  const finalAck = assertLivingAck(next.personaKind, ack);
  if (finalAck) next.livingPersonaAck = true; else delete next.livingPersonaAck;

  await boards.put(next);
  return projectBoard(next);
}

// ── strategy context (ADR 0079 Phase 5) ───────────────────────────────────────

/** The strategy ids a board carries as context. */
function strategyIdsOf(board: AdvisoryBoard): string[] {
  return (board.contextRefs ?? []).flatMap((r) => (r.kind === 'strategy' ? [r.strategyId] : []));
}

/** The project ids a board carries as context. */
function projectIdsOf(board: AdvisoryBoard): string[] {
  return (board.contextRefs ?? []).flatMap((r) => (r.kind === 'project' ? [r.projectId] : []));
}

/**
 * The board-context RESOLVER registered into the core seam (ADR 0079 §Correction).
 * Core calls this at board-group formation; it loads the board (raw — the convener
 * already passed board RBAC at the `@@` summon) and builds the strategy block,
 * RBAC-filtered for the convener. Fail-soft: a missing board / no refs ⇒ null.
 */
export async function resolveBoardStrategyContext(tenantId: string, boardId: string, convener: string | undefined): Promise<string | null> {
  const board = await boards.get(`${tenantId}:${boardId}`);
  if (!board) return null;
  const strategyIds = strategyIdsOf(board);
  const projectIds = projectIdsOf(board);
  // Both static-context kinds (ADR 0079 strategy + ADR 0100 project), each
  // RBAC-filtered for the convener, concatenated into one boardroom context block.
  const blocks = (await Promise.all([
    strategyIds.length > 0 ? buildStrategyContextBlock(tenantId, strategyIds, convener) : Promise.resolve(null),
    projectIds.length > 0 ? buildProjectContextBlock(tenantId, projectIds, convener) : Promise.resolve(null),
  ])).filter((b): b is string => Boolean(b));
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

/** Preview the resolved strategy context a board would give its advisors,
 *  RBAC-filtered for the CALLER (the FE "preview before convening"). The board
 *  read is RBAC-gated by `getBoard` (visibility + tenant). */
export async function previewBoardStrategyContext(tenantId: string, userId: string | undefined, boardId: string): Promise<StrategyContextEntry[]> {
  const board = await getBoard(tenantId, userId, boardId);
  return resolveStrategyEntriesByIds(tenantId, strategyIdsOf(board), userId);
}

export async function deleteBoard(tenantId: string, userId: string | undefined, boardId: string): Promise<void> {
  const board = await getBoard(tenantId, userId, boardId);
  if (board.createdBy !== userId) throw new OpenwopError('forbidden_scope', 'Only the board owner can delete it.', 403, { boardId });
  await boards.delete(`${tenantId}:${boardId}`);
}

/** The boardIds in this tenant created by the demo seed (`createdBy` marker) —
 *  used by the demo-data registry to count + clear ONLY seeded boards, never a
 *  user-authored one. */
const SEED_ACTOR = 'demo:advisory-seed';
export async function listSeededBoardIds(tenantId: string): Promise<string[]> {
  return (await boards.listByPrefix(`${tenantId}:`)).filter((b) => b.createdBy === SEED_ACTOR).map((b) => b.boardId);
}

/** Delete ONLY the demo-seeded advisory boards in this tenant (admin/seed-clear
 *  path — bypasses the owner check `deleteBoard` enforces, but is scoped to the
 *  seed `createdBy` marker so it never removes a user-created board). Returns the
 *  count deleted. */
export async function clearSeededAdvisoryBoards(tenantId: string): Promise<number> {
  const ids = await listSeededBoardIds(tenantId);
  for (const boardId of ids) await boards.delete(`${tenantId}:${boardId}`);
  return ids.length;
}

/** Resolve a board by its `@@<handle>` summon token (visibility-gated). Returns
 *  the board + its advisor + moderator rosterIds so the AI chat can expand the
 *  cohort into the active-agents lineup. The chat conversation itself runs on the
 *  existing `chat.turn` infra (ADR 0040 § Correction 2026-06-15) — there is no
 *  separate convene/transcript here. */
export async function getBoardByHandle(
  tenantId: string,
  userId: string | undefined,
  handle: string,
): Promise<AdvisoryBoard & { disclaimer: string | null }> {
  const norm = slugify(handle);
  const b = (await boards.listByPrefix(`${tenantId}:`)).find((x) => x.handle === norm && canRead(x, userId));
  if (!b) throw new OpenwopError('not_found', 'Board not found.', 404, { handle });
  return projectBoard(b);
}
