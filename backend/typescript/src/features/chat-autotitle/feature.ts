/**
 * Conversation auto-titling (ADR 0151) — on the first exchange of a new chat, a cheap
 * LLM names the conversation by its topic (LibreChat `immediate`+`completion`), writing
 * the existing chat-session title and emitting a `conversation.titled` host event the FE
 * consumes live. A BACKEND side-effect feature: no routes, no store of its own (it writes
 * through the existing `chatSessions` title) — this entry DECLARES the toggle default and
 * the binding is *called from* `conversationExchange` (the established core→feature seam,
 * exactly like `memory-auto-extract`). `registerRoutes` is intentionally a no-op.
 *
 * Toggle default ON, bucketed per USER (a personal UX preference; per-user opt-out, or a
 * workspace can disable it org-wide via the panel). OFF ⇒ the FE substring placeholder is
 * the title (today's behavior).
 *
 * @see docs/adr/0151-conversation-auto-titling.md
 */
import type { BackendFeature } from '../types.js';
import { AUTOTITLE_TOGGLE_ID } from './binding.js';

export const chatAutotitleFeature: BackendFeature = {
  id: 'chat-autotitle',
  registerRoutes: () => { /* side-effect feature — no backend routes (ADR 0151) */ },
  toggleDefault: {
    id: AUTOTITLE_TOGGLE_ID,
    label: 'Auto-name conversations',
    description:
      'On the first message of a new chat, a quick model names the conversation by its '
      + 'topic (in the conversation\'s own language) instead of using the first 60 '
      + 'characters. It names a chat ONCE and never overrides a name you set yourself. '
      + 'A per-user preference, ON by default; turn it off to keep the plain substring name.',
    category: 'Chat',
    status: 'on',
    bucketUnit: 'user',
    salt: 'chat-autotitle',
  },
};
