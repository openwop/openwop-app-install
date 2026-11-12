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
import { buildWhatsAppSurface, WHATSAPP_SURFACE_POLICY } from './surface.js';
import { bindWhatsAppStorage, recordInboundMessage, extractWaInbound, eraseWhatsAppSubject, cleanupWhatsAppConnection, claimInboundMessage, extractWaStatuses, recordDeliveryStatus } from './whatsappService.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { onConnectionRevoked } from '../../host/connectionLifecycle.js';
import { registerInboundObserver, registerInboundGate, registerInboundStatusObserver } from '../connections/inboundWebhooks.js';
import { getConnection } from '../connections/connectionsService.js';
import { createLogger } from '../../observability/logger.js';
import { applyInboundKeyword, whatsappDispatchAllowed } from './compliance.js';
import { registerWhatsAppRoutes } from './routes.js';
import { sendWhatsApp } from './whatsappService.js';
import { registerReplyTransport, type ChannelReply, type ReplyTransportResult } from '../connections/messagingOutbound.js';

const log = createLogger('features.whatsapp');

export const whatsappFeature: BackendFeature = {
  id: 'whatsapp',
  surface: { id: 'whatsapp', build: buildWhatsAppSurface, orgPolicy: WHATSAPP_SURFACE_POLICY },
  // No routes in Phase 1 — registration binds the storage handle the workflow
  // surface's brokered egress needs (the initHostExtPersistence lifecycle) and
  // the verified-inbound observer that opens/renews the 24h window ledger.
  registerRoutes: (deps) => {
    bindWhatsAppStorage(deps.storage);
    // Both BSP transports feed the same window ledger + keyword ladder; the
    // extractor normalizes each provider's envelope — EVERY message in a Cloud
    // batch is processed (a STOP as message 2+ counts).
    //
    // ADR 1053 D4 — each message id is CLAIMED before its side effects, so a
    // replayed signed delivery (Twilio signs no timestamp) or a BSP redelivery
    // does nothing the second time. D5 — STRICT: a failed write releases the
    // claim and propagates, the route answers 5xx and the BSP redelivers (an
    // opt-out that could not be written must never be acked). D4a — a START is
    // applied only from an org/workspace connection, whose inbound config only an
    // admin can set; a STOP from any connection.
    const onInbound = async ({ tenantId, connectionId, body, now }: { tenantId: string; connectionId: string; body: Record<string, unknown>; now: number }): Promise<void> => {
      const messages = extractWaInbound(body);
      if (messages.length === 0) return;
      const connection = await getConnection(tenantId, connectionId);
      const axis: 'user' | 'org' | 'workspace' = connection?.userId ? 'user' : connection?.orgId ? 'org' : 'workspace';
      const optInAllowed = connection !== null && axis !== 'user';
      for (const msg of messages) {
        if (!msg.id) { log.info('whatsapp_inbound_without_id', { tenantId, connectionId }); continue; }
        const claim = await claimInboundMessage(tenantId, connectionId, msg.id);
        if (!claim.owned) continue;
        try {
          // D6 — the provider's own time when it sends one, never later than now.
          const at = msg.at && msg.at.getTime() < now ? msg.at : new Date(now);
          await recordInboundMessage(tenantId, connectionId, msg.from, at);
          // Phase 2 — the STOP/START keyword ladder (immediate, fail-closed).
          await applyInboundKeyword(tenantId, msg.from, msg.text, { optInAllowed, connectionId, axis });
          await claim.complete();
        } catch (err) {
          await claim.release();
          throw err;
        }
      }
    };
    registerInboundObserver('whatsapp-twilio', onInbound, { strict: true });
    registerInboundObserver('whatsapp-cloud', onInbound, { strict: true });
    // ADR 1053 D3 — delivery truth, from verified callbacks on the sending connection only.
    const onStatus = async ({ tenantId, connectionId, body }: { tenantId: string; connectionId: string; body: Record<string, unknown> }): Promise<void> => {
      for (const update of extractWaStatuses(body)) await recordDeliveryStatus(tenantId, connectionId, update);
    };
    registerInboundStatusObserver('whatsapp-twilio', onStatus);
    registerInboundStatusObserver('whatsapp-cloud', onStatus);
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
    // ADR 1042 D4 — a channel REPLY on WhatsApp rides the one governed send
    // (toggle, binding, STRICT explicit opt-in, the 24h window, idempotency keyed
    // on the inbound message id). A customer who never opted in gets nothing
    // (`consent_denied`) — a conversational reply lane is a P2c user decision.
    const waReply = async (reply: ChannelReply): Promise<ReplyTransportResult> => {
      if (reply.lane.kind !== 'connection') return { sent: false, error: 'wrong_lane' };
      const r = await sendWhatsApp(
        { storage: deps.storage, tenantId: reply.tenantId, runId: `channel-reply:${reply.inboundMessageId}`, actingUserId: reply.actingUserId },
        { connectionId: reply.lane.connectionId, to: reply.chatId, body: reply.text.slice(0, 4096), idempotencyKey: `channel-reply:${reply.inboundMessageId}` },
      );
      return r.sent ? { sent: true, providerRef: r.providerSid ?? '' } : { sent: false, error: r.error };
    };
    registerReplyTransport('whatsapp-twilio', waReply);
    registerReplyTransport('whatsapp-cloud', waReply);
  },
  toggleDefault: {
    id: 'whatsapp',
    label: 'WhatsApp (official BSP)',
    description:
      'WhatsApp business messaging through the official Business Solution Provider channel (Twilio BSP). '
      + 'Inbound customer messages start or resume workflows; outbound sends are compliance-gated — explicit '
      + 'per-number opt-in, the 24-hour customer-service window, pre-approved templates outside it, and '
      + 'fork-stable send idempotency. Enabling accepts Meta’s Business Solution Terms.',
    category: 'Integrations',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'whatsapp',
  },
  requiredPacks: [
    'feature.whatsapp.nodes', // ADR 0394 P1 — the governed whatsapp.send node
    'vendor.openwop-app.whatsapp.agents', // ADR 0394 P2 — the scoped customer-service persona (Meta primary-functionality ban)
  ],
};
