/**
 * WhatsApp compliance routes (ADR 0394 Phase 2) — host-extension,
 * non-normative. The tenant-admin surface for the no-training attestation:
 *
 *   GET    …/whatsapp/orgs/:orgId/attestation  — status (workspace:read)
 *   PUT    …/whatsapp/orgs/:orgId/attestation  — record (host:whatsapp:manage)
 *   DELETE …/whatsapp/orgs/:orgId/attestation  — revoke (host:whatsapp:manage)
 *
 * Recording the attestation is what lets verified inbound WhatsApp messages
 * fire AI workflows (the `registerInboundGate` fail-closed dispatch gate).
 * Admin-only (`host:whatsapp:manage`, reserved to built-in admin/owner): the
 * attestation is a Meta-facing compliance statement for the whole tenant.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import type { Request } from 'express';
import { requireFeatureEnabled, requireString, tenantOf } from '../featureRoute.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { listTenantMembers } from '../../host/accessControlService.js';
import { getAttestation, recordNoTrainAttestation, revokeAttestation, type WaAttestation } from './compliance.js';
import { readWhatsAppHealth } from './health.js';
import { listDeliveryFailures } from './whatsappService.js';
import { listCallerConnections, requireScopeAtOrg } from '../connections/routes.js';
import { getPairing } from '../connections/messagingOutbound.js';
import { getInboundConfig } from '../connections/inboundWebhooks.js';
import { OpenwopError } from '../../types.js';

const FEATURE = { toggleId: 'whatsapp', label: 'WhatsApp' };
const MANAGE = 'host:whatsapp:manage' as const;

/**
 * ADR 1053 D10 (grade-code WA85CD-15, grade-ux WA85UX-15) — every WhatsApp
 * setting is TENANT-wide, so every route is addressed at the WORKSPACE ROOT
 * (`:orgId === tenantId`) and its scope is judged THERE, exactly as
 * `requireConnectionsManage` judges a workspace connection. Not the tenant-wide
 * union: that tier is "admin of ANY org", so a sub-org admin could attest or
 * revoke for every org, or read every org's failures (the row-31 / BI84WF-11
 * finding). A different org in the path is a 404 naming the rule.
 */
async function authorizeRoot(req: Request, scope: 'workspace:read' | typeof MANAGE): Promise<{ userId: string; tenantId: string }> {
  await requireFeatureEnabled(req, FEATURE.toggleId, FEATURE.label);
  const tenantId = tenantOf(req);
  if (req.params.orgId !== tenantId) {
    throw new OpenwopError('not_found', 'WhatsApp settings belong to the whole workspace: address them at the workspace root (orgs/<workspace id>).', 404, { reason: 'not_workspace_root' });
  }
  await requireScopeAtOrg(req, tenantId, scope);
  return { userId: (await resolveCallerUser(req)).userId, tenantId };
}

async function holdsRootManage(req: Request, tenantId: string): Promise<boolean> {
  try { await requireScopeAtOrg(req, tenantId, MANAGE); return true; } catch { return false; }
}

/** The attestation as every route returns it (WA85UX-11: PUT answers the GET's
 *  shape, so the page never loses `canManage` after acting). The attester is named
 *  from THIS tenant's member roster (WA85UX-12: a shared `ws:` member's own user row
 *  lives in their home tenant), never from another tenant's records. */
async function attestationView(req: Request, tenantId: string, attestation: WaAttestation | null): Promise<Record<string, unknown>> {
  const member = attestation
    ? (await listTenantMembers(tenantId).catch(() => [])).find((m) => m.subject === attestation.attestedBy && m.displayName)
    : undefined;
  return {
    attested: attestation !== null,
    canManage: await holdsRootManage(req, tenantId),
    ...(attestation ? { attestedBy: attestation.attestedBy, attestedAt: attestation.attestedAt } : {}),
    ...(member ? { attestedByName: member.displayName } : {}),
  };
}
const BASE = '/host/openwop-app/whatsapp/orgs/:orgId/attestation';

