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
import { authorizeOrgScope, requireString } from '../featureRoute.js';
import { getAttestation, recordNoTrainAttestation, revokeAttestation } from './compliance.js';
import { readWhatsAppHealth } from './health.js';
import { OpenwopError } from '../../types.js';

const FEATURE = { toggleId: 'whatsapp', label: 'WhatsApp' };
const BASE = '/v1/host/openwop-app/whatsapp/orgs/:orgId/attestation';

export function registerWhatsAppRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(BASE, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const attestation = await getAttestation(tenantId);
      res.json({
        attested: attestation !== null,
        ...(attestation ? { attestedBy: attestation.attestedBy, attestedAt: attestation.attestedAt } : {}),
      });
    } catch (err) { next(err); }
  });

  app.put(BASE, async (req, res, next) => {
    try {
      const { user, tenantId } = await authorizeOrgScope(req, FEATURE, 'host:whatsapp:manage');
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
      const attestation = await recordNoTrainAttestation(tenantId, user.userId);
      res.status(201).json({ attested: true, attestedBy: attestation.attestedBy, attestedAt: attestation.attestedAt });
    } catch (err) { next(err); }
  });

  app.delete(BASE, async (req, res, next) => {
    try {
      const { tenantId } = await authorizeOrgScope(req, FEATURE, 'host:whatsapp:manage');
      const removed = await revokeAttestation(tenantId);
      if (!removed) throw new OpenwopError('not_found', 'No attestation is recorded for this workspace.', 404);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── Phase 3 — enforcement-awareness health (workspace:read) ──────────────
  // GET …/whatsapp/orgs/:orgId/health?connectionId=… — binding + attestation +
  // the bound sender's BSP quality rating / messaging tier + the documented
  // enforcement ladder. A degraded read raises `openwop-app.whatsapp.health-degraded`.
  app.get('/v1/host/openwop-app/whatsapp/orgs/:orgId/health', async (req, res, next) => {
    try {
      const { user, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      const connectionId = requireString(req.query.connectionId, 'connectionId');
      const health = await readWhatsAppHealth(
        { storage: deps.storage, tenantId, runId: `whatsapp-health:${connectionId}`, actingUserId: user.userId },
        connectionId,
      );
      res.json(health);
    } catch (err) { next(err); }
  });
}
