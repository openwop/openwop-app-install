/**
 * ADR 1042 D3/D7 — per-connection channel routes (host-extension, non-normative):
 *
 *   GET|PUT  /host/openwop-app/connections/:id/channel             answering agent, bot handle, model
 *   GET|POST /host/openwop-app/connections/:id/senders             approved + pending senders; approve one
 *   PUT      /host/openwop-app/connections/:id/senders/:senderId/self   the owner marks their own account (D9)
 *   DELETE   /host/openwop-app/connections/:id/senders/:senderId   revoke an approval
 *   DELETE   /host/openwop-app/connections/:id/senders/:senderId/pending   deny a pending request (CHAN-P0-8)
 *   (GET /senders marks each approval `mine` when the caller is its owner; CHAN-P0-8)
 *   GET|PUT  /host/openwop-app/messaging/relay/:relayId/channel    a relay lane's agent, model and own account (ADR 1043 D3)
 *   GET|POST /host/openwop-app/messaging/relay/:relayId/senders    a device's approved + pending senders; approve (ADR 1043 D9)
 *   DELETE   /host/openwop-app/messaging/relay/:relayId/senders/:senderId[/pending]   revoke / deny (ADR 1043 D9)
 *
 * ADR 1043 D9 (CHAN-P1b, "Per-device, owner approves") — a relay device's peers are
 * approved by the device's OWNER, for that device only, in the same sender and
 * pending stores keyed by the device's lane. A workspace admin may list the
 * approved senders and revoke one; only the owner approves, denies or sees pending.
 *
 * The SAME predicate as every other per-connection route (`authorizeManage`:
 * owner for a personal row, `host:connections:manage` for an org or workspace
 * row) plus a workspace write for every change. 404 unless `channel-ingress`
 * is on. Approving a sender makes the APPROVER that sender's paired owner: the
 * sender's messages become turns in the approver's main chat, run as them.
 *
 * ADR 1043 D3 — the relay lane's route shares this access shape: the same
 * feature check, the same workspace write for a change, and ONE owner predicate.
 * A relay device is personal, so only its owner manages it (the rule
 * `authorizeManage` applies to a personal connection). Both PUT routes validate
 * the body with `parseSettingsBody`, so the two cannot drift.
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, requireTenantWrite, tenantOf } from '../featureRoute.js';
import { getConnection } from '../connections/connectionsService.js';
import { authorizeManage } from '../connections/routes.js';
import { getAgentRegistry } from '../../executor/agentRegistry.js';
import type { Storage } from '../../storage/storage.js';
import { isRelayWorkspaceAdmin, optionalAccountId } from '../../routes/messaging.js';
import { getRelayOwnerRecord, setRelayOwnerAccountId } from '../../messaging/relayOwner.js';
import {
  approveSender, dismissPendingSender, getApprovedSender, getChannelSettings, laneKeyOf, listApprovedSenders, listPendingSenders, putChannelSettings, revokeSender, setSenderSelf, type ChannelSettings,
} from './stores.js';

export const CHANNEL_INGRESS_TOGGLE = 'channel-ingress';
const C = '/host/openwop-app/connections/:id';
const SENDER_RE = /^(group:)?-?[A-Za-z0-9_.:+@-]{1,128}$/;
const HANDLE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MODEL_RE = /^[A-Za-z0-9_.:/-]{1,128}$/;

const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

async function managedConnection(req: Request) {
  await requireFeatureEnabled(req, CHANNEL_INGRESS_TOGGLE, 'Channels into chat');
  const existing = await getConnection(tenantOf(req), req.params.id);
  if (!existing) throw new OpenwopError('not_found', 'Connection not found.', 404, { connectionId: req.params.id });
  await authorizeManage(req, existing);
  return { existing, laneKey: laneKeyOf({ kind: 'connection', connectionId: existing.connectionId, provider: existing.provider }) };
}

/** ADR 1043 D3 — the relay lane's managed device: feature on, same tenant, and the caller owns it. */
async function managedRelay(req: Request, storage: Storage) {
  await requireFeatureEnabled(req, CHANNEL_INGRESS_TOGGLE, 'Channels into chat');
  const tenantId = tenantOf(req);
  const device = await storage.getRelayDevice(req.params.relayId);
  if (!device || device.tenantId !== tenantId || device.status === 'revoked') {
    throw new OpenwopError('not_found', 'Relay not found.', 404, { relayId: req.params.relayId });
  }
  const owner = await getRelayOwnerRecord(device.relayId, tenantId);
  if (!owner || owner.ownerUserId !== actingUserOf(req)) {
    throw new OpenwopError('forbidden', 'Only the person who activated this relay can manage it.', 403);
  }
  return { device, owner, laneKey: laneKeyOf({ kind: 'relay', relayId: device.relayId, channel: device.channel }) };
}

