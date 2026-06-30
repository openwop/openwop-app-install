/**
 * Persistent-conversation metadata (ADR 0043) — the sidecar that turns a
 * sample-grade `chat_session` into a typed, owned, multi-participant CONVERSATION
 * without a 3-backend SQL migration. The `chat_session` (id/title/messageCount)
 * stays the title+message store; this record — keyed by the SAME conversationId —
 * adds the fields it lacks: `type`, owner, participant membership, 1:1 dedup key,
 * read state, and the board link. The conversation is ONE logical entity
 * (session + meta), not a parallel chat store.
 *
 * Identity reuses the ADR 0041 subjectRef vocabulary verbatim — `user:<userId>`
 * (ADR 0005) / `agent:<agentId>` (roster) — so a participant id needs no new
 * scheme and lines up with the per-subject memory namespace. A future
 * `project:<id>` slots into the same tagged string.
 *
 * Backed by the host-ext `DurableCollection` (the same primitive kanban / sharing
 * / roster / advisory-board use). NON-NORMATIVE host-ext (`/v1/host/openwop-app/*`).
 *
 * @see docs/adr/0043-persistent-conversations.md
 */

import { createHash } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';
import { setReadMarker, deleteReadMarkersOf } from './conversationReadState.js';
import { subjectScope, type Subject } from './subject.js';

/** The four conversation types that share this one model. `project` slots in
 *  later via the same discriminator + a `project:` participant (ADR 0043 §model). */
export type ConversationType = 'agent' | 'person' | 'group' | 'workspace' | 'channel';
export const CONVERSATION_TYPES: readonly ConversationType[] = ['agent', 'person', 'group', 'workspace'];

/** ADR 0132 — the per-conversation capability scope CONFIG (the user's narrowing
 *  of the agent's permitted tools for THIS conversation). Core-owned so the typed
 *  `ConversationMeta.capabilityScope` field never imports a feature (the
 *  `host/` → `features/` boundary); the `conversation-tools` feature owns the
 *  resolver + the loop enforcement and imports this shape DOWN from core.
 *
 *  Semantics are strictly NARROWING (never a widening — a scope can only REMOVE
 *  tools the agent could otherwise use; see `resolveCapabilityScope`):
 *   - `mode:'agent-default'` ⇒ no narrowing (== feature-off behavior).
 *   - `mode:'restricted'`    ⇒ `enabled`/`disabled`/`requireApproval` apply.
 *  Entries are tool ids OR dotted-namespace prefixes (the ADR 0102 `tokenMatches`
 *  semantics: `crm` ⊇ `crm.field.update`). */
export interface ConversationCapabilityScope {
  mode: 'agent-default' | 'restricted';
  /** When present, restrict the agent's tools to (intersect with) this set. Absent
   *  ⇒ start from the full agent ceiling, then subtract `disabled`. */
  enabled?: string[];
  /** Tool ids/prefixes removed from the ceiling for this conversation. */
  disabled?: string[];
  /** Tool ids/prefixes that SUSPEND for per-call approval this conversation
   *  (clamped to the effective enabled set by the resolver). */
  requireApproval?: string[];
  /** Provenance — who set the scope + when (audit; non-secret). */
  setBy?: string;
  setAt?: string;
}

/** A participant subject — the ADR 0041 subjectRef. `user:<userId>` or
 *  `agent:<agentId>` today; `project:<id>`/`workspace:<id>` extensible. */
export type SubjectRef = string;
export const userRef = (userId: string): SubjectRef => `user:${userId}`;
export const agentRef = (agentId: string): SubjectRef => `agent:${agentId}`;

export interface ConversationParticipant {
  subjectRef: SubjectRef;
  role: 'owner' | 'member';
  addedAt: string;
  /** Read-state marker — ISO ts of the last message this participant has seen;
   *  drives the sidebar unread badge.
   *
   *  AUTHORITATIVE SOURCE: `conversationReadState.ts`, NOT this field. On a
   *  STORED meta this is vestigial — pre-split `markRead` wrote it here, but the
   *  current `markRead` writes the dedicated store and the route projection
   *  (`withReadMarkers`) joins the live value back onto the response. A value
   *  baked into a stored record is a frozen pre-split snapshot kept only as a
   *  transition fallback; do not read it directly. */
  lastReadAt?: string;
}

