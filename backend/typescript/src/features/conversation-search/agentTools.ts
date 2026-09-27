/**
 * Conversation-search agent tool (XCH-HOLE-5, LLM-EXCHANGE-AUDIT Wave 4) —
 * the ADR 0308 seam. `openwop:conversations.search` gives an agent the
 * "find where we discussed X" read the FTS route has had since ADR 0112.
 * Access is IDENTICAL to the route: the shared `searchVisibleConversations`
 * resolves the ACTING USER's visible conversations through the ADR 0043
 * predicate before the query — an agent can never surface a co-tenant
 * non-participant's conversation. Fails empty (not open) without an acting
 * user (system runs have no human whose conversations could be searched).
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { searchVisibleConversations } from './searchEngine.js';
import type { Storage } from '../../storage/storage.js';
import type { ConversationType } from '../../host/conversationStore.js';

export const CONVERSATIONS_SEARCH_TOOL_ID = 'openwop:conversations.search';

const VALID_TYPES: ReadonlySet<string> = new Set<ConversationType>(['agent', 'person', 'group', 'workspace']);

export function registerConversationSearchAgentTools(storage: Storage): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CONVERSATIONS_SEARCH_TOOL_ID,
      description:
        'Full-text search over the current user\'s OWN conversations and messages ("find where we discussed X"). '
        + 'Returns matching conversations with snippets. Read-only; only conversations the user participates in are searchable.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: 'The search text.' },
          type: { type: 'string', description: "Optional conversation type filter: 'agent' | 'person' | 'group' | 'workspace'." },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max hits (default 10).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) {
        return { content: JSON.stringify({ hits: [], note: 'no acting user on this run — nothing searchable' }) };
      }
      const type = typeof input.type === 'string' && VALID_TYPES.has(input.type) ? (input.type as ConversationType) : undefined;
      const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.min(input.limit, 50) : 10;
      const hits = await searchVisibleConversations(storage, scope.tenantId, scope.actingUserId, String(input.query ?? ''), {
        ...(type ? { type } : {}),
        limit,
      });
      // ADR 0685 D1 — project EXPLICITLY. This used to be `JSON.stringify({ hits })`, i.e. the
      // engine's `SearchHit` shape WAS the model-facing contract: any field added to the engine
      // for internal or UI reasons reached a model automatically, with no decision and no schema
      // text explaining it. `matchedAt` was the live instance — declared, populated, typed on the
      // FE client, and read by NOTHING (zero consumers repo-wide) — shipping to every model that
      // called this tool as an undocumented timestamp. Its own comment claimed it was "for jump
      // to", which a `createdAt` cannot serve; the hit already carries `messageId` for that.
      //
      // The allowlist is the generator fix: dropping `matchedAt` alone would leave the NEXT
      // internal field to reach a model silently. Widening what a model reads is now a
      // deliberate edit here, pinned by a test that compares these keys to the tool's output.
      return {
        content: JSON.stringify({
          hits: hits.map((h) => ({
            conversationId: h.conversationId,
            title: h.title,
            ...(h.type ? { type: h.type } : {}),
            ...(h.messageId ? { messageId: h.messageId } : {}),
            snippet: h.snippet,
            score: h.score,
            ...(h.role ? { role: h.role } : {}),
          })),
        }),
      };
    },
  });
}
