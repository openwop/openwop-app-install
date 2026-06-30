/**
 * Team-channel routes (ADR 0126 Phase 1) — host-extension, tenant-scoped + toggle-
 * gated. Channels are membership-governed (not org-scoped). v1 local-host.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { tenantOf } from '../featureRoute.js';
import { OpenwopError } from '../../types.js';
import { addChannelAgent, addChannelMember, archiveChannel, assertChannelAccess, createChannel, getChannel, isChannelOwner, joinChannel, listChannelsForViewer, listChannelMessages, postChannelMessage, removeChannelAgent, removeChannelMember, renameChannel } from './channelService.js';
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
      const meta = await getChannel(tenantOf(req), req.params.channelId, c);
      // viewerIsOwner is server-computed (ADR 0154 Phase 2) — the FE gates its
      // management UI on this, never on a reconstructed identity comparison.
      res.json({ channel: { ...meta, viewerIsOwner: isChannelOwner(meta, c) } });
    } catch (err) { next(err); }
  });
  app.patch(`${BASE}/:channelId`, async (req, res, next) => {
    try {
      await gate(req);
      const name = (req.body as { name?: unknown })?.name;
      if (typeof name !== 'string') throw new OpenwopError('validation_error', '`name` is required.', 400, { field: 'name' });
      res.json({ channel: await renameChannel(tenantOf(req), req.params.channelId, caller(req), name) });
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/:channelId/archive`, async (req, res, next) => {
    try { await gate(req); await archiveChannel(tenantOf(req), req.params.channelId, caller(req)); res.status(204).end(); } catch (err) { next(err); }
  });
  // ADR 0126 Phase 2 — membership-gated post + read (the gate is in the service).
  app.get(`${BASE}/:channelId/messages`, async (req, res, next) => {
    try { await gate(req); res.json({ messages: await listChannelMessages(tenantOf(req), req.params.channelId, caller(req)) }); } catch (err) { next(err); }
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
      res.status(201).json(result);
      // ADR 0154 Phase 4 — fire-and-forget agent turn for an addressed agent member.
      // Best-effort: never blocks or fails the human post (the helper never throws).
      // `content` is a validated string here (postChannelMessage threw otherwise).
      void dispatchChannelAgentTurns(deps, tenantId, channelId, result.messageId, typeof content === 'string' ? content : '', callerId);
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
  app.delete(`${BASE}/:channelId/members/:userId`, async (req, res, next) => {
    try { await gate(req); res.json({ channel: await removeChannelMember(tenantOf(req), req.params.channelId, caller(req), req.params.userId) }); } catch (err) { next(err); }
  });
  // ADR 0154 Phase 4 — remove an agent member (owner-gated).
  app.delete(`${BASE}/:channelId/agents/:agentId`, async (req, res, next) => {
    try { await gate(req); res.json({ channel: await removeChannelAgent(tenantOf(req), req.params.channelId, caller(req), req.params.agentId) }); } catch (err) { next(err); }
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
