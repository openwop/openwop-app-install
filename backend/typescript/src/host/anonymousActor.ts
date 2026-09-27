/**
 * RFC 0132 (Draft) — anonymous-actor authorization for public agent surfaces.
 * Reference-host PHASE 1 (read tier) + PHASE 2 (bounded-write-egress tier).
 *
 * A public agent surface (the ADR 0127 embeddable chat widget, or the sample
 * conformance seam) dispatches a tool call for a caller with NO account and NO
 * credential. This module is the ONE OWNER of the authorization that lets such a
 * surface act SAFELY — every consumer (the widget tool loop AND the sample
 * host-extension seam) routes through the same primitives here:
 *
 *   - the actor is an OPAQUE, per-session, non-PII, non-cross-linkable principal
 *     (`mintAnonPrincipal`) — never the client sessionId, an IP, or a fingerprint;
 *   - its authority is a DEFAULT-DENY, explicit per-surface grant (`resolveAnonGrant`,
 *     `authorizeAnonTool`) — NEVER the ADR 0315 default-on baseline;
 *   - a READ-tier tool is tenant-scoped, no-egress, no-secrets (`actingUserId`
 *     undefined ⇒ the ADR 0308 deliverable/secret tools fail closed for free);
 *   - a BOUNDED-WRITE-EGRESS tool is permitted ONLY behind a MANDATORY control
 *     (`writeControl:'hitl'` ⇒ the RFC 0051 approval gate; an UNCONTROLLED write is
 *     DENIED `anon-write-ungated`), and an egress MUST ride the SSRF-guarded,
 *     audience-bound path (`guardAnonEgress`) with NO tenant credential attached
 *     out-of-audience (`anon-egress-denied`);
 *   - every tool decision is an RFC 0049 `authorization.decided` record attributable
 *     to the opaque principal, carrying no PII/credential (`emitAnonAuthorizationDecided`
 *     / `anonAuthorizationDecidedPayload`).
 *
 * HONEST-OFF: `OPENWOP_ANON_ACTOR_ENABLED` defaults unset ⇒ the host advertises
 * nothing (`anonymousActorAdvertised`), the sample seam 404s, and every public
 * surface stays on today's runless no-tools dispatch. Mirrors
 * `features/cdp/dataResidency.ts`.
 *
 * @see RFCS/0132-anonymous-actor-authorization.md (§A principal kind, §B capability,
 *      §C two tiers + MUST-NOTs, §D audit)
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { anonOwnerStamp } from './runOwner.js';
import { scoreOnlineEvalsOnTerminal } from './workflowEvalOnline.js';
import { stampRunCostOnTerminal } from '../observability/costEmitter.js';
import { foldWorkflowSpendOnTerminal } from './workflowBudgets.js';
import type { Storage } from '../storage/storage.js';
import type { AiCallMessage, AiToolCallRequest, AiToolCallResult } from '../executor/types.js';
import { buildRunRecord } from './runDispatch.js';
import { compileAgentTools, runChatToolLoop, type AgentEvent } from './agentDispatch.js';
import { createScopedAgentToolProvider } from './agentToolProvider.js';
import { isDeniedWebhookHost } from './webhookEgressGuard.js';
import { getApproval, resolveApproval, reopenApproval, eraseApprovalSubject, registerAnonSurfaceWriteApprovalHandler, type PendingApproval } from './approvalService.js';
import { resolveEffectiveAccess } from './accessControlService.js';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.anonymousActor');

// Re-exported so a consumer that builds an anon-owned run (the widget path here +
// the sample seam) imports the run constructor from THIS one owner alongside the
// authorization primitives, rather than reaching into runDispatch independently.
export { buildRunRecord } from './runDispatch.js';

/** The synthetic workflowId an anon public-surface run carries. The run is NOT a
 *  workflow execution — it is a durable owner + audit anchor for the tool turn. */
export const ANON_SURFACE_WORKFLOW_ID = 'openwop-app.public-anon-surface';

/** RFC 0132 §C — the two anon authority tiers. */
export type AnonTier = 'read' | 'bounded-write-egress';

/** §B/§C.3 — the mandatory controls a host MAY enforce before an anon write/egress.
 *  This host wires `hitl` (the RFC 0051 approval gate). */
export type AnonWriteControl = 'hitl' | 'rate-limit-session-cap';

/**
 * RFC 0132 §C — the NORMALIZED per-surface grant the authorization primitives
 * operate on. `read` + `write` are the EXPLICIT tool allowlists (default-deny — a
 * tool in neither is never granted, never the ADR 0315 baseline). `writeControl`
 * is the mandatory control for the write tier — ABSENT ⇒ writes are uncontrolled
 * and MUST be denied. `egressAudiences` are the destinations an anon egress may
 * reach (§C.3) — a destination outside them is denied, and no credential ever
 * attaches out-of-audience.
 */
