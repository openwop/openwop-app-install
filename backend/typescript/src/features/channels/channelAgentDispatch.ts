/**
 * ADR 0154 Phase 4 / ADR 0192 D1 — dispatch an agent turn when a human channel
 * post addresses an agent member.
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
 * Targeting (ADR 0192 D1 — corrects the ADR 0154 deferral): an explicit
 * `@<mention-slug>` token (persisted on the participant at membership time —
 * what the composer autocomplete inserts) OR a raw `@<agentId>` token addresses
 * that agent member; with NO matching token and EXACTLY ONE agent member, that
 * sole agent is the implicit addressee ("a bot in the channel"). BEST-EFFORT:
 * never throws — a dispatch failure must not fail the human's post (which
 * already persisted).
 *
 * TWIN RECALL IS STRUCTURALLY DENIED ON THIS LANE — a DECISION, not a gap
 * (RCL-4 adjacent note, ADR 0589 §D2). Because these runs are SYSTEM-FIRED
 * with no `actingUserId`, `resolveBorrowedRecall`'s audience gate denies them
 * (`audience-no-caller`): a granted twin @mentioned in a channel answers
 * WITHOUT its owner's memory. That is the correct fail-closed posture — a
 * channel post lands in a workspace-visible conversation, and D2's rationale
 * (owner-only audience; an unattributed dispatch is the same exposure with
 * less information about it) applies with full force. Do not thread the
 * POSTER's id in as the acting user to "fix" this: the poster is generally
 * not the twin's owner, and the reply is visible to the whole channel.
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

/** An addressable agent member: its id, the ADR 0192 D1 mention slug persisted
 *  at membership time (absent on legacy members, which match by id only), and
 *  the ADR 0202 D1 reply policy (absent on legacy members → derived). */
export interface AgentMentionTarget { agentId: string; mentionSlug?: string | undefined; responsePolicy?: 'all' | 'mention' | undefined }

/** ADR 0202 D1 — the EFFECTIVE reply policy, DERIVED read-only (no write): a
 *  stamped policy wins; an unstamped agent is `'all'` iff it is the sole agent
 *  (the pre-0200 invisible sole-agent rule), else `'mention'`. */
function effectivePolicy(agent: AgentMentionTarget, agentCount: number): 'all' | 'mention' {
  return agent.responsePolicy ?? (agentCount === 1 ? 'all' : 'mention');
}

/** Pure targeting (exported for tests): an explicit `@<slug>` or `@<agentId>`
 *  token addresses that agent member; with no matching token, every agent whose
 *  EFFECTIVE policy is `'all'` replies (ADR 0202 D1); a `'mention'`-policy agent
 *  needs an explicit mention. */
export function selectChannelTurnTargets(agents: readonly (AgentMentionTarget | string)[], text: string): string[] {
  const rows: AgentMentionTarget[] = agents.map((a) => (typeof a === 'string' ? { agentId: a } : a));
  if (rows.length === 0) return [];
  // An empty post (an attachment-only envelope, ADR 0192 D5) addresses nobody —
  // without this, an 'all'-policy agent would fire a paid run with an empty task
  // on every caption-less attachment.
  if (!text.trim()) return [];
  const tokens = mentionTokens(text);
  const mentioned = rows
    .filter((a) => tokens.has(a.agentId.toLowerCase()) || (a.mentionSlug !== undefined && tokens.has(a.mentionSlug.toLowerCase())))
    .map((a) => a.agentId);
  if (mentioned.length > 0) return mentioned;
  // No explicit mention → every effective-'all' agent replies (ADR 0202 D1).
  return rows.filter((a) => effectivePolicy(a, rows.length) === 'all').map((a) => a.agentId);
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

    const agents = (meta.participants ?? [])
      .filter((p) => p.subjectRef.startsWith(AGENT_PREFIX))
      .map((p) => ({ agentId: p.subjectRef.slice(AGENT_PREFIX.length), mentionSlug: p.mentionSlug, responsePolicy: p.responsePolicy }));
    if (agents.length === 0) return;

    const targets = selectChannelTurnTargets(agents, body);
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
          // task capped so the agent never receives more than what was stored.
          configurable: { agentId, task: body.slice(0, 100_000), conversationId: channelId, credentialRef: CHANNEL_MANAGED_CREDENTIAL_REF },
          metadata: { channel: { source: 'channel', channelId, triggeringMessageId: triggerMessageId, agentId } },
        });
      } catch { /* best-effort per agent */ }
    }
  } catch { /* best-effort — never fail the post */ }
}
