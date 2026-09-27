/**
 * ADR 0553 P3 — the MCP decision audit record.
 *
 * The ADR's Decision § "Authentication first" asks for exactly one thing and
 * bounds it in the same sentence:
 *
 *   > Audit method, server/tool/resource identifier, principal, outcome,
 *   > duration and trace id; never arguments, content or bearer tokens by
 *   > default.
 *
 * Both halves are load-bearing, and the second is the harder one to keep. An
 * MCP refusal is the single most tempting place to log "why" in full — the
 * token that had the wrong audience, the arguments the peer sent, the content
 * it returned — and every one of those is either a credential, attacker-
 * controlled text, or untrusted third-party content that has no business in a
 * durable, tamper-evident chain. So the payload key set is CLOSED and pinned by
 * a test (`mcp-audit-record.test.ts`), the way `run-event-payloads.schema.json`
 * closes `authorizationDecided` and `compensation-operator.test.ts` pins it.
 *
 * NOT A SECOND AUDIT SYSTEM. This writes through `appendAudit`
 * (`host/auditChainService.ts`), the same per-tenant hash chain
 * `authorization.decided`, governance decisions and consent changes use. The
 * only thing this module owns is the SHAPE — which fields an MCP decision
 * contributes and, more importantly, which it may not.
 *
 * `target` is deliberately one field rather than three (`serverId` / `toolName`
 * / `uri`): the ADR names "server/tool/resource identifier" as one concept, and
 * three optional fields would let a caller populate a combination the closed set
 * cannot describe. It is composed HERE, from a server id (operator-curated) and
 * a method-scoped name, so a peer cannot choose what a row looks like.
 */

import { trace } from '@opentelemetry/api';
import { appendAudit } from './auditChainService.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.mcpAudit');

/** The audit-chain `kind` for every MCP decision. One kind, so a reader can
 *  select the whole surface without knowing which refusal fired. */
export const AUDIT_KIND_MCP_DECIDED = 'mcp.decided';

/**
 * The closed outcome vocabulary. `allowed` is the happy path; everything else
 * is a refusal this host made BEFORE or INSTEAD OF talking to a peer.
 *
 * Closed on purpose: an open string would let a call site invent an outcome the
 * dashboards and the retention classifier have never seen, and the value ends up
 * in a durable chain that cannot be rewritten.
 */
export const MCP_AUDIT_OUTCOMES = [
  'allowed',
  'version_refused',
  'downgrade_refused',
  'audience_refused',
  'unauthenticated',
  'cancelled',
] as const;
export type McpAuditOutcome = (typeof MCP_AUDIT_OUTCOMES)[number];

/**
 * The closed reason vocabulary — a CODE, never a message.
 *
 * A free-text reason is how a bearer token or a peer's error prose reaches a
 * durable record, so there is no field for one. When a refusal needs more than
 * a code to diagnose, the place for it is the content-free structured log, not
 * the audit chain.
 */
export const MCP_AUDIT_REASONS = [
  'ok',
  'unsupported_revision',
  'header_absent_legacy_unserved',
  'pinned_profile_not_offered',
  'audience_mismatch',
  'audience_unreadable',
  'anonymous_principal',
  'run_cancelled',
] as const;
export type McpAuditReason = (typeof MCP_AUDIT_REASONS)[number];

/**
 * The CLOSED payload key set. Pinned by `mcp-audit-record.test.ts`, which
 * asserts `Object.keys(payload).sort()` equals exactly this — so adding a field
 * is a deliberate, reviewed act and adding `arguments` / `content` / `token`
 * fails the build rather than the next privacy review.
 */
export const MCP_AUDIT_PAYLOAD_KEYS = [
  'direction',
  'durationMs',
  'method',
  'outcome',
  'principal',
  'reason',
  'target',
  'traceId',
] as const;

export interface McpAuditInput {
  readonly tenantId: string;
  /** `inbound` = a peer calling this host's mount; `outbound` = this host calling a peer. */
  readonly direction: 'inbound' | 'outbound';
  /**
   * The JSON-RPC method.
   *
   * PEER-SUPPLIED on the inbound path — it is read straight off the request
   * body, so it is attacker-controlled text and is bounded below on the way in.
   * (An earlier revision of this comment claimed it was "host vocabulary, never
   * peer-supplied free text", which was false for `routes/mcp.ts`'s version
   * refusal and would have let a peer choose how many bytes an append-only row
   * costs.)
   */
  readonly method: string;
  /** Server id + optional tool/resource name, composed by `mcpAuditTarget`. */
  readonly target: string;
  /** The acting principal id. Opaque (RFC 0048); never an email or a token. */
  readonly principal: string;
  readonly outcome: McpAuditOutcome;
  readonly reason: McpAuditReason;
  readonly durationMs: number;
}

/**
 * Compose the one `target` field. Both halves are host-side identifiers: a
 * server id comes from operator-curated manifest data and a tool/resource name
 * is bounded here, so a peer cannot inflate a row by choosing a long name.
 */
export function mcpAuditTarget(serverId: string, name?: string): string {
  return name ? `${boundAuditString(serverId)}/${boundAuditString(name)}` : boundAuditString(serverId);
}

/** Bound any string that reaches a durable row. A peer does not get to choose
 *  how large an append-only entry is. */
function boundAuditString(v: string): string {
  return v.length > 128 ? `${v.slice(0, 128)}…` : v;
}

/**
 * Write one MCP decision to the audit chain.
 *
 * AWAITED by design where the caller can await it, and never allowed to change
 * the decision: an audit-sink failure that turned a refusal into a 500 would be
 * an availability lever, and one that turned it into a SUCCESS would be far
 * worse. A failed append is logged loudly and the decision stands as made — the
 * same reasoning `recordAuthorizationDecision` gives at
 * `authorityContext.ts:370`, and the same conclusion.
 */
export async function recordMcpAudit(input: McpAuditInput): Promise<void> {
  const traceId = trace.getActiveSpan()?.spanContext().traceId ?? '';
  const payload: Record<string, unknown> = {
    direction: input.direction,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    method: boundAuditString(input.method),
    outcome: input.outcome,
    principal: input.principal,
    reason: input.reason,
    target: input.target,
    traceId,
  };
  try {
    await appendAudit(input.tenantId, AUDIT_KIND_MCP_DECIDED, payload);
  } catch (err) {
    log.error('mcp_audit_append_failed', {
      error: err instanceof Error ? err.message : String(err),
      outcome: input.outcome,
      reason: input.reason,
    });
  }
}
