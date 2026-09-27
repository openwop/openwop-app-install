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
import { registerSubjectEraser } from './subjectErasure.js';
import { ERASED, ERASED_USER_REF, subjectKeyForms } from './subjectErasureRedaction.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.conversationStore');

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
  /** ADR 0192 D1 — the @-mention token that addresses this AGENT member,
   *  derived via `host/slug.ts` from the resolved manifest at membership time
   *  and unique within the conversation. FROZEN at add-time (mention tokens in
   *  history must keep resolving); re-adding the agent re-derives it. Stamped
   *  only at membership-mutation time — never from a read path (a read-path
   *  meta rewrite would race concurrent participant mutations, the LWW hazard
   *  the read-state split exists to avoid). Absent on user members and on
   *  legacy agent members (which keep matching by agentId). */
  mentionSlug?: string;
  /** ADR 0192 D1 — the agent's human label at add-time ("Code Reviewer"),
   *  shown by roster/message projections without a registry read. */
  displayLabel?: string;
  /** ADR 0202 D1 — an AGENT member's reply policy: `'all'` = replies to every
   *  human post; `'mention'` = only when @mentioned. Stamped at ADD time (never
   *  a read path — the LWW hazard). ABSENT on legacy agents: the dispatcher
   *  DERIVES the effective policy (`?? (soleAgent ? 'all' : 'mention')`),
   *  matching the pre-0200 invisible sole-agent rule with zero writes. */
  responsePolicy?: 'all' | 'mention';
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
  // GRADE-D6 — atomic insert-if-absent: two concurrent FIRST creators
  // previously interleaved load(null)/put and the loser's init (participants,
  // owner) was silently clobbered. CAS(null, meta) keeps create-or-return
  // semantics exactly; on losing the race, return the winner's row.
  if (await metas.compareAndSwap(null, meta)) return meta;
  const winner = await loadMeta(`${tenantId}:${conversationId}`);
  return winner ?? meta;
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
  /** ADR 0278 GRADE-7 — ASSERT this owner binding on the rebuilt meta (the
   *  canonical board chat passes its `board:<id>` subject so a racing rewrite
   *  can never permanently strip the subject-access join gate). `undefined`
   *  preserves whatever the existing meta carries (the legacy behavior). */
  assertOwnerSubject?: Subject,
): Promise<ConversationMeta> {
  // GRADE-D6 — bounded CAS: concurrent stamps (two first opens, or an open
  // racing a summon) were last-writer-wins, silently dropping the loser's
  // participant merges. Retries rebuild against the fresh row; exhausted →
  // today's LWW put + warn (converging, slightly lossy — the recorded residual).
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const casBase = attempt === 0 && preloaded !== undefined ? preloaded : await loadMeta(`${tenantId}:${conversationId}`);
    const casResult = await buildAndSwapBoardGroup(tenantId, conversationId, boardId, participants, ownerUserId, casBase, injectedContextBlock, assertOwnerSubject);
    if (casResult) return casResult;
  }
  log.warn('board_group_stamp_contended', { conversationId, boardId });
  const finalBase = await loadMeta(`${tenantId}:${conversationId}`);
  return buildBoardGroupMeta(tenantId, conversationId, boardId, participants, ownerUserId, finalBase, injectedContextBlock, assertOwnerSubject, true);
}

/** Build the next board-group meta from `existing`; when `forcePut`, write LWW
 *  and return it; otherwise CAS and return the row on success / null on a lost
 *  race (the caller retries against a fresh read). */
async function buildAndSwapBoardGroup(
  tenantId: string,
  conversationId: string,
  boardId: string,
  participants: SubjectRef[],
  ownerUserId: string | undefined,
  existing: ConversationMeta | null,
  injectedContextBlock: string | null | undefined,
  assertOwnerSubject: Subject | undefined,
): Promise<ConversationMeta | null> {
  const next = composeBoardGroupMeta(tenantId, conversationId, boardId, participants, ownerUserId, existing, injectedContextBlock, assertOwnerSubject);
  return (await metas.compareAndSwap(existing, next)) ? next : null;
}

