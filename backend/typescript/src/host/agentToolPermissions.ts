/**
 * Per-tool read/write permission gate (ADR 0101 Phase 4 / ADR 0102).
 *
 * The agent-profile `permissions` (ADR 0031) are an allowlist of the tool/action
 * classes an agent may touch: `read` + `write` are the positive allowlist,
 * `never` is the hard deny. ADR 0036 already enforces `never` at the heartbeat +
 * assistant ACTION-CLASS seams; this is the finer PER-TOOL-CALL gate that ADR
 * 0036 deferred to "a toolHooks follow-on (RFC 0064)".
 *
 * This module is the PURE evaluator — the same compose-don't-fork shape as
 * `agentPolicyResolver`. It owns no store and no I/O; the caller passes the
 * agent's `permissions` (resolved from its profile) and the tool name. Its
 * verdict composes with the RFC 0064 `evaluateToolHook` scope/rate gate at the
 * call site; it is NOT baked into that normative evaluator.
 *
 * Matching model (ADR 0102): a permission token matches a tool name on an exact
 * or dotted-namespace-PREFIX basis — token `crm` covers `crm.field.update`,
 * token `crm.read` covers only `crm.read` (and any `crm.read.*`). This lets the
 * seed lists (`crm.read`, `kanban.card.write`, …) and coarser namespace tokens
 * both work.
 *
 * Fail-OPEN when an agent declares NO positive allowlist (`read` + `write` both
 * empty/absent): an agent that hasn't opted into tool allowlisting is unchanged
 * (its tools are governed only by the `never` deny + the §A14 manifest allowlist).
 * Fail-CLOSED once it opts in: with a non-empty allowlist, a tool off the list is
 * denied. `never` always wins.
 *
 * Activation: this gate is wired at the live tool-loop chokepoint behind the
 * `OPENWOP_AGENT_TOOL_PERMISSIONS_ENABLED` env flag (default OFF) — see ADR 0102
 * for why live default-on awaits validation of real tool-call names against the
 * seeded permission ids.
 *
 * @see docs/adr/0102-per-tool-permission-enforcement.md
 * @see src/host/agentPolicyResolver.ts — the action-class sibling (ADR 0036)
 */

export interface ToolPermissions {
  read?: string[];
  write?: string[];
  never?: string[];
}

export type ToolPermissionReason = 'never' | 'not-allowlisted' | 'allowlisted' | 'ungated';

export interface ToolPermissionVerdict {
  allowed: boolean;
  reason: ToolPermissionReason;
}

/** True when a permission `token` covers `toolName`: an exact match, or a
 *  dotted-namespace prefix (`crm` ⊇ `crm.field.update`). A bare prefix never
 *  matches across a non-dot boundary (`crm` does NOT match `crmx.foo`). */
export function tokenMatches(token: string, toolName: string): boolean {
  return toolName === token || toolName.startsWith(`${token}.`);
}

/**
 * Resolve whether `toolName` is permitted for an agent with these `permissions`.
 * Pure + side-effect-free. Composition (most→least restrictive):
 *   1. `never` ⊇ toolName            → DENY (`never`), short-circuits.
 *   2. empty/absent positive allowlist → ALLOW (`ungated`) — opt-in, unchanged.
 *   3. `read ∪ write` ⊇ toolName     → ALLOW (`allowlisted`).
 *   4. otherwise                      → DENY (`not-allowlisted`), fail-closed.
 */
export function evaluateToolPermission(
  toolName: string,
  permissions: ToolPermissions | null | undefined,
): ToolPermissionVerdict {
  if (!permissions) return { allowed: true, reason: 'ungated' };

  const never = permissions.never ?? [];
  if (never.some((t) => tokenMatches(t, toolName))) {
    return { allowed: false, reason: 'never' };
  }

  const allowlist = [...(permissions.read ?? []), ...(permissions.write ?? [])];
  if (allowlist.length === 0) {
    // No positive allowlist declared → the agent hasn't opted into tool
    // allowlisting; its tools are unchanged (governed only by `never` above).
    return { allowed: true, reason: 'ungated' };
  }

  return allowlist.some((t) => tokenMatches(t, toolName))
    ? { allowed: true, reason: 'allowlisted' }
    : { allowed: false, reason: 'not-allowlisted' };
}

/** Whether the live per-tool permission gate is enabled (ADR 0102). Default OFF
 *  until real agent tool-call names are validated against the seeded permission
 *  ids — see the ADR's activation gate. Read per-call so a deploy can flip it
 *  without a rebuild (mirrors the rate-limit env knobs). */
export function agentToolPermissionsEnabled(): boolean {
  return process.env.OPENWOP_AGENT_TOOL_PERMISSIONS_ENABLED === 'true';
}
