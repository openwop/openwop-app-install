/**
 * RFC 0154 §D — the authority facts an action was taken under, and the ambient
 * context that carries them (ADR 0556 P3).
 *
 * ADR 0556's decision reads: "Every outbox/A2A/MCP/sandbox/compensation action
 * records both actor and workload identities in the existing audit/provenance
 * owners." This module is the ONE place those two identities live together, and
 * the one place they are turned into a record.
 *
 * ── Content-free, and what that costs ───────────────────────────────────────
 * Every field here is an opaque id, an enum, or an integer — the `auth.md` §D
 * audit-fact vocabulary and the `observability.md` §"Identity and delegation
 * attributes" span vocabulary, which are deliberately the same list. No subject,
 * no issuer URL, no token, no chain. The chain in particular is reduced to its
 * DEPTH before it gets here: `observability.md` states "the chain itself is
 * never an attribute", and a depth is the part an operator can act on.
 *
 * ── Two sinks, deliberately ─────────────────────────────────────────────────
 * An authorization DECISION (a workload credential resolved or refused) goes to
 * the durable per-tenant hash chain, `auditChainService.appendAudit` — it is a
 * security event, it is low-frequency, and tamper evidence is the point.
 *
 * A per-ACTION record (an effect, an A2A call, an MCP call, a sandbox execution,
 * a compensation action) goes to the structured log and the active span. It does
 * NOT go to the hash chain, and that is a decision rather than an oversight: the
 * chain serializes per tenant behind a CAS + mutex, so routing every node effect
 * through it would serialize the executor on the audit log. The span is the
 * correlated record; the chain is the tamper-evident one.
 *
 * ── Replay ──────────────────────────────────────────────────────────────────
 * `authorityForReplay` is the widening guard. ADR 0556: "Replay uses the
 * recorded authority facts and does not remint broader authority." A replay
 * re-executes history under the authority that history was created with, and the
 * only safe combination with the replaying caller's own authority is an
 * INTERSECTION — see the function's own note for why a union is the bug this
 * exists to make impossible.
 *
 * @see spec/v1/auth.md §D · spec/v1/observability.md §"Identity and delegation attributes"
 * @see docs/adr/0556-production-metrics-workload-identity-and-assurance-operations.md (P3)
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';
import { createLogger } from '../observability/logger.js';
import { recordAuthzDecision } from '../observability/metricSeams.js';
import { appendAudit } from './auditChainService.js';
import { registerRunStartContributor } from './runStartContext.js';
import type {
  AudienceDecision,
  IssuerClass,
  ResolvedWorkloadPrincipal,
  SenderConstraintMethod,
  WorkloadIdentityScheme,
  WorkloadRefusalCause,
  WorkloadRefusalReason,
} from './workloadIdentity.js';
import type { Scope } from './accessControlService.js';

const log = createLogger('host.authority');

/** The seams that record an action's authority. Closed so a new seam is a
 *  deliberate addition to this list rather than a free-form string. */
export const AUTHORITY_SEAMS = ['effect', 'dispatch', 'a2a', 'mcp', 'sandbox', 'compensation'] as const;
export type AuthoritySeam = (typeof AUTHORITY_SEAMS)[number];

/**
 * Who acted, and as what.
 *
 * `actor` and `workload` are BOTH present for a worker: the actor is the
 * principal whose authority the action runs under, the workload is the process
 * that executed it. ADR 0556's context section is explicit that "user identity,
 * worker identity and the authority delegated to a run must not collapse into
 * one bearer or log label", and keeping them as two fields is the mechanical
 * form of that.
 */
