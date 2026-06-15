/**
 * Board of Advisors API client (ADR 0040). Boards + council sessions under
 * /v1/host/openwop-app/advisors/*. Every route is toggle + RBAC + visibility
 * gated server-side; the client surfaces the server's message on a non-2xx.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type PersonaKind = 'historical' | 'fictional' | 'original' | 'living';
export type BoardVisibility = 'private' | 'shared';

export interface AdvisoryBoard {
  boardId: string;
  tenantId: string;
  orgId: string;
  name: string;
  handle: string;
  advisors: string[];
  moderatorRosterId?: string;
  visibility: BoardVisibility;
  personaKind: PersonaKind;
  livingPersonaAck?: boolean;
  turnPolicy: { rounds: number; order: 'declared' | 'round-robin'; synthesize: boolean };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  disclaimer: string | null;
}

export interface CouncilTurn {
  turnIndex: number;
  speakerId: string;
  speakerName: string;
  role: 'user' | 'advisor' | 'moderator';
  content: string;
  ts: string;
  grounded?: boolean;
}

export interface AdvisorySession {
  sessionId: string;
  boardId: string;
  turns: CouncilTurn[];
  createdAt: string;
  updatedAt: string;
}

export interface RosterMember { rosterId: string; persona: string; label?: string }
export interface OrgRef { orgId: string; name: string }

const base = `${config.baseUrl}/v1/host/openwop-app/advisors`;
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
  const res = await fetch(`${base}/boards`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ boards: AdvisoryBoard[] }>(res, 'listBoards')).boards;
}

export interface CreateBoardInput {
  orgId: string;
  name: string;
  advisors: string[];
  moderatorRosterId?: string;
  visibility: BoardVisibility;
  personaKind: PersonaKind;
  livingPersonaAck?: boolean;
}
export async function createBoard(input: CreateBoardInput): Promise<AdvisoryBoard> {
  const res = await fetch(`${base}/boards`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<AdvisoryBoard>(res, 'createBoard');
}

export async function deleteBoard(boardId: string): Promise<void> {
  const res = await fetch(`${base}/boards/${encodeURIComponent(boardId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 404) throw new Error(`deleteBoard returned ${res.status}`);
}

export async function convene(boardId: string, prompt: string, sessionId?: string): Promise<AdvisorySession> {
  const res = await fetch(`${base}/boards/${encodeURIComponent(boardId)}/convene`, fetchOpts({
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ prompt, ...(sessionId ? { sessionId } : {}) }),
  }));
  return asJson<AdvisorySession>(res, 'convene');
}

export async function listRoster(): Promise<RosterMember[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/roster`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ roster: RosterMember[] }>(res, 'listRoster')).roster;
}

export async function listOrgs(): Promise<OrgRef[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: OrgRef[] }>(res, 'listOrgs')).orgs;
}