export interface AnonSurfaceGrant {
  read: string[];
  write: string[];
  writeControl?: AnonWriteControl;
  egressAudiences?: string[];
}

/** True iff the operator has deliberately enabled anonymous-actor authorization. */
export function anonymousActorEnabled(): boolean {
  return process.env.OPENWOP_ANON_ACTOR_ENABLED === 'true';
}

/**
 * Whether this host advertises the `anonymousActor` capability (§B). Honest-off:
 * the block is OMITTED entirely unless the operator opts in. Mirrors
 * `dataResidencyAdvertised()`.
 */
export function anonymousActorAdvertised(): boolean {
  return anonymousActorEnabled();
}

/**
 * The `capabilities.anonymousActor` advertisement block (§B). This host honors
 * BOTH tiers behaviorally — the read tier (tenant-scoped, no secrets) AND the
 * bounded-write-egress tier behind the `hitl` control (RFC 0051 approval gate) +
 * the SSRF/audience-bound egress guard — so it truthfully advertises both, with
 * `writeEgressControls:['hitl']` (§B.2 requires it non-empty when the write tier is
 * listed). `failClosed` is const-true: an absent/unresolvable grant denies.
 */
export function anonymousActorCapability(): {
  supported: true;
  tiers: ['read', 'bounded-write-egress'];
  writeEgressControls: ['hitl'];
  failClosed: true;
} {
  return { supported: true, tiers: ['read', 'bounded-write-egress'], writeEgressControls: ['hitl'], failClosed: true };
}

/**
 * §A.2/§A.3 — the host secret the per-session principal HMACs against, so the
 * minted id is stable-per-session yet non-reversible + non-forgeable. Operator
 * override via env; else a per-PROCESS random salt (anon principals are ephemeral
 * — session-scoped — so a restart minting fresh ids is correct, not a bug).
 */
const ANON_HMAC_SECRET = process.env.OPENWOP_ANON_ACTOR_HMAC_SECRET || randomBytes(32).toString('hex');

/**
 * §A — mint the OPAQUE, non-PII, non-cross-linkable per-session anon principal.
 * The caller-supplied `surfaceSessionKey` (e.g. `<widgetId>:<sessionId>`) is
 * host-HMAC'd, so the caller INFLUENCES which principal it maps to but can never
 * FORGE a specific value or reach another session's id, and the value embeds no
 * IP/email/fingerprint/third-party identity. Never persisted beyond the session.
 */
export function mintAnonPrincipal(surfaceSessionKey: string): string {
  const mac = createHmac('sha256', ANON_HMAC_SECRET).update(surfaceSessionKey).digest('hex').slice(0, 16);
  return `anon:sess-${mac}`;
}

/** Normalize a list of tool ids: trimmed, non-empty, deduped (order preserved). */
function cleanToolIds(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== 'string') continue;
    const id = t.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * §C.1 — resolve a surface's EXPLICIT grant into the normalized `AnonSurfaceGrant`.
 * DEFAULT-DENY: an unset/malformed grant returns EMPTY read+write sets, and the ADR
 * 0315 default-on baseline is NEVER merged in. Accepts the widget's operator-config
 * shape `{ read?, write?, writeControl?, egressAudiences? }`.
 */
export function resolveAnonGrant(widget: {
  anonToolGrant?: { read?: unknown; write?: unknown; writeControl?: unknown; egressAudiences?: unknown } | undefined;
}): AnonSurfaceGrant {
  const g = widget.anonToolGrant;
  if (!g || typeof g !== 'object') return { read: [], write: [] };
  const grant: AnonSurfaceGrant = { read: cleanToolIds(g.read), write: cleanToolIds(g.write) };
  if (g.writeControl === 'hitl' || g.writeControl === 'rate-limit-session-cap') grant.writeControl = g.writeControl;
  const audiences = cleanToolIds(g.egressAudiences);
  if (audiences.length > 0) grant.egressAudiences = audiences;
  return grant;
}

/** True iff the surface grants ≥1 tool at either tier (⇒ the anon tool path runs;
 *  an empty grant keeps today's runless no-tools dispatch). */
export function anonGrantHasTools(grant: AnonSurfaceGrant): boolean {
  return grant.read.length > 0 || grant.write.length > 0;
}

/**
 * RFC 0132 §A — project the RFC 0048 owner triple + the `principalKind:"anonymous"`
 * witness for an anon-actor run, from the markers `runAnonReadTurn` stamps on
 * `run.metadata`. Returns undefined for any non-anon run (so the run snapshot only
 * grows the `owner` field for anon runs — additive, never for authenticated runs).
 * The single owner of the projection, composed by `projectRunSnapshot`.
 */
