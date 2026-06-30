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

export const chatExportFeature: BackendFeature = {
  id: 'chat-export',
  registerRoutes: (deps) => { registerChatExportRoutes(deps); },
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
