/**
 * Host-extension chat-session history routes (Phase 2C.1).
 *
 *   GET    /v1/host/openwop-app/chat/sessions               — list (tenant-scoped, latest first)
 *   POST   /v1/host/openwop-app/chat/sessions               — { title? } → 201 { sessionId, title, ... }
 *   GET    /v1/host/openwop-app/chat/sessions/:id           — full session header
 *   PATCH  /v1/host/openwop-app/chat/sessions/:id           — { title } → 200 updated
 *   DELETE /v1/host/openwop-app/chat/sessions/:id           — 204, cascade deletes messages
 *   GET    /v1/host/openwop-app/chat/sessions/:id/messages  — full message thread
 *   POST   /v1/host/openwop-app/chat/sessions/:id/messages  — { messageId, role, content, meta? } → 201
 *
 * Namespace: these routes live under `/v1/host/openwop-app/*` per
 * `spec/v1/host-extensions.md` §"Canonical prefixes" — they are NOT
 * part of the OpenWOP v1 wire contract.
 *
 * Storage: backed by `chat_sessions` + `chat_messages` (sqlite v7 /
 * postgres v5 migrations). Tenant-scoped: each session belongs to one
 * tenant (the `tenantId` from the auth middleware). Best-effort — no
 * per-user concept beyond tenant.
 *
 * Auth: every route requires a valid Bearer token / session cookie
 * (handled by the global auth middleware). Bearer-authed callers
 * (`tenants: ['*']`) use the `_anon` tenant bucket so legacy unauth
 * bearer-authed probes still group consistently.
 */

import type { Express, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../types.js';
import { probeProviderCapabilities } from '../host/modelCapabilityProbe.js';
import { getProviderConfig, listSelectableProviderIds } from '../providers/catalog.js';
import type { Storage } from '../storage/storage.js';
import {
  CONVERSATION_TYPES,
  type ConversationType,
  type SubjectRef,
  type ConversationMeta,
  userRef,
  dmKeyOf,
  ensureConversationMeta,
  getConversationMeta,
  listConversationMetas,
  findByDmKey,
  markAsBoardGroup,
  addParticipant,
  removeParticipant,
  markRead,
  setConversationRun,
} from '../host/conversationStore.js';
import { resolveBoardContextResult, resolveBoardCohortForCaller } from '../host/boardContextResolver.js';
import { deleteConversationCompletely } from '../host/conversationCascade.js';
import { readMarkersOf, readMarkersByConversation, type ReadMarkerView } from '../host/conversationReadState.js';
import { publishChatMessageAppended, publishConversationFrame } from '../host/chatMessageBus.js';
import { addReaction, removeReaction, listReactionsForConversation, aggregateReactions, deleteReactionsForMessage, isReactionEmoji, REACTION_EMOJI } from '../host/messageReactionsStore.js';
import { resolveSubjectAccess, levelSatisfies } from '../host/subjectAccess.js';
import { isVisibleToAsync, isRailListed } from '../host/conversationVisibility.js';
import { setMessageFeedback, getMessageFeedback, listMessageFeedbackForSession, isFeedbackRating } from '../host/messageFeedbackStore.js';
import { encodeMessageCursor, decodeMessageCursor, MAX_MESSAGE_PAGE } from '../host/messageCursor.js';

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
// A subjectRef is `<kind>:<id>` — kind is a word, id is the host's id grammar.
const SUBJECT_REF_PATTERN = /^(user|agent|project|workspace):[A-Za-z0-9._:-]{1,128}$/;
const MAX_TITLE_BYTES = 256;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_META_BYTES = 64 * 1024;
const MAX_PARTICIPANTS = 16;
// MAX_MESSAGE_PAGE + the cursor codec moved to host/messageCursor.ts (CS-CH-3)
// so the channels routes page with the SAME idiom — one owner.

function tenantFromReq(req: Request): string {
  // Auth middleware sets req.tenantId on session-cookied requests.
  // Bearer-authed probes have tenants: ['*'] but no req.tenantId
  // — bucket them under `_anon` so they don't trample real sessions.
  return req.tenantId ?? '_anon';
}

/** The acting user's stable subject (ADR 0005) — the conversation owner. */
function actingUserOf(req: Request): string | undefined {
  return req.userId ?? req.principal?.principalId;
}

/** The caller as a subjectRef, for stamping/comparing a message's `author_subject`
 *  (ADR 0102 Phase 2). A user session → `user:<id>` (same space as `ownerUserId`);
 *  a bearer/anon principal → its `principalId`; nothing → null. */
function callerSubject(req: Request): string | null {
  if (req.userId) return userRef(req.userId);
  return req.principal?.principalId ?? null;
}

/** Owner-gate a participant mutation (ADR 0043 RBAC). When the conversation has
 *  a recorded owner, only that owner may change its membership — a non-owner
 *  caller (a different user in the same tenant) gets 403. A legacy/anon
 *  conversation with no recorded owner stays permissive (tenant-scoping is the
 *  only guard there, as before). */
function requireOwner(meta: ConversationMeta | null, req: Request): void {
  if (meta?.ownerUserId && meta.ownerUserId !== actingUserOf(req)) {
    throw new OpenwopError('forbidden', 'Only the conversation owner may change its participants.', 403);
  }
}

/** Async, subject-aware `requireVisible`: 404 (no existence leak) when the caller
 *  may not READ the conversation. */
async function requireVisibleAsync(meta: ConversationMeta | null, req: Request, tenantId: string, sessionId: string): Promise<void> {
  if (!(await isVisibleToAsync(meta, tenantId, actingUserOf(req)))) {
    throw new OpenwopError('not_found', `chat_session "${sessionId}" not found.`, 404);
  }
}

/** Membership-aware MANAGE gate (rename / delete / participant mutation). For a
 *  Subject-bound conversation only a caller with WRITE on the subject — org-scoped
 *  authority, NEVER mere membership (ADR 0045/0054 boundary) — may manage it; this
 *  lets any project writer manage the chat while stopping a removed owner. A
 *  conversation with no subject resolution falls back to the owner-only gate. */
async function requireManageAsync(meta: ConversationMeta | null, req: Request, tenantId: string): Promise<void> {
  if (meta?.ownerSubject) {
    const level = await resolveSubjectAccess(tenantId, meta.ownerSubject, actingUserOf(req));
    if (level !== null) {
      if (!levelSatisfies(level, 'write')) {
        throw new OpenwopError('forbidden', 'Only a project writer may manage this conversation.', 403);
      }
      return;
    }
  }
  requireOwner(meta, req);
}

/** Project a chat-session header + its conversation meta into the unified
 *  conversation shape the sidebar consumes. Legacy sessions with no meta default
 *  to a tenant-owned `agent` conversation (back-compat).
 *
 *  `readBySubject` joins each participant's read marker (ADR 0043 — read state
 *  now lives in its own store) back into `participants[].lastReadAt`, keeping the
 *  wire shape stable. A marker wins over any value baked into the meta by the
 *  pre-split `markRead` (so existing read state survives the transition). */
/** Join each participant's read marker (ADR 0043 — read state lives in its own
 *  store) into `participants[].lastReadAt` (+ the ADR 0192 D6 counters:
 *  `readMessageCount` for unread differencing, `mentionCount` for the mention
 *  tier). A marker's `lastReadAt` wins over any value baked into the meta by
 *  the pre-split `markRead`; an ABSENT marker `lastReadAt` (mention-only
 *  marker) must NOT clobber the meta fallback (architect finding 13). */
function withReadMarkers(
  participants: readonly ConversationMeta['participants'][number][],
  readBySubject?: ReadonlyMap<SubjectRef, ReadMarkerView>,
  /** ADR 0192 Phase-2 amendment — the CALLER's subjectRef; the matching row is
   *  stamped `isSelf: true` so the FE derives unread/mention counts from ITS
   *  OWN row (the old `role === 'owner'` heuristic reads the wrong marker for
   *  every non-owner member). */
  callerRef?: string | null,
): ReadonlyArray<Record<string, unknown>> {
  return participants.map((p) => {
    const view = readBySubject?.get(p.subjectRef);
    const lastReadAt = view?.lastReadAt ?? p.lastReadAt;
    return {
      ...p,
      ...(lastReadAt ? { lastReadAt } : {}),
      ...(view?.readMessageCount !== undefined ? { readMessageCount: view.readMessageCount } : {}),
      ...(view?.mentionCount !== undefined && view.mentionCount > 0 ? { mentionCount: view.mentionCount } : {}),
      ...(callerRef && p.subjectRef === callerRef ? { isSelf: true } : {}),
    };
  });
}

function toConversation(
  session: { sessionId: string; title: string; createdAt: string; updatedAt: string; messageCount: number },
  meta: ConversationMeta | null,
  readBySubject?: ReadonlyMap<SubjectRef, ReadMarkerView>,
  callerRef?: string | null,
): Record<string, unknown> {
  const participants = withReadMarkers(meta?.participants ?? [], readBySubject, callerRef);
  return {
    ...session,
    type: meta?.type ?? 'agent',
    ...(meta?.ownerUserId ? { ownerUserId: meta.ownerUserId } : {}),
    ...(meta?.boardId ? { boardId: meta.boardId } : {}),
    // ADR 0054 D6 — surface the owning Subject (a `project:<id>`) so the chat UI
    // can offer "Convene the team" for a project's group chat.
    ...(meta?.ownerSubject ? { ownerSubject: meta.ownerSubject } : {}),
    ...(meta?.branchedFrom ? { branchedFrom: meta.branchedFrom } : {}), // ADR 0117 — FE branch indicator
    participants,
  };
}

function readConversationType(v: unknown): ConversationType {
  if (v === undefined) return 'agent';
  if (typeof v !== 'string' || !CONVERSATION_TYPES.includes(v as ConversationType)) {
    throw new OpenwopError('validation_error', `type MUST be one of: ${CONVERSATION_TYPES.join(', ')}.`, 400);
  }
  return v as ConversationType;
}

function readParticipants(v: unknown): SubjectRef[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_PARTICIPANTS) {
    throw new OpenwopError('validation_error', `participants MUST be an array of ${MAX_PARTICIPANTS} subjectRefs or fewer.`, 400);
  }
  for (const ref of v) {
    if (typeof ref !== 'string' || !SUBJECT_REF_PATTERN.test(ref)) {
      throw new OpenwopError('validation_error', 'each participant MUST be a subjectRef like `user:<id>` or `agent:<id>`.', 400);
    }
  }
  return v as SubjectRef[];
}