export function anonRunOwner(
  run: { tenantId: string; metadata?: Record<string, unknown> },
): { tenant: string; principal: string; principalKind: 'anonymous' } | undefined {
  const md = run.metadata as { principalKind?: unknown; anonPrincipal?: unknown } | undefined;
  if (md?.principalKind === 'anonymous' && typeof md.anonPrincipal === 'string' && md.anonPrincipal.length > 0) {
    return { tenant: run.tenantId, principal: md.anonPrincipal, principalKind: 'anonymous' };
  }
  return undefined;
}

/** RFC 0132 §D — the machine-stable reasons an anon authorization decision carries.
 *  ADR 0469: `anon-write-held`/`-capped` = the HITL hold path (A2/A3);
 *  `anon-write-auto-allowed`/`-auto-capped` = the Phase-D rate-limit-session-cap
 *  path (auto-executed inline under a per-session+per-day cap / denied over it). */
export type AnonAuthorizationReason = 'anon-granted' | 'anon-not-granted' | 'anon-write-ungated' | 'anon-egress-denied' | 'anon-write-held' | 'anon-write-capped' | 'anon-write-auto-allowed' | 'anon-write-auto-capped';

/**
 * RFC 0132 §C — the decision for ONE anon tool call against a surface grant.
 * DEFAULT-DENY:
 *   - a tool in the READ allowlist ⇒ granted (read tier);
 *   - a tool in the WRITE allowlist WITH a resolvable control ⇒ granted (write
 *     tier) but `requiresApproval` — the caller MUST route it through the control
 *     (HITL/approval + the egress guard) before any durable effect;
 *   - a tool in the WRITE allowlist with NO control ⇒ DENIED `anon-write-ungated`;
 *   - a tool in NEITHER list ⇒ DENIED `anon-not-granted` (never the ADR 0315 baseline).
 */
export interface AnonToolAuthorization {
  allowed: boolean;
  reason: AnonAuthorizationReason;
  tier?: AnonTier;
  /** A granted WRITE tool that must pass its mandatory control before executing. */
  requiresApproval?: boolean;
  /** ADR 0469 Phase D — the mandatory control a granted write must ride: `hitl`
   *  (held for approval — A2) or `rate-limit-session-cap` (auto-executed inline
   *  under a per-session+per-day cap — Phase D). The wrapper branches on this. */
  control?: AnonWriteControl;
}

export function authorizeAnonTool(grant: AnonSurfaceGrant, toolName: string): AnonToolAuthorization {
  if (grant.read.includes(toolName)) return { allowed: true, reason: 'anon-granted', tier: 'read' };
  if (grant.write.includes(toolName)) {
    // §C.3 — a write/egress tool is permitted ONLY behind a mandatory control. This
    // host wires `hitl` (approval hold) + `rate-limit-session-cap` (capped auto-run);
    // a surface with no control is exactly the fail-open shape the RFC forbids, denied.
    if (grant.writeControl === 'hitl' || grant.writeControl === 'rate-limit-session-cap') {
      return { allowed: true, reason: 'anon-granted', tier: 'bounded-write-egress', requiresApproval: true, control: grant.writeControl };
    }
    return { allowed: false, reason: 'anon-write-ungated', tier: 'bounded-write-egress' };
  }
  return { allowed: false, reason: 'anon-not-granted' };
}

/** RFC 0132 §C.3 — the outcome of the SSRF-guarded, audience-bound egress guard. */
export interface AnonEgressDecision {
  decision: 'allowed' | 'downgraded' | 'denied';
  reason: string;
  /** ALWAYS false for an anon actor in this host — an anon egress never becomes a
   *  confused deputy for a tenant/host credential (the default credential-free posture). */
  credentialAttached: boolean;
}

/**
 * §C.3 — guard an anon-initiated egress. Composes the host's existing SSRF defense
 * (`isDeniedWebhookHost` — private/loopback/metadata targets) with the RFC 0079
 * audience binding: a destination outside the surface's declared `audiences` is
 * DENIED `out-of-audience`; an in-audience destination is DOWNGRADED to
 * credential-free (an anon actor never rides a tenant BYOK credential). A
 * host-issued/tenant credential is NEVER attached (`credentialAttached:false`).
 */
export function guardAnonEgress(destination: string, audiences: readonly string[]): AnonEgressDecision {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    return { decision: 'denied', reason: 'invalid-url', credentialAttached: false };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { decision: 'denied', reason: 'unsupported-scheme', credentialAttached: false };
  }
  // SSRF: reject private/loopback/link-local/metadata hosts (the same guard the
  // host's webhook + web-research egress use).
  if (isDeniedWebhookHost(url.hostname)) {
    return { decision: 'denied', reason: 'ssrf-blocked', credentialAttached: false };
  }
  // RFC 0079 audience binding: an anon egress to a destination the surface never
  // declared is denied — and no credential ever attaches out-of-audience.
  if (!audiences.some((a) => a === url.hostname)) {
    return { decision: 'denied', reason: 'out-of-audience', credentialAttached: false };
  }
  // In-audience: permitted, but credential-free (the anon default posture).
  return { decision: 'downgraded', reason: 'anon-credential-free', credentialAttached: false };
}

