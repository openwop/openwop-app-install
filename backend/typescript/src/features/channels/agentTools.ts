/**
 * Channels agent tool (XCH-HOLE-7, LLM-EXCHANGE-AUDIT round 3) — the ADR 0308
 * seam. `openwop:channels.list` — "which channels can I see/join?" via the
 * SAME `listChannelsForViewer` the discovery route calls: the visibility
 * predicate (public channels + the caller's own private memberships, never
 * another user's private rooms) lives in the service, so route and tool share
 * it by construction. LIST tool ⇒ fails EMPTY + note without an acting user
 * (the tasks.deck convention; ARCHITECTURE.md read-tool contract).
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { listChannelsForViewer } from './channelService.js';

export const CHANNELS_LIST_TOOL_ID = 'openwop:channels.list';

export function registerChannelsAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CHANNELS_LIST_TOOL_ID,
      description:
        'List the chat channels visible to the current user: public channels plus their own private memberships '
        + '(name, joined, member/agent counts, last activity). Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async run(_input, scope) {
      if (!scope.actingUserId) {
        // Fail-EMPTY, honestly: visibility is viewer-driven, so a turn without
        // a human subject has no channel view — not "there are no channels".
        return { content: JSON.stringify({ channels: [], note: 'No acting user on this turn — channel visibility requires a signed-in user.' }) };
      }
      const rows = await listChannelsForViewer(scope.tenantId, scope.actingUserId);
      return {
        content: JSON.stringify({
          channels: rows.map((r) => ({
            conversationId: r.conversationId,
            channel: r.channel,
            joined: r.joined,
            memberCount: r.memberCount,
            agentCount: r.agentCount,
            lastActivityAt: r.lastActivityAt,
          })),
        }),
      };
    },
  });
}