async function buildBoardGroupMeta(
  tenantId: string,
  conversationId: string,
  boardId: string,
  participants: SubjectRef[],
  ownerUserId: string | undefined,
  existing: ConversationMeta | null,
  injectedContextBlock: string | null | undefined,
  assertOwnerSubject: Subject | undefined,
  forcePut: boolean,
): Promise<ConversationMeta> {
  const next = composeBoardGroupMeta(tenantId, conversationId, boardId, participants, ownerUserId, existing, injectedContextBlock, assertOwnerSubject);
  if (forcePut) await metas.put(next);
  return next;
}

/** The PURE meta composition markAsBoardGroup has always done — extracted so the
 *  CAS loop rebuilds against each fresh read. */
function composeBoardGroupMeta(
  tenantId: string,
  conversationId: string,
  boardId: string,
  participants: SubjectRef[],
  ownerUserId: string | undefined,
  existing: ConversationMeta | null,
  injectedContextBlock: string | null | undefined,
  assertOwnerSubject: Subject | undefined,
): ConversationMeta {
  const ts = now();
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
    // ADR 0278 — PRESERVE the generic owner binding (and GRADE-7: allow the
    // caller to ASSERT it): the canonical board chat is created with
    // `ownerSubject: board:<id>` (the subject-access join gate); rebuilding the
    // meta without it silently erased shared-visibility access on every
    // re-open/summon, and a summon racing an open could drop it forever.
    ...((assertOwnerSubject ?? existing?.ownerSubject) ? { ownerSubject: assertOwnerSubject ?? existing?.ownerSubject } : {}),
    ...(nextBlock ? { injectedContextBlock: nextBlock } : {}),
    participants: merged,
    createdAt: existing?.createdAt ?? ts,
    updatedAt: ts,
  };
  return next;
}

/** GRADE-D7 — refresh an ENTITY-bound chat session's title after the entity was
 *  renamed (boards, projects): the title is set only at session creation, so a
 *  rename left the rail stale forever. Title-source-guarded — never clobbers a
 *  user rename (`titleSource !== 'default'`) — and a no-op when unchanged. */
export async function refreshEntityChatTitle(
  storage: import('../storage/storage.js').Storage,
  tenantId: string,
  sessionId: string,
  expectedTitle: string,
): Promise<void> {
  const session = await storage.getChatSession(tenantId, sessionId);
  if (!session || session.title === expectedTitle) return;
  if ((session.titleSource ?? 'default') !== 'default') return;
  await storage.updateChatSession(tenantId, sessionId, { title: expectedTitle, updatedAt: now() });
}

/** ADR 0278 GRADE-13 — release a conversation's generic owner binding. Used when
 *  the OWNING ENTITY is deleted (an advisory board): with the entity gone its
 *  access resolver returns 'none' for everyone, which would strand the
 *  transcript as permanently unreadable, undeletable dead data. Stripping
 *  `ownerSubject` drops the conversation back to the legacy owner/participant
 *  gate (the creator keeps read/manage; org-wide join ends — correct, since the
 *  entity that granted the join no longer exists). Idempotent; a no-op when the
 *  meta is absent or carries no owner binding. */
export async function releaseConversationOwnerSubject(tenantId: string, conversationId: string): Promise<void> {
  const existing = await loadMeta(`${tenantId}:${conversationId}`);
  if (!existing?.ownerSubject) return;
  const { ownerSubject: _released, ...rest } = existing;
  await metas.put({ ...rest, updatedAt: now() });
}

/** Add a participant (idempotent). Returns the updated meta, or null if the
 *  conversation has no meta. */
export async function addParticipant(
  tenantId: string,
  conversationId: string,
  subjectRef: SubjectRef,
  preloaded?: ConversationMeta | null,
  /** ADR 0192 D1 / ADR 0202 D1 — mention identity + response policy stamped
   *  ONLY here (membership-mutation time), so no read path ever rewrites the meta. */
  extras?: Pick<ConversationParticipant, 'mentionSlug' | 'displayLabel' | 'responsePolicy'>,
): Promise<ConversationMeta | null> {
  const meta = preloaded === undefined ? await loadMeta(`${tenantId}:${conversationId}`) : preloaded;
  if (!meta) return null;
  if (meta.participants.some((p) => p.subjectRef === subjectRef)) return meta;
  const next: ConversationMeta = {
    ...meta,
    participants: [...meta.participants, { subjectRef, role: 'member', addedAt: now(), ...(extras?.mentionSlug ? { mentionSlug: extras.mentionSlug } : {}), ...(extras?.displayLabel ? { displayLabel: extras.displayLabel } : {}), ...(extras?.responsePolicy ? { responsePolicy: extras.responsePolicy } : {}) }],
    updatedAt: now(),
  };
  await metas.put(next);
  return next;
}