export interface ConversationMeta {
  conversationId: string;
  tenantId: string;
  type: ConversationType;
  /** The owning user's `User.userId` (ADR 0005). Nullable for legacy/anon
   *  sessions created before this model — they stay tenant-visible. */
  ownerUserId?: string;
  /** Canonical 1:1 key (sorted `owner|other` subjectRefs) so a second "open chat
   *  with X" resolves to the SAME conversation. Absent for group/workspace. */
  dmKey?: string;
  /** When `type:'group'` was seeded from an advisory board (ADR 0040) — the
   *  cohort template it came from. The board stays the template; this is the instance. */
  boardId?: string;
  /** ADR 0079 Phase 5 / ADR 0080 §Follow-on — the pre-resolved CONTEXT block a
   *  registered board-context resolver produced, snapshotted when the board group
   *  was formed (stable for the boardroom's life; injected into each advisor's
   *  prompt by `conversationExchange`). Feature-agnostic (strategy is the only
   *  producer today). Absent ⇒ no injected block. Legacy records persisted the
   *  same value under `strategyContext`; `loadMeta` normalizes it on read. */
  injectedContextBlock?: string;
  /** ADR 0054 D3 — the generic CONTAINER this conversation belongs to (a
   *  `kind:'project'` Subject for a project's group chat). The same `ownerSubject`
   *  binding boards/memory/schedules use; supersedes the advisory-specific `boardId`. */
  ownerSubject?: Subject;
  /** The RFC 0005 conversation RUN id backing this chat (the long-lived
   *  `core.conversationGate` run). Persisted server-side so reopening the chat
   *  from another device / after the local session blob is gone REUSES the same
   *  suspended run — keeping the agent's server-side context — instead of opening
   *  a fresh run and orphaning the old one. Set lazily on first open; self-heals
   *  when the run is dead (the client drops it and opens a new one). */
  conversationRunId?: string;
  /** ADR 0117 — branch lineage. Set when this conversation was forked from
   *  another at a settled turn: the parent conversation id + the message count
   *  carried forward (the branch point). Absent on a root conversation. */
  branchedFrom?: { conversationId: string; fromSeq: number };
  /** ADR 0126 — channel descriptor (only on `type:'channel'`). v1 local-host;
   *  presence/typing/receipts are RFC-gated + NOT carried here. */
  channel?: { name: string; description?: string; visibility: 'public' | 'private'; archived?: boolean };
  /** ADR 0132 — per-conversation capability scope CONFIG (the user's narrowing of
   *  the agent's permitted tools). Absent ⇒ agent-default (no narrowing). The
   *  resolved EFFECTIVE set is stamped per-run in `run.metadata.capabilityScope`. */
  capabilityScope?: ConversationCapabilityScope;
  participants: ConversationParticipant[];
  createdAt: string;
  updatedAt: string;
}

/** A deterministic conversation id for a Subject's group chat (ADR 0054) — so a
 *  project's chat is idempotent (one chat per project, re-opened not re-forked).
 *  Matches the route id pattern /^[A-Za-z0-9_-]{1,64}$/. */
export function subjectConversationId(tenantId: string, subject: Subject): string {
  return `subjc-${createHash('sha256').update(`${tenantId}:${subjectScope(subject)}`).digest('hex').slice(0, 24)}`;
}

const metas = new DurableCollection<ConversationMeta>('chat:conversation', (m) => `${m.tenantId}:${m.conversationId}`);

const now = (): string => new Date().toISOString();

/** The deterministic 1:1 dedup key for an owner + the single other party
 *  (order-independent), so reopening a DM never forks a new conversation. */
export function dmKeyOf(a: SubjectRef, b: SubjectRef): string {
  return [a, b].sort().join('|');
}

/** Read a stored meta, normalizing the legacy `strategyContext` snapshot key to
 *  the generic `injectedContextBlock` (ADR 0080 §Follow-on rename) so board
 *  conversations created before the rename keep their injected context. */
async function loadMeta(key: string): Promise<ConversationMeta | null> {
  const m = await metas.get(key);
  if (m && m.injectedContextBlock === undefined) {
    const legacy = (m as ConversationMeta & { strategyContext?: string }).strategyContext;
    if (legacy !== undefined) return { ...m, injectedContextBlock: legacy };
  }
  return m;
}

export async function getConversationMeta(tenantId: string, conversationId: string): Promise<ConversationMeta | null> {
  return loadMeta(`${tenantId}:${conversationId}`);
}

/** Persist the conversation RUN id backing a chat (ADR 0067 continuity). Updates
 *  an existing meta in place; if none exists yet (a plain chat never promoted to
 *  group/DM), creates a MINIMAL meta that preserves the chat's current
 *  visibility — `type:'agent'`, NO `ownerUserId` (an unowned meta is tenant-
 *  visible, exactly like the no-meta default `isVisibleTo` applies today), so
 *  recording the run id can never tighten or loosen who can see the chat. */
export async function setConversationRun(tenantId: string, conversationId: string, conversationRunId: string): Promise<void> {
  const key = `${tenantId}:${conversationId}`;
  const existing = await loadMeta(key);
  if (existing) {
    if (existing.conversationRunId === conversationRunId) return; // idempotent no-op
    await metas.put({ ...existing, conversationRunId, updatedAt: now() });
    return;
  }
  const ts = now();
  await metas.put({ conversationId, tenantId, type: 'agent', conversationRunId, participants: [], createdAt: ts, updatedAt: ts });
}

