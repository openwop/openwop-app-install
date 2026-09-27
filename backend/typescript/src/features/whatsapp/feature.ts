/**
 * WhatsApp BSP channel (ADR 0394) — the OFFICIAL Business-Solution-Provider
 * lane (Twilio BSP first; Meta Cloud API in a later phase) on the ADR 0175
 * messaging-gateway seam. This package owns ONLY the compliance surface: the
 * gated send service (`whatsappService.ts` — consent + 24h window + template
 * discipline + fork-stable idempotency) and the `ctx.features.whatsapp`
 * workflow surface the `feature.whatsapp.nodes` pack calls. Inbound rides
 * `features/connections/inboundWebhooks.ts` (`whatsapp-twilio` provider);
 * number binding rides `pairConnection`; credentials ride the EXISTING
 * `twilio` connection.
 *
 * Distinct from the demo messaging RELAY gateway (`src/messaging/`,
 * `routes/messaging.ts`): the relay is a self-hosted device lane (the
 * operator's own CLI owns the platform connection); THIS is the compliant
 * server-side SaaS lane. They share nothing and must not — recorded as an
 * ADR 0394 boundary correction note.
 *
 * Toggle OFF by default: enabling WhatsApp means accepting Meta's BSP terms
 * (a compliance + billing surface the operator gates independently of the
 * terms-free Slack/Discord/Telegram channels — ADR 0394 matrix row 2).
 */
import type { BackendFeature } from '../types.js';
import { buildWhatsAppSurface } from './surface.js';
import { bindWhatsAppStorage, recordInboundMessage, extractWaInbound, eraseWhatsAppSubject, cleanupWhatsAppConnection } from './whatsappService.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { onConnectionRevoked } from '../../host/connectionLifecycle.js';
import { registerInboundObserver, registerInboundGate } from '../connections/inboundWebhooks.js';
import { applyInboundKeyword, whatsappDispatchAllowed } from './compliance.js';
import { registerWhatsAppRoutes } from './routes.js';

export const whatsappFeature: BackendFeature = {
  id: 'whatsapp',
  surface: { id: 'whatsapp', build: buildWhatsAppSurface },
  // No routes in Phase 1 — registration binds the storage handle the workflow
  // surface's brokered egress needs (the initHostExtPersistence lifecycle) and
  // the verified-inbound observer that opens/renews the 24h window ledger.
  registerRoutes: (deps) => {
    bindWhatsAppStorage(deps.storage);
    // Both BSP transports feed the same window ledger + keyword ladder; the
    // extractor normalizes each provider's envelope to {from, text}[] — EVERY
    // message in a Cloud batch is processed (a STOP as message 2+ counts).
    const onInbound = async ({ tenantId, connectionId, body, now }: { tenantId: string; connectionId: string; body: Record<string, unknown>; now: number }): Promise<void> => {
      for (const msg of extractWaInbound(body)) {
        await recordInboundMessage(tenantId, connectionId, msg.from, new Date(now));
        // Phase 2 — the STOP/START keyword ladder (immediate, fail-closed).
        await applyInboundKeyword(tenantId, msg.from, msg.text);
      }
    };
    registerInboundObserver('whatsapp-twilio', onInbound);
    registerInboundObserver('whatsapp-cloud', onInbound);
    // Phase 2 — the no-training attestation gate: WhatsApp message data never
    // fires an AI workflow for a tenant that has not attested (fail-closed).
    registerInboundGate('whatsapp-twilio', async ({ tenantId }) => whatsappDispatchAllowed(tenantId));
    registerInboundGate('whatsapp-cloud', async ({ tenantId }) => whatsappDispatchAllowed(tenantId));
    // GRADE-DATA 2026-07-17 — a WhatsApp subjectKey is an E.164 phone number:
    // GDPR erasure must purge the conversation/dispatch rows carrying it.
    registerSubjectEraser(eraseWhatsAppSubject);
    // GRADE-DATA 2026-07-17 — a revoked connection drops its number binding +
    // conversation windows (a stale pairing misreported "bound" to health).
    onConnectionRevoked('whatsapp', async ({ tenantId, connectionId }) => {
      await cleanupWhatsAppConnection(tenantId, connectionId);
    });
    registerWhatsAppRoutes(deps);
  },
  toggleDefault: {
    id: 'whatsapp',
    label: 'WhatsApp (official BSP)',
    description:
      'WhatsApp business messaging through the official Business Solution Provider channel (Twilio BSP). '
      + 'Inbound customer messages start or resume workflows; outbound sends are compliance-gated — explicit '
      + 'per-number opt-in, the 24-hour customer-service window, pre-approved templates outside it, and '
      + 'fork-stable send idempotency. OFF by default: enabling accepts Meta’s Business Solution Terms.',
    category: 'Integrations',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'whatsapp',
  },
  requiredPacks: [
    { name: 'feature.whatsapp.nodes', version: '1.0.0' }, // ADR 0394 P1 — the governed whatsapp.send node
    { name: 'feature.whatsapp.agents', version: '1.0.0' }, // ADR 0394 P2 — the scoped customer-service persona (Meta primary-functionality ban)
  ],
};
