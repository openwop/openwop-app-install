/**
 * Derive the active-agents lineup from a conversation's stored participants
 * (ADR 0043 — completes Phase 4/5 by retiring the FE-only lineup).
 *
 * Membership lives server-side on the conversation meta (`participants`); the
 * live routing lineup is DERIVED from it on open, so it survives a cross-device
 * reload instead of starting empty. Only `agent:<id>` participants become rows
 * (the `user:` owner is not a routable voice); each is resolved to its persona /
 * slug / modelClass via the agent catalog, and an unresolvable ref (catalog
 * miss) is dropped rather than rendered as a bare id.
 *
 * Pure + side-effect-free so the projection is unit-testable; `ChatSidebar`
 * supplies the resolver from its loaded agent-mention catalog.
 */

import type { ConversationParticipant } from '../../client/chatSessionsClient.js';
import type { ActiveAgentRow } from '../activeAgents/types.js';

export interface ResolvedAgentInfo {
  persona: string;
  slug: string;
  modelClass: string;
}

/** Resolve an `agentId` to its display info, or null when the catalog has no
 *  such agent (uninstalled / not yet loaded). */
export type AgentResolver = (agentId: string) => ResolvedAgentInfo | null;

const AGENT_PREFIX = 'agent:';

/** Project a conversation's participants into active-agent rows, in participant
 *  order, de-duplicated, dropping non-agent and unresolvable refs. */
export function participantsToLineup(
  participants: readonly ConversationParticipant[],
  resolve: AgentResolver,
): ActiveAgentRow[] {
  const rows: ActiveAgentRow[] = [];
  const seen = new Set<string>();
  for (const p of participants) {
    if (!p.subjectRef.startsWith(AGENT_PREFIX)) continue; // owner / non-agent subject
    const agentId = p.subjectRef.slice(AGENT_PREFIX.length);
    if (!agentId || seen.has(agentId)) continue;
    const info = resolve(agentId);
    if (!info) continue; // catalog miss — don't surface a bare id
    seen.add(agentId);
    rows.push({ agentId, persona: info.persona, slug: info.slug, modelClass: info.modelClass, addedAt: p.addedAt });
  }
  return rows;
}