/** ADR 0132 — set (or clear) a conversation's capability-scope CONFIG. Mirrors
 *  `setConversationRun`: updates an existing meta in place, or creates a MINIMAL
 *  tenant-visible meta (`type:'agent'`, no `ownerUserId`) if none exists yet, so
 *  recording a scope never tightens/loosens who can see the chat. Pass `undefined`
 *  to clear the scope (revert to agent-default). Returns the updated meta. */
export async function setConversationCapabilityScope(
  tenantId: string,
  conversationId: string,
  scope: ConversationCapabilityScope | undefined,
): Promise<ConversationMeta> {
  const key = `${tenantId}:${conversationId}`;
  const existing = await loadMeta(key);
  const ts = now();
  if (existing) {
    const next: ConversationMeta = { ...existing, updatedAt: ts };
    if (scope) next.capabilityScope = scope; else delete next.capabilityScope;
    await metas.put(next);
    return next;
  }
  const created: ConversationMeta = {
    conversationId, tenantId, type: 'agent', participants: [], createdAt: ts, updatedAt: ts,
    ...(scope ? { capabilityScope: scope } : {}),
  };
  await metas.put(created);
  return created;
}

/** All conversation metas for a tenant (the sidebar list joins these onto the
 *  chat-session headers). */
export async function listConversationMetas(tenantId: string): Promise<ConversationMeta[]> {
  return metas.listByPrefix(`${tenantId}:`);
}

/** Find an existing 1:1 conversation by its canonical dmKey (open-or-resume). */
export async function findByDmKey(tenantId: string, dmKey: string): Promise<ConversationMeta | null> {
  return (await metas.listByPrefix(`${tenantId}:`)).find((m) => m.dmKey === dmKey) ?? null;
}

export interface ConversationMetaInit {
  type: ConversationType;
  ownerUserId?: string;
  participants?: SubjectRef[];
  dmKey?: string;
  boardId?: string;
  ownerSubject?: Subject;
  branchedFrom?: { conversationId: string; fromSeq: number };
  channel?: { name: string; description?: string; visibility: 'public' | 'private'; archived?: boolean };
}

/** Create (or return the existing) conversation meta for a session — idempotent.
 *  The owner is recorded as an `owner`-role participant; the rest are members. */
export async function ensureConversationMeta(
  tenantId: string,
  conversationId: string,
  init: ConversationMetaInit,
): Promise<ConversationMeta> {
  const existing = await loadMeta(`${tenantId}:${conversationId}`);
  if (existing) return existing;
  const ts = now();
  const ownerSubject = init.ownerUserId ? userRef(init.ownerUserId) : null;
  const participants: ConversationParticipant[] = [];
  if (ownerSubject) participants.push({ subjectRef: ownerSubject, role: 'owner', addedAt: ts });
  for (const ref of init.participants ?? []) {
    if (ref === ownerSubject) continue;
    if (participants.some((p) => p.subjectRef === ref)) continue;
    participants.push({ subjectRef: ref, role: 'member', addedAt: ts });
  }
  const meta: ConversationMeta = {
    conversationId,
    tenantId,
    type: init.type,
    ...(init.ownerUserId ? { ownerUserId: init.ownerUserId } : {}),
    ...(init.dmKey ? { dmKey: init.dmKey } : {}),
    ...(init.boardId ? { boardId: init.boardId } : {}),
    ...(init.ownerSubject ? { ownerSubject: init.ownerSubject } : {}),
    ...(init.branchedFrom ? { branchedFrom: init.branchedFrom } : {}),
    ...(init.channel ? { channel: init.channel } : {}),
    participants,
    createdAt: ts,
    updatedAt: ts,
  };
  await metas.put(meta);
  return meta;
}

/** Promote a conversation to the group chat for an advisory board (ADR 0043
 *  Phase 4) — the `@@<board>` summon stamps the CURRENT chat as the board's
 *  group conversation in place (no session fork), so the boardroom turns land
 *  in a conversation that shows under Groups and links back to the board.
 *
 *  Create-or-update + idempotent: converts an existing `agent` meta to `group`,
 *  sets the `boardId`, and merges the cohort as members (the owner stays owner;
 *  re-summoning the same board is a no-op once the cohort is present). */
