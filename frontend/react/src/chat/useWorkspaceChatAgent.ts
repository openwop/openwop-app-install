/**
 * ADR 0975 D12 — a NEW plain chat in a workspace that declares a chat agent opens
 * scoped to it.
 *
 * A feature-declared default participant workspace may name one (KickTodo names
 * KickBot, the one agent its `viewer` participants may chat with — D11). The
 * generic assistant there is refused `runs:create`, so a participant who typed
 * straight into the composer met a raw scope error. `/me/workspaces` carries the
 * id as `chatAgent` on that workspace's row; every other workspace has none, and
 * nothing here changes for it.
 *
 * Activation is the `@mention` path (`activateAgent`), so the conversation start
 * carries `metadata.agentScope` and each turn is addressed to the agent, exactly
 * as `@KickBot` does. It is a STARTING scope, not a lock: `@mention` or the agent
 * picker still switches, and it applies to every member alike (the workspace's
 * chat is its declared agent; an operator who wants another one names it). It
 * grants nothing: the feature's run-start grant decides who may chat.
 *
 * `chat/` stays product-neutral: no feature import, only the declared id.
 */
import { useEffect, useRef, useState } from 'react';
import { listMyWorkspaces, type MyWorkspaces } from '../client/workspaceClient.js';
import type { AgentMentionEntry } from './lib/agentMentions.js';
import type { ConversationType } from '../client/chatSessionsClient.js';

/** The ACTIVE workspace's declared chat agent, or null. */
export function activeWorkspaceChatAgent(w: Pick<MyWorkspaces, 'workspaces' | 'active'>): string | null {
  return w.workspaces.find((x) => x.workspaceId === w.active)?.chatAgent ?? null;
}

/** The active workspace's chat agent. Null while loading, signed out (`enabled`
 *  false), on error, or when none is declared. One read per surface mount. */
export function useWorkspaceChatAgent(enabled: boolean): string | null {
  const [agentId, setAgentId] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) { setAgentId(null); return; }
    let live = true;
    listMyWorkspaces()
      .then((w) => { if (live) setAgentId(activeWorkspaceChatAgent(w)); })
      .catch(() => { /* no default: the chat opens as it always has */ });
    return () => { live = false; };
  }, [enabled]);
  return agentId;
}

export interface DefaultChatAgentInput {
  /** From `useWorkspaceChatAgent`; null = do nothing. */
  agentId: string | null;
  /** An explicit scope (`?agent=`) wins; the default never competes with it. */
  explicitScope: string | null | undefined;
  activateAgent: (entry: AgentMentionEntry) => string;
  agentEntries: readonly AgentMentionEntry[];
  session: { id: string; messages: readonly unknown[]; conversationRunId?: string | undefined };
  isHydrating: boolean;
  /** Set for channels, groups, workspace and person chats: never defaulted. */
  conversationType?: ConversationType | undefined;
}

/**
 * Activate the workspace's chat agent in an EMPTY plain chat, once per session.
 *
 * Never a chat with history or an open conversation run (an existing conversation
 * is never re-pointed), never while hydrating (it looks empty until it loads), and
 * never a typed conversation. Once per SESSION id rather than once per agent:
 * `/clear` mints a fresh session whose lineup is the default assistant again.
 */
export function useDefaultChatAgent(input: DefaultChatAgentInput): void {
  const { agentId, explicitScope, activateAgent, agentEntries, session, isHydrating, conversationType } = input;
  const doneFor = useRef<string | null>(null);
  const empty = session.messages.length === 0 && !session.conversationRunId;
  useEffect(() => {
    if (!agentId || explicitScope || conversationType || doneFor.current === session.id) return;
    if (isHydrating || !empty) return;
    const entry = agentEntries.find((e) => e.agentId === agentId);
    if (!entry) return; // catalog still loading, or the agent isn't offered here
    doneFor.current = session.id;
    activateAgent(entry);
  }, [agentId, explicitScope, conversationType, session.id, isHydrating, empty, agentEntries, activateAgent]);
}
