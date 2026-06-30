/**
 * Active-agents state hook (phase D1 + D3).
 *
 * Owns the lineup + currently-routing agent state for a chat session.
 * Backed by `ChatSession.activeAgents` so it survives a reload + the
 * BE persistence cycle in `useChatSession`.
 *
 * Surface:
 *   - `lineup` — readonly array always starting with the default
 *     OpenWOP Assistant row, then any user-activated agents in
 *     activation order.
 *   - `currentAgentId` — the agentId the chat is currently routing
 *     through. `DEFAULT_ASSISTANT_ID` when no agent is active.
 *   - `activateAgent(entry)` — D3 wires this to the `@`-mention
 *     submit path. If the agent is already in the lineup it just
 *     switches; otherwise it's added + switched-to in one step.
 *   - `switchTo(agentId)` — D1's panel uses this when the user
 *     clicks a row in the panel.
 *   - `remove(agentId)` — D1's `×` button. Pack-installed agents +
 *     user-authored agents are both removable; only the default
 *     assistant resists removal (the hook silently no-ops on it).
 *
 * The hook reaches *into* `setSession` from `useChatSession` rather
 * than holding its own state — the lineup is part of the session and
 * has to ride along through persistence, reload, and the chat
 * session-switcher. A standalone `useState` here would double-source
 * the truth and drift.
 */

import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react';
import type { ChatSession } from '../types.js';
import type { AgentMentionEntry } from '../lib/agentMentions.js';
import {
  DEFAULT_ASSISTANT_ID,
  DEFAULT_ASSISTANT_ROW,
} from './constants.js';
import type { ActiveAgentRow } from './types.js';

export interface UseActiveAgentsResult {
  /** Default-assistant row first, then user-activated agents in
   *  activation order. */
  lineup: readonly ActiveAgentRow[];
  /** `DEFAULT_ASSISTANT_ID` when no agent is active; otherwise the
   *  agentId of the routing agent. Guaranteed to reference an entry
   *  in `lineup`. */
  currentAgentId: string;
  /** Used by phase D3's `@`-mention submit path. Returns the agentId
   *  that's now current — caller can include it on the dispatch. */
  activateAgent: (entry: AgentMentionEntry) => string;
  /** Replace the lineup wholesale from a conversation's stored participants
   *  (ADR 0043 — derive on open so the lineup survives a cross-device reload).
   *  Resets the routing voice to the default assistant; membership is the
   *  server's, the routing choice is the user's. */
  setLineup: (rows: readonly ActiveAgentRow[]) => void;
  /** Used by the panel's row-click. */
  switchTo: (agentId: string) => void;
  /** Used by the panel's `×` button. */
  remove: (agentId: string) => void;
}

export function useActiveAgents(
  session: ChatSession,
  setSession: Dispatch<SetStateAction<ChatSession>>,
): UseActiveAgentsResult {
  const lineup = useMemo<readonly ActiveAgentRow[]>(() => {
    const persisted = session.activeAgents?.lineup ?? [];
    return [DEFAULT_ASSISTANT_ROW, ...persisted];
  }, [session.activeAgents?.lineup]);

  const currentAgentId = session.activeAgents?.currentAgentId ?? DEFAULT_ASSISTANT_ID;

  const activateAgent = useCallback((entry: AgentMentionEntry): string => {
    let resolvedAgentId = entry.agentId;
    setSession((s) => {
      const existing = s.activeAgents?.lineup ?? [];
      const already = existing.find((it) => it.agentId === entry.agentId);
      const nextLineup = already
        ? existing
        : [
            ...existing,
            {
              agentId: entry.agentId,
              persona: entry.displayName,
              slug: entry.slug,
              modelClass: entry.modelClass,
              addedAt: new Date().toISOString(),
            },
          ];
      resolvedAgentId = entry.agentId;
      return {
        ...s,
        activeAgents: {
          lineup: nextLineup,
          currentAgentId: entry.agentId,
        },
      };
    });
    return resolvedAgentId;
  }, [setSession]);

  const setLineup = useCallback((rows: readonly ActiveAgentRow[]): void => {
    setSession((s) => ({
      ...s,
      activeAgents: { lineup: [...rows], currentAgentId: null },
    }));
  }, [setSession]);

  const switchTo = useCallback((agentId: string): void => {
    setSession((s) => {
      const existing = s.activeAgents?.lineup ?? [];
      const isDefault = agentId === DEFAULT_ASSISTANT_ID;
      const isInLineup = existing.some((it) => it.agentId === agentId);
      // Refuse to switch to an id that isn't in the lineup AND isn't
      // the default assistant — that would be a UX bug (panel can't
      // show a row that isn't backed). Silently no-op rather than
      // throw so a stale BroadcastChannel message can't break the
      // session.
      if (!isDefault && !isInLineup) return s;
      return {
        ...s,
        activeAgents: {
          lineup: existing,
          currentAgentId: isDefault ? null : agentId,
        },
      };
    });
  }, [setSession]);

  const remove = useCallback((agentId: string): void => {
    if (agentId === DEFAULT_ASSISTANT_ID) return; // default is sticky
    setSession((s) => {
      const existing = s.activeAgents?.lineup ?? [];
      const filtered = existing.filter((it) => it.agentId !== agentId);
      if (filtered.length === existing.length) return s; // wasn't there
      const wasCurrent = s.activeAgents?.currentAgentId === agentId;
      return {
        ...s,
        activeAgents: {
          lineup: filtered,
          currentAgentId: wasCurrent ? null : (s.activeAgents?.currentAgentId ?? null),
        },
      };
    });
  }, [setSession]);

  return { lineup, currentAgentId, activateAgent, setLineup, switchTo, remove };
}