/** ADR 0202 D1 — set an agent participant's reply policy. A real membership
 *  mutation (rewrites the participant record) — never a read path. */
export async function setParticipantResponsePolicy(
  tenantId: string,
  conversationId: string,
  subjectRef: SubjectRef,
  policy: 'all' | 'mention',
  preloaded?: ConversationMeta | null,
): Promise<ConversationMeta | null> {
  const meta = preloaded === undefined ? await loadMeta(`${tenantId}:${conversationId}`) : preloaded;
  if (!meta) return null;
  const next: ConversationMeta = {
    ...meta,
    participants: meta.participants.map((p) => (p.subjectRef === subjectRef ? { ...p, responsePolicy: policy } : p)),
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
  const channel = { ...meta.channel, ...patch };
  // An empty-string description means CLEAR — drop the key so consumers never
  // see (and never have to special-case) `description: ''` (ADR 0192 D4).
  if (channel.description === '') delete channel.description;
  const next: ConversationMeta = { ...meta, channel, updatedAt: now() };
  await metas.put(next);
  return next;
}

/** Mark a participant's read position (ADR 0043 — unread badge). Writes a
 *  dedicated per-(conversation, subject) read marker rather than rewriting the
 *  whole meta, so it can't race a concurrent participant mutation on the same
 *  record. The route's projection joins the marker back into the response. */
export async function markRead(tenantId: string, conversationId: string, subjectRef: SubjectRef, at: string, readMessageCount?: number): Promise<void> {
  await setReadMarker(tenantId, conversationId, subjectRef, at, readMessageCount);
}

// ── ADR 0464 P2 — DSAR subject erasure ───────────────────────────────────────
// A conversation is SHARED history — other participants' transcript. Deleting it
// on one participant's DSAR would erase everyone's record, so a conversation is
// NEVER deleted here; instead the erased subject's identifiers are ANONYMIZED in
// place: `ownerUserId`, a user-kind `ownerSubject`, the matching
// `participants[].subjectRef` (the participant row is KEPT so the transcript's
// membership shape survives — the message author simply reads as `user:[erased]`),
// and the subject's segment of a 1:1 `dmKey`. Channel `name`/`description` are
// WORKSPACE content (the room's identity, authored as a shared artifact), NOT the
// subject's personal data, so they are deliberately left intact. The read
// markers, feedback, and reactions the subject authored are DELETED by their own
// erasers (separate stores). Idempotent; tenant-scoped; fail-closed on falsy input.

/** DSAR eraser — anonymize the subject's identity across every conversation meta
 *  in the tenant, without deleting any conversation. */
export async function eraseSubjectConversations(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const m of await metas.listByPrefix(`${tenantId}:`)) {
    const ownerHit = m.ownerUserId !== undefined && forms.has(m.ownerUserId);
    const partHit = m.participants.some((p) => forms.has(p.subjectRef));
    const subjHit = m.ownerSubject?.kind === 'user' && forms.has(m.ownerSubject.id);
    const dmHit = m.dmKey !== undefined && m.dmKey.split('|').some((seg) => forms.has(seg));
    if (!ownerHit && !partHit && !subjHit && !dmHit) continue;
    const next: ConversationMeta = {
      ...m,
      participants: m.participants.map((p) => (forms.has(p.subjectRef) ? { ...p, subjectRef: ERASED_USER_REF } : p)),
      updatedAt: now(),
    };
    if (ownerHit) next.ownerUserId = ERASED;
    if (subjHit) next.ownerSubject = { kind: 'user', id: ERASED };
    if (dmHit) next.dmKey = m.dmKey!.split('|').map((seg) => (forms.has(seg) ? ERASED_USER_REF : seg)).join('|');
    await metas.put(next);
  }
}

/** Register the conversation-store DSAR eraser (idempotent — the seam dedupes by
 *  reference). Called from the host-erasers boot step (host/hostSubjectErasers.ts). */
export function registerConversationErasure(): void {
  registerSubjectEraser(eraseSubjectConversations);
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
