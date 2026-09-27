/**
 * Board of Advisors API client (ADR 0040). The board ENTITY (cohort) under
 * /host/openwop-app/advisors/*; the boardroom conversation runs in the AI chat
 * (ADR 0040 § Correction 2026-06-15), so there's no convene/session client here —
 * `getBoardByHandle` resolves `@@<handle>` to the cohort the chat activates.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { cachedRead } from '../../client/requestCache.js';

export type PersonaKind = 'historical' | 'fictional' | 'original' | 'living';
export type BoardVisibility = 'private' | 'shared';

/** A selected strategy the board carries into its advisors' prompt (ADR 0079 Phase 5). */
export type AdvisoryContextRef =
  | { kind: 'strategy'; strategyId: string }
  | { kind: 'project'; projectId: string };

export interface AdvisoryBoard {
  boardId: string;
  tenantId: string;
  orgId: string;
  name: string;
  handle: string;
  advisors: string[];
  contextRefs?: AdvisoryContextRef[];
  moderatorRosterId?: string;
  visibility: BoardVisibility;
  personaKind: PersonaKind;
  livingPersonaAck?: boolean;
  /** ADR 0588 D5 — WHO made the acknowledgement. Absent ⇒ unattributed (a
   *  pre-0588 row, or a synthetic seed actor), which the form must never
   *  pre-tick: re-affirming someone else's acknowledgement without showing it is
   *  the defect (ADVB-4). */
  livingPersonaAckBy?: string;
  livingPersonaAckAt?: string;
  turnPolicy: { rounds: number; order: 'declared' | 'round-robin'; synthesize: boolean };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  disclaimer: string | null;
}

export interface RosterMember { rosterId: string; persona: string; label?: string }
export interface OrgRef { orgId: string; name: string }

const base = `${config.baseUrl}/host/openwop-app/advisors`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listBoards(): Promise<AdvisoryBoard[]> {
  // Read on mount by every chat tab's @@-board picker. Coalesce concurrent reads
  // (TTL 0 = in-flight-only); board create/delete reflects on the next read.
  return cachedRead('advisory.boards', 0, async () => {
    const res = await fetch(`${base}/boards`, fetchOpts({ headers: authedHeaders() }));
    return (await asJson<{ boards: AdvisoryBoard[] }>(res, 'listBoards')).boards;
  });
}

export interface CreateBoardInput {
  orgId: string;
  name: string;
  advisors: string[];
  contextRefs?: AdvisoryContextRef[];
  moderatorRosterId?: string;
  visibility: BoardVisibility;
  personaKind: PersonaKind;
  livingPersonaAck?: boolean;
}
export async function createBoard(input: CreateBoardInput): Promise<AdvisoryBoard> {
  const res = await fetch(`${base}/boards`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<AdvisoryBoard>(res, 'createBoard');
}

// ADR 0100 D2 — share a KB (strategy / priority-matrix managed, or the org's
// project KBs) with every advisor on a board.
export type SharedKbKind = 'strategy' | 'priority-matrix' | 'project';
export interface SharedKnowledgeItem { kind: SharedKbKind; shared: boolean; exists: boolean; count: number; shareable: boolean }
/** ADR 0278 — ensure-or-reuse the board's ONE canonical conversation (join
 *  semantics: any caller with board read opens the SAME chat). */
/**
 * Ensure-or-join the board's ONE canonical conversation.
 *
 * M1 — `contextDegraded` is TYPED here and read by both openers. It was emitted
 * by the route (ADV-UX-9) and had zero consumers anywhere in the repo: the PR
 * claimed the opener was "told instead of only a server log", and the server log
 * was still the only observable thing. `true` means the curator's re-snapshot of
 * the board's planning context failed, so the durable PROVENANCE record of "what
 * this room was told" is stale. It is NOT the grounding — `host/chatContext.ts`
 * re-resolves that per caller, per turn (ADVB-1) — so this is a warning, never a
 * refusal. Absent on the response when composition was whole.
 */
export async function ensureBoardChat(boardId: string): Promise<{ sessionId: string; contextDegraded?: boolean }> {
  const res = await fetch(`${base}/boards/${encodeURIComponent(boardId)}/chat`, fetchOpts({ method: 'POST', headers: authedHeaders() }));
  return asJson<{ sessionId: string; contextDegraded?: boolean }>(res, 'ensureBoardChat');
}

export async function getSharedKnowledge(boardId: string): Promise<SharedKnowledgeItem[]> {
  const res = await fetch(`${base}/boards/${encodeURIComponent(boardId)}/shared-knowledge`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ items: SharedKnowledgeItem[] }>(res, 'getSharedKnowledge')).items;
}
export async function setSharedKnowledge(boardId: string, kind: SharedKbKind, shared: boolean): Promise<SharedKnowledgeItem[]> {
  const res = await fetch(`${base}/boards/${encodeURIComponent(boardId)}/shared-knowledge`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ kind, shared }) }));
  return (await asJson<{ items: SharedKnowledgeItem[] }>(res, 'setSharedKnowledge')).items;
}

