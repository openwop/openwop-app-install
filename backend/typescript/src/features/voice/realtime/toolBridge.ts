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
import { listManifestAgents } from '../../../host/agentDispatch.js';
import { effectiveToolAllowlist, resolveAgentToolAllowlistOverride } from '../../../host/agentToolAllowlistService.js';
import { resolveAgentIdentity, type AgentIdentity } from '../../../host/agentIdentity.js';
import { sanitizeToolName } from '../../../providers/dispatchProviderTools.js';
import { buildFirewallHook, SENSITIVE_APPROVAL_TOOLS } from '../../../features/capability-firewall/firewallHook.js';
import { getCapabilityRules, getUnknownToolPolicy, getFirewallMode, getDefaultDenyVerdict, getPlatformRules } from '../../../features/capability-firewall/ruleStore.js';
import type { RealtimeToolDecl } from './types.js';

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
function allowlistOf(identity: AgentIdentity | null, override: readonly string[] | undefined): readonly string[] {
  if (!identity) return [];
  const m = listManifestAgents().find((a) => a.agentId === identity.agentId);
  return effectiveToolAllowlist(m?.toolAllowlist, override);
}

async function agentAllowlist(tenantId: string, agentId: string | undefined): Promise<readonly string[]> {
  const identity = await agentIdentityOf(tenantId, agentId);
  if (!identity) return [];
  const override = await resolveAgentToolAllowlistOverride(tenantId, identity.agentId);
  return allowlistOf(identity, override);
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
  for (const name of await agentAllowlist(tenantId, agentId)) {
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
  const name = resolveWireToolName(allowlistOf(identity, override), input.name);
  if (!name) {
    return { status: 'denied', reason: `Tool "${input.name}" is not in this agent's allowlist.` };
  }
  // 2) Capability firewall (composition-aware) + the ADR 0150 SAFE-MODE baseline.
  //    Built ALWAYS (not only when the tenant has rules) so a SENSITIVE tool
  //    (code-exec / file-write / off-host egress) needs approval over voice
  //    exactly as it does over chat — the rule-less path used to skip the hook
  //    entirely, so those actions ran ungated over voice. Evaluated on the
  //    CANONICAL id, so rules + the seen-set match the ids typed-chat uses.
  //    `bypassApproval:false` — a live voice turn has no permission-mode
  //    pre-authorization. A require-approval verdict returns an HONEST, TYPED
  //    refusal the model relays; on the browser-relay transport the client also
  //    shows the in-voice approval card (A7), whose Approve re-invokes this call
  //    with `userApproved` — never a silent execution.
  const [rules, unknownToolPolicy, mode, defaultDenyVerdict, platformRules] = await Promise.all([
    getCapabilityRules(input.tenantId),
    getUnknownToolPolicy(input.tenantId),
    getFirewallMode(input.tenantId),
    getDefaultDenyVerdict(input.tenantId),
    getPlatformRules(),
  ]);
  const fw = buildFirewallHook({
    rules, unknownToolPolicy,
    requireApprovalTools: SENSITIVE_APPROVAL_TOOLS,
    bypassApproval: false,
    // A7 — the human's one-shot card approval for exactly this canonical tool.
    // `approvedTools` downgrades ONLY a require-approval verdict; a hard deny
    // (rules / platform floor) is never bypassed (firewallHook contract).
    ...(input.userApproved ? { approvedTools: new Set([name]) } : {}),
    mode, defaultDenyVerdict, platformRules,
  });
  const verdict = fw.evaluate([...seen(input.sessionId)], name);
  if (verdict.decision === 'deny') return { status: 'denied', reason: verdict.reason ?? 'Blocked by the capability firewall.' };
  if (verdict.decision === 'require-approval') {
    return {
      status: 'requires_approval',
      // Typed, honest refusal for the model (never a silent bypass): the action
      // was NOT performed and needs a human approval the voice lane can't show.
      reason: JSON.stringify({
        error: 'approval_required',
        message: 'this action needs human approval — ask the user to run it from the chat where an approval card can be shown',
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
  );
  return { status: 'ok', result: modelText, ...(out.isError ? { isError: true } : {}) };
}
