/**
 * useScopeToAgent — activate a specific agent in the conversation lineup once
 * its catalog entry is available (ADR 0073 Phase 2). The single home for
 * "scope this conversation to agent N", shared by:
 *   - the full chat surface's `?agent=` deep-link (ChatSidebar), and
 *   - an embedded ConversationView (e.g. the workflow builder scoping to the
 *     Workflow Architect) — programmatically, with no URL search param.
 *
 * Entry-gated + once-per-agentId: it no-ops until the agent catalog has loaded
 * the matching entry (re-running as `agentEntries` arrives), activates exactly
 * once for a given `agentId` (a ref guards against re-yanking the current voice
 * after the user manually switched), and re-activates if `agentId` changes.
 *
 * `agentEntries` is passed IN (not fetched here) so a surface that already calls
 * `useAgentMentions()` — like ChatSidebar — doesn't pay a second /v1/agents
 * round-trip; an embed calls `useAgentMentions()` itself and forwards `entries`.
 *
 * @see docs/adr/0073-embeddable-conversation-view.md
 */

import { useEffect, useRef, useState } from 'react';
import type { UseActiveAgentsResult } from './useActiveAgents.js';
import type { AgentMentionEntry } from '../lib/agentMentions.js';

export function useScopeToAgent(
  activeAgents: UseActiveAgentsResult,
  agentEntries: readonly AgentMentionEntry[],
  agentId: string | null,
): boolean {
  const handled = useRef<string | null>(null);
  // Which agent the conversation is scoped to, once it IS (state, not the ref,
  // so a consumer re-renders when scoping lands).
  const [scopedTo, setScopedTo] = useState<string | null>(null);
  useEffect(() => {
    if (!agentId || handled.current === agentId) return;
    const entry = agentEntries.find((e) => e.agentId === agentId || e.slug === agentId.toLowerCase());
    if (!entry) return; // catalog still loading — this effect re-runs when entries arrive
    handled.current = agentId;
    activeAgents.activateAgent(entry);
    setScopedTo(agentId);
  }, [activeAgents, agentEntries, agentId]);
  // ADR 0773 — true once the requested agent is active (or none was requested).
  // A caller that SENDS on the user's behalf (an embed `prompt`) must wait for
  // this: a turn sent before the catalog loads goes out unscoped, i.e. as plain
  // chat with none of the agent's tools (measured: the builder's empty-sheet
  // "Draft it" reached the model with tools=0).
  return !agentId || scopedTo === agentId;
}
