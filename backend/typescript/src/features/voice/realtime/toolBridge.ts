/**
 * Real-time voice tool bridge (ADR 0141 RT-2).
 *
 * The realtime model (OpenAI/Gemini) runs the turn, but tool EXECUTION stays host-side so a
 * voice-initiated action is gated exactly like a typed one: the agent's tool allowlist, then
 * the composition-aware Capability Firewall (ADR 0135), then the SAME `executeTool` the chat
 * agent loop uses. The realtime model can only request a call; it cannot bypass host policy.
 * Firewall parity with the chat loop is WITNESSED, not assumed: `test/safe-mode-egress-
 * gate-implied.test.ts` §D2 (ADR 0724) drives both hook shapes over the same names. (ADR 0724
 * found this sentence had no witness and the egress-class flag was missing here — and that the
 * class gate guards an EMPTY population in every lane; the NAME set is what asks today.)
 *
 * Composition awareness: the firewall evaluates the next tool against the tools already used
 * THIS session (read-drive + send-email ⇒ deny/approve), so we track a per-session seen-set.
 */
import { createAgentToolProvider, createScopedAgentToolProvider } from '../../../host/agentToolProvider.js';
import { toModelToolResult } from '../../../host/toModelToolResult.js';
import { getAgentRegistry } from '../../../executor/agentRegistry.js';
import { resolveAgentToolPermissionSet } from '../../../host/agentProfileService.js';
import { evaluateToolPermissionSet, agentToolPermissionsEnabled } from '../../../host/agentToolPermissions.js';
import { effectiveToolAllowlist, resolveAgentToolAllowlistOverride } from '../../../host/agentToolAllowlistService.js';
import { resolveAgentIdentity, type AgentIdentity } from '../../../host/agentIdentity.js';
import { sanitizeToolName } from '../../../providers/dispatchProviderTools.js';
import { buildLaneFirewall } from '../../../host/laneFirewall.js';
import { resolveConversationToolGate } from '../../../host/conversationToolScope.js';
import { toolAuthorityHolds } from '../../../host/conversationVisibility.js';
import { listToolApprovals, approvedToolSets, recordToolApprovalRequested } from '../../conversation-tools/approvalLedger.js';
import type { RealtimeToolDecl } from './types.js';
import { createLogger } from '../../../observability/logger.js';

const log = createLogger('features.voice.toolBridge');

/** The agent's allowlisted tool names (∅ when the agent has none / isn't found → default-deny).
 *  ADR 0277 — identity-normalized: the manifest allowlist lives on the persona's REGISTRY
 *  projection (`agentRef.agentId`), but a picker-scoped voice session carries the `host:*`
 *  rosterId. The raw-id manifest lookup missed → EVERY roster-scoped session got an empty
 *  allowlist (zero tools), silently. Normalize first (point-get for `host:*`; reverse scan is
 *  fine here — mint + tool-call time, never a per-turn text path). */
async function agentIdentityOf(tenantId: string, agentId: string | undefined): Promise<AgentIdentity | null> {
  if (!agentId) return null;
  return resolveAgentIdentity(tenantId, agentId, { allowReverseScan: true });
}

/** The agent's effective offered tools = the super-admin ADR 0104 override
 *  (full-replace, the operator REVOKE path) when set, else manifest ∪ the ADR
 *  0315 default-on baseline. The override MUST be honored on voice too — both
 *  the decl (offering) and the execute (entitlement) read this, so a revoked
 *  tool is neither declared to the realtime model nor executable. Pure given a
 *  resolved override. */
async function allowlistOf(
  tenantId: string,
  identity: AgentIdentity | null,
  override: readonly string[] | undefined,
): Promise<readonly string[]> {
  if (!identity) return [];
  // ADR 0775 D4 — resolve WITHIN the tenant. The old `listManifestAgents().find`
  // searched every tenant's user agents, and `user.<slug>` ids repeat across
  // tenants (ADR 0379), so a session could be offered — and execute — another
  // tenant's same-named agent's tools (`ARWF-5`). `resolve` answers a pack agent
  // by its bare id and a user agent only under its owner tenant, and reads
  // through to storage on a miss.
  const m = await getAgentRegistry().resolve(identity.agentId, tenantId);
  return effectiveToolAllowlist(m?.toolAllowlist, override);
}