export async function markAsBoardGroup(
  tenantId: string,
  conversationId: string,
  boardId: string,
  participants: SubjectRef[],
  ownerUserId?: string,
  /** The already-loaded meta (or null), to skip a redundant read when the caller
   *  has just fetched it (e.g. for an owner check). Omit to load here. */
  preloaded?: ConversationMeta | null,
  /** ADR 0079 Phase 5 / ADR 0080 §Follow-on — the pre-resolved context block (from
   *  a board-context resolver) to snapshot onto the boardroom (the caller resolved
   *  it, RBAC-filtered for the convener). `undefined` leaves an existing snapshot
   *  untouched; `null` clears it. */
  injectedContextBlock?: string | null,
): Promise<ConversationMeta> {
  const ts = now();
  const existing = preloaded === undefined ? await loadMeta(`${tenantId}:${conversationId}`) : preloaded;
  const merged: ConversationParticipant[] = existing ? [...existing.participants] : [];
  const ownerSubject = ownerUserId ? userRef(ownerUserId) : null;
  if (ownerSubject && !merged.some((p) => p.subjectRef === ownerSubject)) {
    merged.push({ subjectRef: ownerSubject, role: 'owner', addedAt: ts });
  }
  for (const ref of participants) {
    if (ref === ownerSubject) continue;
    if (merged.some((p) => p.subjectRef === ref)) continue;
    merged.push({ subjectRef: ref, role: 'member', addedAt: ts });
  }
  // `undefined` ⇒ keep an existing snapshot; `null` ⇒ clear; a string ⇒ set.
  const nextBlock = injectedContextBlock === undefined ? existing?.injectedContextBlock : (injectedContextBlock ?? undefined);
  const next: ConversationMeta = {
    conversationId,
    tenantId,
    type: 'group',
    ...(ownerUserId ? { ownerUserId } : existing?.ownerUserId ? { ownerUserId: existing.ownerUserId } : {}),
    boardId,
    ...(nextBlock ? { injectedContextBlock: nextBlock } : {}),
    participants: merged,
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  };
  await metas.put(next);
  return next;
}

/** Add a participant (idempotent). Returns the updated meta, or null if the
 *  conversation has no meta. */
export async function addParticipant(tenantId: string, conversationId: string, subjectRef: SubjectRef, preloaded?: ConversationMeta | null): Promise<ConversationMeta | null> {
  const meta = preloaded === undefined ? await loadMeta(`${tenantId}:${conversationId}`) : preloaded;
  if (!meta) return null;
  if (meta.participants.some((p) => p.subjectRef === subjectRef)) return meta;
  const next: ConversationMeta = {
    ...meta,
    participants: [...meta.participants, { subjectRef, role: 'member', addedAt: now() }],
    updatedAt: now(),
  };
  await metas.put(next);
  return next;
}

/** Remove a participant (never the owner). Returns the updated meta, or null. */
export async function removeParticipant(tenantId: string, conversationId: string, subjectRef: SubjectRef, preloaded?: ConversationMeta | null): Promise<ConversationMeta | null> {
  const meta = preloaded === undefined ? await loadMeta(`${tenantId}:${conversationId}`) : preloaded;
  if (!meta) return null;
  const next: ConversationMeta = {
    ...meta,
    participants: meta.participants.filter((p) => !(p.subjectRef === subjectRef && p.role !== 'owner')),
    updatedAt: now(),
  };
  await metas.put(next);
  return next;
}

/** ADR 0126 — patch a channel conversation's descriptor (rename / archive). */
export async function setConversationChannel(
  tenantId: string,
  conversationId: string,
  patch: Partial<{ name: string; description: string; visibility: 'public' | 'private'; archived: boolean }>,
): Promise<ConversationMeta | null> {
  const meta = await loadMeta(`${tenantId}:${conversationId}`);
  if (!meta || meta.type !== 'channel' || !meta.channel) return null;
  const next: ConversationMeta = { ...meta, channel: { ...meta.channel, ...patch }, updatedAt: now() };
  await metas.put(next);
  return next;
}

/** Mark a participant's read position (ADR 0043 — unread badge). Writes a
 *  dedicated per-(conversation, subject) read marker rather than rewriting the
 *  whole meta, so it can't race a concurrent participant mutation on the same
 *  record. The route's projection joins the marker back into the response. */
export async function markRead(tenantId: string, conversationId: string, subjectRef: SubjectRef, at: string): Promise<void> {
  await setReadMarker(tenantId, conversationId, subjectRef, at);
}

export async function deleteConversationMeta(tenantId: string, conversationId: string): Promise<void> {
  await metas.delete(`${tenantId}:${conversationId}`);
  // Cascade the conversation's read markers (separate store). Best-effort + after
  // the meta delete: a mid-failure orphans markers, but conversationIds are
  // random UUIDs (never reused), so an orphan can never be inherited by a future
  // conversation, and the list projection only joins markers onto live session
  // headers — so an orphan is inert (never surfaced).
  await deleteReadMarkersOf(tenantId, conversationId);
}
