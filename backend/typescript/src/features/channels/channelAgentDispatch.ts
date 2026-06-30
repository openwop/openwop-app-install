/**
 * ADR 0154 Phase 4 — dispatch an agent turn when a human channel post addresses
 * an agent member.
 *
 * SERVER-AUTHORITATIVE: a channel has N connected clients, so the turn MUST be
 * fired once by the host (not per client). Exactly-once holds WITHOUT an
 * idempotency claim — each post has a unique messageId handled by one request, and
 * the agent-runner's reply append is idempotent on the runId (so even a crash-
 * recovered re-run can't duplicate); see the inline note on the dispatch loop. The
 * turn rides the shared `startWorkflowRun` → the channels-owned
 * `openwop-app.channel.turn` (a core agent-runner) → the reply is appended into
 * the channel conversation by the agent-runner. SYSTEM-FIRED: no actingUserId, a
 * host-owned managed credential, attribution stamped in `run.metadata.channel`.
 *
 * v1 targeting: an explicit `@<agentId>` token addresses that agent member; with
 * NO token and EXACTLY ONE agent member, that sole agent is the implicit addressee
 * ("a bot in the channel"). Multi-agent `@slug` is deferred (no server-side slug
 * source — ResolvedAgentManifest has no slug). BEST-EFFORT: never throws — a
 * dispatch failure must not fail the human's post (which already persisted).
 */
import { startWorkflowRun, type StartRunDeps } from '../../host/runStarter.js';
import { getConversationMeta } from '../../host/conversationStore.js';
import { CHANNEL_TURN_WORKFLOW_ID, CHANNEL_MANAGED_CREDENTIAL_REF } from './channelTurnWorkflow.js';

const AGENT_PREFIX = 'agent:';

/** Parse `@token`s from a post (e.g. "@research hi" → {"research"}). Lowercased. */
function mentionTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/@([a-z0-9._-]+)/gi)) out.add(m[1].toLowerCase());
  return out;
}

/** Pure targeting (exported for tests): an explicit `@<agentId>` token addresses
 *  that agent member; with no matching token and exactly ONE agent member, that
 *  sole agent is the implicit addressee; otherwise nobody (multi-agent needs an
 *  explicit mention). */
export function selectChannelTurnTargets(agentIds: readonly string[], text: string): string[] {
  if (agentIds.length === 0) return [];
  const tokens = mentionTokens(text);
  const mentioned = agentIds.filter((id) => tokens.has(id.toLowerCase()));
  return mentioned.length > 0 ? mentioned : (agentIds.length === 1 ? [...agentIds] : []);
}

export async function dispatchChannelAgentTurns(
  deps: StartRunDeps,
  tenantId: string,
  channelId: string,
  triggerMessageId: string,
  text: string,
  authorUserId: string | undefined,
): Promise<void> {
  try {
    if (!authorUserId) return; // only a real (human) poster triggers a turn
    const body = text.trim();
    if (!body) return;
    const meta = await getConversationMeta(tenantId, channelId);
    if (!meta || meta.type !== 'channel' || meta.channel?.archived) return;

    const agentIds = (meta.participants ?? [])
      .filter((p) => p.subjectRef.startsWith(AGENT_PREFIX))
      .map((p) => p.subjectRef.slice(AGENT_PREFIX.length));
    if (agentIds.length === 0) return;

    const targets = selectChannelTurnTargets(agentIds, body);
    if (targets.length === 0) return;

    // Exactly-once WITHOUT an idempotency claim: each post has a unique messageId and
    // is handled by exactly one request (this route), so dispatch fires once per
    // (post, agent). A crash-recovered re-run of the SAME run re-uses its runId, and
    // the agent-runner's reply append is idempotent on that runId — so even a re-run
    // can't duplicate the reply. The reply append bypasses this route, so it never
    // re-triggers dispatch. (`triggeringMessageId` is kept in metadata for tracing.)
    for (const agentId of targets) {
      try {
        await startWorkflowRun(deps, {
          tenantId,
          workflowId: CHANNEL_TURN_WORKFLOW_ID,
          // task capped to match the persisted message (channelService caps at 100 KB)
          // so the agent never receives more than what was stored.
          configurable: { agentId, task: body.slice(0, 100_000), conversationId: channelId, credentialRef: CHANNEL_MANAGED_CREDENTIAL_REF },
          metadata: { channel: { source: 'channel', channelId, triggeringMessageId: triggerMessageId, agentId } },
        });
      } catch { /* best-effort per agent */ }
    }
  } catch { /* best-effort — never fail the post */ }
}
