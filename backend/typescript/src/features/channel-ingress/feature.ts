/**
 * Channels into chat (ADR 1042, phase P0 of ADR 1041) — the channel core.
 *
 * Messages from hosted chat connections (Telegram, Slack, Discord commands,
 * WhatsApp) and from the device relay become turns in the paired owner's MAIN
 * CHAT conversations, answered by the existing exchange and agent tool loop,
 * with the reply sent back to the chat it came from. Default-deny sender
 * pairing, per-message dedup and a per-connection inbound budget hold on both
 * lanes. No new chat store and no new chat UI (CLAUDE.md "AI chat — reuse").
 *
 * OFF by default (ADR 1041 D4). With it off: a conversation-mode inbound config
 * fires nothing, and the relay keeps its workflow bridge exactly as before.
 * Distinct from `channels` (ADR 0126 team channels, an always-on feature).
 */
import type { BackendFeature } from '../types.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { onConnectionRevoked } from '../../host/connectionLifecycle.js';
import { registerExchangeSettledObserver } from '../../host/exchange/settledObservers.js';
import { registerConversationalIngress } from '../connections/inboundWebhooks.js';
import { hasBotMention, registerRelayConversationalIngress, type RelayConversationalIngress } from '../../routes/messaging.js';
import { admitConnectionMessage, admitRelayMessage, ingestConnectionMessage, ingestRelayMessage, makeSettledObserver } from './ingress.js';
import { registerChannelReplyTransports } from './transports.js';
import { registerChannelIngressRoutes, CHANNEL_INGRESS_TOGGLE } from './routes.js';
import { isChannelConversation, laneKeyOf, purgeLane } from './stores.js';
import { registerChannelConversationCheck } from '../../host/channelConversationGuard.js';
import { registerChannelIngressErasure } from './erasure.js';
import { isRelayGroup } from '../../messaging/groupDetection.js';

const enabledFor = async (tenantId: string): Promise<boolean> =>
  (await resolveOne(CHANNEL_INGRESS_TOGGLE, { tenantId }).catch(() => null))?.enabled === true;

export const channelIngressFeature: BackendFeature = {
  id: CHANNEL_INGRESS_TOGGLE,
  registerRoutes: (deps) => {
    const ingressDeps = { storage: deps.storage, hostSuite: deps.hostSuite };
    registerConversationalIngress({
      enabled: enabledFor,
      admit: async (input) => ({ admitted: (await admitConnectionMessage(input)).admitted }),
      // The turn runs detached; there is no run id to report at acknowledgement.
      ingest: async (input) => { await ingestConnectionMessage(ingressDeps, input); return { runId: null }; },
    });
    // ADR 1043 D9 — one mapping from a device envelope to the admission's input, so
    // the pre-budget admission and the dispatch re-check read the same fields.
    const relayInput = (input: Parameters<RelayConversationalIngress['admit']>[0]) => {
      const isGroup = isRelayGroup(input.channel, input.envelope);
      return {
        tenantId: input.tenantId, relayId: input.relayId, channel: input.channel, ownerUserId: input.ownerUserId,
        ...(input.ownerAccountId ? { ownerAccountId: input.ownerAccountId } : {}),
        chatId: input.envelope.conversationId, senderId: input.envelope.peerId, isGroup, fromMe: input.envelope.fromMe === true,
        // An approved group is answered only when it names the assistant.
        addressed: isGroup && hasBotMention(input.envelope, input.channel),
      };
    };
    registerRelayConversationalIngress({
      enabled: enabledFor,
      // ADR 1042 D12 / ADR 1043 D9 — runs BEFORE the device's inbound budget is spent.
      admit: (input) => admitRelayMessage(relayInput(input)),
      ingest: async (input) => {
        const out = await ingestRelayMessage(ingressDeps, {
          ...relayInput(input),
          ...(input.ownerPersonalTenant ? { ownerPersonalTenant: input.ownerPersonalTenant } : {}),
          messageId: input.envelope.platformMessageId, text: input.envelope.text,
        });
        return out.status === 'accepted' ? { status: 'accepted', conversationId: out.conversationId } : { status: 'dropped', reason: out.reason };
      },
      // ADR 1043 D3 — a revoked device takes its lane's settings, approvals and pending senders with it.
      onRevoked: async (tenantId, relayId) => { await purgeLane(tenantId, laneKeyOf({ kind: 'relay', relayId, channel: '' })); },
    });
    registerChannelReplyTransports(deps.storage);
    // Round 3 — core refuses to re-bind/branch these sessions and keeps them out of search.
    registerChannelConversationCheck(isChannelConversation);
    registerExchangeSettledObserver(makeSettledObserver({ storage: deps.storage }));
    // A revoked connection takes its approvals, pending requests and settings with it.
    onConnectionRevoked('channel-ingress', async ({ tenantId, connectionId }) => {
      await purgeLane(tenantId, laneKeyOf({ kind: 'connection', connectionId, provider: '' }));
    });
    // ADR 1042 D8 — subject erasure for the owner AND the external person.
    registerChannelIngressErasure();
    registerChannelIngressRoutes(deps);
  },
  toggleDefault: {
    id: CHANNEL_INGRESS_TOGGLE,
    label: 'Channels into chat',
    description:
      'Messages from connected Telegram, Slack, Discord and WhatsApp accounts, and from your own devices through the relay, '
      + 'land in the main chat as conversations with an agent, and the agent’s reply goes back to the same chat. '
      + 'Senders are blocked until someone who manages the connection approves them.',
    category: 'Integrations',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'channel-ingress',
  },
};