async function agentAllowlist(tenantId: string, agentId: string | undefined): Promise<readonly string[]> {
  const identity = await agentIdentityOf(tenantId, agentId);
  if (!identity) return [];
  const override = await resolveAgentToolAllowlistOverride(tenantId, identity.agentId);
  return allowlistOf(tenantId, identity, override);
}

/** The realtime tool DECLARATIONS for a session = the agent's allowlist ∩ resolvable builtins.
 *  Names go out #578-SANITIZED (provider function names reject `:`/`.` — raw ids like
 *  `openwop:knowledge.search` fail the whole mint/session); the decls are consumed ONLY at
 *  provider egress (the Gemini token setup + the OpenAI session/connect payloads). The model
 *  calls back with the sanitized name; `resolveWireToolName` maps it back to the original id
 *  so allowlist/firewall/executor still see the canonical tool. */
export async function resolveAgentToolDecls(tenantId: string, agentId: string | undefined): Promise<RealtimeToolDecl[]> {
  const { resolveTool } = createAgentToolProvider({ tenantId: '_decls' });
  const decls: RealtimeToolDecl[] = [];
  // Grade-code ARCD-6 — with ADR 0102 enforcement on, do not OFFER a tool the
  // execute side will refuse.
  const identity = agentId && agentToolPermissionsEnabled() ? await agentIdentityOf(tenantId, agentId) : null;
  const perms = identity ? await resolveAgentToolPermissionSet(tenantId, agentId ?? identity.agentId, identity.agentId) : [];
  for (const name of await agentAllowlist(tenantId, agentId)) {
    if (perms.length > 0 && !evaluateToolPermissionSet(name, perms).allowed) continue;
    const def = resolveTool(name);
    if (def) decls.push({ name: sanitizeToolName(def.name), description: def.description ?? '', parameters: (def.inputSchema as Record<string, unknown>) ?? { type: 'object' } });
  }
  return decls;
}

/** Resolve a provider WIRE tool name (possibly #578-sanitized) back to the allowlisted id.
 *  Exact match wins (original ids keep working); else the allowlisted id whose sanitized
 *  form matches. Undefined ⇒ not allowlisted under either spelling (default-deny). Pure. */
export function resolveWireToolName(allowlist: readonly string[], wireName: string): string | undefined {
  if (allowlist.includes(wireName)) return wireName;
  return allowlist.find((a) => sanitizeToolName(a) === wireName);
}

// Per-session seen-tool set (in-memory, same-instance — like the audio buffers). Composition input.
const seenBySession = new Map<string, Set<string>>();
const seen = (sessionId: string): Set<string> => { let s = seenBySession.get(sessionId); if (!s) { s = new Set(); seenBySession.set(sessionId, s); } return s; };
export function clearRealtimeSessionTools(sessionId: string): void { seenBySession.delete(sessionId); }

export type ToolCallOutcome =
  | { status: 'ok'; result: string; isError?: boolean }
  | { status: 'denied'; reason: string }
  | { status: 'requires_approval'; reason: string };

/** Best-effort: a ledger write never breaks the voice turn. */
async function recordHeld(tenantId: string, conversationId: string, toolName: string, origin: 'baseline' | 'policy', args: Record<string, unknown>): Promise<void> {
  try { await recordToolApprovalRequested(tenantId, conversationId, toolName, { origin, input: args }); }
  catch (err) { log.warn('voice_held_tool_record_failed', { toolName, error: err instanceof Error ? err.message : String(err) }); }
}

