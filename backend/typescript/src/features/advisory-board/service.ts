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
import { MAX_MULTI_PARTY_PARTICIPANTS } from '../../host/multiPartyConversation.js';
// ADR 0079 Phase 5 — strategy context (one-directional import; strategy never
// imports advisory-board, so no cycle).
import { getStrategy, canSubjectReadStrategy, buildStrategyContextBlock, resolveStrategyEntriesByIds } from '../strategy/strategyService.js';
import { getProject, resolveProjectAccess, buildProjectContextBlock } from '../projects/projectsService.js';
import type { StrategyContextEntry } from '../strategy/types.js';
import type { AdvisoryBoard, AdvisoryContextRef, BoardVisibility, PersonaKind } from './types.js';
import { reconcileCohortBindings, getBoardSharedKnowledge, reconcileBoardForSourceChange } from './advisoryBoardKnowledgeService.js';
import { subjectConversationId, releaseConversationOwnerSubject } from '../../host/conversationStore.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import type { AccessLevel } from '../../host/subjectAccess.js';
import type { Subject } from '../../host/subject.js';
import type { BoardContextValue } from '../../host/boardContextResolver.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.advisory-board');

/** R3 (the low-tier-R2 flagged residual) — the own-board effective-kinds read
 *  used to fail SILENTLY as [] ("nothing shared"), so a degraded reconcile —
 *  which over-retains by design (removed advisors keep bindings until the next
 *  idempotent toggle/edit re-converges) — was indistinguishable from a healthy
 *  one. Semantics unchanged (over-retain, never over-remove; never fail the
 *  caller); the degradation is now a NAMED event an operator can see. */
