/**
 * Team-channel routes (ADR 0126 Phase 1) — host-extension, tenant-scoped + toggle-
 * gated. Channels are membership-governed (not org-scoped). v1 local-host.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { tenantOf } from '../featureRoute.js';
import { OpenwopError } from '../../types.js';
import { encodeMessageCursor, decodeMessageCursor, MAX_MESSAGE_PAGE } from '../../host/messageCursor.js';
import { addChannelAgent, addChannelMember, archiveChannel, assertChannelAccess, channelRoster, createChannel, getChannel, isChannelOwner, joinChannel, leaveChannel, listChannelsForViewer, listChannelMessages, postChannelMessage, removeChannelAgent, removeChannelMember, renameChannel, setChannelDescription, setChannelAgentPolicy, resolveChannelCatchup } from './channelService.js';
import { startWorkflowRun } from '../../host/runStarter.js';
import { CHANNEL_TURN_WORKFLOW_ID, CHANNEL_MANAGED_CREDENTIAL_REF } from './channelTurnWorkflow.js';
import { resolveSubjectDisplays } from '../../host/subjectDisplay.js';
import { userRef } from '../../host/conversationStore.js';
import { listReactionsForConversation, aggregateReactions } from '../../host/messageReactionsStore.js';
import { dispatchChannelAgentTurns } from './channelAgentDispatch.js';
import { seedChannelTurnWorkflow } from './channelTurnWorkflow.js';
import { openSseChannel } from '../../host/sseChannel.js';
import { subscribeConversationMessages } from '../../host/chatMessageBus.js';
import { joinPresence, setTyping, snapshotOf } from './channelPresenceTracker.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.channels');

const BASE = '/v1/host/openwop-app/channels';

/** Resolve the ONE caller identity used consistently for the owner stamp, management
 *  authz, and access. `req.userId` is set only on the cookie/OIDC paths, so an API-key
 *  principal must fall back to `req.principal.principalId` (the identity the presence
 *  routes already use, routes.ts:~83). Without this, owner-only management breaks for
 *  API-key-created channels (owner stamped `undefined` → every manage op 403s). */
function caller(req: Request): string | undefined {
  return req.userId ?? req.principal?.principalId;
}

/** ADR 0126 Phase 4 / RFC 0110 — channel presence is OFF by default. An operator opts in
 *  ONLY on a topology that can honor it (single-instance / sticky-session), which is also
 *  what flips the `channelPresence` capability advertisement (discovery). */
export function channelPresenceEnabled(): boolean {
  return process.env.OPENWOP_CHANNEL_PRESENCE_ENABLED === 'true';
}

