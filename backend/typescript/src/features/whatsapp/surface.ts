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
import { sendWhatsApp, getBoundWhatsAppStorage } from './whatsappService.js';

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
        const status =
          result.error === 'feature_disabled' ? 404
          : result.error === 'validation_error' ? 400
          : result.error === 'consent_denied' ? 403
          : result.error === 'outside_window' ? 409
          : result.error === 'no_binding' ? 409
          : result.error === 'wa_not_connected' ? 424
          : 502;
        throw new OpenwopError(
          result.error === 'wa_not_connected' ? 'credential_unavailable' : result.error === 'validation_error' ? 'validation_error' : 'invalid_request',
          result.message,
          status,
          { whatsappError: result.error, ...(result.detail ?? {}) },
        );
      }
      return { sent: true, providerSid: result.providerSid, kind: result.kind, deduped: result.deduped };
    },
  };
}