/** A run-event appender scoped to one anon run (RFC 0049 audit sink). */
export type AnonRunEmit = (event: { type: string; payload: Record<string, unknown> }) => Promise<void>;

export interface AnonAuthorizationDecision {
  /** The opaque anon-session principal (§A) — NEVER PII/credential material. */
  principal: string;
  action: string;
  resource: string;
  allowed: boolean;
  reason: AnonAuthorizationReason;
}

/** §D — the closed `authorization.decided` payload shape. The single owner of the
 *  wire shape, shared by the run-event emitter AND the sample seam's inline response
 *  — so no consumer can smuggle a PII/credential key past this projection. */
export function anonAuthorizationDecidedPayload(d: AnonAuthorizationDecision): {
  principal: string; action: string; resource: string; allowed: boolean; reason: AnonAuthorizationReason;
} {
  return { principal: d.principal, action: d.action, resource: d.resource, allowed: d.allowed, reason: d.reason };
}

/**
 * §D — emit an RFC 0049 `authorization.decided` run event attributable to the
 * opaque anon principal. Reuses the existing event shape (no new event type). The
 * payload carries ONLY `{ principal, action, resource, allowed, reason }` — no
 * PII, no credential material (`anon-actor-audit-opaque`).
 */
export async function emitAnonAuthorizationDecided(emit: AnonRunEmit, d: AnonAuthorizationDecision): Promise<void> {
  await emit({ type: 'authorization.decided', payload: anonAuthorizationDecidedPayload(d) });
}

export interface AnonReadTurnParams {
  storage: Storage;
  /** The surface's owner tenant (§C — reads are scoped to it, CTI-1). */
  tenantId: string;
  /** The resolved public agent driving the turn (persona + system prompt). */
  agent: { agentId: string; persona: string; systemPrompt: string };
  /** The resolved EXPLICIT surface grant (`resolveAnonGrant`). Has ≥1 tool by the
   *  time this is called — an empty grant keeps today's runless dispatch. */
  grant: AnonSurfaceGrant;
  /** The per-surface session key the anon principal is minted from (§A). */
  surfaceSessionKey: string;
  /** The untrusted visitor message, ALREADY fenced by the caller (ADR 0027). */
  fencedUserMessage: string;
  /** The tool-call transport (the managed free-tier round in prod; a fake in
   *  tests). Pure DI — this module never reaches for a provider key. */
  callAIWithTools: (r: AiToolCallRequest) => Promise<AiToolCallResult>;
  /** Bound the observe→act loop (default = the loop's own DEFAULT_MAX_TOOL_ROUNDS). */
  maxRounds?: number;
  /** ADR 0469 A2 — DI hook for a GRANTED WRITE behind an approval control: the
   *  caller (the chat-widget `publicGateway`, which owns the widget + caps +
   *  approval store) gates the anon write cap (anti-flood) and creates the durable
   *  hold. This module stays feature-agnostic (no widget/caps/approval import) —
   *  it only invokes the hook and maps the result to the visitor. Absent ⇒ the
   *  legacy stub ("pending_approval", no durable hold) for read-only surfaces/tests. */
  holdGrantedWrite?: (
    call: { name: string; input?: Record<string, unknown> },
    ctx: { runId: string; principal: string; toolCallIdx: number },
  ) => Promise<{ status: 'held' | 'capped' | 'error'; message?: string }>;
  /** ADR 0469 Phase D — DI hook for the `rate-limit-session-cap` control: gate an
   *  anon write against the per-session (+ per-day, defense-in-depth) auto-write cap.
   *  `allowed` ⇒ the wrapper executes the write INLINE (no human gate); over the cap
   *  ⇒ denied. Wired by `publicGateway` (owns the widget + counters); this module
   *  stays feature-agnostic. Only consulted for a pure tenant-write surface — a
   *  surface that declares egress audiences keeps writes on the HITL hold path so no
   *  audience-unbound egress is ever auto-run (architect Q1). */
  autoWriteUnderCap?: (
    call: { name: string; input?: Record<string, unknown> },
    ctx: { runId: string; principal: string },
  ) => Promise<{ allowed: boolean; message?: string }>;
}

export interface AnonReadTurnResult {
  /** The agent's final answer (the ONLY thing the public projection returns). */
  reply: string;
  /** The durable anon run's id (owner.principalKind:'anonymous'). */
  runId: string;
  /** The opaque anon principal the run + audit records are attributed to. */
  principal: string;
}