async function ownEffectiveShared(tenantId: string, board: AdvisoryBoard, phase: string): Promise<string[]> {
  try {
    return (await getBoardSharedKnowledge(tenantId, board)).filter((i) => i.shared).map((i) => i.kind);
  } catch (err) {
    log.warn('shared_knowledge_read_degraded', { boardId: board.boardId, phase, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

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

/**
 * A simulated-persona disclaimer surfaced in the projection so the UI always
 * shows "not the real person" (ADR 0040 § "Legal / likeness governance").
 *
 * ADR 0588 D5 — TOTAL: every persona kind yields a disclaimer. It used to return
 * `null` for `original`/`fictional`, and `personaKind` is an unvalidated
 * board-level dropdown never correlated with the cohort — so a board of the four
 * seeded living-figure simulations, set to "Original personas", shipped with no
 * disclaimer at all. Removing the null arm is what makes an unvalidated
 * self-declaration safe to leave unvalidated: the *worst* case is now a weaker
 * true statement (every advisor IS a simulation) rather than silence.
 *
 * The return type stays `string | null` because the wire shape and every FE
 * renderer already handle null; nothing in-tree produces it today.
 */
export function disclaimerFor(personaKind: PersonaKind): string | null {
  if (personaKind === 'original' || personaKind === 'fictional') {
    return 'Advisors are simulated AI personas for ideation only — not real advisors, and their guidance is not professional advice.';
  }
  return 'Advisors are simulated personas for ideation only — not the real individuals, and not endorsed by them.';
}

/**
 * ADR 0588 D5 — a `living` board MUST carry an acknowledgement before it can
 * convene. `types.ts` has promised this since ADR 0040 ("MUST be set before the
 * board can convene") and NOTHING enforced it: `assertLivingAck` fires only at
 * create/update, which the seed satisfied by fabricating the ack outright.
 *
 * Fail-closed on all THREE convene lanes — the canonical `…/chat` route, core's
 * `@@`-summon cohort resolve, and the TURN itself (`boardConveneRefusal` →
 * `host/chatContext.ts`, which is the ONE composition owner for text chat AND
 * realtime voice). The seeded demo board is unconvenable until its owner
 * acknowledges: the governance gate demonstrating itself, rather than being
 * bypassed by the one cohort in the product that triggers it.
 *
 * **CORRECTION (H1, 2026-08-20).** This comment used to claim "Fail-closed on
 * BOTH convene lanes … so the seeded demo board is now unconvenable", and for one
 * population that was FALSE — measured by running it, not by reading. The two
 * lanes it named are both room-CREATION lanes. A tenant that had ALREADY opened
 * the Titans boardroom — precisely the population `clearFabricatedLivingAcks`
 * targets, since the fabricated ack is what let them open it — kept a fully
 * seated `type:'group'` conversation one click away in the sidebar, and it
 * composed turns normally after the ack was stripped (`chatContext` even
 * re-resolved its board block for it). Gating where the turn is composed is what
 * makes the sentence true.
 */
export function assertBoardConvenable(board: AdvisoryBoard): void {
  if (board.personaKind === 'living' && board.livingPersonaAck !== true) {
    throw new OpenwopError(
      'validation_error',
      'This board simulates living individuals. Its owner must acknowledge that these are non-endorsed simulations before it can convene.',
      422,
      { field: 'livingPersonaAck', boardId: board.boardId },
    );
  }
}

/**
 * H1 / ADR 0588 D5 — the CONVENE GATE registered into the board seam, evaluated
 * on the turn path. Returns the refusal MESSAGE for a board that may not convene,
 * or `null`.
 *
 * Caller-neutral on purpose: it reads only the board's own governance state, so
 * it needs no subject and can never become an existence oracle for a caller who
 * cannot read the board (the conversation's own visibility gate already decided
 * that, upstream, before a turn composes at all).
 *
 * A MISSING board returns `null`, not a refusal: "the board is gone" is not this
 * gate's business, and the board-context leg composes nothing for it anyway.
 */
export async function boardConveneRefusal(tenantId: string, boardId: string): Promise<string | null> {
  const board = await boards.get(`${tenantId}:${boardId}`);
  if (!board) return null;
  try {
    assertBoardConvenable(board);
    return null;
  } catch (err) {
    if (err instanceof OpenwopError) return err.message;
    throw err;
  }
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
    const entry = await getRosterEntry(tenantId, rosterId);
    if (!entry) {
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

/**
 * WF-BOA-6 — the SEATED cohort is moderator + advisors, and `discovery.ts`
 * advertises `multiPartyConversation.maxParticipants = MAX_MULTI_PARTY_PARTICIPANTS`
 * (8) describing exactly this. `LIMITS.advisors` capped the advisors ALONE and
 * `moderatorRosterId` was validated independently with no requirement that it be
 * one of them, so a board could seat NINE against an advertised eight. The number
 * was enforced only in `routes/multiPartyConversationSeam.ts` — a separate
 * in-memory `councils` map no board conversation ever touches, which is also the
 * only thing the conformance leg drives. Enforced HERE, where the cohort is
 * actually built, so the advertisement describes the production lane.
 */
function assertCohortSeats(advisors: readonly string[], moderatorRosterId: string | undefined): void {
  const seats = advisors.length + (moderatorRosterId && !advisors.includes(moderatorRosterId) ? 1 : 0);
  if (seats > MAX_MULTI_PARTY_PARTICIPANTS) {
    throw new OpenwopError(
      'validation_error',
      `A board seats at most ${MAX_MULTI_PARTY_PARTICIPANTS} participants (advisors plus a chair who is not one of them).`,
      400,
      { field: 'advisors', seats, max: MAX_MULTI_PARTY_PARTICIPANTS },
    );
  }
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

export interface CreateBoardOptions {
  /** ADR 0588 D5 — the SEED ONLY. Lets a demo board be created with
   *  `personaKind:'living'` and NO acknowledgement, so the seed stops
   *  fabricating a right-of-publicity record — over the FOUR advisors of the one
   *  `living` seeded board (`titans`) — that no human ever made. (CORRECTED
   *  2026-08-20: was "eight named real individuals"; the other four seeded
   *  advisors are the `historical` `timeless` board and carry no ack.) The board is created **unconvenable**
   *  (`assertBoardConvenable`) until its owner acknowledges — which is the
   *  honest state, and the only one that does not have to be un-fabricated
   *  later. NEVER pass this from a request path. */
  allowUnacknowledgedLiving?: boolean;
}

export async function createBoard(tenantId: string, orgId: string, actor: string, input: BoardInput, opts: CreateBoardOptions = {}): Promise<AdvisoryBoard & { disclaimer: string | null }> {
  const name = str(input.name, 'name', LIMITS.name);
  const personaKind = readPersonaKind(input.personaKind);
  const livingAck = opts.allowUnacknowledgedLiving && input.livingPersonaAck === undefined
    ? undefined
    : assertLivingAck(personaKind, input.livingPersonaAck);
  const advisors = await resolveCohort(tenantId, input.advisors);
  const moderatorRosterId = input.moderatorRosterId === undefined ? undefined : str(input.moderatorRosterId, 'moderatorRosterId', LIMITS.handle);
  if (moderatorRosterId) {
    const mod = await getRosterEntry(tenantId, moderatorRosterId);
    if (!mod) throw new OpenwopError('not_found', 'Moderator not found in this workspace.', 404, { moderatorRosterId });
  }
  assertCohortSeats(advisors, moderatorRosterId);
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
    // ADR 0588 D5 — ATTRIBUTED. An acknowledgement that cannot say who made it
    // is not a compliance record.
    ...(livingAck ? { livingPersonaAck: true, livingPersonaAckBy: actor, livingPersonaAckAt: ts } : {}),
    turnPolicy: parseTurnPolicy(input.turnPolicy),
    createdBy: actor,
    createdAt: ts,
    updatedAt: ts,
  };
  await boards.put(board);
  return projectBoard(board);
}

/** True for a board stamped by a synthetic demo seeder (`demo:advisory-seed`,
 *  `demo:strategy-showcase`, `demo:ops-planning`, …) rather than a person. No
 *  caller identity ever takes the `demo:` shape, so without special handling a
 *  seeded board is permanently uneditable — the same dead end ADR 0321 solved
 *  for delete with the superadmin override. */
const isSeedActor = (actor: string): boolean => actor.startsWith('demo:');

export async function updateBoard(tenantId: string, userId: string | undefined, boardId: string, input: BoardInput): Promise<AdvisoryBoard & { disclaimer: string | null }> {
  const board = await getBoard(tenantId, userId, boardId);
  // Owner-only, EXCEPT a seeded board: demo boards are starting points, so the
  // first tenant user to edit one ADOPTS it (createdBy re-stamps to them, below).
  // Adoption also drops it out of `seededBoardIds`, so seed cleanup (ADR 0321)
  // no longer deletes a board the user has made their own.
  const adopting = !!userId && userId !== board.createdBy && isSeedActor(board.createdBy);
  if (board.createdBy !== userId && !adopting) throw new OpenwopError('forbidden_scope', 'Only the board owner can edit it.', 403, { boardId });

  const ts = now();
  const next: AdvisoryBoard = { ...board, updatedAt: ts, ...(adopting && userId ? { createdBy: userId } : {}) };
  // ADR 0588 D5 (ADVB-4) — ADOPTION DOES NOT INHERIT THE ACKNOWLEDGEMENT.
  // `createdBy` re-stamps to the adopting user, and the ack re-assertion below
  // used to re-read the EXISTING `true`, so a user who merely RENAMED a seeded
  // board silently became owner-of-record of a right-of-publicity
  // acknowledgement they were never shown. Dropping it here means the PATCH must
  // carry an explicit `livingPersonaAck: true` (the form asks), or the board
  // fails 422 with the exact reason. The exit the refusal prescribes is real and
  // one click away: the edit dialog renders the acknowledgement checkbox
  // whenever `personaKind` is `living`, pre-unticked.
  if (adopting) {
    delete next.livingPersonaAck;
    delete next.livingPersonaAckBy;
    delete next.livingPersonaAckAt;
  }
  if (input.name !== undefined) next.name = str(input.name, 'name', LIMITS.name);
  if (input.personaKind !== undefined) next.personaKind = readPersonaKind(input.personaKind);
  if (input.visibility !== undefined) next.visibility = readVisibility(input.visibility);
  if (input.turnPolicy !== undefined) next.turnPolicy = parseTurnPolicy(input.turnPolicy);
  const previousAdvisors = board.advisors;
  if (input.advisors !== undefined) next.advisors = await resolveCohort(tenantId, input.advisors);
  if (input.contextRefs !== undefined) {
    const refs = await resolveContextRefs(tenantId, userId, input.contextRefs);
    if (refs.length) next.contextRefs = refs; else delete next.contextRefs;
  }
  if (input.moderatorRosterId !== undefined) {
    if (input.moderatorRosterId === null) { delete next.moderatorRosterId; }
    else {
      const moderatorRosterId = str(input.moderatorRosterId, 'moderatorRosterId', LIMITS.handle);
      const mod = await getRosterEntry(tenantId, moderatorRosterId);
      if (!mod) throw new OpenwopError('not_found', 'Moderator not found in this workspace.', 404, { moderatorRosterId });
      next.moderatorRosterId = moderatorRosterId;
    }
  }
  assertCohortSeats(next.advisors, next.moderatorRosterId);
  if (input.handle !== undefined) next.handle = await uniqueHandle(tenantId, slugify(str(input.handle, 'handle', LIMITS.handle)), boardId);
  // Re-assert the living-persona ack against the resolved final state.
  const ack = input.livingPersonaAck !== undefined ? input.livingPersonaAck : next.livingPersonaAck;
  const finalAck = assertLivingAck(next.personaKind, ack);
  if (finalAck) {
    next.livingPersonaAck = true;
    // Re-attribute whenever the PATCH itself carries the acknowledgement (an
    // adoption always does, per the drop above). An inherited ack keeps its
    // original attribution — including "absent", for pre-0588 rows.
    if (input.livingPersonaAck === true && userId) { next.livingPersonaAckBy = userId; next.livingPersonaAckAt = ts; }
  } else {
    delete next.livingPersonaAck;
    delete next.livingPersonaAckBy;
    delete next.livingPersonaAckAt;
  }

  await boards.put(next);

  // ADR 0277 P2 — reconcile the Shared-knowledge bindings against the cohort
  // change. Previously an ADDED advisor silently got no bindings (and the
  // toggle read OFF via the derived check) and a REMOVED advisor kept org
  // strategy/priority/project KBs forever (a grant leak). Cross-board
  // protection: skip unbinding an advisor another board still grants that kind
  // to (conservative — over-retain, never over-remove). Best-effort: a
  // reconcile failure never fails the board update (bindings re-converge on
  // the next share toggle or cohort edit — both idempotent).
  if (input.advisors !== undefined) {
    const removed = previousAdvisors.filter((a) => !next.advisors.includes(a));
    const added = next.advisors.filter((a) => !previousAdvisors.includes(a));
    // GRADE-12 — reconcile the EFFECTIVE kinds: stored intent ∪ the legacy
    // DERIVED state of the PRE-edit board (a pre-0277 board whose sharedness
    // is purely derived — all advisors bound, no stored kind — previously got
    // no reconcile on ITS OWN cohort edits: removed advisors kept the org KBs).
    // Derived kinds are computed against the pre-edit cohort (`board`), which
    // is the population the grant actually covered.
    const effectiveOwn = (removed.length > 0 || added.length > 0)
      ? new Set<string>([
          ...(next.sharedKbKinds ?? []),
          ...(await ownEffectiveShared(tenantId, board, 'update_cohort_reconcile')),
        ])
      : new Set<string>();
    if ((removed.length > 0 || added.length > 0) && effectiveOwn.size > 0) {
      try {
        const others = (await boards.listByPrefix(`${tenantId}:`)).filter((b) => b.boardId !== next.boardId);
        // Effective sharedness per other board = STORED intent ∪ the legacy
        // DERIVED state (a board that shared before `sharedKbKinds` existed has
        // bindings but no stored kind — its grants must protect too, or this
        // reconcile would strip them and re-introduce the drift for that edge).
        // Bounded: only boards containing a removed advisor are consulted.
        const relevant = others.filter((b) => removed.some((r) => b.advisors.includes(r)));
        const resolveMemo = new Map<string, string[]>(); // GRADE-D2 — dedupe per (kind, org)
        const effectiveKinds = new Map<string, Set<string>>();
        for (const b of relevant) {
          const kinds = new Set<string>((await getBoardSharedKnowledge(tenantId, b, resolveMemo)).filter((i) => i.shared).map((i) => i.kind));
          effectiveKinds.set(b.boardId, kinds);
        }
        const isProtected = (advisorId: string, kind: string): boolean =>
          relevant.some((b) => b.advisors.includes(advisorId) && (effectiveKinds.get(b.boardId)?.has(kind) ?? false));
        await reconcileCohortBindings(tenantId, { ...next, sharedKbKinds: [...effectiveOwn] }, removed, added, isProtected);
      } catch (err) {
        log.warn('shared_knowledge_reconcile_failed', { boardId: next.boardId, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return projectBoard(next);
}

/**
 * ADR 0608 D5 (`CPC-3`) — the registered `ShareableKbReconciler`. Runs for every
 * board in the changed org whose EFFECTIVE shared kinds include `kind` (stored
 * intent UNION the legacy derived state, the same union `updateBoard`/`deleteBoard`
 * use — a board that shared before `sharedKbKinds` existed has bindings and no
 * stored kind, and must still be reconciled or the leak survives for exactly the
 * oldest tenants). Bounded: only boards in the affected org are read.
 */
export async function reconcileSharedKbForSourceChange(tenantId: string, orgId: string, kind: string): Promise<void> {
  const inOrg = (await boards.listByPrefix(`${tenantId}:`)).filter((b) => b.orgId === orgId);
  for (const board of inOrg) {
    const effective = new Set<string>([
      ...(board.sharedKbKinds ?? []),
      ...(await ownEffectiveShared(tenantId, board, 'source_change_reconcile')),
    ]);
    if (!effective.has(kind)) continue;
    await reconcileBoardForSourceChange(tenantId, board, kind);
  }
}

// ── canonical board conversation (ADR 0278) ──────────────────────────────────

/** An ADVISORY board as a Subject (ADR 0278) — the owner key of its ONE
 *  canonical conversation. Never host.kanban. */
export function boardSubject(boardId: string): Subject {
  return { kind: 'board', id: boardId };
}

/**
 * The caller's access level for a board Subject (the ADR 0054 D5 seam, per-kind
 * since ADR 0278). Mirrors `resolveProjectAccess`: WRITE ⟺ org `workspace:write`
 * (the ADR 0045 boundary — membership never grants write); READ ⟺ `shared`
 * visibility + org `workspace:read`, or the creator of a `private` board.
 * Missing board ⇒ 'none' (fail-closed — its conversation outlives it gated).
 */
export async function resolveBoardAccess(tenantId: string, boardId: string, callerSubject: string | undefined): Promise<AccessLevel> {
  const b = await boards.get(`${tenantId}:${boardId}`);
  if (!b) return 'none';
  const access = await resolveEffectiveAccess(tenantId, { subject: callerSubject, orgId: b.orgId });
  if (access.scopes.includes('workspace:write')) return 'write';
  if (b.visibility === 'shared' && access.scopes.includes('workspace:read')) return 'read';
  if (b.visibility === 'private' && callerSubject && b.createdBy === callerSubject) return 'read';
  return 'none';
}

/** The board's cohort as chat-callable `agent:<id>` refs — moderator first, then
 *  the advisors in declared order. ONE owner: both the canonical `…/chat` lane
 *  and core's `@@`-summon attach derive their speak-set from here, so the two
 *  can never disagree about who is seated. Roster ids with no live entry are
 *  dropped (a deleted advisor cannot speak). */
export async function boardCohortAgentRefs(tenantId: string, board: AdvisoryBoard): Promise<string[]> {
  const cohort = [
    ...(board.moderatorRosterId ? [board.moderatorRosterId] : []),
    ...board.advisors.filter((id) => id !== board.moderatorRosterId),
  ];
  const refs: string[] = [];
  for (const rosterId of cohort) {
    const entry = await getRosterEntry(tenantId, rosterId);
    if (entry) refs.push(`agent:${entry.agentRef.agentId}`);
  }
  return refs;
}

/**
 * WF-BOA-3 — the board-READ gate + speak-set for core's `@@`-summon attach lane
 * (`POST /chat/sessions/:id/board`), registered into the board seam. Returns
 * `null` — never throws, never leaks existence — when the board is missing or
 * the caller may not read it; core turns that into a 404.
 *
 * `resolveBoardAccess` is the same predicate the canonical conversation's join
 * gate uses (ADR 0278), so the two lanes admit exactly the same callers.
 */
export async function resolveBoardCohortForCaller(
  tenantId: string,
  boardId: string,
  caller: string | undefined,
): Promise<string[] | null> {
  const level = await resolveBoardAccess(tenantId, boardId, caller);
  if (level === 'none') return null;
  const board = await boards.get(`${tenantId}:${boardId}`);
  if (!board) return null;
  // ADR 0588 D5 — the likeness gate the type has always promised, on the convene
  // lane. Throws 422 (a distinct answer from "not found"): the board exists and
  // the caller may read it; it may not yet SPEAK.
  assertBoardConvenable(board);
  return boardCohortAgentRefs(tenantId, board);
}

/** ADR 0277 P2 — persist the "Shared knowledge" toggle as STORED intent on the
 *  board (the source of truth cohort reconciliation works from). Caller (the
 *  route) has already enforced org `workspace:write`. */
export async function recordSharedKbKind(tenantId: string, boardId: string, kind: string, shared: boolean): Promise<void> {
  // GRADE-14 — CAS loop: two concurrent toggles for DIFFERENT kinds were
  // read-modify-put last-writer-wins, silently dropping one kind's intent
  // (which also disabled its future removal reconciliation). Bounded retries;
  // on sustained contention the final state is still one caller's intent.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const b = await boards.get(`${tenantId}:${boardId}`);
    if (!b) return;
    const current = b.sharedKbKinds ?? [];
    const nextKinds = shared ? (current.includes(kind) ? current : [...current, kind]) : current.filter((k) => k !== kind);
    if (nextKinds.length === current.length && nextKinds.every((k, i) => k === current[i])) return; // no change
    const next: AdvisoryBoard = { ...b, updatedAt: now() };
    if (nextKinds.length > 0) next.sharedKbKinds = nextKinds; else delete next.sharedKbKinds;
    if (await boards.compareAndSwap(b, next)) return;
  }
  log.warn('shared_kind_record_contended', { boardId, kind, shared });
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
export async function resolveBoardStrategyContext(tenantId: string, boardId: string, convener: string | undefined): Promise<BoardContextValue> {
  const board = await boards.get(`${tenantId}:${boardId}`);
  if (!board) return { block: null, shortfall: 0 };
  const strategyIds = strategyIdsOf(board);
  const projectIds = projectIdsOf(board);
  // Both static-context kinds (ADR 0079 strategy + ADR 0100 project), each
  // RBAC-filtered for the convener, concatenated into one boardroom context block.
  const [strategy, project] = await Promise.all([
    strategyIds.length > 0 ? buildStrategyContextBlock(tenantId, strategyIds, convener) : Promise.resolve({ block: null, droppedNonAuthz: 0 }),
    projectIds.length > 0 ? buildProjectContextBlock(tenantId, projectIds, convener) : Promise.resolve({ block: null, droppedNonAuthz: 0 }),
  ]);
  const blocks = [strategy.block, project.block].filter((b): b is string => Boolean(b));
  // M4 — a board whose four strategies are three-quarters archived resolves to a
  // ONE-strategy block and `failed: false`. That is a silently truncated grounding
  // served as complete: no `degraded` entry, no GROUNDING NOTICE, same shape as
  // WF-BOA-4 and the likelier production one. The shortfall rides the ledger.
  // AUTHZ drops are excluded upstream — `degraded` is caller-neutral by contract.
  return { block: blocks.length > 0 ? blocks.join('\n\n') : null, shortfall: strategy.droppedNonAuthz + project.droppedNonAuthz };
}

/** Preview the resolved strategy context a board would give its advisors,
 *  RBAC-filtered for the CALLER (the FE "preview before convening"). The board
 *  read is RBAC-gated by `getBoard` (visibility + tenant). */
export async function previewBoardStrategyContext(tenantId: string, userId: string | undefined, boardId: string): Promise<StrategyContextEntry[]> {
  const board = await getBoard(tenantId, userId, boardId);
  return resolveStrategyEntriesByIds(tenantId, strategyIdsOf(board), userId);
}

/**
 * ADR 0288 roster-lifecycle consumer (grade-data AGT-1) — PRUNE a deleted roster
 * member from every board's LIVE membership: drop it from `advisors[]` and clear
 * `moderatorRosterId` when it was the moderator. The board itself survives (an
 * emptied board is visible breakage the owner resolves — never silently deleted).
 * Idempotent; bounded tenant-prefixed scan.
 */
export async function pruneAdvisorFromBoards(tenantId: string, rosterId: string): Promise<number> {
  let pruned = 0;
  for (const b of await boards.listByPrefix(`${tenantId}:`)) {
    const isAdvisor = b.advisors.includes(rosterId);
    const isModerator = b.moderatorRosterId === rosterId;
    if (!isAdvisor && !isModerator) continue;
    const next = { ...b, advisors: b.advisors.filter((a) => a !== rosterId), updatedAt: new Date().toISOString() };
    if (isModerator) delete next.moderatorRosterId;
    await boards.put(next);
    pruned += 1;
  }
  return pruned;
}

export async function deleteBoard(tenantId: string, userId: string | undefined, boardId: string, allowAdminOverride = false): Promise<void> {
  const board = await getBoard(tenantId, userId, boardId);
  // Owner-only, EXCEPT a superadmin may delete any board in the workspace. Demo
  // boards are created by synthetic seed actors (demo:advisory-seed, …), so
  // without this override no human could ever remove a leftover seeded board —
  // the delete would always 403 (SEED cleanup escape hatch, ADR 0321).
  if (board.createdBy !== userId && !allowAdminOverride) throw new OpenwopError('forbidden_scope', 'Only the board owner can delete it.', 403, { boardId });
  // GRADE-13 — deleting the board previously (a) left every advisor's
  // Shared-knowledge bindings in place FOREVER (the cohort-removal leak, via
  // deletion) and (b) stranded the canonical conversation: with the board gone
  // `resolveBoardAccess` returns 'none' for everyone, so the transcript became
  // permanently unreadable, undeletable dead data. Reconcile as if the whole
  // cohort were removed (cross-board + legacy protection identical to
  // updateBoard), then release the conversation to the legacy owner gate.
  // Best-effort: cleanup failure never blocks the delete (both idempotent).
  try {
    const effective = new Set<string>([
      ...(board.sharedKbKinds ?? []),
      ...(await ownEffectiveShared(tenantId, board, 'delete_cohort_reconcile')),
    ]);
    if (effective.size > 0 && board.advisors.length > 0) {
      const others = (await boards.listByPrefix(`${tenantId}:`)).filter((b) => b.boardId !== boardId);
      const relevant = others.filter((b) => board.advisors.some((a) => b.advisors.includes(a)));
      const resolveMemo = new Map<string, string[]>(); // GRADE-D2 — dedupe per (kind, org)
      const effectiveKinds = new Map<string, Set<string>>();
      for (const b of relevant) {
        effectiveKinds.set(b.boardId, new Set((await getBoardSharedKnowledge(tenantId, b, resolveMemo)).filter((i) => i.shared).map((i) => i.kind)));
      }
      const isProtected = (advisorId: string, kind: string): boolean =>
        relevant.some((b) => b.advisors.includes(advisorId) && (effectiveKinds.get(b.boardId)?.has(kind) ?? false));
      await reconcileCohortBindings(tenantId, { ...board, sharedKbKinds: [...effective] }, board.advisors, [], isProtected);
    }
    await releaseConversationOwnerSubject(tenantId, subjectConversationId(tenantId, boardSubject(boardId)));
  } catch (err) {
    log.warn('board_delete_cleanup_failed', { boardId, error: err instanceof Error ? err.message : String(err) });
  }
  await boards.delete(`${tenantId}:${boardId}`);
}

/**
 * ADVB-4 / ADR 0588 D5 — UN-fabricate. Stopping the seed from writing the
 * acknowledgement only helps tenants seeded AFTER this change; the seeder is
 * idempotent by handle, so every tenant seeded before it keeps a
 * `livingPersonaAck: true` that no human made. "We stopped fabricating" is not
 * the same claim as "there is no fabricated record", and only the second one is
 * worth making.
 *
 * Scope is deliberately narrow, and each condition is load-bearing:
 *   - `personaKind === 'living'` — the only kind the ack governs;
 *   - the board is STILL SEED-OWNED (`createdBy` is a `demo:` actor) — a board a
 *     human has adopted is NOT touched. That row's ack may also be inherited
 *     fiction, but it is unrecoverable (nothing distinguishes "the owner
 *     acknowledged" from "the seed did"), and clearing it would destroy a record
 *     that might be genuine. Adoption now re-asks instead;
 *   - the ack is UNATTRIBUTED or attributed to a `demo:` actor — never a human's.
 *
 * The board becomes unconvenable until its owner acknowledges (422 naming the
 * field). That is a visible, one-checkbox-recoverable break, and the alternative
 * is continuing to serve a fabricated right-of-publicity record. Idempotent.
 */
export async function clearFabricatedLivingAcks(tenantId: string): Promise<number> {
  let cleared = 0;
  for (const b of await boards.listByPrefix(`${tenantId}:`)) {
    if (b.personaKind !== 'living' || b.livingPersonaAck !== true) continue;
    if (!isSeedActor(b.createdBy)) continue;
    if (b.livingPersonaAckBy && !isSeedActor(b.livingPersonaAckBy)) continue;
    const next: AdvisoryBoard = { ...b, updatedAt: now() };
    delete next.livingPersonaAck;
    delete next.livingPersonaAckBy;
    delete next.livingPersonaAckAt;
    await boards.put(next);
    cleared += 1;
    log.info('living_persona_ack_unfabricated', { boardId: b.boardId, tenantId });
  }
  return cleared;
}

/** Test-only raw write (the `__reset*` seam convention). Exists so
 *  `clearFabricatedLivingAcks`' seed-OWNERSHIP guard can be witnessed: the row
 *  shape it protects — an ADOPTED board carrying an unattributed pre-0588 ack —
 *  is by design unconstructable through the public API after ADR 0588 D5, so
 *  without this the guard's test arm is VACUOUS (measured: dropping the guard
 *  left the suite green). Never called from src/. */
export async function __putBoardForTest(board: AdvisoryBoard): Promise<void> {
  await boards.put(board);
}

/** The boardIds in this tenant created by the demo seed (`createdBy` marker) —
 *  used by the demo-data registry to count + clear ONLY seeded boards, never a
 *  user-authored one. */
const SEED_ACTOR = 'demo:advisory-seed';
async function listSeededBoardIds(tenantId: string): Promise<string[]> {
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
