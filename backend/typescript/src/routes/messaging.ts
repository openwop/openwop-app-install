/**
 * Messaging relay-gateway routes (demo app only — NOT normative openwop v1).
 *
 * Vendor-prefixed under `/v1/host/openwop-app/messaging` per `host-extensions.md`:
 * openwop is a channel-agnostic workflow protocol, so chat channels
 * (Signal / WhatsApp / iMessage) live entirely in a host-extension layer.
 * Other hosts MAY add their own under their own vendor prefix; nothing here
 * is part of the protocol wire surface.
 *
 * Architecture (distributed-relay pattern): the openwop CLI owns the platform
 * connection and runs as a local relay device. It registers once, exchanges
 * an activation code for a device token, then heartbeats + pulls outbound.
 * Inbound platform messages are POSTed here and bridged to a workflow run;
 * outbound replies are queued per relay and pulled + acked by the device.
 *
 *   Device lifecycle (operator bearer):
 *     POST   .../relay/register             — issue relayId + activation code
 *     POST   .../relay/activate             — exchange code → device token (binds the owner, ADR 1043 D3)
 *     POST   .../relay/revoke               — deactivate a relay
 *     GET    .../relay/devices              — this workspace's relays with presence and canRevoke (ADR 1042 CHAN-P0-8, ADR 1043 D3)
 *   Device loop (x-openwop-device-token; bearer-public per auth allowlist):
 *     POST   .../device/heartbeat           — keepalive + status report
 *     POST   .../device/rotate              — rotate the device token (ADR 1043 D1)
 *     POST   .../device/inbound             — ingest a platform message
 *     GET    .../device/outbound            — pull pending egress for this relay
 *     POST   .../device/ack                 — acknowledge delivered AND failed egress (ADR 1043 D1)
 *
 * ADR 1043 D1 is the contract the openwop-cli relay implements: every device
 * auth refusal is a 401 with `details.reason` (`device_token_missing`,
 * `device_token_invalid`, `device_token_expired`, `device_revoked`).
 *
 * ADR 1043 D9 (CHAN-P1b) — in conversation mode a device admits a peer only when
 * that device's OWNER approved it (channel-ingress's sender store, keyed by the
 * device's lane; the routes live in that feature). The connector policy, allowlist
 * and pairing below govern the legacy workflow lane only, and a pairing request
 * is never answered.
 *   Outbound enqueue (operator bearer / bridge):
 *     POST   .../relay/enqueue              — queue an egress for a relay
 *   Connectors (operator bearer):  GET|POST .../connectors[/:id[/enable|disable|test]]
 *   Sessions (operator bearer):    GET .../sessions[/:key]; DELETE .../sessions/:key
 *
 * State is durable in `Storage` (relay_devices / relay_outbound /
 * messaging_connectors / messaging_sessions across sqlite + postgres) so the
 * gateway is correct across a multi-instance / restarting host. Device tokens
 * are persisted as a SHA-256 hash only; the plaintext is returned once at
 * activation. Tenant scope follows the same wildcard/`?tenantId` rules as the
 * notification routes.
 */

import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import type { Storage } from '../storage/storage.js';
import { onWorkflowForked } from '../host/workflowsRegistry.js';
import { tryDurableStorage } from '../host/durable/durableStore.js';
import {
  RELAY_CHANNELS,
  type ChatEgressEnvelope,
  type ChatIngressEnvelope,
  type DmPolicy,
  type GroupPolicy,
  type MessagingBridge,
  type MessagingIdentityRecord,
  type MessagingPolicyRecord,
  type MessagingRoutingRuleRecord,
  type RelayChannel,
  type RelayDeviceRecord,
} from '../messaging/types.js';
import { syntheticNotifyDeliverer, type NotifyDeliverer } from '../messaging/notifyDeliverer.js';
import { claimRelayInbound, deleteRelayInboundClaims, releaseRelayInbound } from '../messaging/inboundClaims.js';
import { deleteRelayOwner, getRelayOwnerRecord, recordRelayOwner } from '../messaging/relayOwner.js';
import {
  ACTIVATION_MAX_FAILURES, EGRESS_MAX_ATTEMPTS, OFFLINE_AFTER_MS, TOKEN_GRACE_MS,
  activationFailuresOf, clearEgressAttempts, clearRegistration, egressAttempts, getPresence, getRegistration, relayPresenceOf,
  purgeRelayLifecycle, recordActivationFailure, recordEgressAttempt, recordHeartbeat, recordRegistration,
  recordTokenGrace, relayForGraceToken,
} from '../messaging/relayLifecycle.js';
import { selectRoutingRule } from '../messaging/bridge.js';
import { RELAY_DEVICE_TOKEN_TTL_MS } from '../messaging/outboundRetention.js';
import { disabledRelayChannels, relayChannelDisabled, setRelayChannelEnabled } from '../messaging/relayChannelSwitch.js';
import { isRelayGroup } from '../messaging/groupDetection.js';
import { enforceChannelInboundRateLimit } from '../middleware/rateLimit.js';
import { createLogger } from '../observability/logger.js';

const relayLog = createLogger('routes.messaging');

const DM_POLICIES: readonly DmPolicy[] = ['pairing', 'allowlist', 'open', 'disabled'];
const GROUP_POLICIES: readonly GroupPolicy[] = ['allowlist', 'open', 'disabled'];
const NOTIFY_KINDS = ['email', 'sms'] as const;
type NotifyKind = (typeof NOTIFY_KINDS)[number];

const BASE = '/host/openwop-app/messaging';

/** ADR 1042 D7 — the conversation-mode handler for relay messages (registered by
 *  the channel-ingress feature; dependency inversion, this route never imports it). */
export interface RelayConversationalIngress {
  enabled(tenantId: string): Promise<boolean>;
  /** ADR 1043 D9 + ADR 1042 D12 — the admission (the owner's self lane, or a sender
   *  approved on THIS device), run BEFORE the device's inbound budget is spent. A
   *  stranger is recorded as pending under the recorder's own budget and cap. */
  admit(input: { tenantId: string; relayId: string; channel: RelayChannel; envelope: ChatIngressEnvelope; ownerUserId: string; ownerAccountId?: string }):
    Promise<{ admitted: true } | { admitted: false; reason: string }>;
  ingest(input: { tenantId: string; relayId: string; channel: RelayChannel; envelope: ChatIngressEnvelope; ownerUserId: string; ownerPersonalTenant?: string; ownerAccountId?: string }):
    Promise<{ status: 'accepted'; conversationId: string } | { status: 'dropped'; reason: string }>;
  /** ADR 1043 D3 — a revoked device's lane (settings, approvals, pending senders) goes with it. */
  onRevoked?(tenantId: string, relayId: string): Promise<void>;
}
let relayIngress: RelayConversationalIngress | null = null;
export function registerRelayConversationalIngress(handler: RelayConversationalIngress | null): void {
  relayIngress = handler;
}

// ADR 1043 CHAN-F12: one constant, shared with the outbound retention sweep (its window).
const DEVICE_TOKEN_TTL_MS = RELAY_DEVICE_TOKEN_TTL_MS; // 30 days
/** ADR 1043 D1 — the device rotates on its first heartbeat past this (7 days before expiry). */
const ROTATE_BEFORE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const rotateAfterOf = (tokenExpiresAt: string): string =>
  new Date(Date.parse(tokenExpiresAt) - ROTATE_BEFORE_EXPIRY_MS).toISOString();
const mintDeviceToken = (): string => `dtok_${randomUUID().replace(/-/g, '')}`;
const ACTIVATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const HEARTBEAT_INTERVAL_SECONDS = 30;
const OUTBOUND_POLL_INTERVAL_SECONDS = 5;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface Deps {
  storage: Storage;
  bridge?: MessagingBridge;
  /** Email/SMS delivery seam. Defaults to the synthetic stub (accepted, not
   *  delivered) when the host wires none. */
  notifyDeliverer?: NotifyDeliverer;
}

