/**
 * Task-deck agent tool (XCH-HOLE-4, LLM-EXCHANGE-AUDIT Wave 4) — the ADR 0308
 * seam. `openwop:tasks.deck` is the READ counterpart the write-only
 * `openwop:kanban.add-todo` never had: "what am I running / blocked on?".
 * Access is IDENTICAL to the route: the shared `buildOwnedTaskDeck` applies
 * the IDOR ownership filter (the acting user's runs + their direct children).
 * Fails empty without an acting user.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { buildOwnedTaskDeck, emptyTaskDeck } from './routes.js';
import type { Storage } from '../../storage/storage.js';

export const TASKS_DECK_TOOL_ID = 'openwop:tasks.deck';

export function registerTaskDeckAgentTools(storage: Storage): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: TASKS_DECK_TOOL_ID,
      description:
        'Read the current user\'s run/task deck: their pending, running, blocked (with the blocking interrupt), '
        + 'delegated, completed, and failed runs. Use it to answer "what is running / blocked / done?" before '
        + 'proposing new work. Read-only; shows only the user\'s own runs.',
      inputSchema: {
        type: 'object',
        properties: {
          conversationRunId: { type: 'string', description: 'Optional: narrow to one conversation/parent run and its children.' },
        },
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      if (!scope.actingUserId) {
        return { content: JSON.stringify({ deck: emptyTaskDeck(), note: 'no acting user on this run — nothing owned' }) };
      }
      const conversationRunId = typeof input.conversationRunId === 'string' ? input.conversationRunId : undefined;
      const deck = await buildOwnedTaskDeck(storage, scope.tenantId, scope.actingUserId, conversationRunId);
      return { content: JSON.stringify({ deck }) };
    },
  });
}