/**
 * RFC 0132 §C — run one anonymous tool turn for the widget surface.
 *
 * Creates a durable run OWNED by the surface tenant with an OPAQUE anon principal
 * and `principalKind:'anonymous'` (the wire witness), then drives the EXISTING
 * shared tool loop with:
 *   - the tools compiled to EXACTLY the surface grant (read ∪ write; NOT the ADR
 *     0315 baseline);
 *   - `actingUserId` UNDEFINED, so the ADR 0308 deliverable/secret tools fail
 *     closed and no secret/BYOK material is reachable;
 *   - tenant scoped to the surface (CTI-1 — no cross-tenant reach);
 *   - `authorizeAnonTool` enforced per call in the executor wrapper: a READ tool
 *     executes; a granted WRITE tool is HELD behind its control (NOT executed — a
 *     durable write requires the RFC 0051 approval, so the loop is told it is
 *     pending); an UNCONTROLLED write is denied `anon-write-ungated`; a non-granted
 *     tool is refused by the loop and audited `anon-not-granted`.
 *
 * Returns the assistant text only (the caller projects the PUBLIC response).
 */
export async function runAnonReadTurn(params: AnonReadTurnParams): Promise<AnonReadTurnResult> {
  const { storage, tenantId, agent, grant } = params;
  const principal = mintAnonPrincipal(params.surfaceSessionKey);
  const now = new Date().toISOString();

  const run = buildRunRecord({
    workflowId: ANON_SURFACE_WORKFLOW_ID,
    tenantId,
    metadata: { principalKind: 'anonymous', anonPrincipal: principal },
    // RFC 0165 §B (ADR 0625) — the same anon principal as the Subject.
    owner: anonOwnerStamp(principal),
    now,
  });
  // ADR 0604 (TOCC-1, RECORDED NOT FIXED) — this is a DELIBERATE `storage.insertRun`,
  // i.e. the one run-creation path in the host that does NOT go through
  // `insertRunWithStartContext`. ADR 0099 §implementation says "all run creation
  // funnels through one new owner … a new run-creation path inherits the stamp
  // by using the seam"; this lane does not, so an anon run can never carry a
  // frozen `run.metadata.compaction` and tool-output compaction is structurally
  // unavailable here — a second inert lane beside the chat one fixed in
  // `conversationToolLoop.ts`.
  //
  // It is NOT switched to the seam in this batch on purpose. The seam also runs
  // the AUTHORITY contributor, which mints a recorded authority block from
  // `currentAuthority()`; doing that for an ANONYMOUS principal is a
  // security-relevant change that belongs in its own reviewed decision, not in a
  // token-savings fix. Routing anon through the seam (or giving the seam a
  // per-contributor opt-out) is the follow-up.
  await storage.insertRun(run);
  const runId = run.runId;

  const emit: AnonRunEmit = async (event) => {
    await storage.appendEvent({ eventId: randomUUID(), runId, type: event.type, payload: event.payload, timestamp: new Date().toISOString() });
  };
  const resource = `tenant:${tenantId}`;
  const decide = (action: string, allowed: boolean, reason: AnonAuthorizationReason): Promise<void> =>
    emitAnonAuthorizationDecided(emit, { principal, action: `tool:${action}`, resource, allowed, reason });

  // §C.1 — DEFAULT-DENY tool surface: read ∪ write granted tools, compiled against
  // themselves so the set is EXACTLY the grant (never the ADR 0315 baseline).
  // `actingUserId` is intentionally absent (the fail-closed floor).
  const granted = [...grant.read, ...grant.write];
  const toolProvider = createScopedAgentToolProvider({ tenantId, runId });
  const tools = compileAgentTools(
    { agentId: agent.agentId, persona: agent.persona, systemPrompt: agent.systemPrompt, toolAllowlist: granted } as Parameters<typeof compileAgentTools>[0],
    granted,
    toolProvider.resolveTool,
    granted,
  );

  // Per-tool authorization at the execution boundary (§C). A read tool executes; a
  // granted write tool is HELD behind its control (never executed here — the durable
  // write needs the RFC 0051 approval); an uncontrolled write is denied.
  let anonWriteIdx = 0; // ADR 0469 — per-run write index for the deterministic hold key
  const wrappedExecuteTool: typeof toolProvider.executeTool = async (call) => {
    const auth = authorizeAnonTool(grant, call.name);
    await decide(call.name, auth.allowed, auth.reason);
    if (auth.tier === 'read' && auth.allowed) return toolProvider.executeTool(call);
    if (auth.reason === 'anon-write-ungated') {
      return { content: JSON.stringify({ error: 'anon_write_ungated', message: 'This action requires an approval control that is not configured for this public surface.' }), isError: true };
    }
    // ADR 0469 Phase D — `rate-limit-session-cap`: AUTO-EXECUTE the write inline under
    // a per-session (+per-day) cap, NO human gate. Honored ONLY for a pure tenant-write
    // surface — a surface that declares egress audiences keeps writes on the HITL hold
    // path below, so no audience-unbound egress is ever auto-run (architect Q1). The
    // tool still runs tenant-scoped with `actingUserId` undefined (a deliverable/secret
    // tool fails closed — the no-secret floor holds even without a human in the loop).
    const egressDeclared = (grant.egressAudiences?.length ?? 0) > 0;
    if (auth.control === 'rate-limit-session-cap' && !egressDeclared && params.autoWriteUnderCap) {
      const cap = await params.autoWriteUnderCap({ name: call.name, ...(call.input ? { input: call.input } : {}) }, { runId, principal });
      if (!cap.allowed) {
        await decide(call.name, false, 'anon-write-auto-capped');
        return { content: JSON.stringify({ error: 'anon_write_auto_capped', message: cap.message ?? 'This surface has reached its automatic-action limit — tell the visitor to try again later.' }), isError: true };
      }
      await decide(call.name, true, 'anon-write-auto-allowed');
      return toolProvider.executeTool(call);
    }
    // ADR 0469 A2 — a GRANTED write behind a control is HELD for operator review
    // (never executed here — the deferred write runs on approve, A4). The caller's
    // `holdGrantedWrite` hook gates the anti-flood cap + creates the durable hold;
    // it stays feature-agnostic. Absent ⇒ the legacy stub (no durable hold).
    if (params.holdGrantedWrite) {
      const held = await params.holdGrantedWrite({ name: call.name, ...(call.input ? { input: call.input } : {}) }, { runId, principal, toolCallIdx: anonWriteIdx++ });
      if (held.status === 'capped') {
        await decide(call.name, false, 'anon-write-capped');
        return { content: JSON.stringify({ error: 'anon_write_capped', message: held.message ?? 'This surface has reached its limit for queued actions — tell the visitor to try again later.' }), isError: true };
      }
      if (held.status === 'error') {
        return { content: JSON.stringify({ error: 'anon_write_error', message: 'This action could not be queued for review.' }), isError: true };
      }
      await decide(call.name, true, 'anon-write-held');
    }
    return { content: JSON.stringify({ status: 'pending_approval', message: 'This action was requested for human approval and NOT performed. Tell the visitor it is awaiting review.' }), isError: false };
  };

  // §C.1 — a model-requested tool NOT in the grant is refused by the shared loop
  // (`agent.toolReturned{status:'forbidden'}`) and never dispatched; mirror that into
  // an allowed:false `anon-not-granted` audit record. The loop sets no capability-
  // scope/firewall gate, so a `forbidden` here can only mean "not in the grant".
  const onEvent = async (e: AgentEvent): Promise<void> => {
    if (e.type === 'agent.toolReturned' && (e as { status?: unknown }).status === 'forbidden') {
      const toolName = typeof (e as { toolName?: unknown }).toolName === 'string' ? String((e as { toolName?: unknown }).toolName) : 'unknown';
      await decide(toolName, false, 'anon-not-granted');
    }
  };

  const messages: AiCallMessage[] = [{ role: 'user', content: params.fencedUserMessage }];
  const loop = await runChatToolLoop(
    {
      provider: 'openwop-free', model: 'openwop-free', credentialRef: 'managed:openwop-free',
      systemPrompt: agent.systemPrompt,
      messages,
      tools,
      agentId: agent.agentId,
      persona: agent.persona,
      ...(params.maxRounds ? { maxRounds: params.maxRounds } : {}),
      onEvent,
    },
    { callAIWithTools: params.callAIWithTools, executeTool: wrappedExecuteTool },
  );

  const doneAt = new Date().toISOString();
  try {
    await storage.updateRun(runId, { status: loop.error ? 'failed' : 'completed', completedAt: doneAt, updatedAt: doneAt });
    // ADR 0480 (code-review M1) — the anon-widget settle lane is a production
    // terminal the executor sites never see.
    void scoreOnlineEvalsOnTerminal(storage, runId);
    // ADR 0482 grade-fix M1 — its managed-AI spend is money: stamp + fold like
    // every other terminal seam (the anon workflowId isn't budgetable, but the
    // per-node cost record + fleet totals must still count it — no uncounted
    // spend seam if the free tier ever bills).
    void stampRunCostOnTerminal(storage, runId)
      .then((usd) => foldWorkflowSpendOnTerminal(storage, runId, usd));
  } catch (err) {
    log.warn('anon_run_terminal_patch_failed', { runId, error: err instanceof Error ? err.message : String(err) });
  }

  return { reply: loop.finalText, runId, principal };
}