interface CreateSessionRequest {
  title?: unknown;
  /** Optional client-chosen id. Must match `[A-Za-z0-9_-]{1,64}`;
   *  defaults to a fresh UUID when omitted. */
  sessionId?: unknown;
  /** Conversation type (ADR 0043). Defaults to `agent`. */
  type?: unknown;
  /** Initial participant subjectRefs (`agent:<id>` / `user:<id>`). The caller is
   *  always added as the owner. */
  participants?: unknown;
  /** When seeding a `group` from an advisory board (ADR 0040). */
  boardId?: unknown;
}

interface PatchSessionRequest {
  title?: unknown;
}

interface AppendMessageRequest {
  messageId?: unknown;
  role?: unknown;
  content?: unknown;
  meta?: unknown;
}

const VALID_ROLES = ['user', 'assistant', 'system', 'workflow_run'] as const;

export function registerChatSessionRoutes(app: Express, deps: { storage: Storage }): void {
  const { storage } = deps;

  // ADR 0124 — capability-aware model selector: a thin read of the RFC 0031 model
  // capabilities per configured provider, so the composer can badge/disable a
  // model by what it supports (vision/tools/long-context). Static introspection
  // (same posture as the public capabilities advertisement); no tenant state.
  app.get('/v1/host/openwop-app/chat/model-capabilities', (_req, res, next) => {
    try {
      // ADR 0164 — advertise ONLY user-selectable providers (the catalog's
      // `!managed && !hidden` set). The prior hard-coded array leaked `minimax`
      // (hidden: true — reached via the managed `openwop-free` tier, never picked
      // by name) into the in-chat model picker on every surface.
      const providers = listSelectableProviderIds();
      res.json({
        providers: providers.map((provider) => ({
          provider,
          capabilities: probeProviderCapabilities(provider),
          // ADR 0124 Phase 2c — the selectable models per provider (id + label +
          // capabilities), from the static providers catalog. Non-sensitive.
          models: (getProviderConfig(provider)?.models ?? []).map((m) => ({ id: m.id, label: m.label, capabilities: m.capabilities, recommended: m.recommended === true })),
        })),
      });
    } catch (err) { next(err); }
  });

  // NOTE: the `conversations-v2` rollout toggle (ADR 0043 Phase 2) was RETIRED
  // here once the Conversations rail became the sole chat IA — the legacy
  // SessionHistoryDrawer + ActiveAgentsPanel it gated were deleted, so there is
  // nothing left to switch to. A lingering durable override resolves to nothing
  // (no declared default) and is harmless.

  // ── sessions collection ────────────────────────────────────────────
  app.get('/v1/host/openwop-app/chat/sessions', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      const [sessions, metas, readByConversation] = await Promise.all([
        storage.listChatSessions(tenantId),
        listConversationMetas(tenantId),
        readMarkersByConversation(tenantId),
      ]);
      const byId = new Map(metas.map((m) => [m.conversationId, m]));
      // Enrich each header with its conversation meta (type + participants) so
      // the sidebar can group Agents / Groups / Workspace (ADR 0043). Legacy
      // sessions with no meta project as tenant-owned `agent` conversations.
      // Read markers are batch-loaded once + joined per session (no N+1).
      // Participant-scoped (ADR 0043 Phase 6): a member only sees conversations
      // they own or participate in (legacy unowned stay tenant-visible).
      const userId = actingUserOf(req);
      // Subject-aware (ADR 0054): a project group chat is visible to its members
      // (via `subjectAccess`), not just its participants — so resolve async.
      const shown = await Promise.all(sessions.map((s) => isVisibleToAsync(byId.get(s.sessionId) ?? null, tenantId, userId)));
      const visible = sessions.filter((s, i) => {
        if (!shown[i]) return false;
        // ADR 0154 — an archived channel drops out of the rail (parity with the
        // dedicated listChannels endpoint, which already excludes archived).
        const meta = byId.get(s.sessionId);
        if (meta?.type === 'channel' && meta.channel?.archived) return false;
        // ADR 0195 — a PUBLIC channel is now READABLE by any tenant member
        // (channel-aware visibility), but only rail-LISTED for its members:
        // browse remains the discovery surface (ADR 0154).
        if (!isRailListed(meta ?? null, userId)) return false;
        return true;
      });
      res.json({ sessions: visible.map((s) => toConversation(s, byId.get(s.sessionId) ?? null, readByConversation.get(s.sessionId), callerSubject(req))) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/chat/sessions', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as CreateSessionRequest;
      if (typeof body !== 'object' || body === null) {
        throw new OpenwopError('validation_error', 'Request body MUST be a JSON object.', 400);
      }

      let sessionId: string;
      if (body.sessionId !== undefined) {
        if (typeof body.sessionId !== 'string' || !ID_PATTERN.test(body.sessionId)) {
          throw new OpenwopError(
            'validation_error',
            'sessionId MUST match /^[A-Za-z0-9_-]{1,64}$/.',
            400,
          );
        }
        sessionId = body.sessionId;
      } else {
        sessionId = randomUUID();
      }

      let title = 'New chat';
      if (body.title !== undefined) {
        if (typeof body.title !== 'string' || body.title.length === 0) {
          throw new OpenwopError('validation_error', 'title MUST be a non-empty string when present.', 400);
        }
        if (Buffer.byteLength(body.title, 'utf8') > MAX_TITLE_BYTES) {
          throw new OpenwopError('validation_error', `title MUST be ${MAX_TITLE_BYTES} bytes or fewer.`, 400);
        }
        title = body.title;
      }

      const convType = readConversationType(body.type);
      const participants = readParticipants(body.participants);
      const boardId = body.boardId === undefined ? undefined : (typeof body.boardId === 'string' ? body.boardId : (() => { throw new OpenwopError('validation_error', 'boardId MUST be a string when present.', 400); })());

      const now = new Date().toISOString();
      const tenantId = tenantFromReq(req);
      try {
        await storage.createChatSession({
          sessionId,
          tenantId,
          title,
          createdAt: now,
          updatedAt: now,
          messageCount: 0,
        });
      } catch (err) {
        // Treat unique-violation as a 409 so the FE can surface "id
        // already taken" instead of a 500.
        const code = (err as { code?: string }).code;
        if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === '23505') {
          throw new OpenwopError(
            'idempotency_key_conflict',
            `chat_session "${sessionId}" already exists.`,
            409,
          );
        }
        throw err;
      }

      // The conversation meta sidecar (ADR 0043) — type + owner + participants,
      // keyed by the same id. The caller is the owner.
      const meta = await ensureConversationMeta(tenantId, sessionId, {
        type: convType,
        ...(actingUserOf(req) ? { ownerUserId: actingUserOf(req) } : {}),
        participants,
        ...(boardId ? { boardId } : {}),
      });

      res.status(201).json(toConversation({ sessionId, title, createdAt: now, updatedAt: now, messageCount: 0 }, meta));
    } catch (err) {
      next(err);
    }
  });

  // ── session item ───────────────────────────────────────────────────
  app.get('/v1/host/openwop-app/chat/sessions/:sessionId', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      const session = await storage.getChatSession(tenantId, req.params.sessionId);
      if (!session) {
        throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
      }
      const [meta, readBySubject] = await Promise.all([
        getConversationMeta(tenantId, req.params.sessionId),
        readMarkersOf(tenantId, req.params.sessionId),
      ]);
      await requireVisibleAsync(meta, req, tenantId, req.params.sessionId);
      res.json(toConversation(session, meta, readBySubject, callerSubject(req)));
    } catch (err) {
      next(err);
    }
  });

  app.patch('/v1/host/openwop-app/chat/sessions/:sessionId', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      const existing = await storage.getChatSession(tenantId, req.params.sessionId);
      if (!existing) {
        throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
      }
      await requireVisibleAsync(await getConversationMeta(tenantId, req.params.sessionId), req, tenantId, req.params.sessionId);
      const body = (req.body ?? {}) as PatchSessionRequest;
      if (typeof body !== 'object' || body === null) {
        throw new OpenwopError('validation_error', 'Request body MUST be a JSON object.', 400);
      }
      const patch: { title?: string; titleSource?: 'user'; updatedAt: string } = { updatedAt: new Date().toISOString() };
      if (body.title !== undefined) {
        if (typeof body.title !== 'string' || body.title.length === 0) {
          throw new OpenwopError('validation_error', 'title MUST be a non-empty string when present.', 400);
        }
        if (Buffer.byteLength(body.title, 'utf8') > MAX_TITLE_BYTES) {
          throw new OpenwopError('validation_error', `title MUST be ${MAX_TITLE_BYTES} bytes or fewer.`, 400);
        }
        patch.title = body.title;
        // ADR 0151 — a manual rename pins the title as user-authored so the
        // first-exchange auto-titler never overwrites it (it only runs on 'default').
        patch.titleSource = 'user';
      }
      await storage.updateChatSession(tenantId, req.params.sessionId, patch);
      const updated = await storage.getChatSession(tenantId, req.params.sessionId);
      // Project through toConversation so a rename preserves the conversation's
      // type + participants (+ read markers) in the response (the sidebar
      // consumes this shape).
      if (!updated) { res.json(updated); return; }
      const [meta, readBySubject] = await Promise.all([
        getConversationMeta(tenantId, req.params.sessionId),
        readMarkersOf(tenantId, req.params.sessionId),
      ]);
      res.json(toConversation(updated, meta, readBySubject, callerSubject(req)));
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/chat/sessions/:sessionId', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      if (!(await storage.getChatSession(tenantId, req.params.sessionId))) {
        throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
      }
      // Visible to non-members? 404. Visible but not the owner? 403 — only the
      // owner deletes a conversation (a participant leaves via the × instead).
      const meta = await getConversationMeta(tenantId, req.params.sessionId);
      await requireVisibleAsync(meta, req, tenantId, req.params.sessionId);
      await requireManageAsync(meta, req, tenantId);
      // The whole cascade — session (messages cascade in SQL), meta, the four
      // host-owned sidecars, then the feature seam. Extracted to ONE owner
      // during UX_UPGRADE-projects R2, when a second caller appeared and got a
      // PARTIAL version of it dangerously wrong; see `host/conversationCascade.ts`.
      await deleteConversationCompletely(storage, tenantId, req.params.sessionId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── messages sub-collection ────────────────────────────────────────
  // GET …/messages              → the full thread (legacy; unchanged).
  // GET …/messages?limit=N      → the N most-recent messages (ASC) + a
  //                                `nextCursor` to page older, or null at the
  //                                start of history (ADR 0043 Phase 3b).
  // GET …/messages?limit=N&before=<cursor> → the N messages older than the cursor.
  app.get('/v1/host/openwop-app/chat/sessions/:sessionId/messages', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      const session = await storage.getChatSession(tenantId, req.params.sessionId);
      if (!session) {
        throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
      }
      const meta = await getConversationMeta(tenantId, req.params.sessionId);
      await requireVisibleAsync(meta, req, tenantId, req.params.sessionId);
      // The conversation RUN id backing this chat (ADR 0067 continuity) — the
      // client restores it on open so continuing the chat reuses the same
      // suspended run instead of orphaning it + losing server-side context.
      const conversationRunId = meta?.conversationRunId;

      // ADR 0195 D3 — multi-party threads join the message reactions (ONE
      // batched prefix read per conversation; aggregates carry viewer-aware
      // `mine`). 1:1 threads skip the read (no reactions UI there).
      const isMultiParty = meta?.type === 'channel' || meta?.type === 'group';
      const reactionsByMessage = isMultiParty ? await listReactionsForConversation(tenantId, req.params.sessionId) : null;
      const viewer = callerSubject(req);
      const withReactions = <T extends { messageId: string }>(rows: readonly T[]): ReadonlyArray<T & { reactions?: ReturnType<typeof aggregateReactions> }> =>
        reactionsByMessage
          ? rows.map((m) => {
              const agg = aggregateReactions(reactionsByMessage.get(m.messageId), viewer);
              return agg.length ? { ...m, reactions: agg } : m;
            })
          : rows;

      // No `limit` → full thread, back-compat shape `{ messages }`.
      if (req.query.limit === undefined) {
        const messages = await storage.listChatSessionMessages(req.params.sessionId);
        res.json({ messages: withReactions(messages), ...(conversationRunId ? { conversationRunId } : {}) });
        return;
      }

      const limit = Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGE_PAGE) {
        throw new OpenwopError('validation_error', `limit MUST be an integer between 1 and ${MAX_MESSAGE_PAGE}.`, 400);
      }
      let before: { createdAt: string; messageId: string } | undefined;
      if (req.query.before !== undefined) {
        const decoded = typeof req.query.before === 'string' ? decodeMessageCursor(req.query.before) : null;
        if (!decoded) {
          throw new OpenwopError('validation_error', 'before MUST be a cursor of the form `<ISO-8601>~<messageId>`.', 400);
        }
        before = decoded;
      }

      // Fetch one extra to detect whether older messages remain beyond the page.
      const fetched = await storage.listChatSessionMessages(req.params.sessionId, { limit: limit + 1, ...(before ? { before } : {}) });
      const hasMore = fetched.length > limit;
      // `fetched` is ASC; the surplus oldest row sits at the front — drop it.
      const messages = hasMore ? fetched.slice(1) : fetched;
      const oldest = messages[0];
      const nextCursor = hasMore && oldest ? encodeMessageCursor(oldest) : null;
      res.json({ messages: withReactions(messages), nextCursor, ...(conversationRunId ? { conversationRunId } : {}) });
    } catch (err) {
      next(err);
    }
  });

  // ── persist the conversation RUN id backing a chat (ADR 0067 continuity) ──
  // PUT { conversationRunId } records the long-lived conversation run on the
  // session's meta so a later open (other device / cleared local blob) reuses the
  // same suspended run instead of opening a fresh one + orphaning the old. The
  // caller must already see the session (visibility gate); the run id itself is
  // opaque and non-sensitive.
  app.put('/v1/host/openwop-app/chat/sessions/:sessionId/conversation-run', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      if (!(await storage.getChatSession(tenantId, req.params.sessionId))) {
        throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
      }
      await requireVisibleAsync(await getConversationMeta(tenantId, req.params.sessionId), req, tenantId, req.params.sessionId);
      const body = (req.body ?? {}) as { conversationRunId?: unknown };
      if (typeof body.conversationRunId !== 'string' || !ID_PATTERN.test(body.conversationRunId)) {
        throw new OpenwopError('validation_error', 'conversationRunId MUST match /^[A-Za-z0-9_-]{1,64}$/.', 400);
      }
      await setConversationRun(tenantId, req.params.sessionId, body.conversationRunId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ADR 0117 — branch a conversation at a settled turn. Forks the message
  // lineage: a child conversation seeded with the parent's first `fromSeq`
  // messages, recording `branchedFrom`. Participant-scoped (404 on a parent the
  // caller may not see). The child opens its own conversation run lazily (ADR
  // 0043) — server-side agent-context :fork is a documented refinement (OQ).
  app.post('/v1/host/openwop-app/chat/sessions/:sessionId/branch', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      const parentId = req.params.sessionId;
      const parentMeta = await getConversationMeta(tenantId, parentId);
      await requireVisibleAsync(parentMeta, req, tenantId, parentId); // 404 if not owner/participant
      const parentSession = await storage.getChatSession(tenantId, parentId);
      if (!parentSession) throw new OpenwopError('not_found', `chat_session "${parentId}" not found.`, 404);

      const allMessages = await storage.listChatSessionMessages(parentId);
      const total = allMessages.length;
      const body = (req.body ?? {}) as { fromSeq?: unknown };
      const fromSeq = body.fromSeq === undefined ? total : body.fromSeq;
      if (typeof fromSeq !== 'number' || !Number.isInteger(fromSeq) || fromSeq < 0) {
        throw new OpenwopError('validation_error', 'fromSeq MUST be a non-negative integer.', 400);
      }
      if (fromSeq > total) {
        throw new OpenwopError('validation_error', `fromSeq ${fromSeq} exceeds the conversation length (${total}).`, 422);
      }

      const childId = randomUUID();
      const childTitle = `${parentSession.title} (branch)`;
      const now = new Date().toISOString();
      await storage.createChatSession({ sessionId: childId, tenantId, title: childTitle, createdAt: now, updatedAt: now, messageCount: 0 });
      // Carry the settled prefix into the child (fresh message ids; preserve role/
      // content/author/order). appendChatMessage atomically bumps the child count.
      const prefix = allMessages.slice(0, fromSeq);
      for (let i = 0; i < prefix.length; i++) {
        const m = prefix[i]!;
        await storage.appendChatMessage({ messageId: `${childId}-m${i}`, sessionId: childId, role: m.role, content: m.content, meta: m.meta, authorSubject: m.authorSubject, createdAt: m.createdAt });
      }
      const meta = await ensureConversationMeta(tenantId, childId, {
        type: parentMeta?.type ?? 'agent',
        ...(actingUserOf(req) ? { ownerUserId: actingUserOf(req) } : {}),
        branchedFrom: { conversationId: parentId, fromSeq },
      });
      res.status(201).json(toConversation({ sessionId: childId, title: childTitle, createdAt: now, updatedAt: now, messageCount: prefix.length }, meta));
    } catch (err) { next(err); }
  });

  app.post('/v1/host/openwop-app/chat/sessions/:sessionId/messages', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      const session = await storage.getChatSession(tenantId, req.params.sessionId);
      if (!session) {
        throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
      }
      const convMeta = await getConversationMeta(tenantId, req.params.sessionId);
      await requireVisibleAsync(convMeta, req, tenantId, req.params.sessionId);
      // ADR 0192 D6 — channel posts MUST use the channel route, which owns the
      // archived check, mention/agent dispatch, live publish, and counters. The
      // generic append reaching a channel would silently skip all four.
      if (convMeta?.type === 'channel') {
        throw new OpenwopError('validation_error', 'Channel messages MUST be posted via /v1/host/openwop-app/channels/:id/messages.', 400);
      }
      const body = (req.body ?? {}) as AppendMessageRequest;
      if (typeof body !== 'object' || body === null) {
        throw new OpenwopError('validation_error', 'Request body MUST be a JSON object.', 400);
      }
      if (typeof body.messageId !== 'string' || !ID_PATTERN.test(body.messageId)) {
        throw new OpenwopError(
          'validation_error',
          'messageId MUST match /^[A-Za-z0-9_-]{1,64}$/.',
          400,
        );
      }
      if (typeof body.role !== 'string' || !VALID_ROLES.includes(body.role as (typeof VALID_ROLES)[number])) {
        throw new OpenwopError(
          'validation_error',
          `role MUST be one of: ${VALID_ROLES.join(', ')}.`,
          400,
        );
      }
      if (typeof body.content !== 'string') {
        throw new OpenwopError('validation_error', 'content MUST be a JSON string.', 400);
      }
      if (Buffer.byteLength(body.content, 'utf8') > MAX_CONTENT_BYTES) {
        throw new OpenwopError('validation_error', `content MUST be ${MAX_CONTENT_BYTES} bytes or fewer.`, 400);
      }
      let metaStr: string | null = null;
      if (body.meta !== undefined && body.meta !== null) {
        if (typeof body.meta !== 'string') {
          throw new OpenwopError('validation_error', 'meta MUST be a JSON string when present.', 400);
        }
        if (Buffer.byteLength(body.meta, 'utf8') > MAX_META_BYTES) {
          throw new OpenwopError('validation_error', `meta MUST be ${MAX_META_BYTES} bytes or fewer.`, 400);
        }
        metaStr = body.meta;
      }

      const now = new Date().toISOString();
      try {
        // `appendChatMessage` atomically bumps the parent session's
        // `message_count` + `updated_at` in the same transaction so
        // concurrent appends don't lose increments. Previously the
        // route did read-then-write on `session.messageCount`, which
        // raced under load.
        await storage.appendChatMessage({
          messageId: body.messageId,
          sessionId: req.params.sessionId,
          role: body.role as (typeof VALID_ROLES)[number],
          content: body.content,
          meta: metaStr,
          // ADR 0102 Phase 2 — SERVER-STAMP the author (never client-supplied) so
          // an in-place edit can be gated to the author or the session owner.
          authorSubject: callerSubject(req),
          createdAt: now,
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === '23505') {
          throw new OpenwopError(
            'idempotency_key_conflict',
            `chat_message "${body.messageId}" already exists.`,
            409,
          );
        }
        throw err;
      }

      // ADR 0192 D6 — group (multi-party) appends converge on the bus's
      // post-processing (live-delivery publish + mention stamping) so the bus
      // stays the real multi-party choke-point. 1:1 appends skip it (no
      // subscriber semantics, no mention tier).
      if (convMeta?.type === 'group') {
        publishChatMessageAppended({
          messageId: body.messageId,
          sessionId: req.params.sessionId,
          role: body.role as (typeof VALID_ROLES)[number],
          content: body.content,
          meta: metaStr,
          authorSubject: callerSubject(req),
          createdAt: now,
        }, tenantId);
      }

      res.status(201).json({
        messageId: body.messageId,
        sessionId: req.params.sessionId,
        role: body.role,
        content: body.content,
        meta: metaStr,
        createdAt: now,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── update a message's content in place (ADR 0067) ─────────────────
  // PUT { content, meta? } re-saves an existing message — a run-backed
  // `workflow_run` message's state (node cards + the HITL interrupt card) grows
  // across its lifecycle, so it's re-persisted as it evolves rather than appended
  // (the messageId is unique → append would 409). `created_at`/`role` are
  // immutable, so thread order + counts are unaffected. 404 if the message (or
  // session) doesn't exist — the client falls back to a fresh append.
  app.put('/v1/host/openwop-app/chat/sessions/:sessionId/messages/:messageId', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      if (!(await storage.getChatSession(tenantId, req.params.sessionId))) {
        throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
      }
      const meta = await getConversationMeta(tenantId, req.params.sessionId);
      await requireVisibleAsync(meta, req, tenantId, req.params.sessionId);
      const body = (req.body ?? {}) as { content?: unknown; meta?: unknown };
      if (typeof body.content !== 'string') {
        throw new OpenwopError('validation_error', 'content MUST be a JSON string.', 400);
      }
      if (Buffer.byteLength(body.content, 'utf8') > MAX_CONTENT_BYTES) {
        throw new OpenwopError('validation_error', `content MUST be ${MAX_CONTENT_BYTES} bytes or fewer.`, 400);
      }
      let metaStr: string | null = null;
      if (body.meta !== undefined && body.meta !== null) {
        if (typeof body.meta !== 'string') {
          throw new OpenwopError('validation_error', 'meta MUST be a JSON string when present.', 400);
        }
        if (Buffer.byteLength(body.meta, 'utf8') > MAX_META_BYTES) {
          throw new OpenwopError('validation_error', `meta MUST be ${MAX_META_BYTES} bytes or fewer.`, 400);
        }
        metaStr = body.meta;
      }
      // ADR 0102 Phase 2 — edit authz: only the message's AUTHOR or the session
      // owner/manager may overwrite it (so a member of a shared chat can't tamper
      // with another's message). 404 first (no existence leak). A null author
      // (legacy/anon row) is owner-writable via requireManageAsync.
      // ADR 0195 D1 — the row (not just the author) drives the server-derived
      // editedAt stamp + the channel-aware authz below.
      const existingMsg = await storage.getChatMessage(req.params.sessionId, req.params.messageId);
      if (!existingMsg) {
        throw new OpenwopError('not_found', `chat_message "${req.params.messageId}" not found.`, 404);
      }
      const caller = callerSubject(req);
      const isAuthor = existingMsg.authorSubject !== null && caller !== null && existingMsg.authorSubject === caller;
      if (!isAuthor) {
        // ADR 0195 D1 — for a CHANNEL the non-author fallback is the channel
        // owner ONLY (never requireManageAsync, whose ownerless-permissive
        // branch would let any tenant member edit others' messages in an
        // ownerless legacy channel — the ADR 0192 finding-2 class).
        if (meta?.type === 'channel') {
          if (!meta.ownerUserId || meta.ownerUserId !== actingUserOf(req)) {
            throw new OpenwopError('forbidden', 'Only the author or the channel owner may edit this message.', 403);
          }
        } else {
          await requireManageAsync(meta, req, tenantId); // throws 403 unless owner/manager
        }
      }
      // ADR 0195 D1 — archived channels reject edits (mirrors the post guard).
      if (meta?.type === 'channel' && meta.channel?.archived) {
        throw new OpenwopError('validation_error', 'Channel is archived.', 400);
      }
      // ADR 0195 D2 — a TOMBSTONED row is immutable: editing it would replace
      // the sentinel while meta.deletedAt persists (a ghost half-undelete).
      let storedMeta: Record<string, unknown> = {};
      try { storedMeta = existingMsg.meta ? JSON.parse(existingMsg.meta) as Record<string, unknown> : {}; } catch { /* opaque */ }
      if (typeof storedMeta.deletedAt === 'string' && existingMsg.role !== 'workflow_run') {
        throw new OpenwopError('validation_error', 'A deleted message cannot be edited.', 400);
      }
      // ADR 0195 D1 — server-derived editedAt: `role !== 'workflow_run'` (the
      // run-card re-persist is the ONLY legitimate non-edit caller) AND the
      // content actually changed. Never client-attested — an author can't hide
      // an edit by omitting a flag. Stamped into the meta JSON. A caller-meta
      // PUT with UNCHANGED content must not drop a previously-stamped editedAt.
      let finalMeta = metaStr;
      if (existingMsg.role !== 'workflow_run') {
        if (body.content !== existingMsg.content) {
          let parsed: Record<string, unknown> = {};
          try { parsed = metaStr ? JSON.parse(metaStr) as Record<string, unknown> : { ...storedMeta }; } catch { /* rebuild */ }
          parsed.editedAt = new Date().toISOString();
          finalMeta = JSON.stringify(parsed);
        } else if (metaStr !== null && typeof storedMeta.editedAt === 'string') {
          let parsed: Record<string, unknown> = {};
          try { parsed = JSON.parse(metaStr) as Record<string, unknown>; } catch { /* rebuild */ }
          if (parsed.editedAt === undefined) {
            parsed.editedAt = storedMeta.editedAt;
            finalMeta = JSON.stringify(parsed);
          }
        }
      }
      const updated = await storage.updateChatMessageContent(req.params.sessionId, req.params.messageId, body.content, finalMeta);
      if (!updated) {
        throw new OpenwopError('not_found', `chat_message "${req.params.messageId}" not found.`, 404);
      }
      // CSC-1 — a content edit keeps messageCount, so bump the conversation's
      // updatedAt (as title edits already do) — the search index is watermarked on
      // `messageCount:updatedAt`, so this is what makes an edit re-index instead of
      // serving the stale old text.
      await storage.updateChatSession(tenantId, req.params.sessionId, { updatedAt: new Date().toISOString() });
      // ADR 0195 — publish-only frame (NOT publishChatMessageAppended: edits
      // never re-stamp mentions) so open channel/group streams reload.
      if (meta?.type === 'channel' || meta?.type === 'group') {
        publishConversationFrame('updated', req.params.sessionId, req.params.messageId);
      }
      res.status(200).json({ messageId: req.params.messageId, sessionId: req.params.sessionId, content: body.content, meta: finalMeta });
    } catch (err) {
      next(err);
    }
  });

  // ── tombstone-delete a message (ADR 0195 D2) ─────────────────────────
  // NOT a row delete: content becomes the canonical tombstone and the meta
  // gains deletedAt/deletedBy, so messageCount (ADR 0192 D6 unread
  // differencing), ordering, and branch anchors all survive. Same authz as
  // edit. The FE detects a tombstone by meta.deletedAt — never by parsing the
  // content sentinel — and tombstoned rows can never dispatch an agent turn
  // (dispatch happens only on the channel POST path, which this is not).
  app.delete('/v1/host/openwop-app/chat/sessions/:sessionId/messages/:messageId', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      if (!(await storage.getChatSession(tenantId, req.params.sessionId))) {
        throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
      }
      const meta = await getConversationMeta(tenantId, req.params.sessionId);
      await requireVisibleAsync(meta, req, tenantId, req.params.sessionId);
      const existingMsg = await storage.getChatMessage(req.params.sessionId, req.params.messageId);
      if (!existingMsg) {
        throw new OpenwopError('not_found', `chat_message "${req.params.messageId}" not found.`, 404);
      }
      const caller = callerSubject(req);
      const isAuthor = existingMsg.authorSubject !== null && caller !== null && existingMsg.authorSubject === caller;
      if (!isAuthor) {
        if (meta?.type === 'channel') {
          if (!meta.ownerUserId || meta.ownerUserId !== actingUserOf(req)) {
            throw new OpenwopError('forbidden', 'Only the author or the channel owner may delete this message.', 403);
          }
        } else {
          await requireManageAsync(meta, req, tenantId);
        }
      }
      if (meta?.type === 'channel' && meta.channel?.archived) {
        throw new OpenwopError('validation_error', 'Channel is archived.', 400);
      }
      let parsed: Record<string, unknown> = {};
      try { parsed = existingMsg.meta ? JSON.parse(existingMsg.meta) as Record<string, unknown> : {}; } catch { /* rebuild */ }
      if (typeof parsed.deletedAt === 'string') { res.status(204).end(); return; } // already tombstoned — idempotent
      parsed.deletedAt = new Date().toISOString();
      if (caller) parsed.deletedBy = caller;
      await storage.updateChatMessageContent(req.params.sessionId, req.params.messageId, '{"deleted":true}', JSON.stringify(parsed));
      // CSC-1 — a tombstone keeps the row (messageCount unchanged), so bump the
      // conversation's updatedAt — the search index (watermarked on
      // `messageCount:updatedAt`) re-indexes and the deleted content stops matching.
      await storage.updateChatSession(tenantId, req.params.sessionId, { updatedAt: new Date().toISOString() });
      // Cascade the message's reactions (best-effort — a failure leaves
      // orphaned rows the projection simply won't find a message for).
      try { await deleteReactionsForMessage(tenantId, req.params.sessionId, req.params.messageId); } catch { /* best-effort */ }
      if (meta?.type === 'channel' || meta?.type === 'group') {
        publishConversationFrame('deleted', req.params.sessionId, req.params.messageId);
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── per-message emoji reactions (ADR 0195 D3) ────────────────────────
  // PUBLIC social state, distinct from the private message feedback (ADR 0071
  // — see the boundary ruling in ADR 0195 §D3b). Any VIEWER of the
  // conversation may react (the channel-aware visibility predicate makes
  // "viewer" mean the same set on both route families); the emoji vocabulary
  // is server-bounded. Idempotent point writes keyed
  // (tenant, conversation, message, subject, emoji).
  app.put('/v1/host/openwop-app/chat/sessions/:sessionId/messages/:messageId/reactions/:emoji', async (req, res, next) => {
    try {
      await handleReaction(req, res, 'add');
    } catch (err) { next(err); }
  });
  app.delete('/v1/host/openwop-app/chat/sessions/:sessionId/messages/:messageId/reactions/:emoji', async (req, res, next) => {
    try {
      await handleReaction(req, res, 'remove');
    } catch (err) { next(err); }
  });

  async function handleReaction(req: Request, res: Response, op: 'add' | 'remove'): Promise<void> {
    const tenantId = tenantFromReq(req);
    if (!(await storage.getChatSession(tenantId, req.params.sessionId))) {
      throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
    }
    const meta = await getConversationMeta(tenantId, req.params.sessionId);
    await requireVisibleAsync(meta, req, tenantId, req.params.sessionId);
    if (meta?.type === 'channel' && meta.channel?.archived) {
      throw new OpenwopError('validation_error', 'Channel is archived.', 400);
    }
    const emoji = decodeURIComponent(req.params.emoji);
    if (!isReactionEmoji(emoji)) {
      throw new OpenwopError('validation_error', `emoji MUST be one of the supported set: ${REACTION_EMOJI.join(' ')}.`, 400);
    }
    const caller = callerSubject(req);
    if (!caller) {
      throw new OpenwopError('forbidden', 'Authentication required.', 403);
    }
    const target = await storage.getChatMessage(req.params.sessionId, req.params.messageId);
    if (!target) {
      throw new OpenwopError('not_found', `chat_message "${req.params.messageId}" not found.`, 404);
    }
    // ADR 0195 D2 — tombstoned messages take no new reactions.
    try {
      const tMeta = target.meta ? JSON.parse(target.meta) as Record<string, unknown> : {};
      if (typeof tMeta.deletedAt === 'string') {
        throw new OpenwopError('validation_error', 'A deleted message cannot be reacted to.', 400);
      }
    } catch (e) { if (e instanceof OpenwopError) throw e; /* opaque meta — allow */ }
    const row = { tenantId, conversationId: req.params.sessionId, messageId: req.params.messageId, subjectRef: caller, emoji };
    if (op === 'add') await addReaction(row);
    else await removeReaction(row);
    if (meta?.type === 'channel' || meta?.type === 'group') {
      publishConversationFrame('reaction', req.params.sessionId, req.params.messageId);
    }
    const all = await listReactionsForConversation(tenantId, req.params.sessionId);
    res.status(200).json({ messageId: req.params.messageId, reactions: aggregateReactions(all.get(req.params.messageId), caller) });
  }

  // ── open-or-resume a 1:1 conversation (ADR 0043) ───────────────────
  // POST { type: 'agent'|'person', subjectRef, title? } → the persistent 1:1 with
  // that subject. Idempotent via the canonical dmKey: a second open resolves to
  // the SAME conversation instead of forking a new session (Slack `conversations.open`).
  app.post('/v1/host/openwop-app/chat/conversations/open', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      const body = (req.body ?? {}) as { type?: unknown; subjectRef?: unknown; title?: unknown };
      const type = readConversationType(body.type);
      if (type !== 'agent' && type !== 'person') {
        throw new OpenwopError('validation_error', 'open supports 1:1 types only (agent | person); use POST /chat/sessions for a group.', 400);
      }
      if (typeof body.subjectRef !== 'string' || !SUBJECT_REF_PATTERN.test(body.subjectRef)) {
        throw new OpenwopError('validation_error', 'subjectRef MUST be a subjectRef like `agent:<id>` or `user:<id>`.', 400);
      }
      const owner = actingUserOf(req);
      const ownerSubject = owner ? userRef(owner) : `tenant:${tenantId}`;
      const dmKey = dmKeyOf(ownerSubject, body.subjectRef);

      const existing = await findByDmKey(tenantId, dmKey);
      if (existing) {
        const session = await storage.getChatSession(tenantId, existing.conversationId);
        if (session) {
          res.json(toConversation(session, existing, await readMarkersOf(tenantId, existing.conversationId), callerSubject(req)));
          return;
        }
        // Stale meta (session gone) — fall through and recreate.
      }

      const sessionId = randomUUID();
      const title = typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.slice(0, MAX_TITLE_BYTES) : 'New chat';
      const ts = new Date().toISOString();
      await storage.createChatSession({ sessionId, tenantId, title, createdAt: ts, updatedAt: ts, messageCount: 0 });
      const meta = await ensureConversationMeta(tenantId, sessionId, {
        type,
        ...(owner ? { ownerUserId: owner } : {}),
        participants: [body.subjectRef],
        dmKey,
      });
      res.status(201).json(toConversation({ sessionId, title, createdAt: ts, updatedAt: ts, messageCount: 0 }, meta));
    } catch (err) {
      next(err);
    }
  });

  // ── attach a board (ADR 0043 Phase 4 — board as a group conversation) ──
  // POST { boardId, participants } promotes THIS conversation to the group chat
  // for an advisory board (ADR 0040): type → group, link the board, seed the
  // cohort as members. The `@@<board>` summon calls this on the current chat so
  // the boardroom turns persist in a conversation that shows under Groups —
  // without forking a new session mid-turn. Idempotent (re-summon is a no-op).
  app.post('/v1/host/openwop-app/chat/sessions/:sessionId/board', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      const session = await storage.getChatSession(tenantId, req.params.sessionId);
      if (!session) {
        throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
      }
      // `participants` is deliberately NOT read from the body any more — the
      // speak-set is derived from the board server-side (WF-BOA-3). Clients may
      // still send it; it is ignored rather than trusted.
      const body = (req.body ?? {}) as { boardId?: unknown };
      if (typeof body.boardId !== 'string' || body.boardId.length < 1 || body.boardId.length > 128) {
        throw new OpenwopError('validation_error', 'boardId MUST be a non-empty string of 128 chars or fewer.', 400);
      }
      // Visibility (404 for non-members, no leak) then owner-gate (403). Reuse
      // the read for the mutation (no second lookup).
      const existing = await getConversationMeta(tenantId, req.params.sessionId);
      await requireVisibleAsync(existing, req, tenantId, req.params.sessionId);
      await requireManageAsync(existing, req, tenantId);
      // ADR 0192 D3 — board promotion would rewrite the meta as `type:'group'`
      // and silently DROP the channel descriptor (destructive; architect
      // finding 2). Channels never promote.
      if (existing?.type === 'channel') {
        throw new OpenwopError('validation_error', 'A channel cannot be converted to a board group.', 400);
      }
      const convener = actingUserOf(req);
      // WF-BOA-3 (Blocker) — GATE ON THE BOARD, and derive the speak-set from
      // it. This lane used to validate `boardId` as a STRING and then stamp it
      // (plus a caller-supplied participant list) onto a durable conversation
      // with no board read anywhere in the handler — fabricated board
      // provenance, and a client-chosen RFC 0101 closed speak-set. It also
      // falsified the precondition the context resolver documents ("the convener
      // already passed board RBAC at the `@@` summon",
      // features/advisory-board/service.ts). The cohort resolver IS the board
      // read gate: `null` ⇒ missing, unreadable, or no board feature ⇒ 404 with
      // no existence leak. Deriving `participants` server-side also retires
      // WF-BOA-9's "the durable meta records the truncated council as the
      // council" — the FE sends only the agents it managed to activate.
      const participants = await resolveBoardCohortForCaller(tenantId, body.boardId, convener);
      if (participants === null) {
        throw new OpenwopError('not_found', `board "${body.boardId}" not found.`, 404);
      }
      // ADR 0079 Phase 5 / ADR 0080 §Follow-on — snapshot the board's planning
      // context onto the boardroom as a PROVENANCE record. It is NOT what
      // grounds a turn: `host/chatContext.ts` re-resolves per CALLER per turn
      // (ADVB-1), because these sources are readability-scoped per user.
      //
      // WF-BOA-2 (Blocker) — `markAsBoardGroup`'s contract is `undefined ⇒ keep`,
      // `null ⇒ CLEAR`. This lane passed a fail-soft `null` straight through, so
      // a TRANSIENT strategy-read failure wiped the room's snapshot, while the
      // sibling canonical lane deliberately passes `?? undefined` and calls that
      // "the SAFE direction". Now the resolver distinguishes the two, so both
      // lanes can be right: a FAILED resolve keeps, an honest EMPTY clears
      // (removing every contextRef must actually clear — the symmetric half).
      const ctx = await resolveBoardContextResult(tenantId, body.boardId, convener);
      const meta = await markAsBoardGroup(tenantId, req.params.sessionId, body.boardId, participants, convener, existing, ctx.failed ? undefined : ctx.block);
      res.json(toConversation(session, meta, await readMarkersOf(tenantId, req.params.sessionId), callerSubject(req)));
    } catch (err) {
      next(err);
    }
  });

  // ── participants (ADR 0043 — replaces the FE-only "active agents" panel) ──
  app.get('/v1/host/openwop-app/chat/sessions/:sessionId/participants', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      if (!(await storage.getChatSession(tenantId, req.params.sessionId))) {
        throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
      }
      const [meta, readBySubject] = await Promise.all([
        getConversationMeta(tenantId, req.params.sessionId),
        readMarkersOf(tenantId, req.params.sessionId),
      ]);
      await requireVisibleAsync(meta, req, tenantId, req.params.sessionId);
      res.json({ participants: withReadMarkers(meta?.participants ?? [], readBySubject, callerSubject(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.put('/v1/host/openwop-app/chat/sessions/:sessionId/participants', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      if (!(await storage.getChatSession(tenantId, req.params.sessionId))) {
        throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
      }
      const subjectRef = (req.body ?? {})?.subjectRef;
      if (typeof subjectRef !== 'string' || !SUBJECT_REF_PATTERN.test(subjectRef)) {
        throw new OpenwopError('validation_error', 'subjectRef MUST be a subjectRef like `agent:<id>`.', 400);
      }
      // Visibility (404, no leak) then owner-gate (403) against the EXISTING meta
      // before lazily materializing it (which would otherwise stamp the caller).
      const existing = await getConversationMeta(tenantId, req.params.sessionId);
      await requireVisibleAsync(existing, req, tenantId, req.params.sessionId);
      await requireManageAsync(existing, req, tenantId);
      // ADR 0192 D3 — channel membership mutates ONLY via the channel routes
      // (assertChannelManage + the agent-registry fail-closed check + slug
      // stamping). The generic gate is also strictly weaker for ownerless
      // legacy channels (requireOwner is permissive there; assertChannelManage
      // 404s). Architect finding 2.
      if (existing?.type === 'channel') {
        throw new OpenwopError('validation_error', 'Channel membership MUST be managed via /v1/host/openwop-app/channels/:id/members.', 400);
      }
      // Lazily materialize meta for a legacy session, then add — reusing the meta
      // we just read (existing wins; otherwise create it once).
      const ensured = existing ?? await ensureConversationMeta(tenantId, req.params.sessionId, { type: 'group', ...(actingUserOf(req) ? { ownerUserId: actingUserOf(req) } : {}) });
      const meta = await addParticipant(tenantId, req.params.sessionId, subjectRef, ensured);
      res.json({ participants: withReadMarkers(meta?.participants ?? [], await readMarkersOf(tenantId, req.params.sessionId), callerSubject(req)) });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/v1/host/openwop-app/chat/sessions/:sessionId/participants/:subjectRef', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      if (!(await storage.getChatSession(tenantId, req.params.sessionId))) {
        throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
      }
      const existing = await getConversationMeta(tenantId, req.params.sessionId);
      await requireVisibleAsync(existing, req, tenantId, req.params.sessionId);
      await requireManageAsync(existing, req, tenantId);
      // ADR 0192 D3 — same guard as the PUT: channel membership only via the
      // channel routes (incl. self-leave `DELETE …/channels/:id/members/me`).
      if (existing?.type === 'channel') {
        throw new OpenwopError('validation_error', 'Channel membership MUST be managed via /v1/host/openwop-app/channels/:id/members.', 400);
      }
      const meta = await removeParticipant(tenantId, req.params.sessionId, decodeURIComponent(req.params.subjectRef), existing);
      res.json({ participants: withReadMarkers(meta?.participants ?? [], await readMarkersOf(tenantId, req.params.sessionId), callerSubject(req)) });
    } catch (err) {
      next(err);
    }
  });

  // ── read state (ADR 0043 Phase 3 — unread badge) ───────────────────
  app.post('/v1/host/openwop-app/chat/sessions/:sessionId/read', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      const session = await storage.getChatSession(tenantId, req.params.sessionId);
      if (!session) {
        throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
      }
      await requireVisibleAsync(await getConversationMeta(tenantId, req.params.sessionId), req, tenantId, req.params.sessionId);
      const owner = actingUserOf(req);
      // ADR 0192 D6 — stamp the session's messageCount at read; the projection
      // derives unreadCount by differencing (exact, zero append-time writes).
      if (owner) await markRead(tenantId, req.params.sessionId, userRef(owner), new Date().toISOString(), session.messageCount);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── message feedback (ADR 0071) ──────────────────────────────────────────
  // Per-(user, message) chat thumbs — DISTINCT from RFC 0056 run annotations.
  // Bound to the caller's own subject; the conversation must be visible (404).
  app.post('/v1/host/openwop-app/chat/messages/:messageId/feedback', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      const b = (req.body ?? {}) as { conversationId?: unknown; rating?: unknown; reason?: unknown };
      if (typeof b.conversationId !== 'string') throw new OpenwopError('validation_error', 'conversationId is required.', 400, {});
      if (!isFeedbackRating(b.rating)) throw new OpenwopError('validation_error', "rating MUST be 'up' | 'down' | 'neutral'.", 400, {});
      // Existence + visibility (the null-meta path reads as visible, so guard the
      // session row first — 404, no existence leak).
      if (!(await storage.getChatSession(tenantId, b.conversationId))) {
        throw new OpenwopError('not_found', `chat_session "${b.conversationId}" not found.`, 404);
      }
      await requireVisibleAsync(await getConversationMeta(tenantId, b.conversationId), req, tenantId, b.conversationId);
      const record = await setMessageFeedback({
        tenantId,
        conversationId: b.conversationId,
        messageId: req.params.messageId,
        subjectRef: userRef(actingUserOf(req) ?? '_anon'),
        rating: b.rating,
        ...(typeof b.reason === 'string' ? { reason: b.reason } : {}),
      });
      res.status(200).json(record);
    } catch (err) {
      next(err);
    }
  });

  app.get('/v1/host/openwop-app/chat/messages/:messageId/feedback', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : '';
      if (!conversationId) throw new OpenwopError('validation_error', 'conversationId query param is required.', 400, {});
      if (!(await storage.getChatSession(tenantId, conversationId))) {
        throw new OpenwopError('not_found', `chat_session "${conversationId}" not found.`, 404);
      }
      await requireVisibleAsync(await getConversationMeta(tenantId, conversationId), req, tenantId, conversationId);
      const mine = await getMessageFeedback(tenantId, conversationId, req.params.messageId, userRef(actingUserOf(req) ?? '_anon'));
      res.status(200).json({ feedback: mine });
    } catch (err) {
      next(err);
    }
  });

  // ── the caller's feedback across a whole session (ADR 0102 Phase 3) ──
  // GET → { feedback: { <messageId>: <rating> } } so reopening a chat re-displays
  // 👍/👎 in ONE round-trip (not an N+1 per-message fetch). Visibility-gated;
  // returns ONLY the caller's own ratings (subject pinned server-side).
  app.get('/v1/host/openwop-app/chat/sessions/:sessionId/feedback', async (req, res, next) => {
    try {
      const tenantId = tenantFromReq(req);
      if (!(await storage.getChatSession(tenantId, req.params.sessionId))) {
        throw new OpenwopError('not_found', `chat_session "${req.params.sessionId}" not found.`, 404);
      }
      await requireVisibleAsync(await getConversationMeta(tenantId, req.params.sessionId), req, tenantId, req.params.sessionId);
      const rows = await listMessageFeedbackForSession(tenantId, req.params.sessionId, userRef(actingUserOf(req) ?? '_anon'));
      const feedback: Record<string, string> = {};
      for (const r of rows) feedback[r.messageId] = r.rating;
      res.status(200).json({ feedback });
    } catch (err) {
      next(err);
    }
  });
}