export function registerChannelRoutes(deps: RouteDeps): void {
  const { app } = deps;
  // ADR 0154 Phase 4 — register the channel agent-turn workflow (idempotent).
  seedChannelTurnWorkflow();
  // CHN-4: channel presence keeps live state in process memory (per-instance), so it
  // is correct only on a single-instance / sticky-session topology. There is no reliable
  // runtime signal for "am I scaled out", so surface the operator requirement loudly at
  // startup when the flag is on — a silent multi-instance enable would fragment presence.
  if (channelPresenceEnabled()) {
    log.warn('channel_presence_enabled', {
      note: 'In-memory channel presence requires single-instance or sticky-session routing; on a scaled-out (multi-instance) deployment presence will fragment across instances.',
    });
  }
  // Channels is always-on (toggle removed); per-channel membership is enforced in
  // the service, so the route-level gate is a no-op kept for call-site symmetry.
  const gate = (_req: Request): Promise<void> => Promise.resolve();
  const presenceGate = (req: Request): Promise<unknown> => {
    if (!channelPresenceEnabled()) throw new OpenwopError('not_found', 'Channel presence is not enabled.', 404, {});
    return gate(req);
  };

  app.get(BASE, async (req, res, next) => {
    // ADR 0154 FU-4 — caller-scoped discovery: public channels + the caller's own
    // private memberships (never leaks other private channels), each `joined`-tagged.
    try { await gate(req); res.json({ channels: await listChannelsForViewer(tenantOf(req), caller(req)) }); } catch (err) { next(err); }
  });
  app.post(BASE, async (req, res, next) => {
    try { await gate(req); res.status(201).json({ channel: await createChannel(tenantOf(req), caller(req), (req.body ?? {}) as Record<string, unknown>) }); } catch (err) { next(err); }
  });
  // ADR 0154 FU-4 — self-join a PUBLIC channel (the caller adds themselves; NOT
  // owner-gated). Private channels 404-mask (no existence leak).
  app.post(`${BASE}/:channelId/join`, async (req, res, next) => {
    try { await gate(req); res.json({ channel: await joinChannel(tenantOf(req), req.params.channelId, caller(req)) }); } catch (err) { next(err); }
  });
  app.get(`${BASE}/:channelId`, async (req, res, next) => {
    try {
      await gate(req);
      const c = caller(req);
      const tenantId = tenantOf(req);
      const meta = await getChannel(tenantId, req.params.channelId, c);
      // viewerIsOwner is server-computed (ADR 0154 Phase 2) — the FE gates its
      // management UI on this, never on a reconstructed identity comparison.
      // ADR 0192 D2 — `roster` carries the RESOLVED display identities (incl.
      // the synthesized owner row); the FE renders names, never raw refs.
      // ADR 0192 Phase-2 amendment — `viewerSubjectRef` lets the feed align the
      // caller's OWN posts (other humans also post role:'user'; without knowing
      // "me", their messages would render as yours).
      res.json({ channel: { ...meta, viewerIsOwner: isChannelOwner(meta, c), roster: await channelRoster(tenantId, meta), ...(c ? { viewerSubjectRef: userRef(c) } : {}) } });
    } catch (err) { next(err); }
  });
  app.patch(`${BASE}/:channelId`, async (req, res, next) => {
    try {
      await gate(req);
      const b = (req.body ?? {}) as { name?: unknown; description?: unknown };
      // ADR 0192 D4 — rename and/or set the description (owner-gated in the service).
      if (typeof b.name !== 'string' && typeof b.description !== 'string') {
        throw new OpenwopError('validation_error', '`name` or `description` is required.', 400, { field: 'name' });
      }
      let channel = typeof b.name === 'string'
        ? await renameChannel(tenantOf(req), req.params.channelId, caller(req), b.name)
        : undefined;
      if (typeof b.description === 'string') {
        channel = await setChannelDescription(tenantOf(req), req.params.channelId, caller(req), b.description);
      }
      res.json({ channel });
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/:channelId/archive`, async (req, res, next) => {
    try { await gate(req); await archiveChannel(tenantOf(req), req.params.channelId, caller(req)); res.status(204).end(); } catch (err) { next(err); }
  });
  // ADR 0126 Phase 2 — membership-gated post + read (the gate is in the service).
  app.get(`${BASE}/:channelId/messages`, async (req, res, next) => {
    // ADR 0192 D2 — each message carries its author's RESOLVED display identity
    // (raw subjectRefs never render as UI). Names resolve once per distinct
    // author via the subjectDisplay seam (point lookups) + the roster's
    // add-time agent labels.
    try {
      await gate(req);
      const tenantId = tenantOf(req);
      // CS-CH-3 — reverse pagination, the chat-sessions idiom: ?limit=N → the N
      // most-recent (ASC) + nextCursor; &before=<cursor> pages older; no limit →
      // the legacy full-thread shape (back-compat). One cursor owner
      // (host/messageCursor.ts).
      let paging: { limit: number; before?: { createdAt: string; messageId: string } } | undefined;
      if (req.query.limit !== undefined) {
        const limit = Number(req.query.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGE_PAGE) {
          throw new OpenwopError('validation_error', `limit MUST be an integer between 1 and ${MAX_MESSAGE_PAGE}.`, 400, {});
        }
        let before: { createdAt: string; messageId: string } | undefined;
        if (req.query.before !== undefined) {
          const decoded = typeof req.query.before === 'string' ? decodeMessageCursor(req.query.before) : null;
          if (!decoded) throw new OpenwopError('validation_error', 'before MUST be a cursor of the form `<ISO-8601>~<messageId>`.', 400, {});
          before = decoded;
        }
        paging = { limit: limit + 1, ...(before ? { before } : {}) }; // +1 = has-more probe
      }
      const fetched = await listChannelMessages(tenantId, req.params.channelId, caller(req), paging);
      const hasMore = paging !== undefined && fetched.length === paging.limit;
      const messages = hasMore ? fetched.slice(1) : fetched; // ASC; surplus oldest at the front
      const oldest = messages[0];
      const nextCursor = paging === undefined ? undefined : (hasMore && oldest ? encodeMessageCursor(oldest) : null);
      const meta = await getChannel(tenantId, req.params.channelId, caller(req));
      const roster = await channelRoster(tenantId, meta);
      const byRef = new Map(roster.map((r) => [r.subjectRef, r]));
      const unresolved = [...new Set(messages.map((m) => m.authorSubject).filter((s): s is string => !!s && !byRef.has(s)))];
      const extra = unresolved.length ? await resolveSubjectDisplays(tenantId, unresolved) : new Map();
      // ADR 0195 D3 — join the message reactions (one batched read).
      const reactionsByMessage = await listReactionsForConversation(tenantId, req.params.channelId);
      const viewer = caller(req);
      const viewerRef = viewer ? userRef(viewer) : null;
      res.json({
        messages: messages.map((m) => {
          const d = m.authorSubject ? (byRef.get(m.authorSubject) ?? extra.get(m.authorSubject)) : undefined;
          const agg = aggregateReactions(reactionsByMessage.get(m.messageId), viewerRef);
          return {
            ...m,
            ...(d ? { authorDisplayName: d.displayName, authorKind: d.kind } : {}),
            ...(agg.length ? { reactions: agg } : {}),
          };
        }),
        // Present only in paged mode (additive — the legacy shape is unchanged).
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      });
    } catch (err) { next(err); }
  });
  // ADR 0154 FU-6 — live message delivery. Always-on (cross-instance via the host-ext
  // pub/sub, unlike the per-instance presence SSE), membership-gated. Carries only the
  // messageId; the durable store stays the source of truth (the FE reloads on a frame).
  app.get(`${BASE}/:channelId/stream`, async (req, res, next) => {
    try {
      await gate(req);
      const tenantId = tenantOf(req);
      const channelId = req.params.channelId;
      await assertChannelAccess(tenantId, channelId, caller(req)); // default-deny non-members (403/404)
      const sse = openSseChannel(req, res, { heartbeatMs: 15_000 });
      const unsub = await subscribeConversationMessages(channelId, (messageId) => {
        if (!sse.closed) res.write(`event: channel.message\ndata: ${JSON.stringify({ messageId })}\n\n`);
      });
      // If the client disconnected DURING the await, openSseChannel's teardown
      // already ran (and is idempotent — it won't re-run), so the onClose hook set
      // below would never fire. Unsubscribe now to avoid a leaked listener.
      if (sse.closed) { void unsub(); return; }
      sse.onClose(() => { void unsub(); });
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/:channelId/messages`, async (req, res, next) => {
    try {
      await gate(req);
      const tenantId = tenantOf(req);
      const channelId = req.params.channelId;
      const callerId = caller(req);
      const content = (req.body as { content?: unknown })?.content;
      const result = await postChannelMessage(tenantId, channelId, callerId, content);
      res.status(201).json({ messageId: result.messageId });
      // ADR 0154 Phase 4 — fire-and-forget agent turn for an addressed agent member.
      // Best-effort: never blocks or fails the human post (the helper never throws).
      // ADR 0192 D5 — dispatch reads the EXTRACTED text (an envelope post's text
      // parts), not the raw serialized content.
      void dispatchChannelAgentTurns(deps, tenantId, channelId, result.messageId, result.text, callerId);
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/:channelId/members`, async (req, res, next) => {
    try {
      await gate(req);
      const b = (req.body ?? {}) as { userId?: unknown; agentId?: unknown };
      // ADR 0154 Phase 4 — an agent can be added as a member (then addressed to
      // dispatch a turn); a user member is the ADR 0126 path.
      if (typeof b.agentId === 'string') {
        res.json({ channel: await addChannelAgent(tenantOf(req), req.params.channelId, caller(req), b.agentId) });
        return;
      }
      if (typeof b.userId !== 'string') throw new OpenwopError('validation_error', '`userId` or `agentId` is required.', 400, { field: 'userId' });
      res.json({ channel: await addChannelMember(tenantOf(req), req.params.channelId, caller(req), b.userId) });
    } catch (err) { next(err); }
  });
  // ADR 0192 D3 — self-serve leave. MUST be registered BEFORE the
  // `:userId`-parameterized remove below: Express matches the FIRST registrant,
  // so a later registration would bind `me` to `:userId` and the leaver would
  // hit the owner-gate 403 (a dead feature). Pinned by a route test.
  app.delete(`${BASE}/:channelId/members/me`, async (req, res, next) => {
    try { await gate(req); await leaveChannel(tenantOf(req), req.params.channelId, caller(req)); res.status(204).end(); } catch (err) { next(err); }
  });
  app.delete(`${BASE}/:channelId/members/:userId`, async (req, res, next) => {
    try { await gate(req); res.json({ channel: await removeChannelMember(tenantOf(req), req.params.channelId, caller(req), req.params.userId) }); } catch (err) { next(err); }
  });
  // ADR 0154 Phase 4 — remove an agent member (owner-gated).
  app.delete(`${BASE}/:channelId/agents/:agentId`, async (req, res, next) => {
    try { await gate(req); res.json({ channel: await removeChannelAgent(tenantOf(req), req.params.channelId, caller(req), req.params.agentId) }); } catch (err) { next(err); }
  });
  // ADR 0202 D1 — set an agent member's reply policy (owner-gated).
  app.put(`${BASE}/:channelId/agents/:agentId/policy`, async (req, res, next) => {
    try {
      await gate(req);
      const policy = (req.body as { policy?: unknown })?.policy;
      if (policy !== 'all' && policy !== 'mention') {
        throw new OpenwopError('validation_error', '`policy` MUST be "all" or "mention".', 400, { field: 'policy' });
      }
      res.json({ channel: await setChannelAgentPolicy(tenantOf(req), req.params.channelId, caller(req), req.params.agentId, policy) });
    } catch (err) { next(err); }
  });
  // ADR 0202 D2 — AI catch-up: fire the channel-turn workflow WITHOUT a
  // conversationId (so the agent-runner does NOT append in-channel — the
  // summary is returned to the requester, not posted). Member-gated; requires a
  // channel agent member. Returns { runId, unreadCount }; the FE reads the
  // completion via the run-event subscription seam.
  app.post(`${BASE}/:channelId/catchup`, async (req, res, next) => {
    try {
      await gate(req);
      const tenantId = tenantOf(req);
      const channelId = req.params.channelId;
      const { agentId, task, unreadCount } = await resolveChannelCatchup(tenantId, channelId, caller(req));
      const runId = await startWorkflowRun(deps, {
        tenantId,
        workflowId: CHANNEL_TURN_WORKFLOW_ID,
        // conversationId OMITTED → no in-channel append (ADR 0125 by construction).
        configurable: { agentId, task, credentialRef: CHANNEL_MANAGED_CREDENTIAL_REF },
        metadata: { channel: { source: 'channel-catchup', channelId, requestedBy: caller(req) ?? undefined } },
      });
      if (!runId) throw new OpenwopError('internal_error', 'Could not start the catch-up summary.', 500, { channelId });
      res.status(202).json({ runId, unreadCount });
    } catch (err) { next(err); }
  });

  // ADR 0126 Phase 4 / RFC 0110 — ephemeral channel presence. The SSE connection IS the
  // presence signal: opening it marks the caller present (membership-gated), closing it
  // marks them gone. Frames carry the `channel.presence` shape but are NEVER persisted
  // (presence is live state — the run-event log is untouched, so replay/:fork are
  // unaffected). 404 when the feature is off (matches the un-advertised capability).
  app.get(`${BASE}/:channelId/presence`, async (req, res, next) => {
    try {
      await presenceGate(req);
      const { ref } = await assertChannelAccess(tenantOf(req), req.params.channelId, req.userId ?? req.principal?.principalId);
      const channelId = req.params.channelId;
      const sse = openSseChannel(req, res, { heartbeatMs: 15_000 });
      const send = (snap: { conversationId: string; present: string[]; typing: string[] }): void => {
        if (!sse.closed) res.write(`event: channel.presence\ndata: ${JSON.stringify(snap)}\n\n`);
      };
      const leave = joinPresence(channelId, ref, send);
      sse.onClose(leave);
      send(snapshotOf(channelId)); // immediate first frame
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/:channelId/presence/typing`, async (req, res, next) => {
    try {
      await presenceGate(req);
      const { ref } = await assertChannelAccess(tenantOf(req), req.params.channelId, req.userId ?? req.principal?.principalId);
      setTyping(req.params.channelId, ref, (req.body as { typing?: unknown })?.typing === true);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ADR 0126 Phase 4 / RFC 0110 — conformance snapshot SEAM (non-normative test plumbing,
  // the multi-party-seam precedent). SSE is a held connection a server-free conformance
  // client can't assert against, so this returns the live `channel.presence` JSON after a
  // TRANSIENT join (so `present` is non-vacuous — it includes the calling member), then
  // leaves. Exercises the SAME membership gate (`assertChannelAccess` → DEFAULT-DENY 403 for
  // a non-member) + the closed RFC 0110 shape. Gated on the presence flag (404 when off ⇒
  // the capability isn't advertised either ⇒ the gated scenario soft-skips).
  app.get(`${BASE}/:channelId/presence/snapshot`, async (req, res, next) => {
    try {
      await presenceGate(req);
      const { ref } = await assertChannelAccess(tenantOf(req), req.params.channelId, req.userId ?? req.principal?.principalId);
      const leave = joinPresence(req.params.channelId, ref, () => { /* snapshot read, no stream */ });
      try {
        res.json(snapshotOf(req.params.channelId));
      } finally {
        leave(); // ephemeral: the membership probe must not leave the caller "present"
      }
    } catch (err) { next(err); }
  });
}
