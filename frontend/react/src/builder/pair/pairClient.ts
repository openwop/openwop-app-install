/**
 * ADR 0773 — builder-pair REST client (host-extension, /v1/host/openwop-app/builder-pair/*).
 */

import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import type { ServerOpState, WorkflowEditSuggestion } from './suggestionModel.js';

const BASE = (): string => `${config.baseUrl}/host/openwop-app/builder-pair`;

export class PairRequestError extends Error {
  constructor(readonly status: number, readonly reason: string | undefined, message: string) {
    super(message);
    this.name = 'PairRequestError';
  }
}

async function readError(res: Response): Promise<PairRequestError> {
  let body: { message?: string; error?: string; details?: { reason?: string } } = {};
  try { body = await res.json() as typeof body; } catch { /* non-JSON body */ }
  return new PairRequestError(res.status, body.details?.reason ?? body.error, body.message ?? `builder-pair request failed (${res.status})`);
}

export interface PairContextBody {
  conversationId: string;
  workflowId: string;
  selection: { nodeIds: string[]; edgeIds: string[] };
  lastRunId?: string;
  /** The conversation run this client holds — binds the pairing (fork guard). */
  conversationRunId?: string;
}

/** A room-shared suggestion as a peer sees it (no requester/conversation ids). */
export interface RoomSuggestionView {
  id: string;
  workflowId: string;
  summary: string;
  ops: Array<{ summary: string; gateSensitive: boolean }>;
  opState: ServerOpState[];
  requesterName: string | null;
  ghostOps: WorkflowEditSuggestion['ops'];
  mine: boolean;
  createdAt: string;
}

export async function putPairContext(body: PairContextBody): Promise<{ selection: PairContextBody['selection']; droppedIds: string[] }> {
  const res = await fetch(`${BASE()}/context`, fetchOpts({
    method: 'PUT',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  }));
  if (!res.ok) throw await readError(res);
  return res.json() as Promise<{ selection: PairContextBody['selection']; droppedIds: string[] }>;
}

/** The conversation's active suggestion, or null when there is none (404). */
export async function getSuggestion(conversationId: string): Promise<WorkflowEditSuggestion | null> {
  const res = await fetch(`${BASE()}/suggestions/${encodeURIComponent(conversationId)}`, fetchOpts({ headers: authedHeaders() }));
  if (res.status === 404) return null;
  if (!res.ok) throw await readError(res);
  return res.json() as Promise<WorkflowEditSuggestion>;
}

export async function listRoomSuggestions(workflowId: string): Promise<RoomSuggestionView[]> {
  const res = await fetch(`${BASE()}/suggestions?workflowId=${encodeURIComponent(workflowId)}`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw await readError(res);
  return ((await res.json()) as { suggestions: RoomSuggestionView[] }).suggestions;
}

export async function patchSuggestion(
  conversationId: string,
  body: { suggestionId: string; opState?: Array<{ index: number; state: ServerOpState }>; visibility?: 'private' | 'room' },
): Promise<WorkflowEditSuggestion> {
  const res = await fetch(`${BASE()}/suggestions/${encodeURIComponent(conversationId)}`, fetchOpts({
    method: 'PATCH',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  }));
  if (!res.ok) throw await readError(res);
  return res.json() as Promise<WorkflowEditSuggestion>;
}

/** ADR 0773 G-05d — draw a chain template as a ghost suggestion on an empty draft. */
export async function suggestFromChain(body: { conversationId: string; workflowId: string; chainId: string; params?: Record<string, unknown> }): Promise<{ suggestionId: string }> {
  const res = await fetch(`${BASE()}/suggestions/from-chain`, fetchOpts({
    method: 'POST',
    headers: authedHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  }));
  if (!res.ok) throw await readError(res);
  return res.json() as Promise<{ suggestionId: string }>;
}
