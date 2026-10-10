/**
 * Chat-egress adapter — `ctx.messaging.dispatchEgressEnvelope` (ADR 0769), the
 * node-context half of the relay gateway (`routes/messaging.ts`). Consumers:
 * `vendor.myndhyve.entities` `messaging.chatSend` / `messaging.chatReply` and
 * `core.openwop.integration.chat-message-generic`.
 *
 * `ctx.messaging` has ONE owner: this module composes the SMS adapter
 * (`makeMessagingAdapter`), so `sendSms` and `dispatchEgressEnvelope` ride the
 * same object the executor wires.
 *
 * The envelope's `accountId` / `connectorInstanceId` names a relay device. The
 * device must belong to the RUN's tenant and be not revoked; a foreign relay and
 * a missing one fail identically (`connector_not_found`), so a pack cannot probe
 * another tenant's relay ids. The device's channel is authoritative — an
 * envelope naming a different channel fails `channel_mismatch` rather than
 * being delivered somewhere its author did not intend.
 *
 * Dedup (ADR 0619 mechanics): the pack's `idempotencyKey` embeds `Date.now()`,
 * so it differs on every attempt and cannot dedup anything. The host IGNORES it
 * and derives its own over `(runId, nodeId, relayId, conversation, content)` —
 * invariant across a `config.retry` re-run or a same-runId recovery, distinct
 * across runs. A replay `:fork` never reaches here: both send nodes are in the
 * ADR 0341 served set (`MANIFEST_FAST_PATH_SERVED`).
 *
 * Failures are RESULTS (`{ success:false, error }`), never throws — the packs
 * surface `outputs.success`, and the error codes are stable strings.
 */
import { createHash } from 'node:crypto';
import { enqueueOutbound } from '../routes/messaging.js';
import type { ChatEgressEnvelope } from '../messaging/types.js';
import type { BrokeredEgressDeps } from './brokeredEgress.js';
import { egressLedgerKey, priorSend, reserveSend, recordSend, releaseSend } from './egressSentLedger.js';
import { makeSmsAdapter, type SmsAdapter } from './smsAdapter.js';

export interface DispatchEgressArgs {
  envelope: unknown;
  connectorInstanceId?: unknown;
  nodeId?: unknown;
}

export interface DispatchEgressResult {
  success: boolean;
  /** The relay egress id (`egr_…`) the device will pull. */
  messageId?: string;
  relayId?: string;
  /** True when a prior attempt of this (run, node, content) already enqueued it. */
  deduplicated?: boolean;
  error?: string;
}

export interface ChatEgressAdapter {
  dispatchEgressEnvelope(args: DispatchEgressArgs): Promise<DispatchEgressResult>;
}

export type MessagingAdapter = SmsAdapter & ChatEgressAdapter;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The envelope's `content.media` (`{kind, ref}` — or `{url}`) as relay attachments. */
function toAttachments(media: unknown): ChatEgressEnvelope['media'] {
  if (!Array.isArray(media)) return undefined;
  const out = media
    .map((m) => rec(m))
    .map((m) => str(m.ref) ?? str(m.url))
    .filter((url): url is string => url !== undefined)
    .map((url) => ({ url }));
  return out.length > 0 ? out : undefined;
}

export function makeChatEgressAdapter(deps: BrokeredEgressDeps): ChatEgressAdapter {
  return {
    async dispatchEgressEnvelope(args) {
      const envelope = rec(args?.envelope);
      const relayId = str(args?.connectorInstanceId) ?? str(envelope.accountId);
      if (!relayId) return { success: false, error: 'connector_required' };

      const device = await deps.storage.getRelayDevice(relayId);
      if (!device || device.tenantId !== deps.tenantId) return { success: false, error: 'connector_not_found' };
      if (device.status === 'revoked') return { success: false, error: 'connector_revoked' };

      const channel = str(envelope.channel);
      if (channel && channel !== device.channel) return { success: false, error: 'channel_mismatch' };

      const delivery = rec(envelope.delivery);
      const conversationId = str(delivery.conversationId);
      if (!conversationId) return { success: false, error: 'conversation_required' };
      const content = rec(envelope.content);
      const text = typeof content.text === 'string' ? content.text : '';
      const media = toAttachments(content.media);
      if (!text && !media) return { success: false, error: 'content_required' };
      const replyToMessageId = str(delivery.inReplyTo);

      const idempotencyKey = createHash('sha256')
        .update(JSON.stringify([deps.runId, str(args?.nodeId) ?? '', relayId, conversationId, replyToMessageId ?? '', text, media?.map((m) => m.url) ?? []]))
        .digest('hex');
      const key = egressLedgerKey(deps.tenantId, 'chat', idempotencyKey);
      const provider = `relay:${device.channel}`;
      const prior = await priorSend(key);
      if (prior) return { success: true, messageId: prior.providerRef, relayId, deduplicated: true };
      if ((await reserveSend({ key, tenantId: deps.tenantId, channel: 'chat', provider, providerRef: '', createdAt: new Date().toISOString() })) === 'duplicate') {
        const winner = await priorSend(key);
        return { success: true, messageId: winner?.providerRef ?? '', relayId, deduplicated: true };
      }

      let egress: ChatEgressEnvelope;
      try {
        egress = await enqueueOutbound(deps.storage, relayId, {
          channel: device.channel,
          conversationId,
          text,
          ...(replyToMessageId ? { replyToMessageId } : {}),
          ...(media ? { media } : {}),
        });
      } catch {
        await releaseSend(key); // a failed enqueue never blocks a retry (put-on-accept)
        return { success: false, error: 'enqueue_failed' };
      }
      await recordSend({ key, tenantId: deps.tenantId, channel: 'chat', provider, providerRef: egress.egressId, createdAt: new Date().toISOString() });
      return { success: true, messageId: egress.egressId, relayId };
    },
  };
}

/** `ctx.messaging` — the one object the executor wires (SMS + chat egress). */
export function makeMessagingAdapter(deps: BrokeredEgressDeps): MessagingAdapter {
  return { ...makeSmsAdapter(deps), ...makeChatEgressAdapter(deps) };
}
