/**
 * ADR 1042 (review N1) — is a relay message from a GROUP chat? One explicit rule
 * per channel, shared by the relay's policy gate and the channel core's scope
 * decision, so the two can never disagree. Anything that looks like a group is a
 * group (a false "group" only narrows).
 *
 *  - the relay's own prefixes: `group:` / `chat:` conversation ids;
 *  - WhatsApp: a group JID ends in `@g.us` (a person is `@s.whatsapp.net`);
 *  - Signal: `channelMeta.groupId` (signal-cli's group id), or a `group.` id;
 *  - iMessage: `channelMeta.isGroup === true`, or a chat GUID with the `;+;`
 *    group marker (`iMessage;+;chat123…`; a 1:1 GUID is `iMessage;-;+1555…`);
 *  - Discord: a `channelMeta.guildId` (a guild channel, not a DM);
 *  - any channel: `channelMeta.isGroup === true`.
 */
import type { ChatIngressEnvelope, RelayChannel } from './types.js';

export function isRelayGroup(channel: RelayChannel | string, envelope: Pick<ChatIngressEnvelope, 'conversationId' | 'channelMeta'>): boolean {
  const id = envelope.conversationId;
  const meta = (envelope.channelMeta ?? {}) as Record<string, unknown>;
  if (id.startsWith('group:') || id.startsWith('chat:')) return true;
  if (meta.isGroup === true) return true;
  switch (channel) {
    case 'whatsapp': return id.endsWith('@g.us');
    case 'signal': return typeof meta.groupId === 'string' || id.startsWith('group.');
    case 'imessage': return id.includes(';+;');
    case 'discord': return typeof meta.guildId === 'string';
    default: return false;
  }
}
