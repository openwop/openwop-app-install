import type { BackendFeature } from '../types.js';

/**
 * Multi-tab chat deck (ADR 0140) — a FRONTEND-ONLY feature. It changes the chat
 * surface (a bounded working set of live, keep-alive conversation tabs) and ships
 * NO backend routes or store: N tabs are N instances of the existing RFC 0005 chat
 * session primitive, isolated by the P1 backend-keyed persistence mode. This entry
 * exists only to DECLARE the toggle default so the frontend
 * `useFeatureAccess('multi-tab-chat')` gate resolves; `registerRoutes` is
 * intentionally a no-op.
 *
 * Default ON since 2026-10-25 (user decision, after ADR 0978). Prod had stored
 * `status:"on"` since 2026-06-25, so the deck was already every prod user's chat;
 * this makes a fresh install (and every white-label adopter) match. It stays a
 * toggle because it is a genuine per-user preference (FEATURES.md, ADR 0434).
 */
export const multiTabChatFeature: BackendFeature = {
  id: 'multi-tab-chat',
  registerRoutes: () => { /* frontend-only — no backend surface (ADR 0140) */ },
  toggleDefault: {
    id: 'multi-tab-chat',
    label: 'Multi-tab chat',
    description:
      'Work in several chat conversations at once: a bounded working set of live, '
      + 'independent tabs that keep streaming in the background while you read another. '
      + 'Each tab is a full instance of the one AI chat (no second chat system); the '
      + 'sidebar list stays the library. A per-user UI preference.',
    category: 'Chat',
    status: 'on',
    bucketUnit: 'user',
    salt: 'multi-tab-chat',
  },
};
