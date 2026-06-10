/**
 * chatSessionReducer — pure message/session transitions, extracted from
 * useChatSession so the state changes are testable in isolation and named as
 * events rather than inlined as ad-hoc `setSession(s => …)` closures (frontend
 * enterprise-review Batch I).
 *
 * Each action returns a NEW ChatSession (immutable); message identity is by
 * `id`. The hook layers SSE/dispatch/persistence on top of these.
 */

import type { ChatSession, ChatMessage } from '../types.js';

export type ChatSessionAction =
  | { type: 'appendMessage'; message: ChatMessage }
  | { type: 'updateMessage'; id: string; patch: Partial<ChatMessage> }
  | { type: 'replaceMessages'; messages: ChatMessage[] }
  | { type: 'removeMessage'; id: string }
  | { type: 'setTitle'; title: string }
  | { type: 'setFeedback'; id: string; feedback: 'positive' | 'negative' | null }
  | { type: 'truncateFrom'; id: string };

export function chatSessionReducer(session: ChatSession, action: ChatSessionAction): ChatSession {
  switch (action.type) {
    case 'appendMessage':
      return { ...session, messages: [...session.messages, action.message] };

    case 'updateMessage': {
      let changed = false;
      const messages = session.messages.map((m) => {
        if (m.id !== action.id) return m;
        changed = true;
        return { ...m, ...action.patch };
      });
      return changed ? { ...session, messages } : session;
    }

    case 'replaceMessages':
      return { ...session, messages: action.messages };

    case 'removeMessage':
      return { ...session, messages: session.messages.filter((m) => m.id !== action.id) };

    case 'setTitle':
      return session.title === action.title ? session : { ...session, title: action.title };

    case 'setFeedback': {
      let changed = false;
      const messages = session.messages.map((m) => {
        if (m.id !== action.id) return m;
        changed = true;
        // Clearing removes the key entirely (matches the prior hook behavior
        // and ChatMessage.feedback being optional, not nullable).
        if (action.feedback === null) {
          const { feedback: _drop, ...rest } = m;
          return rest;
        }
        return { ...m, feedback: action.feedback };
      });
      return changed ? { ...session, messages } : session;
    }

    case 'truncateFrom': {
      const idx = session.messages.findIndex((m) => m.id === action.id);
      if (idx < 0) return session;
      return { ...session, messages: session.messages.slice(0, idx) };
    }

    default: {
      // Exhaustiveness guard: a new action type without a case is a type error.
      const _never: never = action;
      return _never;
    }
  }
}