export interface AuthorityFacts {
  /** Opaque effective-principal id (`openwop.actor.principal`). */
  readonly actor: string;
  readonly actorKind: 'user' | 'workload' | 'agent' | 'service' | 'anonymous';
  /** Opaque workload-principal id (`workload:<scheme>:<hash>`), when a workload
   *  identity was verified for this action. */
  readonly workload?: string;
  readonly scheme?: WorkloadIdentityScheme;
  readonly issuerClass?: IssuerClass;
  readonly senderConstraint: SenderConstraintMethod | 'none';
  readonly delegationDepth: number;
  readonly onBehalfOf?: string;
  readonly scopes: readonly Scope[];
  readonly audienceDecision?: AudienceDecision;
  /**
   * True when these facts were READ from a run's recorded authority rather than
   * minted for this execution. A replay's facts are recorded facts; anything
   * else would be a fresh grant wearing history's clothes.
   */
  readonly recorded: boolean;
  /** Links the span to the `authorization.decided` audit fact. Not a trace id. */
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<AuthorityFacts>();

/** Run `fn` with `facts` as the ambient authority. */
export function runWithAuthority<T>(facts: AuthorityFacts, fn: () => T): T {
  return storage.run(facts, fn);
}

/** The ambient authority, or `undefined` outside any authority scope. */
export function currentAuthority(): AuthorityFacts | undefined {
  return storage.getStore();
}

/** Build facts from a resolved workload principal. */
export function authorityFromWorkload(
  principal: ResolvedWorkloadPrincipal,
  correlationId: string,
): AuthorityFacts {
  return {
    actor: principal.onBehalfOf ?? principal.principalId,
    actorKind: principal.onBehalfOf ? 'service' : 'workload',
    workload: principal.principalId,
    scheme: principal.scheme,
    issuerClass: principal.issuerClass,
    senderConstraint: principal.senderConstraint,
    delegationDepth: principal.delegationDepth,
    ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
    scopes: principal.scopes,
    audienceDecision: principal.audienceDecision,
    recorded: false,
    correlationId,
  };
}

/**
 * The authority a REPLAY runs under.
 *
 * The rule is one line in ADR 0556 — "replay uses the recorded authority facts
 * and does not remint broader authority" — and one operation here: intersect.
 *
 * Why not a union, which is what an implementation reaches for when the replay's
 * caller "obviously" has to be able to run the replay: a union hands the replay
 * every scope the replaying caller holds, so a caller with `runs:create` replays
 * a run recorded under `runs:read` and the recorded effects re-fire with
 * authority the original never had. That is authority laundering through the
 * fork endpoint, and it is invisible — the replay succeeds, which is what it was
 * supposed to do.
 *
 * Why not the recorded set alone: a caller who has since LOST a scope would
 * still exercise it by replaying, so the recorded set is a ceiling and the
 * current caller's set is a second ceiling. The intersection respects both.
 *
 * `delegationDepth` and `recorded` come from the record, never from the caller:
 * the depth describes a chain that was verified once, and re-deriving it from
 * the replaying request would describe a different chain.
 */
export function authorityForReplay(recorded: AuthorityFacts, current: AuthorityFacts | undefined): AuthorityFacts {
  const currentScopes = new Set<string>(current?.scopes ?? recorded.scopes);
  return {
    ...recorded,
    scopes: recorded.scopes.filter((s) => currentScopes.has(s)),
    recorded: true,
    correlationId: current?.correlationId ?? recorded.correlationId,
  };
}

// ── Recording authority ON the run (replay's source of truth) ──────────────

/** Where a run's recorded authority lives in `run.metadata`. */
export const RUN_AUTHORITY_METADATA_KEY = 'authority';

/**
 * The ADR 0099 run-start contributor that freezes the ambient authority into the
 * new run's metadata.
 *
 * `stampRunStartContext` merges WITHOUT overwriting an existing key, and that
 * property is exactly what makes replay correct here: a `:fork`-copied
 * `authority` survives, so a replay re-executes under the authority the original
 * run recorded rather than under whatever the replaying request happens to
 * carry. The rule is not implemented by remembering to check `forkMode` at each
 * call site — it falls out of the merge.
 *
 * Fail-soft per the contributor contract: a run with no ambient authority (an
 * ordinary user request, which is most of them) contributes nothing, and the
 * absence is honest — there was one identity, not two.
 */
export function authorityRunStartContributor(): Promise<Record<string, unknown>> {
  const facts = storage.getStore();
  if (!facts) return Promise.resolve({});
  return Promise.resolve({ [RUN_AUTHORITY_METADATA_KEY]: serializeAuthority(facts) });
}

let stampingWired = false;

/**
 * Register the run-start contributor. Idempotent — `createApp` runs many times
 * in a test suite, and a contributor list that grew per app would stamp the same
 * key N times (harmless, but the kind of harmless that stops being harmless).
 */
export function wireAuthorityRunStamping(): void {
  if (stampingWired) return;
  stampingWired = true;
  registerRunStartContributor(authorityRunStartContributor);
}

/** The content-free wire form stored on a run. Deliberately the same field set
 *  as the span attributes: one vocabulary, two carriers. */
interface StoredAuthority {
  readonly actor: string;
  readonly actorKind: AuthorityFacts['actorKind'];
  readonly workload?: string;
  readonly scheme?: WorkloadIdentityScheme;
  readonly issuerClass?: IssuerClass;
  readonly senderConstraint: SenderConstraintMethod | 'none';
  readonly delegationDepth: number;
  readonly onBehalfOf?: string;
  readonly scopes: readonly string[];
  readonly correlationId: string;
}

function serializeAuthority(facts: AuthorityFacts): StoredAuthority {
  return {
    actor: facts.actor,
    actorKind: facts.actorKind,
    ...(facts.workload ? { workload: facts.workload } : {}),
    ...(facts.scheme ? { scheme: facts.scheme } : {}),
    ...(facts.issuerClass ? { issuerClass: facts.issuerClass } : {}),
    senderConstraint: facts.senderConstraint,
    delegationDepth: facts.delegationDepth,
    ...(facts.onBehalfOf ? { onBehalfOf: facts.onBehalfOf } : {}),
    scopes: [...facts.scopes],
    correlationId: facts.correlationId,
  };
}

/**
 * The `authority` value a FORK/REPLAY should carry — `authorityForReplay`
 * applied and re-serialized.
 *
 * Exists so the fork route performs the narrowing through the same function the
 * rest of the host reasons about, rather than open-coding an intersection at the
 * one call site where getting it wrong is a privilege escalation.
 */
export function forkAuthorityMetadata(
  recorded: AuthorityFacts,
  current: AuthorityFacts | undefined,
): Record<string, unknown> {
  return { ...serializeAuthority(authorityForReplay(recorded, current)) };
}

/**
 * Read a run's recorded authority back.
 *
 * `recorded: true` on the way out, always. These facts describe a decision that
 * was made once, in the past, by a resolver that saw a credential this process
 * no longer has — treating them as freshly minted is what "does not remint
 * broader authority" forbids, and the flag is what lets a downstream record say
 * which it was.
 */
export function readRecordedAuthority(metadata: Record<string, unknown> | undefined): AuthorityFacts | undefined {
  const raw = metadata?.[RUN_AUTHORITY_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null) return undefined;
  const a = raw as Partial<StoredAuthority>;
  if (typeof a.actor !== 'string' || typeof a.correlationId !== 'string') return undefined;
  return {
    actor: a.actor,
    actorKind: a.actorKind ?? 'workload',
    ...(a.workload ? { workload: a.workload } : {}),
    ...(a.scheme ? { scheme: a.scheme } : {}),
    ...(a.issuerClass ? { issuerClass: a.issuerClass } : {}),
    senderConstraint: a.senderConstraint ?? 'none',
    delegationDepth: typeof a.delegationDepth === 'number' ? a.delegationDepth : 0,
    ...(a.onBehalfOf ? { onBehalfOf: a.onBehalfOf } : {}),
    scopes: Array.isArray(a.scopes) ? (a.scopes as readonly Scope[]) : [],
    recorded: true,
    correlationId: a.correlationId,
  };
}

/**
 * The content-free projection of an authority fact — the exact attribute set
 * `observability.md` §"Identity and delegation attributes" names, and the exact
 * payload shape `auth.md` §D allows on an audit fact.
 *
 * ONE function so the span, the log line and the audit payload can never carry
 * different fields, and so adding a field is a decision made here rather than at
 * five call sites.
 */
export function authorityAttributes(facts: AuthorityFacts): Record<string, string | number> {
  return {
    'openwop.actor.principal': facts.actor,
    'openwop.actor.kind': facts.actorKind,
    ...(facts.onBehalfOf ? { 'openwop.actor.on_behalf_of': facts.onBehalfOf } : {}),
    ...(facts.scheme ? { 'openwop.identity.scheme': facts.scheme } : {}),
    ...(facts.issuerClass ? { 'openwop.identity.issuer_class': facts.issuerClass } : {}),
    'openwop.identity.sender_constraint': facts.senderConstraint,
    'openwop.delegation.depth': facts.delegationDepth,
    ...(facts.audienceDecision ? { 'openwop.authz.audience_decision': facts.audienceDecision } : {}),
    'openwop.authz.correlation_id': facts.correlationId,
  };
}

/**
 * Record that `seam` acted under the ambient authority.
 *
 * A no-op when there is no ambient authority, which is the honest behaviour: a
 * seam reached from a plain request that carried no workload credential has one
 * identity, not two, and inventing a workload id for it would make the record
 * say something false. Synchronous — every call site is on a hot path, and one
 * of them (`assertEffectAllowed`) cannot await.
 */
export function recordAuthorityAction(seam: AuthoritySeam, outcome: 'attempt' | 'allow' | 'deny'): void {
  const facts = storage.getStore();
  if (!facts) return;
  const attrs = { ...authorityAttributes(facts), 'openwop.authz.scope_decision': outcome === 'deny' ? 'deny' : 'allow' };
  trace.getActiveSpan()?.setAttributes(attrs);
  log.info('authority.action', { seam, outcome, replayed: facts.recorded, ...attrs });
  // ADR 0556 P4 — the same decision, aggregated. Emitted from the SAME call as
  // the span attribute and the log line, for the reason the effect seam gives
  // for its own trio: a record attached anywhere else could describe a decision
  // that did not happen, or miss one that did. `seam` is deliberately NOT a
  // label — it is open-ended (`effect`, `dispatch`, `sandbox`, and whatever is
  // added next), and the P0 lint's whole point is that the dangerous label is
  // the one whose value set grows without anyone deciding to grow it.
  recordAuthzDecision(outcome, facts.issuerClass);
}

/**
 * The durable `authorization.decided` audit fact for a workload-identity
 * decision (`auth.md` §D — the corpus carrier is
 * `authorization.decided { principal, action, resource, allowed, reason }`).
 *
 * `reason` carries the closed refusal code and the content-free
 * `depth=/issuer=/audience=` tokens §D permits, and NOTHING else. Awaited by
 * every caller: this is the security record of a security decision, and a
 * fire-and-forget append on a serverless runtime is a record that may never be
 * written (the detached-continuation failure this repo has already paid for).
 */
export async function recordAuthorizationDecision(input: {
  readonly tenantId: string;
  readonly principal: string;
  readonly action: string;
  readonly resource?: string;
  readonly allowed: boolean;
  readonly reason: WorkloadRefusalReason | 'resolved';
  readonly cause?: WorkloadRefusalCause;
  readonly delegationDepth: number;
  readonly issuerClass?: IssuerClass;
  readonly audienceDecision: AudienceDecision;
  readonly senderConstraint: SenderConstraintMethod | 'none';
  readonly correlationId: string;
}): Promise<void> {
  const reason = [
    input.reason,
    `depth=${input.delegationDepth}`,
    `issuer=${input.issuerClass ?? 'unknown'}`,
    `audience=${input.audienceDecision}`,
    `constraint=${input.senderConstraint}`,
    ...(input.cause ? [`cause=${input.cause}`] : []),
  ].join(' ');
  try {
    await appendAudit(input.tenantId, 'authorization.decided', {
      principal: input.principal,
      action: input.action,
      ...(input.resource ? { resource: input.resource } : {}),
      allowed: input.allowed,
      reason,
      correlationId: input.correlationId,
    });
  } catch (err) {
    // An audit-sink failure must not become an authentication oracle (a caller
    // able to tell "audit down" from "identity refused" learns something), so it
    // is logged loudly and the decision stands as already made by the resolver.
    log.error('authorization_decided_audit_failed', {
      error: err instanceof Error ? err.message : String(err),
      allowed: input.allowed,
    });
  }
}