/** Execute one realtime tool call through the host policy stack. */
export async function executeRealtimeToolCall(input: {
  tenantId: string;
  agentId: string | undefined;
  sessionId: string;
  name: string;
  args: Record<string, unknown>;
  /** ADR 0324 — the session OPENER's durable user id, recovered SERVER-side
   *  (the sideband session / the host session registry), never the client body.
   *  Without it every ADR 0308 deliverable tool (documents.draft,
   *  kanban.add-todo, …) fails closed with `acting_user_required` — the
   *  "voice Iris can't draft" gap this field closes. */
  actingUserId?: string | undefined;
  /** ADR 0627 D3 (review S2) — the opener's personal tenant, host-bound at mint. */
  personalTenant?: string | undefined;
  /** ADR 0324 — the (existence+visibility-gated) conversation the session runs
   *  inside; scope parity with the chat loop's `chatSessionId` (ADR 0309). */
  conversationId?: string | undefined;
  /** ADR 0467 A7 follow-on — the session's HUMAN clicked the in-voice approval
   *  card for THIS tool call. One-shot: downgrades a `require-approval` verdict
   *  for exactly this canonical tool (`approvedTools`), NEVER a hard deny. The
   *  route honors it only for a session with a bound acting user — the card
   *  click is that human's approval, the same authority as the chat card. */
  userApproved?: boolean | undefined;
}): Promise<ToolCallOutcome> {
  // 1) Allowlist (default-deny). The realtime model can request anything; the host only runs
  //    what the scoped agent is permitted (RFC 0002 §A14). The wire name may be the #578-
  //    sanitized form (decls go out sanitized) — resolve it back to the canonical id first;
  //    unresolvable under either spelling ⇒ not allowlisted ⇒ deny.
  const identity = await agentIdentityOf(input.tenantId, input.agentId);
  // ADR 0104 — honor the super-admin override on the ENTITLEMENT side too, so a
  // revoked tool can't execute over voice even if a stale decl reached the model.
  const override = identity ? await resolveAgentToolAllowlistOverride(input.tenantId, identity.agentId) : undefined;
  const allowlist = await allowlistOf(input.tenantId, identity, override);
  const name = resolveWireToolName(allowlist, input.name);
  if (!name) {
    return { status: 'denied', reason: `Tool "${input.name}" is not in this agent's allowlist.` };
  }
  // 1b) ADR 0102 per-tool permissions — ADR 0775 D3 (architect H1): the voice
  //     lane never evaluated them, so a roster agent's `never` list was bypassed
  //     here even with enforcement on. Same resolver + set evaluation + flag as
  //     the typed loop (`agentDispatch.runChatToolLoop`), keyed by the id the
  //     session was ADDRESSED by (a `host:` id names the exact member).
  if (identity) {
    const perms = await resolveAgentToolPermissionSet(input.tenantId, input.agentId ?? identity.agentId, identity.agentId);
    const perm = evaluateToolPermissionSet(name, perms);
    if (!perm.allowed) {
      const enforcing = agentToolPermissionsEnabled();
      log.info('agent_tool_permission_denied', { agentId: identity.agentId, toolName: name, reason: perm.reason, enforced: enforcing, lane: 'voice' });
      if (enforcing) return { status: 'denied', reason: `Tool "${name}" is blocked by this agent's guardrails (${perm.reason}).` };
    }
  }
  // 1c) ADR 0834 D5 — the CONVERSATION's tool scope, through the ONE resolver the chat
  //     loop uses. Voice runs tools inside the same conversation, and never applied it:
  //     a tool the owner disabled (or held, or put out of mandate with an intent
  //     ledger) stayed callable here. The ledger's decisions fold only for the owner's
  //     own session — the owner approved the tool for their actions, not a participant's.
  let approvedTools: Set<string> | undefined;
  let approvedBaselineTools: Set<string> | undefined;
  if (input.conversationId) {
    const approvals = await listToolApprovals(input.tenantId, input.conversationId);
    const gate = await resolveConversationToolGate({
      tenantId: input.tenantId, conversationKey: input.conversationId, ceiling: allowlist, approvals,
      foldApprovalsOnlyFor: input.actingUserId ?? '',
    });
    if (gate.scope && !gate.scope.enabled.includes(name)) {
      return { status: 'denied', reason: `Tool "${name}" is not enabled for this conversation.` };
    }
    if (gate.scope?.requireApproval.includes(name)) {
      await recordHeld(input.tenantId, input.conversationId, name, 'policy', input.args);
      return { status: 'requires_approval', reason: JSON.stringify({ error: 'approval_required', message: 'this conversation requires approval for this tool — ask the user to approve it from the chat' }) };
    }
    // FW2-CD-6 — the ONE authority predicate (`toolAuthorityHolds`). The opener's id here
    // is the durable user; if it ever differs from the owner's stamp key the fold is
    // skipped (fail-safe: the owner is asked again), never widened.
    if (toolAuthorityHolds(input.actingUserId, gate.ownerUserId)) {
      ({ approvedTools, approvedBaselineTools } = approvedToolSets(approvals));
    }
  }
  // 2) Capability firewall (composition-aware) + the safe-mode baseline, built by the
  //    ONE lane factory (ADR 0834 D1). Evaluated on the CANONICAL id, so rules + the
  //    seen-set match the ids typed-chat uses. No permission-mode pre-authorization on a
  //    live voice turn (`bypass` absent). A held verdict returns an HONEST, TYPED refusal
  //    the model relays; on the browser-relay transport the client also shows the
  //    in-voice approval card (A7), whose Approve re-invokes this call with
  //    `userApproved`. ADR 0834 D2: that one-shot card is client-asserted, so it answers
  //    only the user's own safe-mode ask (`baseline`) — never a tenant/platform/enforce
  //    ask, which needs a ledger approval from the conversation's owner.
  if (input.userApproved) (approvedBaselineTools ??= new Set()).add(name);
  const { hook: fw } = await buildLaneFirewall({
    tenantId: input.tenantId, lane: 'voice',
    ...(approvedTools ? { approvedTools } : {}),
    ...(approvedBaselineTools ? { approvedBaselineTools } : {}),
    resource: input.conversationId ?? `voice:${input.sessionId}`,
    dedupeKey: input.sessionId,
  });
  const verdict = fw.evaluate([...seen(input.sessionId)], name);
  if (verdict.decision === 'deny') return { status: 'denied', reason: verdict.reason ?? 'Blocked by the capability firewall.' };
  if (verdict.decision === 'require-approval') {
    // ADR 0834 D6 — a held voice call lands in the conversation's ledger, so the owner
    // can approve it from the chat's pending-approval notice (the place the message
    // below sends the user).
    if (input.conversationId) await recordHeld(input.tenantId, input.conversationId, name, verdict.origin ?? 'baseline', input.args);
    return {
      status: 'requires_approval',
      // Typed, honest refusal for the model (never a silent bypass): the action
      // was NOT performed and needs a human approval the voice lane can't show.
      reason: JSON.stringify({
        error: 'approval_required',
        message: 'this action needs human approval — ask the user to approve it in the chat, then ask again',
        ...(verdict.reason ? { detail: verdict.reason } : {}),
      }),
    };
  }
  // 3) Execute via the SAME builtin tool executor the agent loop uses.
  // ADR 0277 P2 — the profile id scopes the knowledge tools to the agent's
  // bound collections (absent ⇒ tenant-wide, the agent-less legacy behavior).
  // ADR 0324 — the scope is composed by the ONE composer the chat tool loop
  // uses, so the fail-closed fields (actingUserId, conversationId) stay in
  // parity across transports by construction.
  const { executeTool } = createScopedAgentToolProvider({
    tenantId: input.tenantId, runId: `voice:${input.sessionId}`,
    ...(identity ? { agentProfileId: identity.profileId } : {}),
    ...(input.actingUserId ? { actingUserId: input.actingUserId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.personalTenant ? { personalTenant: input.personalTenant } : {}),
  });
  const out = await executeTool({ name, input: input.args });
  seen(input.sessionId).add(name);
  // RFC 0137 §F1 — this result goes to a realtime MODEL, and this path does NOT
  // go through `runChatToolLoop`, so it needs the fence explicitly. Applied
  // before the stringify so the fence wraps the text the model reads.
  const modelText = toModelToolResult(
    name,
    typeof out.content === 'string' ? out.content : JSON.stringify(out.content),
    out.isError,
    // TOC2CD-14 — a caught throw's message is arbitrary text: always fenced.
    // TOC2CD-11 — a `toolError` helper vouched for the error's host `message`.
    {
      ...(out.fromThrow ? { fromThrow: true, ...(out.errorCode ? { code: out.errorCode } : {}) } : {}),
      ...(out.hostMessage ? { hostVouched: true } : {}),
    },
  );
  return { status: 'ok', result: modelText, ...(out.isError ? { isError: true } : {}) };
}
