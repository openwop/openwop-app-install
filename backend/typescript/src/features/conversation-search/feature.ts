/**
 * Conversation & message full-text search (ADR 0112, backlog B1). A read-only,
 * DERIVED lexical index over the existing ADR 0043 conversation/message store —
 * NOT a second chat store. Rides the host `db.search` surface (RFC 0018), lazily
 * rebuilt from durable rows; results are always post-filtered through the shared
 * ADR 0043 visibility predicate. A `conversation-search` toggle, off by default,
 * bucketed per user (search scope is one person's conversation corpus).
 *
 * @see docs/adr/0112-conversation-full-text-search.md
 */
import type { BackendFeature } from '../types.js';
import { registerConversationSearchAgentTools } from './agentTools.js';
import { registerConversationSearchRoutes } from './routes.js';

export const conversationSearchFeature: BackendFeature = {
  id: 'conversation-search',
  registerRoutes: (deps) => {
    registerConversationSearchRoutes(deps);
    registerConversationSearchAgentTools(deps.storage); // XCH-HOLE-5 (Wave 4) — openwop:conversations.search (ADR 0308 seam)
  },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