/**
 * ADR 1043 D9 (CHAN-P1b) — a relay device's peers. Feature on, same tenant, not
 * revoked (404 otherwise, as `managedRelay`). Says whether the caller is the
 * device's owner (approve, deny, list pending) or a workspace admin (list approved,
 * revoke). Never both read from the tenant-wide relay allowlist.
 */
async function relayPeersAccess(req: Request, storage: Storage) {
  await requireFeatureEnabled(req, CHANNEL_INGRESS_TOGGLE, 'Channels into chat');
  const tenantId = tenantOf(req);
  const device = await storage.getRelayDevice(req.params.relayId);
  if (!device || device.tenantId !== tenantId || device.status === 'revoked') {
    throw new OpenwopError('not_found', 'Relay not found.', 404, { relayId: req.params.relayId });
  }
  const owner = await getRelayOwnerRecord(device.relayId, tenantId);
  const caller = actingUserOf(req);
  const isOwner = !!owner && caller !== undefined && owner.ownerUserId === caller;
  const isAdmin = isOwner ? false : await isRelayWorkspaceAdmin(req);
  return { device, owner, isOwner, isAdmin, laneKey: laneKeyOf({ kind: 'relay', relayId: device.relayId, channel: device.channel }) };
}

/**
 * ADR 1042 D9 / ADR 1043 D9 — every member of an approved group acts with the
 * approver's authority, so the approver must say they understand that before a
 * group is approved. ONE check for both lanes (hosted and relay), server-side.
 */
function requireGroupAcknowledged(senderId: string, body: Record<string, unknown>): void {
  if (senderId.startsWith('group:') && body.groupAcknowledged !== true) {
    throw new OpenwopError('validation_error', 'Approving a group needs `groupAcknowledged: true`: every member acts with your authority.', 400, { field: 'groupAcknowledged', reason: 'group_ack_required' });
  }
}

const ownerOnly = (): OpenwopError =>
  new OpenwopError('forbidden', 'Only the person who activated this relay can manage who may write to it.', 403, { reason: 'relay_peers_owner_only' });

/** One validator for both lanes' settings (agent resolves here; provider and model match one pattern). */
async function parseSettingsBody(req: Request, laneKey: string): Promise<ChannelSettings> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const tenantId = tenantOf(req);
  const agentId = optional(body, 'agentId', /^[A-Za-z0-9_.:-]{1,200}$/);
  // The agent must be one THIS workspace can run (an unknown or foreign id is one 400).
  if (agentId && !(await getAgentRegistry().resolve(agentId, tenantId).catch(() => null))) {
    throw new OpenwopError('validation_error', `Agent '${agentId}' was not found in this workspace.`, 400, { field: 'agentId' });
  }
  const botHandle = optional(body, 'botHandle', HANDLE_RE, (v) => v.replace(/^@/, ''));
  const provider = optional(body, 'provider', MODEL_RE);
  const model = optional(body, 'model', MODEL_RE);
  return {
    laneKey, tenantId,
    ...(agentId ? { agentId } : {}), ...(botHandle ? { botHandle } : {}),
    ...(provider ? { provider } : {}), ...(model ? { model } : {}),
    updatedAt: new Date().toISOString(),
  };
}

function optional(body: Record<string, unknown>, key: string, re: RegExp, transform: (v: string) => string = (v) => v): string | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  const v = typeof raw === 'string' ? transform(raw.trim()) : '';
  if (!re.test(v)) throw new OpenwopError('validation_error', `\`${key}\` is not valid.`, 400, { field: key });
  return v;
}

