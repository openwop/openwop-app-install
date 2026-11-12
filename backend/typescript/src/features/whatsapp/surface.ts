/**
 * WhatsApp workflow surface (ADR 0394 P1) — `ctx.features.whatsapp` for the
 * `feature.whatsapp.nodes.send` pack node. A THIN pass-through: every gate
 * (toggle, binding, consent, 24h window, idempotency) lives in
 * `whatsappService.sendWhatsApp` — the service layer the capability firewall
 * can rely on, since it cannot see node calls. A gate failure surfaces as a
 * TYPED node failure (`OpenwopError`), never success-with-empty.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { OpenwopError } from '../../types.js';
import { sendWhatsApp, getBoundWhatsAppStorage, getDeliveryStatus, type WaSendError } from './whatsappService.js';

/** ADR 1053 D7 — a send is a paid write to a real person: the run's person (actor,
 *  else causing member) must hold `workspace:write` in the tenant (ADR 0837). A run
 *  with no person is not checked (ADR 0832); after D2 it can reach only a
 *  WORKSPACE connection. The service-desk and channel reply lanes call the service
 *  directly and are governed there. */
export const WHATSAPP_SURFACE_POLICY = {
  tenantMethodScopes: { send: 'workspace:write', deliveryStatus: 'workspace:read' },
} as const;

/** Every typed send failure → its HTTP-class status (no default to 502: a new
 *  code must be mapped here or fail to compile). */
const SEND_ERROR_STATUS: Record<WaSendError, number> = {
  feature_disabled: 404,
  validation_error: 400,
  consent_denied: 403,
  opted_out: 403,
  subject_erased: 403,
  outside_window: 409,
  no_binding: 409,
  send_in_flight: 409,
  send_outcome_unknown: 409,
  wa_not_connected: 424,
  wa_request_failed: 502,
  wa_rejected: 502,
};

export function buildWhatsAppSurface(scope: BundleScope): FeatureSurface {
  return {
    // send({ connectionId, to, body? | templateId? (+templateVariables?) })
    //   → { sent: true, providerSid, kind, deduped }
    send: async (args) => {
      const connectionId = str(args.connectionId);
      const to = str(args.to);
      const templateVariables =
        args.templateVariables && typeof args.templateVariables === 'object' && !Array.isArray(args.templateVariables)
          ? Object.fromEntries(Object.entries(args.templateVariables as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
          : undefined;
      const storage = getBoundWhatsAppStorage();
      if (!storage) {
        throw new OpenwopError('invalid_request', 'The WhatsApp channel is not initialized on this host.', 503);
      }
      const result = await sendWhatsApp(
        {
          storage,
          tenantId: scope.tenantId,
          runId: scope.runId ?? `whatsapp:${scope.tenantId}`,
          ...(scope.actingUserId ? { actingUserId: scope.actingUserId } : {}),
        },
        {
          connectionId,
          to,
          body: optStr(args.body),
          templateId: optStr(args.templateId),
          languageCode: optStr(args.languageCode),
          ...(templateVariables ? { templateVariables } : {}),
        },
      );
      if (!result.sent) {
        throw new OpenwopError(
          result.error === 'wa_not_connected' ? 'credential_unavailable' : result.error === 'validation_error' ? 'validation_error' : 'invalid_request',
          result.message,
          SEND_ERROR_STATUS[result.error],
          { whatsappError: result.error, ...(result.detail ?? {}) },
        );
      }
      // ADR 1053 D3 — `accepted` is what a send knows; `sent` stays as its alias.
      return { sent: true, accepted: true, providerSid: result.providerSid, kind: result.kind, deduped: result.deduped, deliveryStatus: result.deliveryStatus };
    },
    // deliveryStatus({ connectionId, providerSid }) → { providerSid, connectionId, kind, status, errorCode, updatedAt }
    // ADR 1053 D3 — written only from verified provider callbacks; an unknown id is
    // a typed not_found, never a fabricated `accepted`.
    deliveryStatus: async (args) => {
      const connectionId = str(args.connectionId);
      const providerSid = str(args.providerSid);
      if (!connectionId) throw new OpenwopError('validation_error', '`connectionId` is required (the connection the message was sent on).', 400, { field: 'connectionId' });
      if (!providerSid) throw new OpenwopError('validation_error', '`providerSid` is required.', 400, { field: 'providerSid' });
      const status = await getDeliveryStatus(scope.tenantId, connectionId, providerSid);
      if (!status) throw new OpenwopError('not_found', 'No WhatsApp message with this id was sent from this workspace.', 404);
      return { ...status };
    },
  };
}