/**
 * ADR 0469 A4 — decide an `anon-surface-write` approval: the DEFERRED execution of
 * the held anon write. On APPROVE, run the held tool tenant-scoped with
 * `actingUserId` UNDEFINED (the ADR 0468 no-secret floor — a secret/deliverable
 * tool fails closed inside the provider) against the SAME opaque anon run that held
 * it, so the audit trail stays attributed to the anon principal. On REJECT, no
 * effect (the write was never performed — nothing to undo).
 *
 * Safety (mirrors `decideEnvironmentPromotion`, the canonical deferred-effect
 * handler): CAS-flip pending→resolved FIRST — `changed` is the at-most-once lock so
 * two concurrent approves never double-execute the (possibly non-idempotent) write —
 * then execute; COMPENSATE (`reopenApproval`) + rethrow if the execution can't
 * complete, so the row never claims "approved" while the write didn't land.
 *
 * Egress note: a held approval is only ever a bounded WRITE. Egress tools are
 * decision-only witnesses at turn time (`decideAnonToolCall` never dispatches them
 * and never holds them), so this deferred path is write-only; a `destination` on the
 * payload (future-proofing) is treated as an un-revalidatable egress and FAILS CLOSED
 * rather than reaching the network without its audience binding.
 */
async function decideAnonSurfaceWrite(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  _opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'anon-surface-write' || !approval.anonSurfaceWrite) {
    return null;
  }

  // RBAC (the claim/reject route enforces NO per-kind scope — every feature handler
  // self-enforces, e.g. `decideEnvironmentPromotion` → host:members:manage). Deciding
  // an anon write TRIGGERS a tenant-scoped write (approve) or terminally resolves it
  // (reject); both require `workspace:write` — the SAME scope `reviewProjection`
  // gates VISIBILITY on. Check BEFORE the CAS flip so an unauthorized decide never
  // consumes the approval. A visibility gate is not a decision gate.
  const decidedBy = _opts.decidedByUserId;
  if (!decidedBy) {
    throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide an approval.', 403, {});
  }
  const access = await resolveEffectiveAccess(tenantId, { subject: decidedBy, ...(approval.orgId ? { orgId: approval.orgId } : {}) });
  if (!(access.scopes as readonly string[]).includes('workspace:write')) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
  }

  // CAS flip pending→resolved; `changed` gates the deferred write so a losing
  // concurrent decide neither double-executes nor double-rejects.
  const lock = await resolveApproval(approvalId, {
    status: outcome,
    ...(_opts.decidedByUserId ? { decidedBy: _opts.decidedByUserId } : {}),
    ...(_opts.note !== undefined ? { note: _opts.note } : {}),
  });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, changed: false };

  if (outcome === 'rejected') {
    // ADR 0470 OQ4 — a DECLINED lead has no ongoing purpose (data minimization): redact
    // its platform-held PII (captured*/tool.args/principal) via the OD4 redactor, keyed
    // by the approval's own opaque principal. The row stays 'rejected' (a PII-free audit
    // record). Best-effort. (The CRM Contact, if any, is the tenant-CONTROLLER's separate
    // record — deliberately NOT cascaded here; a full DSAR-by-email route is the follow-on.)
    await eraseApprovalSubject(tenantId, approval.anonSurfaceWrite.principal).catch(() => {});
    return { approval: lock.approval, changed: true };
  }

  const { runId, tool } = approval.anonSurfaceWrite;
  try {
    // Egress writes can't be revalidated here (no captured audience) — fail closed.
    if (tool.destination) {
      throw new OpenwopError('egress_blocked', 'This queued action cannot be re-authorized for network egress.', 403, { approvalId });
    }
    // Tenant-scoped, actingUserId UNDEFINED (the no-secret floor) — the same posture
    // the held turn ran under. A secret/deliverable tool fails closed in the provider.
    const provider = createScopedAgentToolProvider({ tenantId, runId });
    const result = await provider.executeTool({ name: tool.name, input: tool.args ?? {} });
    if (result.isError) {
      throw new OpenwopError('internal_error', 'The queued action could not be performed.', 500, { approvalId, tool: tool.name });
    }
  } catch (err) {
    await reopenApproval(approvalId); // never claim "approved" when the write didn't land
    throw err;
  }
  // ADR 0470 OQ4 — the write landed: the CRM Contact (via lead.capture → ensureContact)
  // is now the CANONICAL lead record, so the approval's captured*/tool.args PII is a
  // redundant durable copy. Redact it (keyed by the opaque principal) so the approved-
  // lead approval becomes a PII-free audit row (tool + decision + approver + timestamp
  // remain). Best-effort — never fail an already-executed approval on a redaction hiccup.
  await eraseApprovalSubject(tenantId, approval.anonSurfaceWrite.principal).catch(() => {});
  return { approval: lock.approval, changed: true };
}

