/**
 * Active-agents shared constants — the default OpenWOP Assistant sentinel.
 *
 * Relocated here (ADR 0043 — legacy-drawer retirement) from the deleted
 * `ActiveAgentsPanel.tsx` so the sentinel survives that panel's removal. Every
 * consumer of the active-agents state agrees on this id rather than hard-coding
 * the string: the hook (`useActiveAgents`), the chat shell (`ChatSidebar`), and
 * the Conversations rail.
 */

import i18n from '../../i18n/index.js';
import type { ActiveAgentRow } from './types.js';

/** The sentinel id for the default OpenWOP Assistant — the always-present,
 *  non-removable first voice in any chat. */
export const DEFAULT_ASSISTANT_ID = '__default_assistant__';

/** The synthesized lineup row for the default assistant (never persisted).
 *  NOTE: `persona` is resolved at module-import time, so it freezes to the
 *  locale active when this module is first evaluated; it is a display string
 *  only (the stable id is `agentId`), so a runtime locale change won't update
 *  this label until reload. */
export const DEFAULT_ASSISTANT_ROW: ActiveAgentRow = {
  agentId: DEFAULT_ASSISTANT_ID,
  persona: i18n.t('chat:defaultAssistantPersona'),
  slug: 'assistant',
  modelClass: 'chat',
  addedAt: '',
};
