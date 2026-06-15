/**
 * Board of Advisors service (ADR 0040) — the thin composition layer over the
 * roster (advisors), the host convene orchestration (`host/advisoryBoardConvene`),
 * and a host-ext durable store for the board entity + session transcripts. It adds
 * NO persona store and NO RAG store (those are the roster + ADR 0038, composed in
 * the convene layer). Visibility (`private`/`shared`) is server-authoritative; the
 * route layer enforces the toggle + RBAC + org scope BEFORE any method here runs.
 *
 * @see docs/adr/0040-board-of-advisors.md
 */

import { randomBytes } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { getRosterEntry } from '../../host/rosterService.js';
import { conveneAdvisors, defaultCouncilReply, type CouncilReply } from '../../host/advisoryBoardConvene.js';
import type { AdvisoryBoard, AdvisorySession, BoardVisibility, CouncilTurn, PersonaKind } from './types.js';

const PERSONA_KINDS: readonly PersonaKind[] = ['historical', 'fictional', 'original', 'living'];
const VISIBILITIES: readonly BoardVisibility[] = ['private', 'shared'];

const LIMITS = {
  name: 120,
  handle: 60,
  advisors: 8,          // fan-out cap (cost; ADR 0040 § Open questions)
  prompt: 8000,
  maxRounds: 3,
} as const;

const boards = new DurableCollection<AdvisoryBoard>('advisory:board', (b) => `${b.tenantId}:${b.boardId}`);
const sessions = new DurableCollection<AdvisorySession>('advisory:session', (s) => `${s.tenantId}:${s.sessionId}`);

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
  turnPolicy?: { rounds?: unknown; order?: unknown; synthesize?: unknown };
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

function readTurnPolicy(v: BoardInput['turnPolicy']): AdvisoryBoard['turnPolicy'] {
  const rounds = typeof v?.rounds === 'number' && Number.isFinite(v.rounds) ? Math.min(LIMITS.maxRounds, Math.max(1, Math.floor(v.rounds))) : 1;
  const order = v?.order === 'round-robin' ? 'round-robin' : 'declared';
  const synthesize = v?.synthesize === undefined ? true : Boolean(v.synthesize);
  return { rounds, order, synthesize };
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

  const ts = now();
  const board: AdvisoryBoard = {
    boardId: `host:advisory:${slugify(name)}-${shortId()}`,
    tenantId,
    orgId,
    name,
    handle,
    advisors,
    ...(moderatorRosterId ? { moderatorRosterId } : {}),
    visibility: readVisibility(input.visibility),
    personaKind,
    ...(livingAck ? { livingPersonaAck: true } : {}),
    turnPolicy: readTurnPolicy(input.turnPolicy),
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
  if (input.turnPolicy !== undefined) next.turnPolicy = readTurnPolicy(input.turnPolicy);
  if (input.advisors !== undefined) next.advisors = await resolveCohort(tenantId, input.advisors);
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

export async function getSession(tenantId: string, userId: string | undefined, boardId: string, sessionId: string): Promise<AdvisorySession> {
  await getBoard(tenantId, userId, boardId); // visibility gate on the board
  const s = await sessions.get(`${tenantId}:${sessionId}`);
  if (!s || s.boardId !== boardId) throw new OpenwopError('not_found', 'Session not found.', 404, { sessionId });
  return s;
}

interface ConveneInput { prompt?: unknown; sessionId?: unknown }

/** Run a council round on a board and persist the transcript. Reuses the host
 *  convene orchestration; `reply` is injectable for tests (default = managed/mock
 *  per the request's provider). Continues an existing `sessionId` or starts one. */
export async function convene(
  tenantId: string,
  userId: string | undefined,
  userName: string | null,
  boardId: string,
  input: ConveneInput,
  replyOverride?: CouncilReply,
): Promise<AdvisorySession> {
  const board = await getBoard(tenantId, userId, boardId);
  // Living-persona ack is fail-closed at convene too (a board edited to `living`
  // without re-acking can't run).
  assertLivingAck(board.personaKind, board.livingPersonaAck);
  const prompt = str(input.prompt, 'prompt', LIMITS.prompt);

  let session = input.sessionId !== undefined
    ? await sessions.get(`${tenantId}:${str(input.sessionId, 'sessionId', 120)}`)
    : null;
  if (input.sessionId !== undefined && (!session || session.boardId !== boardId)) {
    throw new OpenwopError('not_found', 'Session not found.', 404, { sessionId: input.sessionId });
  }

  // The cohort is resolved (and stamped) at FIRST convene — a later board edit
  // doesn't rewrite an in-flight transcript (ADR 0040 §9).
  const cohort = session?.resolvedCohort ?? { advisors: board.advisors, ...(board.moderatorRosterId ? { moderatorRosterId: board.moderatorRosterId } : {}) };

  // Always the managed (free-tier) provider — the provider is a SERVER decision,
  // never client-selectable from the request body (a `mock`-provider passthrough
  // would let a caller bypass the managed path in prod). Tests inject via
  // `replyOverride`, not an HTTP provider field.
  const reply = replyOverride ?? defaultCouncilReply(tenantId);
  const priorTurns: CouncilTurn[] = session?.turns ?? [];
  const newTurns = await conveneAdvisors(
    {
      tenantId,
      userName,
      prompt,
      advisors: cohort.advisors,
      moderatorRosterId: cohort.moderatorRosterId,
      personaKind: board.personaKind,
      synthesize: board.turnPolicy.synthesize,
      priorTurns,
    },
    { reply },
  );

  const ts = now();
  if (!session) {
    session = {
      sessionId: `sess_${shortId()}${shortId()}`,
      boardId,
      tenantId,
      createdBy: userId ?? 'unknown',
      resolvedCohort: cohort,
      turns: newTurns,
      createdAt: ts,
      updatedAt: ts,
    };
  } else {
    session = { ...session, turns: [...session.turns, ...newTurns], updatedAt: ts };
  }
  await sessions.put(session);
  return session;
}
