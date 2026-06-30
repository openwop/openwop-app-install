/**
 * Real-time voice tool bridge (ADR 0141 RT-2).
 *
 * The realtime model (OpenAI/Gemini) runs the turn, but tool EXECUTION stays host-side so a
 * voice-initiated action is gated exactly like a typed one: the agent's tool allowlist, then
 * the composition-aware Capability Firewall (ADR 0135), then the SAME `executeTool` the chat
 * agent loop uses. The realtime model can only request a call; it cannot bypass host policy.
 *
 * Composition awareness: the firewall evaluates the next tool against the tools already used
 * THIS session (read-drive + send-email ⇒ deny/approve), so we track a per-session seen-set.
 */
import { createAgentToolProvider } from '../../../host/agentToolProvider.js';
import { listManifestAgents } from '../../../host/agentDispatch.js';
import { buildFirewallHook } from '../../../features/capability-firewall/firewallHook.js';
import { getCapabilityRules, getUnknownToolPolicy } from '../../../features/capability-firewall/ruleStore.js';
import type { RealtimeToolDecl } from './types.js';

/** The agent's allowlisted tool names (∅ when the agent has none / isn't found → default-deny). */
function agentAllowlist(agentId: string | undefined): readonly string[] {
  if (!agentId) return [];
  const m = listManifestAgents().find((a) => a.agentId === agentId);
  return m?.toolAllowlist ?? [];
}

/** The realtime tool DECLARATIONS for a session = the agent's allowlist ∩ resolvable builtins. */
export function resolveAgentToolDecls(agentId: string | undefined): RealtimeToolDecl[] {
  const { resolveTool } = createAgentToolProvider({ tenantId: '_decls' });
  const decls: RealtimeToolDecl[] = [];
  for (const name of agentAllowlist(agentId)) {
    const def = resolveTool(name);
    if (def) decls.push({ name: def.name, description: def.description ?? '', parameters: (def.inputSchema as Record<string, unknown>) ?? { type: 'object' } });
  }
  return decls;
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
}): Promise<ToolCallOutcome> {
  // 1) Allowlist (default-deny). The realtime model can request anything; the host only runs
  //    what the scoped agent is permitted (RFC 0002 §A14).
  if (!agentAllowlist(input.agentId).includes(input.name)) {
    return { status: 'denied', reason: `Tool "${input.name}" is not in this agent's allowlist.` };
  }
  // 2) Capability firewall (composition-aware; rule-less tenant ⇒ allow).
  const rules = await getCapabilityRules(input.tenantId);
  if (rules.length > 0) {
    const fw = buildFirewallHook({ rules, unknownToolPolicy: await getUnknownToolPolicy(input.tenantId) });
    const verdict = fw.evaluate([...seen(input.sessionId)], input.name);
    if (verdict.decision === 'deny') return { status: 'denied', reason: verdict.reason ?? 'Blocked by the capability firewall.' };
    if (verdict.decision === 'require-approval') return { status: 'requires_approval', reason: verdict.reason ?? 'This action needs approval.' };
  }
  // 3) Execute via the SAME builtin tool executor the agent loop uses.
  const { executeTool } = createAgentToolProvider({ tenantId: input.tenantId, runId: `voice:${input.sessionId}` });
  const out = await executeTool({ name: input.name, input: input.args });
  seen(input.sessionId).add(input.name);
  return { status: 'ok', result: typeof out.content === 'string' ? out.content : JSON.stringify(out.content), ...(out.isError ? { isError: true } : {}) };
}