export function registerChannelIngressRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const wrap = (h: (req: Request, res: import('express').Response) => Promise<void>) =>
    async (req: Request, res: import('express').Response, next: import('express').NextFunction) => {
      try { await h(req, res); } catch (err) { next(err); }
    };

  app.get(`${C}/channel`, wrap(async (req, res) => {
    const { laneKey } = await managedConnection(req);
    res.json({ settings: await getChannelSettings(laneKey) });
  }));

  app.put(`${C}/channel`, wrap(async (req, res) => {
    const { laneKey } = await managedConnection(req);
    await requireTenantWrite(req);
    const settings = await parseSettingsBody(req, laneKey);
    await putChannelSettings(settings);
    res.json({ settings });
  }));

  // ADR 1043 D3 — a relay lane's agent and model (the gap ADR 1042 left open), and
  // the self lane's own account id. A bot handle means nothing on a personal account.
  const R = '/host/openwop-app/messaging/relay/:relayId/channel';
  app.get(R, wrap(async (req, res) => {
    const { laneKey, owner } = await managedRelay(req, deps.storage);
    res.json({ settings: await getChannelSettings(laneKey), ...(owner.ownerAccountId ? { accountId: owner.ownerAccountId } : {}) });
  }));

  app.put(R, wrap(async (req, res) => {
    const { device, laneKey } = await managedRelay(req, deps.storage);
    await requireTenantWrite(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.botHandle !== undefined) throw new OpenwopError('validation_error', 'A relay lane has no bot handle.', 400, { field: 'botHandle' });
    const settings = await parseSettingsBody(req, laneKey);
    await putChannelSettings(settings);
    let accountId: string | undefined;
    if (body.accountId !== undefined) {
      accountId = body.accountId === null || body.accountId === '' ? undefined : optionalAccountId(body.accountId);
      await setRelayOwnerAccountId(device.relayId, device.tenantId, accountId);
    } else {
      accountId = (await getRelayOwnerRecord(device.relayId, device.tenantId))?.ownerAccountId;
    }
    res.json({ settings, ...(accountId ? { accountId } : {}) });
  }));

  // ADR 1043 D9 (CHAN-P1b) — a relay device's approved and pending senders, keyed by
  // the device's lane. The OWNER lists, approves and denies; a workspace admin may
  // list the approved senders and revoke one. Nobody else.
  const RS = '/host/openwop-app/messaging/relay/:relayId/senders';
  app.get(RS, wrap(async (req, res) => {
    const { isOwner, isAdmin, laneKey } = await relayPeersAccess(req, deps.storage);
    if (!isOwner && !isAdmin) throw ownerOnly();
    const caller = actingUserOf(req);
    const approved = (await listApprovedSenders(tenantOf(req), laneKey)).map((s) => ({ ...s, mine: caller !== undefined && caller === s.ownerUserId }));
    // A stranger's pending request is the owner's business; an admin needs only what they can revoke.
    res.json({ approved, pending: isOwner ? await listPendingSenders(tenantOf(req), laneKey) : [], canApprove: isOwner });
  }));

  app.post(RS, wrap(async (req, res) => {
    const { isOwner, owner, laneKey } = await relayPeersAccess(req, deps.storage);
    if (!isOwner || !owner) throw ownerOnly();
    await requireTenantWrite(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const senderId = typeof body.senderId === 'string' ? body.senderId.trim() : '';
    if (!SENDER_RE.test(senderId)) throw new OpenwopError('validation_error', '`senderId` MUST be a platform user id or `group:<chatId>`.', 400, { field: 'senderId' });
    requireGroupAcknowledged(senderId, body);
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : undefined;
    const row = await approveSender({
      tenantId: tenantOf(req), laneKey, senderId, ownerUserId: owner.ownerUserId,
      ...(owner.ownerPersonalTenant ? { ownerPersonalTenant: owner.ownerPersonalTenant } : {}), ...(label ? { label } : {}),
    });
    res.status(201).json({ sender: { ...row, mine: true } });
  }));

  app.delete(`${RS}/:senderId/pending`, wrap(async (req, res) => {
    const { isOwner, laneKey } = await relayPeersAccess(req, deps.storage);
    if (!isOwner) throw ownerOnly();
    await requireTenantWrite(req);
    await dismissPendingSender(tenantOf(req), laneKey, req.params.senderId);
    res.status(204).end();
  }));

  app.delete(`${RS}/:senderId`, wrap(async (req, res) => {
    const { isOwner, isAdmin, laneKey } = await relayPeersAccess(req, deps.storage);
    if (!isOwner && !isAdmin) throw ownerOnly();
    await requireTenantWrite(req);
    await revokeSender(laneKey, req.params.senderId);
    res.status(204).end();
  }));

  app.get(`${C}/senders`, wrap(async (req, res) => {
    const { laneKey } = await managedConnection(req);
    const tenantId = tenantOf(req);
    // CHAN-P0-8 — `mine`: the caller is this approval's owner, the one person the
    // self route below lets mark it. Derived here with the SAME comparison that
    // route makes, so the settings page never guesses who the caller is.
    const caller = actingUserOf(req);
    const approved = (await listApprovedSenders(tenantId, laneKey)).map((s) => ({ ...s, mine: caller !== undefined && caller === s.ownerUserId }));
    res.json({ approved, pending: await listPendingSenders(tenantId, laneKey) });
  }));

  app.post(`${C}/senders`, wrap(async (req, res) => {
    const { laneKey } = await managedConnection(req);
    await requireTenantWrite(req);
    const owner = actingUserOf(req);
    // The approver becomes the paired owner; no signed-in person, no owner.
    if (!owner) throw new OpenwopError('unauthenticated', 'Sign in to approve a sender.', 401);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const senderId = typeof body.senderId === 'string' ? body.senderId.trim() : '';
    if (!SENDER_RE.test(senderId)) throw new OpenwopError('validation_error', '`senderId` MUST be a platform user id or `group:<chatId>`.', 400, { field: 'senderId' });
    requireGroupAcknowledged(senderId, body);
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : undefined;
    // The approver's own personal workspace, so presence (M4) holds there without a member row.
    const row = await approveSender({ tenantId: tenantOf(req), laneKey, senderId, ownerUserId: owner, ...(req.personalTenant ? { ownerPersonalTenant: req.personalTenant } : {}), ...(label ? { label } : {}) });
    res.status(201).json({ sender: row });
  }));

  // ADR 1042 D9 — "this sender is my own account": only the approval's OWNER may say
  // so (a workspace write, or managing the connection, is not enough), never for a
  // group, and at most one per owner per lane (marking one clears the others).
  app.put(`${C}/senders/:senderId/self`, wrap(async (req, res) => {
    const { laneKey } = await managedConnection(req);
    await requireTenantWrite(req);
    const senderId = req.params.senderId;
    if (senderId.startsWith('group:')) throw new OpenwopError('validation_error', 'A group is never anyone\'s own account.', 400, { field: 'senderId' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.self !== 'boolean') throw new OpenwopError('validation_error', '`self` MUST be a boolean.', 400, { field: 'self' });
    const row = await getApprovedSender(laneKey, senderId);
    if (!row || row.tenantId !== tenantOf(req)) throw new OpenwopError('not_found', 'Sender not found.', 404);
    if (actingUserOf(req) !== row.ownerUserId) {
      throw new OpenwopError('forbidden', 'Only the person who approved this sender can mark it as their own account.', 403);
    }
    res.json({ sender: await setSenderSelf(tenantOf(req), laneKey, senderId, body.self) });
  }));

  // CHAN-P0-8 — deny a pending request. The sender was already blocked (default
  // deny); this removes the request from the review list. Same gates as revoke.
  app.delete(`${C}/senders/:senderId/pending`, wrap(async (req, res) => {
    const { laneKey } = await managedConnection(req);
    await requireTenantWrite(req);
    await dismissPendingSender(tenantOf(req), laneKey, req.params.senderId);
    res.status(204).end();
  }));

  app.delete(`${C}/senders/:senderId`, wrap(async (req, res) => {
    const { laneKey } = await managedConnection(req);
    await requireTenantWrite(req);
    await revokeSender(laneKey, req.params.senderId);
    res.status(204).end();
  }));
}