/** Register the anon-surface-write deferred-execution handler on the core approvals
 *  hook. Called at host boot alongside the other approval gates. */
export function registerAnonSurfaceWriteGate(): void {
  registerAnonSurfaceWriteApprovalHandler(decideAnonSurfaceWrite);
}

/**
 * RFC 0132 §C — the SAMPLE-SEAM per-surface grant. Unlike the widget's
 * `AnonSurfaceGrant` (surface-level `writeControl`/`egressAudiences`), the
 * conformance seam models the grant PER TOOL — each write tool carries its own
 * mandatory control and each egress tool its own audience allowlist — so the
 * single `decideAnonToolCall` witness can express both the controlled and the
 * uncontrolled surface deterministically. Default-deny: a tool in none of the
 * three lists is never granted (never the ADR 0315 baseline).
 */
export interface AnonSeamGrant {
  /** Read-tier tool ids — tenant-scoped, no-egress, no-secrets. */
  read: string[];
  /** Bounded-write tools, each with its MANDATORY control (`none` ⇒ denied). */
  write: { tool: string; control: 'hitl' | 'none' }[];
  /** Egress tools, each bound to the destination hosts it may reach (§C.3). */
  egress: { tool: string; audience: string[] }[];
}

/**
 * RFC 0132 §C — the UNIFIED decision for ONE anon tool call against a seam grant.
 * The single owner of the seam's authorize→egress→dispatch logic (the sample seam
 * owns NO decision logic of its own). `dispatch` is true ONLY for a granted read
 * tool — a bounded-write suspends on `interrupt`, an egress is a decision-only
 * witness (the seam never makes the outbound call), and an ungranted/uncontrolled/
 * out-of-audience tool denies. An anon actor NEVER attaches a credential
 * (`egress.credentialAttached` is const-false).
 */
