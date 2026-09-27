/**
 * Conversation export + import (ADR 0119, backlog B9). Read-only transcript
 * rendering (markdown/JSON) over the existing chat store — no new transcript store.
 * Phase 2 ships the export route over the Phase-1 renderer. A `chat-export` toggle,
 * off by default, per tenant.
 *
 * @see docs/adr/0119-conversation-export-import.md
 */
import type { BackendFeature } from '../types.js';
import { registerChatExportRoutes } from './routes.js';
import { registerChatExportAgentTools } from './agentTools.js';

export const chatExportFeature: BackendFeature = {
  id: 'chat-export',
  registerRoutes: (deps) => {
    registerChatExportRoutes(deps);
    // A6 (chat-first port) — the `openwop:conversations.export-document` agent
    // tool: igniting the ADR 0119 Phase-3 export helper. Registered here (the
    // same feature-init seam documents uses); the tool re-checks the `documents`
    // toggle per tenant and enforces ADR 0043 conversation READ visibility.
    registerChatExportAgentTools();
  },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