export function registerMessagingRoutes(app: Express, deps: Deps): void {
  const { storage, bridge } = deps;
  const notifyDeliverer = deps.notifyDeliverer ?? syntheticNotifyDeliverer;

  // ---- Device lifecycle (operator bearer) ----

  app.post(`${BASE}/relay/register`, async (req, res, next) => {
    try {
      const tenantId = resolveTenant(req);
      const channel = assertChannel((req.body ?? {}).channel);
      const deviceName = optionalString((req.body ?? {}).deviceName);
      const now = Date.now();
      const activationCode = randomUUID().replace(/-/g, '').slice(0, 12);
      const record: RelayDeviceRecord = {
        relayId: `relay_${randomUUID()}`,
        tenantId,
        channel,
        ...(deviceName ? { deviceName } : {}),
        status: 'registered',
        activationCode,
        activationExpiresAt: new Date(now + ACTIVATION_TTL_MS).toISOString(),
        registeredAt: new Date(now).toISOString(),
      };
      await storage.upsertRelayDevice(record);
      // ADR 1043 D3 — registration records WHO registered (never the body) and the
      // device's OWN platform account (`accountId`: a WhatsApp JID or E.164, a Signal
      // number, an iMessage handle; ADR 1042 review N1). The owner is bound at
      // ACTIVATION, by the same person.
      const accountId = optionalAccountId((req.body ?? {}).accountId);
      await recordRegistration({ relayId: record.relayId, tenantId, ...(req.userId ? { registeredBy: req.userId } : {}), ...(accountId ? { accountId } : {}) });
      res.status(201).json({
        relayId: record.relayId,
        channel: record.channel,
        activationCode,
        activationExpiresAt: record.activationExpiresAt,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/relay/activate`, async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const relayId = requireString(body.relayId, 'relayId');
      const activationCode = requireString(body.activationCode, 'activationCode');
      const device = await storage.getRelayDevice(relayId);
      // ADR 1043 D3 — the caller's tenant must be the device's (the same 404 as an
      // unknown relay, so a relay id from another tenant reveals nothing).
      if (!device || device.status === 'revoked' || (device.tenantId !== resolveTenant(req) && !isWildcard(req))) {
        throw new OpenwopError('not_found', 'relay not found', 404);
      }
      // ADR 1043 M2 — WHO may activate is checked BEFORE any code is compared or
      // counted: the person who registered it, or (for a device an operator key
      // registered) a workspace admin. Anyone else gets the same 404 as an unknown
      // relay and counts nothing, so no member can burn another member's code.
      const registration = await getRegistration(relayId);
      const callerKey = req.userId ?? req.principal?.principalId ?? 'anonymous';
      const mayActivate = registration?.registeredBy
        ? registration.registeredBy === req.userId
        : await isRelayWorkspaceAdmin(req);
      if (!mayActivate) throw new OpenwopError('not_found', 'relay not found', 404);
      const locked = (n: number) => n >= ACTIVATION_MAX_FAILURES;
      if (registration?.locked || locked(activationFailuresOf(registration, callerKey)) || (device.status === 'registered' && !device.activationCode)) {
        throw new OpenwopError('forbidden', 'activation is locked for this relay after too many wrong codes; register the device again', 403, { reason: 'activation_locked' });
      }
      if (
        device.activationCode !== activationCode ||
        !device.activationExpiresAt ||
        Date.parse(device.activationExpiresAt) < Date.now()
      ) {
        // Count the wrong code for (device, caller); the fifth locks this caller out.
        const count = await recordActivationFailure(relayId, device.tenantId, callerKey);
        if (locked(count)) {
          throw new OpenwopError('forbidden', 'activation is locked for this relay after too many wrong codes; register the device again', 403, { reason: 'activation_locked' });
        }
        throw new OpenwopError('invalid_request', 'activation code invalid or expired', 400, {
          attemptsLeft: Math.max(0, ACTIVATION_MAX_FAILURES - count),
        });
      }
      const deviceToken = mintDeviceToken();
      const tokenExpiresAt = new Date(Date.now() + DEVICE_TOKEN_TTL_MS).toISOString();
      // ADR 1043 M3 — a conditional, column-only write: only a device still
      // `registered` with THIS code is activated (two racing activations mint one token).
      if (!(await storage.activateRelayDevice(relayId, activationCode, hashToken(deviceToken), tokenExpiresAt))) {
        throw new OpenwopError('conflict', 'this relay was activated or changed meanwhile', 409, { reason: 'activation_conflict' });
      }
      // ADR 1043 D3 — the owner is the ACTIVATING person (ADR 1042 D7: never the body).
      const accountId = optionalAccountId(body.accountId) ?? registration?.accountId;
      const ownerBound = !!req.userId;
      if (req.userId) await recordRelayOwner(relayId, device.tenantId, req.userId, req.personalTenant, accountId);
      await clearRegistration(relayId);
      res.json({
        relayId,
        channel: device.channel,
        deviceToken, // returned once; only the hash is persisted
        tokenExpiresAt,
        rotateAfter: rotateAfterOf(tokenExpiresAt),
        heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
        outboundPollIntervalSeconds: OUTBOUND_POLL_INTERVAL_SECONDS,
        ownerBound,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/relay/revoke`, async (req, res, next) => {
    try {
      const tenantId = resolveTenant(req);
      const relayId = requireString((req.body ?? {}).relayId, 'relayId');
      const device = await storage.getRelayDevice(relayId);
      if (!device || (device.tenantId !== tenantId && !isWildcard(req))) {
        throw new OpenwopError('not_found', 'relay not found', 404);
      }
      // ADR 1043 D3 (coordinator follow-up) — only the device's OWNER or a
      // workspace admin (the connections routes' workspace-level manage check).
      if (!(await canRevokeRelay(req, device))) {
        throw new OpenwopError('forbidden', 'Only the relay\'s owner or a workspace admin can revoke it.', 403, { reason: 'relay_revoke_forbidden', relayId });
      }
      // ADR 1043 M3 — column-only: nothing loaded earlier is written back.
      await storage.revokeRelayDevice(relayId);
      await storage.deleteRelayOutbound(relayId);
      // ADR 1043 D3 — the device's lifecycle rows, its owner and its lane go with it.
      await purgeRelayLifecycle(relayId, device.tenantId);
      // ADR 1043 RELAY-LOG-RETENTION-1 — and its delivery log and inbound dedup claims
      // (both name the contacts it talked to).
      await storage.deleteDeliveryLogForRelay(device.tenantId, relayId);
      await deleteRelayInboundClaims(device.tenantId, { relayIds: [relayId] });
      await deleteRelayOwner(relayId);
      // ADR 1043 D1 — a tombstone for the revoked token until it would have expired,
      // so the relay is told `device_revoked` (stop for good), not `device_token_invalid`.
      if (device.deviceTokenHash && device.tokenExpiresAt) {
        await recordTokenGrace(device.deviceTokenHash, relayId, device.tenantId, device.tokenExpiresAt);
      }
      if (relayIngress?.onRevoked) await relayIngress.onRevoked(device.tenantId, relayId).catch(() => undefined);
      res.json({ relayId, revoked: true });
    } catch (err) {
      next(err);
    }
  });

  // ADR 1042 CHAN-P0-8 + ADR 1043 D3 — the relay devices of the caller's workspace,
  // for the channels settings page. The SAME tenant predicate as `relay/revoke`
  // (`resolveTenant`). Never a secret (no token hash, no activation code). The
  // owner's own platform account (`accountId`) is shown only to that owner.
  // `online` derives from the ONE presence source (ADR 1043: `relayPresenceOf`,
  // the sweep's offline mark or a heartbeat older than OFFLINE_AFTER_MS), and
  // `canRevoke` is the revoke route's own predicate (`canRevokeRelay`).
  app.get(`${BASE}/relay/devices`, async (req, res, next) => {
    try {
      const tenantId = resolveTenant(req);
      const caller = req.userId ?? req.principal?.principalId;
      const now = Date.now();
      const admin = await isRelayWorkspaceAdmin(req);
      const off = new Set(await disabledRelayChannels(tenantId));
      const devices = await Promise.all((await storage.listRelayDevices(tenantId)).map(async (d) => {
        const owner = await getRelayOwnerRecord(d.relayId, d.tenantId);
        const ownedByCaller = owner !== null && caller !== undefined && owner.ownerUserId === caller;
        const p = await getPresence(d.relayId);
        const presence = relayPresenceOf(d, p, now);
        const lastHeartbeatAt = p?.lastHeartbeatAt ?? d.lastHeartbeatAt;
        return {
          relayId: d.relayId,
          channel: d.channel,
          ...(d.deviceName ? { deviceName: d.deviceName } : {}),
          status: d.status,
          registeredAt: d.registeredAt,
          ...(lastHeartbeatAt ? { lastHeartbeatAt } : {}),
          online: presence === 'online',
          presence,
          ...(p?.offlineSince ? { offlineSince: p.offlineSince } : {}),
          owner: owner
            ? { userId: owner.ownerUserId, ownedByCaller, ...(ownedByCaller && owner.ownerAccountId ? { accountId: owner.ownerAccountId } : {}) }
            : null,
          canRevoke: d.status !== 'revoked' && (ownedByCaller || admin),
          // CHAN-F11 — false while a workspace admin has this channel's relay switched off.
          channelEnabled: !off.has(d.channel),
        };
      }));
      res.json({ devices });
    } catch (err) {
      next(err);
    }
  });

  // ---- CHAN-F11 (RELAY-KILL-SWITCH-1): per-channel relay switch, per workspace ----

  // Any member may read it (the devices page shows why a device is paused).
  app.get(`${BASE}/relay/channels`, async (req, res, next) => {
    try {
      const tenantId = resolveTenant(req);
      const off = new Set(await disabledRelayChannels(tenantId));
      res.json({ channels: RELAY_CHANNELS.map((channel) => ({ channel, enabled: !off.has(channel) })), canManage: await isRelayWorkspaceAdmin(req) });
    } catch (err) {
      next(err);
    }
  });

  // Switching a channel changes every member's relay in the workspace: an admin's act.
  app.put(`${BASE}/relay/channels/:channel`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req);
      const tenantId = resolveTenant(req);
      const channel = assertChannel(req.params.channel);
      const enabled = (req.body ?? {}).enabled;
      if (typeof enabled !== 'boolean') throw new OpenwopError('invalid_request', 'enabled MUST be a boolean', 400);
      const off = new Set(await setRelayChannelEnabled(tenantId, channel, enabled));
      relayLog.info('relay_channel_switched', { tenantId, channel, enabled, by: req.userId ?? req.principal?.principalId ?? 'unknown' });
      res.json({ channels: RELAY_CHANNELS.map((c) => ({ channel: c, enabled: !off.has(c) })) });
    } catch (err) {
      next(err);
    }
  });

  // ---- Device loop (x-openwop-device-token; bearer-public per auth allowlist) ----

  app.post(`${BASE}/device/heartbeat`, async (req, res, next) => {
    try {
      const { device } = await authDevice(req, storage);
      const reported = optionalString((req.body ?? {}).status);
      const at = new Date().toISOString();
      // ADR 1043 M3 — touch only the heartbeat columns, and only while the device is
      // still active with the token it authenticated against: a revoke or a rotation
      // that landed after auth is never undone by this write.
      let touched = !!device.deviceTokenHash && await storage.touchRelayDeviceHeartbeat(device.relayId, device.deviceTokenHash, at, reported?.slice(0, 64));
      if (!touched) {
        const fresh = (await authDevice(req, storage)).device; // throws device_revoked / _invalid / _expired
        touched = !!fresh.deviceTokenHash && await storage.touchRelayDeviceHeartbeat(fresh.relayId, fresh.deviceTokenHash, at, reported?.slice(0, 64));
        if (!touched) throw new OpenwopError('conflict', 'the relay changed during the heartbeat; retry', 409, { reason: 'relay_changed' });
      }
      // ADR 1043 D3 — presence; a device the sweep marked offline is back.
      if (await recordHeartbeat(device.relayId, device.tenantId, device.channel, at)) {
        await storage.appendDeliveryLog({
          logId: `dlv_${randomUUID()}`, tenantId: device.tenantId, relayId: device.relayId, channel: device.channel,
          direction: 'inbound', conversationId: '', status: 'online', detail: 'device heartbeat resumed', at,
        });
      }
      res.json({
        ok: true,
        serverTime: at,
        ...(device.tokenExpiresAt ? { tokenExpiresAt: device.tokenExpiresAt, rotateAfter: rotateAfterOf(device.tokenExpiresAt) } : {}),
        heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
        outboundPollIntervalSeconds: OUTBOUND_POLL_INTERVAL_SECONDS,
      });
    } catch (err) {
      next(err);
    }
  });

  // ADR 1043 D1 — rotate the device token. The previous token keeps working for a
  // 10-minute grace, so a client that dies before saving the new one still has a
  // token; a rotation presented WITH the previous token is refused (a stolen old
  // token cannot fork the device).
  app.post(`${BASE}/device/rotate`, async (req, res, next) => {
    try {
      const { device, viaGrace } = await authDevice(req, storage);
      if (viaGrace) {
        // The client holds the PREVIOUS token: its last rotation answer was lost.
        // There is no safe re-auth from an old token (a stolen one could fork the
        // device), so the relay is told plainly and must be set up again.
        throw new OpenwopError('unauthenticated', 'this token was replaced by a rotation whose answer the relay never saved; run relay setup again', 401, { reason: 'device_token_superseded' });
      }
      const deviceToken = mintDeviceToken();
      const now = Date.now();
      const tokenExpiresAt = new Date(now + DEVICE_TOKEN_TTL_MS).toISOString();
      const previousTokenValidUntil = new Date(now + TOKEN_GRACE_MS).toISOString();
      // ADR 1043 M3 — swap only from the hash this request authenticated with.
      if (!device.deviceTokenHash || !(await storage.rotateRelayDeviceToken(device.relayId, device.deviceTokenHash, hashToken(deviceToken), tokenExpiresAt))) {
        throw new OpenwopError('conflict', 'the relay changed during the rotation; retry', 409, { reason: 'relay_changed' });
      }
      await recordTokenGrace(device.deviceTokenHash, device.relayId, device.tenantId, previousTokenValidUntil);
      res.json({ relayId: device.relayId, deviceToken, tokenExpiresAt, rotateAfter: rotateAfterOf(tokenExpiresAt), previousTokenValidUntil });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/device/inbound`, async (req, res, next) => {
    try {
      const device = await requireDevice(req, storage);
      const envelope = parseIngress(req.body, device.channel);
      const sessionKey = `${device.channel}:${envelope.conversationId}`;
      // CHAN-F11 — a channel a workspace admin switched off is acknowledged and dropped
      // first: before admission, budget, dedup claim and delivery log, in both modes.
      // No chat or sender id is logged (the C1 rule for drops before any budget).
      if (await relayChannelDisabled(device.tenantId, device.channel)) {
        relayLog.info('relay_inbound_dropped', { relayId: device.relayId, channel: device.channel, reason: 'channel_disabled' });
        res.status(202).json({ accepted: false, sessionKey, dropped: 'channel_disabled' });
        return;
      }
      // ADR 1042 D7 — with Channels into chat on for the tenant, a message no
      // routing rule claims becomes a turn in the device owner's main-chat
      // conversation (no `messaging_sessions` history, no `uppercase` default).
      // A matching rule keeps its workflow/agent; with the feature off nothing
      // here changes.
      const conversational = relayIngress !== null
        && (await relayIngress.enabled(device.tenantId).catch(() => false))
        && selectRoutingRule(await storage.listMessagingRoutingRules(device.tenantId), device, envelope) === undefined;
      // ADR 1043 D9 + ADR 1042 D12 — conversation mode ADMITS before the device's
      // inbound budget is spent: an ownerless device, the owner's outgoing chatter,
      // a stranger or an un-addressed group is acknowledged and dropped here, so
      // nobody outside the device's approvals can push it into 429s. A stranger is
      // recorded as pending under the recorder's own budget and cap.
      if (conversational && relayIngress) {
        const owner = await getRelayOwnerRecord(device.relayId, device.tenantId);
        const admission = owner
          ? await relayIngress.admit({
            tenantId: device.tenantId, relayId: device.relayId, channel: device.channel, envelope, ownerUserId: owner.ownerUserId,
            ...(owner.ownerAccountId ? { ownerAccountId: owner.ownerAccountId } : {}),
          })
          : { admitted: false as const, reason: 'no-owner' };
        if (!admission.admitted) {
          // Security review of #5573 (C1): an admission drop writes NO delivery-log row.
          // It runs before any budget, so a stranger or a busy un-addressed group could
          // otherwise grow `messaging_delivery_log` (no retention, no erasure) with
          // outsiders' chat ids. A stranger is already recorded, bounded, by the
          // pending recorder; this logs only the reason, never a chat or sender id.
          relayLog.info('relay_inbound_dropped', { relayId: device.relayId, channel: device.channel, reason: admission.reason });
          res.status(202).json({ accepted: false, sessionKey, dropped: admission.reason });
          return;
        }
      }
      // ADR 1042 D6 — the per-device inbound budget (after auth, so only a real
      // device has a bucket; after admission in conversation mode). 429 +
      // Retry-After; the device retries.
      if (enforceChannelInboundRateLimit(res, `relay:${device.relayId}`)) return;
      // ADR 1042 D5 — one platform message is processed once. A duplicate (a
      // device retry, a platform redelivery) is acknowledged and does nothing.
      if (!(await claimRelayInbound(device, envelope.conversationId, envelope.platformMessageId))) {
        res.status(202).json({ accepted: true, sessionKey, deduped: true });
        return;
      }
      try {
        const existing = conversational ? null : await storage.getMessagingSession(sessionKey);
        if (!conversational) await storage.upsertMessagingSession({
          sessionKey,
          tenantId: device.tenantId,
          channel: device.channel,
          conversationId: envelope.conversationId,
          peerId: envelope.peerId,
          ...(envelope.peerDisplay ? { peerDisplay: envelope.peerDisplay } : {}),
          lastInboundAt: envelope.timestamp,
          messageCount: (existing?.messageCount ?? 0) + 1,
          ...(existing?.lastRunId ? { lastRunId: existing.lastRunId } : {}),
        });

        if (conversational && relayIngress) {
          // ADR 1043 D9 (CHAN-P1b) — conversation mode admits by the DEVICE's own
          // approvals, which its owner manages (checked above before the budget, and
          // again by the ingest at dispatch). The tenant-wide connector, policy,
          // allowlist and pairing below are the legacy workflow lane's only: a peer
          // approved there, or on another member's device, is never admitted here.
          // The CURRENT owner (security review M4), read per message.
          const owner = await getRelayOwnerRecord(device.relayId, device.tenantId);
          const outcome = owner
            ? await relayIngress.ingest({ tenantId: device.tenantId, relayId: device.relayId, channel: device.channel, envelope, ...owner })
            : { status: 'dropped' as const, reason: 'no-owner' };
          await storage.appendDeliveryLog({
            logId: `dlv_${randomUUID()}`, tenantId: device.tenantId, relayId: device.relayId, channel: device.channel,
            direction: 'inbound', conversationId: envelope.conversationId,
            status: outcome.status === 'accepted' ? 'bridged' : 'dropped',
            detail: outcome.status === 'accepted' ? `conversation ${outcome.conversationId}` : outcome.reason,
            at: new Date().toISOString(),
          });
          res.status(202).json(outcome.status === 'accepted'
            ? { accepted: true, sessionKey, conversationId: outcome.conversationId }
            : { accepted: false, sessionKey, dropped: outcome.reason });
          return;
        }

        // The legacy workflow lane: the per-connector access policy + pairing/allowlist
        // (Phase C), admin-configured (ADR 1043 H1). Strictly opt-in: if no enabled
        // connector exists for (tenant, channel) OR no policy row is set, behavior is
        // unchanged (open). The gate may drop the message, record a pairing request,
        // or pass through to the bridge.
        const gate = await evaluatePolicyGate(storage, device, envelope);
        if (gate.action === 'drop') {
          await storage.appendDeliveryLog({
            logId: `dlv_${randomUUID()}`, tenantId: device.tenantId, relayId: device.relayId, channel: device.channel,
            direction: 'inbound', conversationId: envelope.conversationId, status: 'dropped', detail: gate.reason, at: new Date().toISOString(),
          });
          res.status(202).json({ accepted: false, sessionKey, dropped: gate.reason });
          return;
        }
        if (gate.action === 'pair') {
          // ADR 1043 D9 — the request is recorded for a workspace admin (`GET pairing`)
          // and NOTHING is sent to the stranger: a pairing prompt would go out from
          // the device owner's personal account to anyone who writes in.
          const pairing = await mintPairingCode(storage, gate.connectorId, device, envelope);
          await storage.appendDeliveryLog({
            logId: `dlv_${randomUUID()}`, tenantId: device.tenantId, relayId: device.relayId, channel: device.channel,
            direction: 'inbound', conversationId: envelope.conversationId, status: 'pairing-pending', detail: pairing.pairingId, at: new Date().toISOString(),
          });
          res.status(202).json({ accepted: false, sessionKey, pairing: { pairingId: pairing.pairingId, code: pairing.code, expiresAt: pairing.expiresAt } });
          return;
        }

        let runId: string | undefined;
        if (bridge) {
          const result = await bridge.onInbound({
            device: { relayId: device.relayId, tenantId: device.tenantId, channel: device.channel },
            envelope,
            sessionKey,
          });
          if (result && result.runId) {
            runId = result.runId;
            const s = await storage.getMessagingSession(sessionKey);
            if (s) await storage.upsertMessagingSession({ ...s, lastRunId: runId });
          }
        }
        await storage.appendDeliveryLog({
          logId: `dlv_${randomUUID()}`,
          tenantId: device.tenantId,
          relayId: device.relayId,
          channel: device.channel,
          direction: 'inbound',
          conversationId: envelope.conversationId,
          status: runId ? 'bridged' : 'ingested',
          ...(runId ? { detail: `run ${runId}` } : {}),
          at: new Date().toISOString(),
        });
        res.status(202).json({ accepted: true, sessionKey, ...(runId ? { runId } : {}) });
      } catch (err) {
        // A failed attempt gives its claim back, so the device's retry lands.
        await releaseRelayInbound(device.relayId, envelope.conversationId, envelope.platformMessageId).catch(() => undefined);
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/device/outbound`, async (req, res, next) => {
    try {
      const device = await requireDevice(req, storage);
      // CHAN-F11 — a switched-off channel pulls nothing; its queue waits (and ages out
      // at the token lifetime if the channel stays off, CHAN-F12).
      if (await relayChannelDisabled(device.tenantId, device.channel)) {
        res.json({ relayId: device.relayId, messages: [], paused: 'channel_disabled' });
        return;
      }
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const queued = await storage.listRelayOutbound(device.relayId, limit);
      // ADR 1043 D1 — each egress carries how many transient failures it has seen.
      const messages = [];
      for (const m of queued) messages.push({ ...m, attempts: await egressAttempts(m.egressId) });
      res.json({ relayId: device.relayId, messages });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/device/ack`, async (req, res, next) => {
    try {
      const device = await requireDevice(req, storage);
      const body = (req.body ?? {}) as { egressIds?: unknown; failed?: unknown };
      // ADR 1043 D1 — `egressIds` were delivered; `failed[]` were not. At least one.
      if (body.egressIds !== undefined && !Array.isArray(body.egressIds)) {
        throw new OpenwopError('invalid_request', 'egressIds MUST be an array', 400);
      }
      if (body.failed !== undefined && !Array.isArray(body.failed)) {
        throw new OpenwopError('invalid_request', 'failed MUST be an array', 400);
      }
      if (body.egressIds === undefined && body.failed === undefined) {
        throw new OpenwopError('invalid_request', 'egressIds[] or failed[] is required', 400);
      }
      const at = new Date().toISOString();
      const log = (egressId: string, status: string, detail: string) => storage.appendDeliveryLog({
        logId: `dlv_${randomUUID()}`, tenantId: device.tenantId, relayId: device.relayId, channel: device.channel,
        direction: 'outbound', conversationId: '', status, detail: `egress ${egressId}: ${detail}`, at,
      });
      // Only ids this device still has queued count (an ack is idempotent, and one
      // device can never ack or fail another device's egress).
      const pending = new Map((await storage.listRelayOutbound(device.relayId, 1000)).map((m) => [m.egressId, m]));
      const delivered = Array.isArray(body.egressIds) ? body.egressIds.map(String).filter((id) => pending.has(id)) : [];
      const acked = delivered.length ? await storage.ackRelayOutbound(device.relayId, delivered) : 0;
      for (const id of delivered) {
        await clearEgressAttempts(id).catch(() => undefined);
        await log(id, 'delivered', 'delivered');
      }
      let failed = 0;
      let deadLettered = 0;
      for (const raw of Array.isArray(body.failed) ? body.failed : []) {
        const f = (raw ?? {}) as { egressId?: unknown; error?: unknown; permanent?: unknown };
        const egressId = typeof f.egressId === 'string' ? f.egressId : '';
        if (!pending.has(egressId) || delivered.includes(egressId)) continue;
        const error = (typeof f.error === 'string' && f.error ? f.error : 'unknown error').slice(0, 200);
        failed += 1;
        const count = f.permanent === true ? EGRESS_MAX_ATTEMPTS : await recordEgressAttempt(egressId, device.relayId, device.tenantId, error);
        if (count >= EGRESS_MAX_ATTEMPTS) {
          await storage.ackRelayOutbound(device.relayId, [egressId]);
          await clearEgressAttempts(egressId).catch(() => undefined);
          await log(egressId, 'failed', f.permanent === true ? `permanent: ${error}` : `max_attempts: ${error}`);
          deadLettered += 1;
        }
      }
      res.json({ acked, failed, deadLettered });
    } catch (err) {
      next(err);
    }
  });

  // ---- Outbound enqueue (operator bearer / inbound bridge) ----

  app.post(`${BASE}/relay/enqueue`, async (req, res, next) => {
    try {
      const tenantId = resolveTenant(req);
      const body = req.body ?? {};
      const relayId = requireString(body.relayId, 'relayId');
      const device = await storage.getRelayDevice(relayId);
      if (!device || (device.tenantId !== tenantId && !isWildcard(req))) {
        throw new OpenwopError('not_found', 'relay not found', 404);
      }
      // ADR 1043 H1 — sending AS a device is its OWNER's act only. Another member
      // (an admin included) cannot queue a send through someone's personal account.
      // A device with no owner (an operator key registered it) only the wildcard
      // operator may drive. The host's own replies enqueue by function call.
      if (!(await isRelayOwnerCaller(req, device)) && !(isWildcard(req) && !(await getRelayOwnerRecord(device.relayId, device.tenantId)))) {
        throw new OpenwopError('forbidden', 'Only the relay\'s owner can send through it.', 403, { reason: 'relay_owner_required', relayId });
      }
      if (device.status !== 'active') throw new OpenwopError('conflict', 'relay is not active', 409, { reason: 'relay_not_active', relayId });
      const egress = await enqueueOutbound(storage, relayId, {
        channel: device.channel,
        conversationId: requireString(body.conversationId, 'conversationId'),
        text: requireString(body.text, 'text'),
        ...(optionalString(body.replyToMessageId) ? { replyToMessageId: String(body.replyToMessageId) } : {}),
        ...parseEgressExtras(body),
      });
      res.status(201).json(egress);
    } catch (err) {
      next(err);
    }
  });

  // ---- Connectors (operator bearer) ----

  app.get(`${BASE}/connectors`, async (req, res, next) => {
    try {
      const connectors = await storage.listMessagingConnectors(listTenantFilter(req));
      res.json({ connectors });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/connectors`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const tenantId = resolveTenant(req);
      const body = req.body ?? {};
      const channel = assertChannel(body.channel);
      const connectorId = optionalString(body.connectorId) ?? `conn_${channel}_${tenantId}`;
      const now = new Date().toISOString();
      const existing = await storage.getMessagingConnector(connectorId);
      const connector = {
        connectorId,
        tenantId,
        channel,
        displayName: optionalString(body.displayName) ?? channel,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : (existing?.enabled ?? false),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await storage.upsertMessagingConnector(connector);
      res.status(existing ? 200 : 201).json(connector);
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/connectors/:id`, async (req, res, next) => {
    try {
      res.json(await getConnectorOr404(req, storage));
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/connectors/:id/enable`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const c = await getConnectorOr404(req, storage);
      const updated = { ...c, enabled: true, updatedAt: new Date().toISOString() };
      await storage.upsertMessagingConnector(updated);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/connectors/:id/disable`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const c = await getConnectorOr404(req, storage);
      const updated = { ...c, enabled: false, updatedAt: new Date().toISOString() };
      await storage.upsertMessagingConnector(updated);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/connectors/:id/test`, async (req, res, next) => {
    try {
      const c = await getConnectorOr404(req, storage);
      // Real deliverability, not a synthetic "ok": outbound for this channel is
      // delivered by an external relay DEVICE pulling the queue, so the probe is
      // only green when an active device for this channel has heartbeated
      // recently. Without one, outbound just queues undelivered — report that
      // honestly rather than a false-positive.
      const FRESH_MS = OFFLINE_AFTER_MS; // ADR 1043 — the ONE presence window
      const now = Date.now();
      const devices = (await storage.listRelayDevices(c.tenantId)).filter(
        (d) => d.channel === c.channel && d.status === 'active',
      );
      const live = devices.filter((d) => d.lastHeartbeatAt && now - Date.parse(d.lastHeartbeatAt) <= FRESH_MS);
      const ok = c.enabled && live.length > 0;
      const detail = !c.enabled
        ? 'connector disabled'
        : live.length > 0
          ? `${live.length} active relay device(s) reachable for ${c.channel}`
          : devices.length > 0
            ? `relay device(s) registered for ${c.channel} but none heartbeated within ${FRESH_MS / 1000}s — outbound would queue undelivered`
            : `no active relay device for ${c.channel} — outbound would queue undelivered`;
      res.json({
        connectorId: c.connectorId,
        channel: c.channel,
        enabled: c.enabled,
        ok,
        relayDevices: devices.length,
        liveRelayDevices: live.length,
        detail,
        probedAt: new Date(now).toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- Sessions (operator bearer) ----

  app.get(`${BASE}/sessions`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const sessions = await storage.listMessagingSessions(listTenantFilter(req));
      res.json({ sessions });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/sessions/:key`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      res.json(await getSessionOr404(req, storage));
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/sessions/:key`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const s = await getSessionOr404(req, storage);
      await storage.deleteMessagingSession(s.sessionKey);
      res.json({ sessionKey: s.sessionKey, deleted: true });
    } catch (err) {
      next(err);
    }
  });

  // ---- Access policy (operator bearer) ----
  // Who may DM / activate in groups, per connector. Absent = host default
  // (DM pairing required, groups allowlist-only, mention required).

  app.get(`${BASE}/connectors/:id/policy`, async (req, res, next) => {
    try {
      const c = await getConnectorOr404(req, storage);
      const policy = (await storage.getMessagingPolicy(c.connectorId)) ?? defaultPolicy(c.connectorId, c.tenantId);
      res.json(policy);
    } catch (err) {
      next(err);
    }
  });

  app.put(`${BASE}/connectors/:id/policy`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const c = await getConnectorOr404(req, storage);
      const body = req.body ?? {};
      const existing = await storage.getMessagingPolicy(c.connectorId);
      const base = existing ?? defaultPolicy(c.connectorId, c.tenantId);
      const policy: MessagingPolicyRecord = {
        connectorId: c.connectorId,
        tenantId: c.tenantId,
        dmPolicy: body.dmPolicy === undefined ? base.dmPolicy : assertDmPolicy(body.dmPolicy),
        groupPolicy: body.groupPolicy === undefined ? base.groupPolicy : assertGroupPolicy(body.groupPolicy),
        requireMention: typeof body.requireMention === 'boolean' ? body.requireMention : base.requireMention,
        updatedAt: new Date().toISOString(),
      };
      await storage.upsertMessagingPolicy(policy);
      // Operator-friendly tripwire: setting requireMention:true with no bot-id
      // env configured means EVERY inbound on this channel would be dropped
      // (no plugin yet populates envelope.mentions[]; the text fallback also
      // needs OPENWOP_MESSAGING_BOT_NAME). Surface it loud in the response so
      // the operator notices BEFORE production traffic starts disappearing.
      const mentionUnreachable = policy.requireMention
        && !process.env[`OPENWOP_MESSAGING_BOT_ID_${c.channel.toUpperCase()}`]
        && !process.env.OPENWOP_MESSAGING_BOT_NAME;
      if (mentionUnreachable) {
        res.json({
          ...policy,
          warning: `requireMention:true is set but neither OPENWOP_MESSAGING_BOT_ID_${c.channel.toUpperCase()} nor OPENWOP_MESSAGING_BOT_NAME is configured — every inbound on this channel will be dropped as 'no-mention' until you set one.`,
        });
        return;
      }
      res.json(policy);
    } catch (err) {
      next(err);
    }
  });

  // ---- Routing rules (operator bearer) ----
  // Map an inbound match (channel + substring pattern) → a bound workflow.
  // Higher priority wins; '*' pattern matches any conversation/peer.

  app.get(`${BASE}/routing`, async (req, res, next) => {
    try {
      const rules = await storage.listMessagingRoutingRules(listTenantFilter(req));
      res.json({ rules });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/routing`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const tenantId = resolveTenant(req);
      const body = req.body ?? {};
      const wf = optionalString(body.workflowId);
      const ag = optionalString(body.agentId);
      if (!wf && !ag) throw new OpenwopError('invalid_request', 'one of workflowId or agentId is required', 400);
      if (wf && ag) throw new OpenwopError('invalid_request', 'workflowId and agentId are mutually exclusive', 400);
      const rule: MessagingRoutingRuleRecord = {
        ruleId: optionalString(body.ruleId) ?? `route_${randomUUID()}`,
        tenantId,
        ...(body.channel === undefined ? {} : { channel: assertChannel(body.channel) }),
        pattern: requireString(body.pattern, 'pattern'),
        ...(wf ? { workflowId: wf } : {}),
        ...(ag ? { agentId: ag } : {}),
        priority: typeof body.priority === 'number' ? body.priority : 0,
        createdAt: new Date().toISOString(),
      };
      await storage.upsertMessagingRoutingRule(rule);
      res.status(201).json(rule);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/routing/:ruleId`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      // Scope the delete to the caller's tenant unless wildcard.
      const found = await getRoutingRuleOr404(req, storage);
      await storage.deleteMessagingRoutingRule(found.ruleId);
      res.json({ ruleId: found.ruleId, deleted: true });
    } catch (err) {
      next(err);
    }
  });

  // ---- Cross-channel identities (operator bearer) ----
  // Link platform peers across channels to one logical person.

  app.get(`${BASE}/identities`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const identities = await storage.listMessagingIdentities(listTenantFilter(req));
      res.json({ identities });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/identities`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const tenantId = resolveTenant(req);
      const body = req.body ?? {};
      const identityId = optionalString(body.identityId);
      const peers = parsePeers(body.peers);
      const now = new Date().toISOString();
      if (identityId) {
        // Link mode: merge peers into an existing identity.
        const existing = await storage.getMessagingIdentity(identityId);
        if (!existing || (existing.tenantId !== tenantId && !isWildcard(req))) {
          throw new OpenwopError('not_found', 'identity not found', 404);
        }
        const merged = mergePeers(existing.peers, peers);
        const updated: MessagingIdentityRecord = {
          ...existing,
          ...(optionalString(body.displayName) ? { displayName: String(body.displayName) } : {}),
          peers: merged,
          updatedAt: now,
        };
        await storage.upsertMessagingIdentity(updated);
        res.json(updated);
        return;
      }
      const identity: MessagingIdentityRecord = {
        identityId: `idn_${randomUUID()}`,
        tenantId,
        ...(optionalString(body.displayName) ? { displayName: String(body.displayName) } : {}),
        peers,
        createdAt: now,
        updatedAt: now,
      };
      await storage.upsertMessagingIdentity(identity);
      res.status(201).json(identity);
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/identities/:id`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      res.json(await getIdentityOr404(req, storage));
    } catch (err) {
      next(err);
    }
  });

  // Unlink a single peer (?channel=&peerId=) or delete the whole identity.
  app.delete(`${BASE}/identities/:id`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const identity = await getIdentityOr404(req, storage);
      const channel = optionalString(req.query.channel);
      const peerId = optionalString(req.query.peerId);
      if (channel && peerId) {
        const peers = identity.peers.filter((p) => !(p.channel === channel && p.peerId === peerId));
        const updated: MessagingIdentityRecord = { ...identity, peers, updatedAt: new Date().toISOString() };
        await storage.upsertMessagingIdentity(updated);
        res.json(updated);
        return;
      }
      await storage.deleteMessagingIdentity(identity.identityId);
      res.json({ identityId: identity.identityId, deleted: true });
    } catch (err) {
      next(err);
    }
  });

  // ---- Delivery log (operator bearer) ----

  app.get(`${BASE}/logs`, async (req, res, next) => {
    try {
      const filter: Parameters<Storage['listDeliveryLog']>[0] = {
        tenantId: listTenantFilter(req),
        ...(optionalString(req.query.channel) ? { channel: assertChannel(req.query.channel) } : {}),
        ...(optionalString(req.query.direction) ? { direction: assertDirection(req.query.direction) } : {}),
        ...(optionalString(req.query.status) ? { status: String(req.query.status) } : {}),
        ...(optionalString(req.query.limit) ? { limit: clampLimit(req.query.limit) } : {}),
      };
      const all = await storage.listDeliveryLog(filter);
      // ADR 1043 H1 — the log names other members' contacts: a non-admin sees
      // only the rows of relays they own.
      let entries = all;
      if (!(await isRelayWorkspaceAdmin(req))) {
        const caller = req.userId ?? req.principal?.principalId;
        const owned = new Set<string>();
        for (const d of await storage.listRelayDevices(resolveTenant(req))) {
          const o = await getRelayOwnerRecord(d.relayId, d.tenantId);
          if (o && caller !== undefined && o.ownerUserId === caller) owned.add(d.relayId);
        }
        entries = all.filter((e) => !!e.relayId && owned.has(e.relayId));
      }
      res.json({ entries });
    } catch (err) {
      next(err);
    }
  });

  // ---- One-off notifications (operator bearer) ----
  // Email / SMS dispatch. Delivered through the injected notifyDeliverer: a
  // configured webhook (fronting SES / Twilio / etc.) actually delivers and
  // reports `status: 'delivered'`; with none configured it falls back to an
  // honest synthetic receipt (`status: 'accepted'`, not delivered).

  app.post(`${BASE}/notify`, async (req, res, next) => {
    try {
      const tenantId = resolveTenant(req);
      const body = req.body ?? {};
      const kind = assertNotifyKind(body.kind);
      const to = requireString(body.to, 'to');
      const text = requireString(body.text, 'text');
      const subject = optionalString(body.subject) ? String(body.subject) : undefined;
      const result = await notifyDeliverer({ kind, to, text, tenantId, ...(subject ? { subject } : {}) });
      res.status(202).json({
        notifyId: `ntf_${randomUUID()}`,
        tenantId,
        kind,
        to,
        ...(subject ? { subject } : {}),
        textLength: text.length,
        status: result.delivered ? 'delivered' : 'accepted',
        ...(result.provider ? { provider: result.provider } : {}),
        detail: result.detail,
        acceptedAt: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- Pairing + allowlist (operator bearer) — Phase C ----

  app.get(`${BASE}/pairing`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const scope = await tenantConnectorScope(storage, req);
      const requested = optionalString(req.query.connectorId);
      if (requested && !scope.owns(requested)) {
        throw new OpenwopError('not_found', 'connector not found', 404);
      }
      const all = await storage.listMessagingPairings(requested);
      // For non-wildcard callers without a connectorId filter, restrict to the
      // caller's own connectors so listing can't disclose other tenants' codes.
      const pairings = scope.isWildcard ? all : all.filter((p) => scope.owns(p.connectorId));
      res.json({ pairings });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/pairing/approve`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const body = req.body ?? {};
      const connectorId = requireString(body.connectorId, 'connectorId');
      const code = requireString(body.code, 'code');
      const pairing = await storage.getMessagingPairingByCode(connectorId, code);
      if (!pairing || Date.parse(pairing.expiresAt) < Date.now()) {
        throw new OpenwopError('not_found', 'pairing code not found or expired', 404);
      }
      const tenantId = resolveTenant(req);
      if (pairing.tenantId !== tenantId && !isWildcard(req)) {
        throw new OpenwopError('not_found', 'pairing code not found or expired', 404);
      }
      await storage.addMessagingAllowlist({
        entryId: `al_${randomUUID()}`,
        connectorId: pairing.connectorId,
        tenantId: pairing.tenantId,
        channel: pairing.channel,
        peerId: pairing.peerId,
        addedAt: new Date().toISOString(),
      });
      await storage.deleteMessagingPairing(pairing.pairingId);
      res.json({ approved: true, connectorId: pairing.connectorId, channel: pairing.channel, peerId: pairing.peerId });
    } catch (err) {
      next(err);
    }
  });

  app.get(`${BASE}/allowlist`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const scope = await tenantConnectorScope(storage, req);
      const requested = optionalString(req.query.connectorId);
      if (requested && !scope.owns(requested)) {
        throw new OpenwopError('not_found', 'connector not found', 404);
      }
      const all = await storage.listMessagingAllowlist(requested);
      const entries = scope.isWildcard ? all : all.filter((e) => scope.owns(e.connectorId));
      res.json({ entries });
    } catch (err) {
      next(err);
    }
  });

  app.post(`${BASE}/allowlist`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const body = req.body ?? {};
      const connectorId = requireString(body.connectorId, 'connectorId');
      const channel = assertChannel(body.channel);
      const peerId = requireString(body.peerId, 'peerId');
      const c = await storage.getMessagingConnector(connectorId);
      if (!c) throw new OpenwopError('not_found', 'connector not found', 404);
      const tenantId = resolveTenant(req);
      if (c.tenantId !== tenantId && !isWildcard(req)) {
        throw new OpenwopError('not_found', 'connector not found', 404);
      }
      const entry = {
        entryId: `al_${randomUUID()}`,
        connectorId, tenantId: c.tenantId, channel, peerId,
        addedAt: new Date().toISOString(),
      };
      await storage.addMessagingAllowlist(entry);
      res.status(201).json(entry);
    } catch (err) {
      next(err);
    }
  });

  app.delete(`${BASE}/allowlist`, async (req, res, next) => {
    try {
      await requireRelayAdmin(req); // ADR 1043 H1 — workspace-wide relay config
      const connectorId = requireString(req.query.connectorId, 'connectorId');
      const channel = assertChannel(req.query.channel);
      const peerId = requireString(req.query.peerId, 'peerId');
      // Tenant ownership check on the connector — otherwise any authenticated
      // caller could delete another tenant's allowlist row if they guess the id.
      const scope = await tenantConnectorScope(storage, req);
      if (!scope.owns(connectorId)) {
        throw new OpenwopError('not_found', 'connector not found', 404);
      }
      const removed = await storage.deleteMessagingAllowlist(connectorId, channel, peerId);
      res.json({ removed, connectorId, channel, peerId });
    } catch (err) {
      next(err);
    }
  });
}

/** Enqueue an outbound egress for a relay. Used by /relay/enqueue and the bridge. */
export async function enqueueOutbound(
  storage: Storage,
  relayId: string,
  fields: {
    channel: RelayChannel;
    conversationId: string;
    text: string;
    replyToMessageId?: string;
    media?: ChatEgressEnvelope['media'];
    components?: ChatEgressEnvelope['components'];
    reactions?: ChatEgressEnvelope['reactions'];
  },
): Promise<ChatEgressEnvelope> {
  // CHAN-F11 — nothing new is queued for a channel a workspace admin switched off.
  const owning = await storage.getRelayDevice(relayId);
  if (owning && (await relayChannelDisabled(owning.tenantId, owning.channel))) {
    throw new OpenwopError('conflict', 'this relay channel is switched off in the workspace', 409, { reason: 'relay_channel_disabled', relayId });
  }
  const egress: ChatEgressEnvelope = {
    egressId: `egr_${randomUUID()}`,
    relayId,
    channel: fields.channel,
    conversationId: fields.conversationId,
    text: fields.text,
    ...(fields.replyToMessageId ? { replyToMessageId: fields.replyToMessageId } : {}),
    ...(fields.media && fields.media.length ? { media: fields.media } : {}),
    ...(fields.components && fields.components.length ? { components: fields.components } : {}),
    ...(fields.reactions && fields.reactions.length ? { reactions: fields.reactions } : {}),
    enqueuedAt: new Date().toISOString(),
  };
  await storage.enqueueRelayOutbound(egress);
  // Best-effort delivery-log entry (queued). tenantId is resolved from the
  // owning device; if the device is gone we skip the log rather than fail.
  const device = owning;
  if (device) {
    await storage.appendDeliveryLog({
      logId: `dlv_${randomUUID()}`,
      tenantId: device.tenantId,
      relayId,
      channel: egress.channel,
      direction: 'outbound',
      conversationId: egress.conversationId,
      status: 'queued',
      detail: `egress ${egress.egressId}`,
      at: egress.enqueuedAt,
    });
  }
  return egress;
}

// ---- helpers ----

function isWildcard(req: Request): boolean {
  return (req.principal?.tenants ?? []).includes('*');
}

function resolveTenant(req: Request): string {
  if (isWildcard(req)) {
    if (typeof req.query.tenantId === 'string' && req.query.tenantId.length > 0) return req.query.tenantId;
    const bodyTenant = (req.body ?? {}).tenantId;
    return typeof bodyTenant === 'string' && bodyTenant.length > 0 ? bodyTenant : 'default';
  }
  return req.tenantId ?? 'default';
}

/** Tenant filter for list endpoints: undefined = all (wildcard, no ?tenantId). */
function listTenantFilter(req: Request): string | undefined {
  if (isWildcard(req)) {
    return typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
  }
  return req.tenantId;
}

/**
 * ADR 1043 D3 — a workspace admin for relay purposes: the SAME workspace-level
 * manage check the connections routes use (`authorizeManage` on a row with no
 * owner and no org ⇒ `host:connections:manage` on the caller's workspace).
 */
export async function isRelayWorkspaceAdmin(req: Request): Promise<boolean> {
  // Imported lazily: a static import of the connections routes from here forms a
  // module-init cycle (media → profiles → chatContext) at app boot.
  const { authorizeManage } = await import('../features/connections/routes.js');
  try {
    await authorizeManage(req, { connectionId: 'relay-devices' });
    return true;
  } catch (err) {
    if (err instanceof OpenwopError && err.httpStatus === 403) return false;
    throw err;
  }
}

/** ADR 1043 H1 — is the caller this device's owner? */
async function isRelayOwnerCaller(req: Request, device: RelayDeviceRecord): Promise<boolean> {
  const caller = req.userId ?? req.principal?.principalId;
  const owner = await getRelayOwnerRecord(device.relayId, device.tenantId);
  return !!owner && caller !== undefined && owner.ownerUserId === caller;
}

/**
 * ADR 1043 H1 — workspace-wide relay configuration (connectors, policy, allowlist,
 * pairing, routing, identities, sessions) changes how EVERY member's relay admits
 * and routes messages, so it is a workspace admin's act (the same check as revoke).
 */
async function requireRelayAdmin(req: Request): Promise<void> {
  if (!(await isRelayWorkspaceAdmin(req))) {
    throw new OpenwopError('forbidden', 'Only a workspace admin can manage the workspace\'s messaging relay settings.', 403, { reason: 'relay_admin_required' });
  }
}

/** ADR 1043 D3 — may this caller revoke this device? Its owner, or a workspace admin. */
async function canRevokeRelay(req: Request, device: RelayDeviceRecord): Promise<boolean> {
  if (await isRelayOwnerCaller(req, device)) return true;
  return isRelayWorkspaceAdmin(req);
}

async function requireDevice(req: Request, storage: Storage): Promise<RelayDeviceRecord> {
  return (await authDevice(req, storage)).device;
}

/**
 * ADR 1043 D1 — authenticate a device token. Every refusal is a 401 with a
 * `details.reason` the relay acts on. A previous token still in its rotation
 * grace authenticates (`viaGrace`), and is refused by the rotate route.
 */
async function authDevice(req: Request, storage: Storage): Promise<{ device: RelayDeviceRecord; viaGrace: boolean }> {
  const token = req.header('x-openwop-device-token');
  if (!token) throw new OpenwopError('unauthenticated', 'x-openwop-device-token header required', 401, { reason: 'device_token_missing' });
  const hash = hashToken(token);
  let device = await storage.getRelayDeviceByTokenHash(hash);
  let viaGrace = false;
  if (!device) {
    const relayId = await relayForGraceToken(hash);
    if (relayId) { device = await storage.getRelayDevice(relayId); viaGrace = true; }
  }
  if (!device) throw new OpenwopError('unauthenticated', 'invalid device token', 401, { reason: 'device_token_invalid' });
  if (device.status !== 'active') throw new OpenwopError('unauthenticated', 'this relay was revoked', 401, { reason: 'device_revoked' });
  // Fail closed (review prep, P1): a token with NO expiry, or an unparseable one,
  // is expired. Every path that writes a token hash (activate, rotate) also
  // writes `tokenExpiresAt`, so only a legacy or corrupt row lands here.
  const expiresAt = device.tokenExpiresAt ? Date.parse(device.tokenExpiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    throw new OpenwopError('unauthenticated', 'device token expired', 401, { reason: 'device_token_expired' });
  }
  return { device, viaGrace };
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9_.:+@;-]{1,128}$/;
/** ADR 1042 N1 / ADR 1043 D6 — the device's own account id, or 400. */
export function optionalAccountId(raw: unknown): string | undefined {
  const v = optionalString(raw)?.trim();
  if (!v) return undefined;
  if (!ACCOUNT_ID_RE.test(v)) throw new OpenwopError('invalid_request', 'accountId is not a valid platform account id', 400, { field: 'accountId' });
  return v;
}

async function getConnectorOr404(req: Request, storage: Storage) {
  const c = await storage.getMessagingConnector(req.params.id);
  if (!c || (c.tenantId !== resolveTenant(req) && !isWildcard(req))) {
    throw new OpenwopError('not_found', 'connector not found', 404);
  }
  return c;
}

async function getSessionOr404(req: Request, storage: Storage) {
  const s = await storage.getMessagingSession(req.params.key);
  if (!s || (s.tenantId !== resolveTenant(req) && !isWildcard(req))) {
    throw new OpenwopError('not_found', 'session not found', 404);
  }
  return s;
}

function assertChannel(raw: unknown): RelayChannel {
  if (typeof raw === 'string' && (RELAY_CHANNELS as readonly string[]).includes(raw)) {
    return raw as RelayChannel;
  }
  throw new OpenwopError('invalid_request', `channel must be one of ${RELAY_CHANNELS.join(', ')}`, 400, {
    allowed: RELAY_CHANNELS,
  });
}

function parseIngress(raw: unknown, channel: RelayChannel): ChatIngressEnvelope {
  const body = (raw ?? {}) as Record<string, unknown>;
  const envelope: ChatIngressEnvelope = {
    channel,
    platformMessageId: requireString(body.platformMessageId, 'platformMessageId'),
    conversationId: requireString(body.conversationId, 'conversationId'),
    peerId: requireString(body.peerId, 'peerId'),
    ...(optionalString(body.peerDisplay) ? { peerDisplay: String(body.peerDisplay) } : {}),
    text: typeof body.text === 'string' ? body.text : '',
    timestamp: optionalString(body.timestamp) ?? new Date().toISOString(),
  };
  if (Array.isArray(body.media)) {
    envelope.media = body.media
      .filter((m): m is { url: string; mimeType?: string; filename?: string } => !!m && typeof (m as { url?: unknown }).url === 'string')
      .map((m) => ({ url: m.url, ...(m.mimeType ? { mimeType: m.mimeType } : {}), ...(m.filename ? { filename: m.filename } : {}) }));
  }
  // ── envelope v2 passthrough (all optional; unknown kinds tolerated) ──
  const kind = optionalString(body.kind);
  if (kind === 'reaction' || kind === 'edit' || kind === 'command' || kind === 'message') envelope.kind = kind;
  if (optionalString(body.quotedMessageId)) envelope.quotedMessageId = String(body.quotedMessageId);
  const reaction = body.reaction as { emoji?: unknown; targetMessageId?: unknown } | undefined;
  if (reaction && typeof reaction.emoji === 'string' && typeof reaction.targetMessageId === 'string') {
    envelope.reaction = { emoji: reaction.emoji, targetMessageId: reaction.targetMessageId };
  }
  const command = body.command as { name?: unknown; args?: unknown } | undefined;
  if (command && typeof command.name === 'string') {
    envelope.command = { name: command.name, ...(typeof command.args === 'string' ? { args: command.args } : {}) };
  }
  if (body.fromMe === true) envelope.fromMe = true; // ADR 1042 D9 — only an explicit true
  if (Array.isArray(body.mentions)) {
    envelope.mentions = body.mentions.filter((m): m is string => typeof m === 'string' && m.length > 0);
  }
  if (body.channelMeta && typeof body.channelMeta === 'object' && !Array.isArray(body.channelMeta)) {
    envelope.channelMeta = body.channelMeta as Record<string, unknown>;
  }
  return envelope;
}

/** Parse the optional envelope-v2 outbound fields (media/components/reactions) off a request body. */
function parseEgressExtras(body: Record<string, unknown>): {
  media?: ChatEgressEnvelope['media'];
  components?: ChatEgressEnvelope['components'];
  reactions?: ChatEgressEnvelope['reactions'];
} {
  const out: {
    media?: ChatEgressEnvelope['media'];
    components?: ChatEgressEnvelope['components'];
    reactions?: ChatEgressEnvelope['reactions'];
  } = {};
  if (Array.isArray(body.media)) {
    out.media = body.media
      .filter((m): m is { url: string; mimeType?: string; filename?: string } => !!m && typeof (m as { url?: unknown }).url === 'string')
      .map((m) => ({ url: m.url, ...(m.mimeType ? { mimeType: m.mimeType } : {}), ...(m.filename ? { filename: m.filename } : {}) }));
  }
  if (Array.isArray(body.components)) {
    out.components = body.components
      .filter((c): c is { id: string; label: string; style?: 'reply' | 'link'; url?: string } =>
        !!c && typeof (c as { id?: unknown }).id === 'string' && typeof (c as { label?: unknown }).label === 'string')
      .map((c) => ({ id: c.id, label: c.label, ...(c.style ? { style: c.style } : {}), ...(c.url ? { url: c.url } : {}) }));
  }
  if (Array.isArray(body.reactions)) {
    out.reactions = body.reactions.filter((r): r is string => typeof r === 'string');
  }
  return out;
}

// ── Phase C: policy/pairing/allowlist helpers ──────────────────────────────

const PAIRING_TTL_MS = 60 * 60 * 1000; // 1 hour

type PolicyGateResult =
  | { action: 'allow'; connectorId?: string }
  | { action: 'drop'; connectorId?: string; reason: string }
  | { action: 'pair'; connectorId: string };

/**
 * Decide whether an inbound message passes the connector's policy (dm/group
 * + allowlist + pairing + requireMention). Opt-in by design: if no enabled
 * connector for (tenant, channel) OR no policy row → action 'allow' (the
 * legacy pass-through). `evaluatePolicyGate` is exported for direct testing.
 *
 * ADR 1043 D9 — the LEGACY WORKFLOW LANE only. Conversation mode never reads it:
 * a relay device there admits by its own owner's approvals (channel-ingress).
 */
export async function evaluatePolicyGate(
  storage: Storage,
  device: { tenantId: string; channel: RelayChannel },
  envelope: ChatIngressEnvelope,
): Promise<PolicyGateResult> {
  const connectors = await storage.listMessagingConnectors(device.tenantId);
  const connector = connectors.find((c) => c.channel === device.channel && c.enabled);
  if (!connector) return { action: 'allow' };
  const policy = await storage.getMessagingPolicy(connector.connectorId);
  if (!policy) return { action: 'allow', connectorId: connector.connectorId };

  // Heuristic group detection: channel-native group/chat prefixes, or a Discord
  // guildId in channelMeta. DMs route on the source number/jid/handle directly.
  // ADR 1042 — one explicit per-channel rule, shared with the channel core.
  const isGroup = isRelayGroup(device.channel, envelope);
  const gate = isGroup ? policy.groupPolicy : policy.dmPolicy;
  if (gate === 'disabled') return { action: 'drop', connectorId: connector.connectorId, reason: 'disabled' };

  const peerAllowed = (gate === 'allowlist' || gate === 'pairing')
    ? !!(await storage.getMessagingAllowlist(connector.connectorId, device.channel, envelope.peerId))
    : true;
  if (gate === 'allowlist' && !peerAllowed) return { action: 'drop', connectorId: connector.connectorId, reason: 'allowlist-miss' };
  if (gate === 'pairing' && !peerAllowed) return { action: 'pair', connectorId: connector.connectorId };

  if (policy.requireMention && !hasBotMention(envelope, device.channel)) {
    return { action: 'drop', connectorId: connector.connectorId, reason: 'no-mention' };
  }
  return { action: 'allow', connectorId: connector.connectorId };
}

/**
 * Is the bot mentioned in this inbound? Channels populate `envelope.mentions[]`
 * with platform-native IDs; we compare against the env-configured bot id for
 * that channel. As a fallback (older clients, channels without native @
 * support like iMessage), check `text` for `@<botName>` (case-insensitive).
 * Returns false when nothing is configured — `requireMention` fails closed.
 */
export function hasBotMention(envelope: ChatIngressEnvelope, channel: RelayChannel): boolean {
  const botId = process.env[`OPENWOP_MESSAGING_BOT_ID_${channel.toUpperCase()}`];
  if (botId && envelope.mentions && envelope.mentions.includes(botId)) return true;
  const botName = process.env.OPENWOP_MESSAGING_BOT_NAME;
  if (botName && typeof envelope.text === 'string') {
    return envelope.text.toLowerCase().includes(`@${botName.toLowerCase()}`);
  }
  return false;
}

/**
 * Build a per-request scope predicate for `connectorId` ownership: wildcard
 * callers see all connectors; everyone else only their own tenant's. Used by
 * the pairing + allowlist routes to avoid cross-tenant disclosure / mutation.
 */
async function tenantConnectorScope(
  storage: Storage,
  req: Request,
): Promise<{ isWildcard: boolean; owns: (connectorId: string) => boolean }> {
  if (isWildcard(req)) return { isWildcard: true, owns: () => true };
  const tenantId = resolveTenant(req);
  const connectors = await storage.listMessagingConnectors(tenantId);
  const allowed = new Set(connectors.map((c) => c.connectorId));
  return { isWildcard: false, owns: (id) => allowed.has(id) };
}

/** Mint a pairing code for an unknown peer; reuse an unexpired one if it exists. */
async function mintPairingCode(
  storage: Storage,
  connectorId: string,
  device: { tenantId: string; channel: RelayChannel; relayId: string },
  envelope: ChatIngressEnvelope,
): Promise<{ pairingId: string; code: string; expiresAt: string }> {
  const now = Date.now();
  const existing = await storage.listMessagingPairings(connectorId);
  const reusable = existing.find((p) =>
    p.channel === device.channel && p.peerId === envelope.peerId && Date.parse(p.expiresAt) > now,
  );
  if (reusable) return { pairingId: reusable.pairingId, code: reusable.code, expiresAt: reusable.expiresAt };
  // Best-effort dedup: delete any STALE row for this (connector, channel, peer)
  // before minting a fresh one. Tightens the TOCTOU window between list+insert.
  for (const p of existing) {
    if (p.channel === device.channel && p.peerId === envelope.peerId) {
      await storage.deleteMessagingPairing(p.pairingId);
    }
  }
  // 6-char base32-ish code: alphanum minus look-alikes (no 0/O/1/I).
  // CSPRNG (not Math.random) — pairing codes are short-lived authorization
  // tokens, so use the same entropy source the rest of the stack does.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet.charAt(randomInt(0, alphabet.length));
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();
  const record = {
    pairingId: `pair_${randomUUID()}`,
    connectorId, tenantId: device.tenantId, channel: device.channel,
    peerId: envelope.peerId, code, expiresAt, createdAt: nowIso,
  };
  await storage.appendMessagingPairing(record);
  return { pairingId: record.pairingId, code, expiresAt };
}

function requireString(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new OpenwopError('invalid_request', `${field} is required`, 400);
  }
  return raw;
}

function optionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Coerce a `?limit=` query value to a sane positive integer in [1, 1000].
 * Non-numeric / non-positive inputs fall back to the default (100) — important
 * because SQLite treats a negative LIMIT as "unbounded", so an unclamped
 * `?limit=-1` would otherwise dump the whole table on the sqlite/memory host.
 */
function clampLimit(raw: unknown, fallback = 100): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 1000);
}

/** Host default policy: DM pairing required, groups allowlist-only, mention required. */
function defaultPolicy(connectorId: string, tenantId: string): MessagingPolicyRecord {
  return {
    connectorId,
    tenantId,
    dmPolicy: 'pairing',
    groupPolicy: 'allowlist',
    requireMention: true,
    updatedAt: new Date().toISOString(),
  };
}

function assertDmPolicy(raw: unknown): DmPolicy {
  if (typeof raw === 'string' && (DM_POLICIES as readonly string[]).includes(raw)) return raw as DmPolicy;
  throw new OpenwopError('invalid_request', `dmPolicy must be one of ${DM_POLICIES.join(', ')}`, 400, { allowed: DM_POLICIES });
}

function assertGroupPolicy(raw: unknown): GroupPolicy {
  if (typeof raw === 'string' && (GROUP_POLICIES as readonly string[]).includes(raw)) return raw as GroupPolicy;
  throw new OpenwopError('invalid_request', `groupPolicy must be one of ${GROUP_POLICIES.join(', ')}`, 400, { allowed: GROUP_POLICIES });
}

function assertDirection(raw: unknown): 'inbound' | 'outbound' {
  if (raw === 'inbound' || raw === 'outbound') return raw;
  throw new OpenwopError('invalid_request', "direction must be 'inbound' or 'outbound'", 400);
}

function assertNotifyKind(raw: unknown): NotifyKind {
  if (typeof raw === 'string' && (NOTIFY_KINDS as readonly string[]).includes(raw)) return raw as NotifyKind;
  throw new OpenwopError('invalid_request', `kind must be one of ${NOTIFY_KINDS.join(', ')}`, 400, { allowed: NOTIFY_KINDS });
}

/** Parse + validate a peers array: [{ channel, peerId }]. */
function parsePeers(raw: unknown): MessagingIdentityRecord['peers'] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is { channel: unknown; peerId: unknown } => !!p && typeof p === 'object')
    .map((p) => ({ channel: assertChannel(p.channel), peerId: requireString(p.peerId, 'peerId') }));
}

/** Merge new peers into existing, de-duped by (channel, peerId). */
function mergePeers(
  existing: MessagingIdentityRecord['peers'],
  incoming: MessagingIdentityRecord['peers'],
): MessagingIdentityRecord['peers'] {
  const seen = new Set(existing.map((p) => `${p.channel}\u0000${p.peerId}`));
  const merged = [...existing];
  for (const p of incoming) {
    const key = `${p.channel}\u0000${p.peerId}`;
    if (!seen.has(key)) { seen.add(key); merged.push(p); }
  }
  return merged;
}

async function getRoutingRuleOr404(req: Request, storage: Storage): Promise<MessagingRoutingRuleRecord> {
  const rules = await storage.listMessagingRoutingRules(listTenantFilter(req));
  const found = rules.find((r) => r.ruleId === req.params.ruleId);
  if (!found) throw new OpenwopError('not_found', 'routing rule not found', 404);
  return found;
}

async function getIdentityOr404(req: Request, storage: Storage): Promise<MessagingIdentityRecord> {
  const i = await storage.getMessagingIdentity(req.params.id);
  if (!i || (i.tenantId !== resolveTenant(req) && !isWildcard(req))) {
    throw new OpenwopError('not_found', 'identity not found', 404);
  }
  return i;
}

// ADR 0789 — a messaging routing rule this tenant bound to a SHARED workflow
// routes to the tenant's fork once edited. Rules are relational rows (no CAS
// primitive); the upsert re-reads the rule first and only rewrites the field.
onWorkflowForked('messaging:routing-rule', async (tenantId, from, to) => {
  const storage = tryDurableStorage();
  if (!storage) return 0;
  let n = 0;
  for (const rule of await storage.listMessagingRoutingRules(tenantId)) {
    if (rule.tenantId !== tenantId || rule.workflowId !== from) continue;
    await storage.upsertMessagingRoutingRule({ ...rule, workflowId: to });
    n += 1;
  }
  return n;
});