export interface AnonToolDecision {
  authorization: { principal: string; action: string; resource: string; allowed: boolean; reason: AnonAuthorizationReason };
  egress?: AnonEgressDecision;
  /** RFC 0051 HITL interrupt for a controlled bounded-write (suspends; no result). */
  interrupt?: { kind: 'approval' };
  /** May the tool actually execute here? True only for a granted read tool. */
  dispatch: boolean;
}

/**
 * RFC 0132 §C — decide one anon tool call against an `AnonSeamGrant`. This is a thin
 * ADAPTER, NOT a second decision core: it maps the seam's per-tool grant onto the two
 * authorization owners — `guardAnonEgress` (egress tier) and `authorizeAnonTool`
 * (read/write tiers) — so the decision RULES live in exactly one place and cannot
 * drift from the production widget path. Conformance-pinned outcomes:
 *   - egress tool: `guardAnonEgress` denies `out-of-audience` (or `ssrf-blocked` for a
 *     private/loopback/metadata host) ⇒ `anon-egress-denied`; an in-audience target is
 *     `downgraded` credential-free ⇒ `anon-granted`. Decision-only (no dispatch); no
 *     credential ever attaches.
 *   - bounded-write tool: `control:'none'` ⇒ denied `anon-write-ungated` (no
 *     interrupt); `control:'hitl'` ⇒ allowed `anon-granted` + an approval interrupt
 *     (suspends; no dispatch, no durable write).
 *   - read tool ⇒ allowed `anon-granted`, dispatch.
 *   - else ⇒ denied `anon-not-granted` (never the ADR 0315 baseline).
 */
export function decideAnonToolCall(params: {
  principal: string;
  tenantId: string;
  grant: AnonSeamGrant;
  tool: string;
  args?: Record<string, unknown> | undefined;
  destination?: string | undefined;
}): AnonToolDecision {
  const { principal, tenantId, grant, tool, destination } = params;
  const action = `tool:${tool}`;
  const resource = `tenant:${tenantId}`;
  const authz = (allowed: boolean, reason: AnonAuthorizationReason) => ({ principal, action, resource, allowed, reason });

  // Egress tier — delegate to the ONE audience-bound, SSRF-guarded egress owner.
  const egressEntry = grant.egress.find((e) => e.tool === tool);
  if (egressEntry) {
    const egress = guardAnonEgress(destination ?? '', egressEntry.audience);
    return egress.decision === 'denied'
      ? { authorization: authz(false, 'anon-egress-denied'), egress, dispatch: false }
      : { authorization: authz(true, 'anon-granted'), egress, dispatch: false };
  }

  // Read/write tiers — delegate to the ONE authorization owner. Map the seam's
  // per-tool control onto the surface-grant shape `authorizeAnonTool` reads, using the
  // control of the SPECIFIC write tool being decided.
  const writeEntry = grant.write.find((w) => w.tool === tool);
  const surfaceGrant: AnonSurfaceGrant = {
    read: grant.read,
    write: grant.write.map((w) => w.tool),
    ...(writeEntry?.control === 'hitl' ? { writeControl: 'hitl' as const } : {}),
  };
  const auth = authorizeAnonTool(surfaceGrant, tool);
  const decision: AnonToolDecision = {
    authorization: authz(auth.allowed, auth.reason),
    dispatch: auth.allowed && auth.tier === 'read',
  };
  if (auth.requiresApproval) decision.interrupt = { kind: 'approval' };
  return decision;
}