/** Owner-only edit (PATCH). Any omitted field is left unchanged server-side. */
export interface UpdateBoardInput {
  name?: string;
  advisors?: string[];
  contextRefs?: AdvisoryContextRef[];
  visibility?: BoardVisibility;
  personaKind?: PersonaKind;
  livingPersonaAck?: boolean;
  /** ADV-UX-7 — the synthesizing chair. `null` clears it (server-side
   *  `input.moderatorRosterId === null ⇒ delete`). The field existed on
   *  `CreateBoardInput` and was omitted here, and no form ever set it, so
   *  `chairAgentId` was always "the first activated advisor" — a DISPUTANT
   *  writing the recommendation, contradicting both `boardMentionTip`'s "then
   *  the chair synthesizes" and the FEATURES.md row. */
  moderatorRosterId?: string | null;
}
export async function updateBoard(boardId: string, input: UpdateBoardInput): Promise<AdvisoryBoard> {
  const res = await fetch(`${base}/boards/${encodeURIComponent(boardId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<AdvisoryBoard>(res, 'updateBoard');
}

export async function deleteBoard(boardId: string): Promise<void> {
  const res = await fetch(`${base}/boards/${encodeURIComponent(boardId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 404) throw new Error(`deleteBoard returned ${res.status}`);
}

/** Read ONE board by id (visibility-gated server-side; 404 for a `private`
 *  board the caller does not own — no existence leak). Retires half of ADVB-7:
 *  the route has existed since ADR 0040 with no client at all. The chat's
 *  simulated-persona disclaimer is its first consumer (ADV-UX-1). */
export async function getBoard(boardId: string): Promise<AdvisoryBoard> {
  const res = await fetch(`${base}/boards/${encodeURIComponent(boardId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<AdvisoryBoard>(res, 'getBoard');
}

/** Resolve a board by its `@@<handle>` summon token → the cohort the AI chat
 *  activates into its active-agents lineup. Visibility-gated server-side. */
export async function getBoardByHandle(handle: string): Promise<AdvisoryBoard> {
  const res = await fetch(`${base}/boards/by-handle/${encodeURIComponent(handle)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson<AdvisoryBoard>(res, 'getBoardByHandle');
}

export async function listRoster(): Promise<RosterMember[]> {
  // The Board of Advisors IS the home of advisor-subject agents — include them
  // (they're hidden from the general `/roster`).
  const res = await fetch(`${config.baseUrl}/host/openwop-app/roster?includeAdvisors=true`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ roster: RosterMember[] }>(res, 'listRoster')).roster;
}

export async function listOrgs(): Promise<OrgRef[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: OrgRef[] }>(res, 'listOrgs')).orgs;
}