export function registerWhatsAppRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(BASE, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeRoot(req, 'workspace:read');
      res.json(await attestationView(req, tenantId, await getAttestation(tenantId)));
    } catch (err) { next(err); }
  });

  app.put(BASE, async (req, res, next) => {
    try {
      const { userId, tenantId } = await authorizeRoot(req, MANAGE);
      const body = (req.body ?? {}) as Record<string, unknown>;
      // The explicit confirmation is the point — no silent one-click attest.
      if (body.confirmNoTraining !== true) {
        throw new OpenwopError(
          'validation_error',
          'Pass `confirmNoTraining: true` to attest that no LLM provider used with WhatsApp data trains on it (zero-retention / training disabled).',
          400,
          { field: 'confirmNoTraining' },
        );
      }
      const attestation = await recordNoTrainAttestation(tenantId, userId);
      res.status(201).json(await attestationView(req, tenantId, attestation));
    } catch (err) { next(err); }
  });

  app.delete(BASE, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeRoot(req, MANAGE);
      const removed = await revokeAttestation(tenantId);
      if (!removed) throw new OpenwopError('not_found', 'No attestation is recorded for this workspace.', 404);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── ADR 1053 D10 — the settings page's reads ─────────────────────────────
  // GET …/whatsapp/orgs/:orgId/connections — the connections the caller can see
  // (the ONE reader `GET /connections` uses) that carry a WhatsApp sender
  // binding, with the facts that decide what they can do: the scope axis (a
  // personal row sends only for its owner and cannot grant START) and whether
  // inbound is configured (status callbacks and the 24h window need it).
  app.get('/host/openwop-app/whatsapp/orgs/:orgId/connections', async (req, res, next) => {
    try {
      const { tenantId } = await authorizeRoot(req, 'workspace:read');
      const out: Array<Record<string, unknown>> = [];
      for (const c of await listCallerConnections(req)) {
        if (c.provider !== 'twilio' && c.provider !== 'whatsapp-cloud') continue;
        const pairing = await getPairing(c.connectionId);
        if (!pairing || (pairing.provider !== 'whatsapp-twilio' && pairing.provider !== 'whatsapp-cloud')) continue;
        const inbound = await getInboundConfig(tenantId, c.connectionId);
        const inboundForWa = inbound !== null && (inbound.provider === 'whatsapp-twilio' || inbound.provider === 'whatsapp-cloud');
        out.push({
          connectionId: c.connectionId,
          displayName: c.displayName,
          transport: pairing.provider,
          sender: pairing.channelId,
          axis: c.userId ? 'user' : c.orgId ? 'org' : 'workspace',
          status: c.status,
          inbound: inboundForWa ? (inbound!.enabled ? 'enabled' : 'disabled') : 'none',
        });
      }
      res.json({ connections: out });
    } catch (err) { next(err); }
  });

  // GET …/whatsapp/orgs/:orgId/delivery-failures — recent provider-reported
  // failures (last four digits only). Admin-only: who was messaged is customer data.
  app.get('/host/openwop-app/whatsapp/orgs/:orgId/delivery-failures', async (req, res, next) => {
    try {
      const { tenantId } = await authorizeRoot(req, MANAGE);
      const rows = await listDeliveryFailures(tenantId);
      res.json({ failures: rows.map(({ id: _id, tenantId: _t, ...rest }) => rest) });
    } catch (err) { next(err); }
  });

  // ── Phase 3 — enforcement-awareness health (workspace:read) ──────────────
  // GET …/whatsapp/orgs/:orgId/health?connectionId=… — binding + attestation +
  // the bound sender's BSP quality rating / messaging tier + the documented
  // enforcement ladder. A degraded read raises `openwop-app.whatsapp.health-degraded`.
  app.get('/host/openwop-app/whatsapp/orgs/:orgId/health', async (req, res, next) => {
    try {
      const { userId, tenantId } = await authorizeRoot(req, 'workspace:read');
      const connectionId = requireString(req.query.connectionId, 'connectionId');
      const health = await readWhatsAppHealth(
        { storage: deps.storage, tenantId, runId: `whatsapp-health:${connectionId}`, actingUserId: userId },
        connectionId,
      );
      res.json(health);
    } catch (err) { next(err); }
  });
}
