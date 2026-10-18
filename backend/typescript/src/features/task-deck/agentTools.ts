/**
 * Task-deck agent tool (XCH-HOLE-4, LLM-EXCHANGE-AUDIT Wave 4) — the ADR 0308
 * seam. `openwop:tasks.deck` is the READ counterpart the write-only
 * `openwop:kanban.add-todo` never had: "what am I running / blocked on?".
 * Access is IDENTICAL to the route: the shared `buildOwnedTaskDeck` applies
 * the ownership rule (ADR 0902 D4: the canonical run owner, or the whole personal
 * workspace) and the host-written delegation tree.
 * Fails empty without an acting user.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { buildOwnedTaskDeck, deckViewerOfScope, emptyTaskDeck } from './routes.js';
import type { Storage } from '../../storage/storage.js';

export const TASKS_DECK_TOOL_ID = 'openwop:tasks.deck';

export function registerTaskDeckAgentTools(storage: Storage, catalog: Parameters<typeof buildOwnedTaskDeck>[1]): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    effect: 'read',
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
      const viewer = deckViewerOfScope(scope);
      if (!viewer) {
        return { content: JSON.stringify({ deck: emptyTaskDeck(), note: 'no acting user on this run — nothing owned' }) };
      }
      const conversationRunId = typeof input.conversationRunId === 'string' ? input.conversationRunId : undefined;
      const deck = await buildOwnedTaskDeck(storage, catalog, scope.tenantId, viewer, conversationRunId);
      return { content: JSON.stringify({ deck }) };
    },
  });
}
