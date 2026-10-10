/**
 * ADR 0773 D2 + D4 — the two builder-pair stores.
 *
 *  - PAIRING CONTEXT: what the builder says it is showing, written by the
 *    builder in `beforeSend` (never on selection change — ADR 0773 A7) and read
 *    by the `read-canvas` / `suggest-edits` tools. Keyed
 *    `${tenant}:${user}:${chatSessionId}` — a point `get`, and the chat session
 *    id is the tool scope's unforgeable `conversationId` (ADR 0309 threading).
 *  - SUGGESTIONS: at most ONE active `WorkflowEditSuggestion` per (user,
 *    conversation), keyed `${tenant}:${user}:${chatSessionId}` (ADR 0773 A3 —
 *    every hot read is a point `get`, never a `list()` scan). The USER is in the
 *    key because the chat session id is CLIENT-supplied (`metadata.chatSessionId`),
 *    so a session id alone would let one member overwrite another's suggestion
 *    (review CR-3). A newer suggestion supersedes the older one.
 *    Room-shared suggestions are additionally indexed per workflow
 *    (`${tenant}:wf:${workflowId}`) so peers read them by key.
 *
 * Both carry a 24 h lifetime: `registerKvAgeOut` (day granularity) reclaims the
 * rows, and every read also refuses a row older than {@link PAIR_ROW_TTL_MS},
 * so the age-out tick's cadence never extends what a reader sees.
 *
 * Erasure: rows are tenant-indexed (teardown reaches them via `tenantOf`) and a
 * subject erasure removes a user's contexts and suggestions through
 * {@link eraseSubjectBuilderPairRows}.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import type { SuggestedOp } from './editOps.js';

export const PAIR_ROW_TTL_MS = 24 * 60 * 60 * 1000;

export interface PairSelection {
  nodeIds: string[];
  edgeIds: string[];
}

export interface PairContext {
  tenantId: string;
  userId: string;
  conversationId: string;
  workflowId: string;
  selection: PairSelection;
  /** Ids the builder sent that the head does not contain — dropped, reported. */
  droppedIds: string[];
  /** A run of THIS workflow in THIS tenant, validated on write (ADR 0764 D5 rule). */
  lastRunId?: string;
  /**
   * The conversation RUN this pairing belongs to (review CR-4 fork guard). Set by
   * the client when it knows its run, else bound by the first tool call. A
   * `:fork` of the conversation copies `chatSessionId` but runs under a NEW run
   * id, so its tool calls do not match and are refused.
   */
  boundRunId?: string;
  updatedAt: string;
}

export type OpState = 'pending' | 'kept' | 'dropped' | 'superseded';
export type SuggestionVisibility = 'private' | 'room';

export interface WorkflowEditSuggestion {
  id: string;
  tenantId: string;
  workflowId: string;
  conversationId: string;
  requestedBy: string;
  baseRevision: string;
  summary: string;
  ops: SuggestedOp[];
  opState: OpState[];
  visibility: SuggestionVisibility;
  /** ADR 0773 G-01c — up to three model-proposed follow-up asks (untrusted text). */
  followUps?: string[];
  /** ADR 0773 G-05b — how many ops the Architect said it will place (append mode). */
  plannedOps?: number;
  /** Where the ops came from: the Architect, or a chain template (G-05d). */
  source?: 'architect' | 'chain';
  createdAt: string;
  updatedAt: string;
}

interface RoomIndexRow {
  tenantId: string;
  workflowId: string;
  /** Suggestion keys (`${tenant}:${conversationId}`) shared with the room. */
  keys: string[];
  updatedAt: string;
}

const contextKey = (tenantId: string, userId: string, conversationId: string): string => `${tenantId}:${userId}:${conversationId}`;
export const suggestionKey = (tenantId: string, userId: string, conversationId: string): string => `${tenantId}:${userId}:${conversationId}`;
const roomKey = (tenantId: string, workflowId: string): string => `${tenantId}:wf:${workflowId}`;

const contexts = new DurableCollection<PairContext>(
  'builder-pair:context',
  (c) => contextKey(c.tenantId, c.userId, c.conversationId),
  undefined,
  (c) => c.tenantId,
);
const suggestions = new DurableCollection<WorkflowEditSuggestion>(
  'builder-pair:suggestion',
  (s) => suggestionKey(s.tenantId, s.requestedBy, s.conversationId),
  undefined,
  (s) => s.tenantId,
);
const roomIndex = new DurableCollection<RoomIndexRow>(
  'builder-pair:room',
  (r) => roomKey(r.tenantId, r.workflowId),
  undefined,
  (r) => r.tenantId,
);

// Tenant-indexed on purpose (teardown reaches the rows); the sweep deletes via
// the collection, so markers do not strand (WF-ORGINV-1).
registerKvAgeOut({ id: 'builder-pair:context', prefix: 'hostext:builder-pair:context:', ttlDays: 1, timestampField: 'updatedAt', acceptIndexed: true });
registerKvAgeOut({ id: 'builder-pair:suggestion', prefix: 'hostext:builder-pair:suggestion:', ttlDays: 1, timestampField: 'updatedAt', acceptIndexed: true });
registerKvAgeOut({ id: 'builder-pair:room', prefix: 'hostext:builder-pair:room:', ttlDays: 1, timestampField: 'updatedAt', acceptIndexed: true });

const fresh = <T extends { updatedAt: string }>(row: T | null, now = Date.now()): T | null =>
  row && now - Date.parse(row.updatedAt) <= PAIR_ROW_TTL_MS ? row : null;

export async function putPairContext(ctx: PairContext): Promise<void> {
  await contexts.put(ctx);
}

export async function getPairContext(tenantId: string, userId: string, conversationId: string): Promise<PairContext | null> {
  return fresh(await contexts.get(contextKey(tenantId, userId, conversationId)));
}

export async function getSuggestion(tenantId: string, userId: string, conversationId: string): Promise<WorkflowEditSuggestion | null> {
  return fresh(await suggestions.get(suggestionKey(tenantId, userId, conversationId)));
}

/** Replace the conversation's active suggestion. The previous one's undecided
 *  ops are gone with it (superseded) — the builder refetches and re-renders. */
export async function putSuggestion(s: WorkflowEditSuggestion): Promise<void> {
  const prior = await suggestions.get(suggestionKey(s.tenantId, s.requestedBy, s.conversationId));
  await suggestions.put(s);
  if (prior?.visibility === 'room' && (prior.workflowId !== s.workflowId || s.visibility !== 'room')) {
    await removeFromRoom(prior.tenantId, prior.workflowId, suggestionKey(prior.tenantId, prior.requestedBy, prior.conversationId));
  }
  if (s.visibility === 'room') await addToRoom(s.tenantId, s.workflowId, suggestionKey(s.tenantId, s.requestedBy, s.conversationId));
}

export async function updateSuggestion(s: WorkflowEditSuggestion): Promise<void> {
  const prior = await suggestions.get(suggestionKey(s.tenantId, s.requestedBy, s.conversationId));
  await suggestions.put(s);
  const key = suggestionKey(s.tenantId, s.requestedBy, s.conversationId);
  if (s.visibility === 'room' && prior?.visibility !== 'room') await addToRoom(s.tenantId, s.workflowId, key);
  if (s.visibility !== 'room' && prior?.visibility === 'room') await removeFromRoom(s.tenantId, s.workflowId, key);
}

/** What a PEER sees of a room-shared suggestion: never the requester's user id
 *  or conversation id (review CR-3 — either would let a member target it). */
export interface RoomSuggestionView {
  id: string;
  workflowId: string;
  summary: string;
  ops: Array<{ summary: string; gateSensitive: boolean }>;
  opState: OpState[];
  /** ADR 0773 G-06b — the requester's DISPLAY name (never their id). */
  requesterName: string | null;
  /** The ops' ghost geometry for read-only rendering by peers (G-06b). */
  ghostOps: SuggestedOp[];
  mine: boolean;
  createdAt: string;
}

export async function listRoomSuggestions(
  tenantId: string,
  workflowId: string,
  callerId: string | undefined,
  nameOf: (userId: string) => Promise<string | null> = async () => null,
): Promise<RoomSuggestionView[]> {
  const row = await roomIndex.get(roomKey(tenantId, workflowId));
  if (!row) return [];
  const out: RoomSuggestionView[] = [];
  for (const key of row.keys) {
    const s = fresh(await suggestions.get(key));
    if (!s || s.visibility !== 'room' || s.workflowId !== workflowId || s.tenantId !== tenantId) continue;
    out.push({
      id: s.id, workflowId: s.workflowId, summary: s.summary, opState: s.opState, createdAt: s.createdAt,
      ops: s.ops.map((o) => ({ summary: o.summary, gateSensitive: o.gateSensitive })),
      requesterName: await nameOf(s.requestedBy),
      ghostOps: s.ops,
      mine: callerId !== undefined && s.requestedBy === callerId,
    });
  }
  return out;
}

async function addToRoom(tenantId: string, workflowId: string, key: string): Promise<void> {
  const k = roomKey(tenantId, workflowId);
  const row = await roomIndex.get(k);
  const keys = [...new Set([...(row?.keys ?? []), key])].slice(-50);
  await roomIndex.put({ tenantId, workflowId, keys, updatedAt: new Date().toISOString() });
}

async function removeFromRoom(tenantId: string, workflowId: string, key: string): Promise<void> {
  const k = roomKey(tenantId, workflowId);
  const row = await roomIndex.get(k);
  if (!row) return;
  const keys = row.keys.filter((x) => x !== key);
  if (keys.length === 0) await roomIndex.delete(k);
  else await roomIndex.put({ ...row, keys, updatedAt: new Date().toISOString() });
}

/** Subject erasure: remove a user's pairing contexts and the suggestions they requested. */
export async function eraseSubjectBuilderPairRows(tenantId: string, userId: string): Promise<number> {
  return eraseRows(tenantId, userId);
}

/** ADR 0464 — the registered eraser (a NAMED function: WF-CONS-2). */
async function eraseBuilderPairSubject(tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> {
  return { rowsTouched: await eraseRows(tenantId, subjectKey) };
}
registerSubjectEraser(eraseBuilderPairSubject);

async function eraseRows(tenantId: string, userId: string): Promise<number> {
  let n = 0;
  for (const c of await contexts.listForTenantIndexed(tenantId)) {
    if (c.userId === userId && (await contexts.delete(contextKey(c.tenantId, c.userId, c.conversationId)))) n++;
  }
  for (const s of await suggestions.listForTenantIndexed(tenantId)) {
    if (s.requestedBy !== userId) continue;
    if (s.visibility === 'room') await removeFromRoom(s.tenantId, s.workflowId, suggestionKey(s.tenantId, s.requestedBy, s.conversationId));
    if (await suggestions.delete(suggestionKey(s.tenantId, s.requestedBy, s.conversationId))) n++;
  }
  return n;
}
