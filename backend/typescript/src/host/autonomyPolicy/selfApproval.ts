/**
 * ADR 0942 D10.2 — no self-approval on an autonomy gate.
 *
 * The requesting principals of a run are its acting user (`actingUserId`, the
 * person whose request started it), else its causing member, and its RFC 0165 owner. Neither may cast a
 * counting vote on an autonomy gate of that run.
 *
 * > CORRECTED (the sole-admin self-approval ADR, D1, user decision 2026-11-15): this
 * > file used to say there is "no sole-approver escape". There now is ONE, narrow:
 * > `soleAdminSelfApproval` below. A requester may approve their own autonomy gate
 * > only when they are a person voting in their own session, hold the workspace
 * > admin scope, and nobody else could decide the gate; never on a quorum gate,
 * > an MCP-origin run or an attended branch fork. Evaluated at decide time, so a
 * > second admin restores the two-person rule at once. Every use is audited.
 *
 * Identities are compared after canonicalisation: a delegated key resolves to its
 * issuer (`canonicalDecider`, an unresolvable one is treated as the requester —
 * fail closed), and a scheme-prefixed subject to its userId.
 */
import { canonicalDecider, isDelegatedSubject } from '../delegatedSubject.js';
import { canonicalReviewerUserId, resolveEligibleApprovers, type ApproverRefs } from '../approverResolution.js';
import { isRunOwnedBy, type RunSubjectV2 } from '../runOwner.js';
import { hasDistinctScopeHolder, resolveEffectiveAccess } from '../accessControlService.js';
import { selfApprovalBlockedCore } from '../approvalSelfCheck.js';
import { appendAudit } from '../auditChainService.js';
import { createLogger } from '../../observability/logger.js';
import { runAutonomyOf } from './frozen.js';

const log = createLogger('host.autonomy.selfApproval');

/** The workspace admin scope (ADR 0905 D3 precedent: `features/email/sendApproval.ts`). */
export const SOLE_ADMIN_SCOPE = 'host:members:manage';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when the interrupt is an ADR 0942 autonomy gate (its data carries the host-written block). */
export function isAutonomyGateData(data: unknown): boolean {
  return isObj(data) && isObj(data.autonomy) && typeof data.autonomy.actionClass === 'string';
}

/** Is `voter` (or the principal a delegate acts for) one of the run's requesters? */
export async function isAutonomyRequester(
  run: { tenantId: string; metadata?: Record<string, unknown> | null },
  voters: ReadonlyArray<string | undefined>,
): Promise<boolean> {
  const metadata = run.metadata ?? {};
  const actor = typeof metadata.actingUserId === 'string' && metadata.actingUserId.trim() ? metadata.actingUserId : undefined;
  const cause = typeof metadata.orgScopeSubject === 'string' && metadata.orgScopeSubject.trim() ? metadata.orgScopeSubject : undefined;
  // Same actor-else-cause precedence as the run membership floor. This identity
  // only DENIES a vote; it grants no role, credential or notice authority.
  const requester = actor ?? cause;
  const requesters = new Set<string>();
  if (requester) {
    const decider = await canonicalDecider(run.tenantId, requester);
    if (decider === null) return true;
    requesters.add(requester); requesters.add(decider);
    requesters.add(await canonicalReviewerUserId(run.tenantId, decider));
  }
  for (const raw of voters) {
    if (!raw) continue;
    // The opaque owner can name the raw API key rather than its issuer.
    if (isRunOwnedBy(run, raw)) return true;
    const decider = await canonicalDecider(run.tenantId, raw);
    if (decider === null) return true;
    const userId = await canonicalReviewerUserId(run.tenantId, decider);
    if ([raw, decider, userId].some((alias) => requesters.has(alias) || isRunOwnedBy(run, alias))) return true;
  }
  return false;
}

type RunLike = { tenantId: string; metadata?: Record<string, unknown> | null; forkMode?: 'replay' | 'branch' };

export interface SoleAdminQuestion {
  tenantId: string;
  /** The gate's client org, when it is org-scoped (the decide bar is that org). */
  orgId?: string;
  /** The interrupt or approval id, for the record and the logs. */
  gateId: string;
  /** The identity that voted, exactly as received. */
  voter: string;
  /** True only for a person voting through their own interactive session. API keys,
   *  capability tokens, agents, delegates and host lanes pass false. */
  humanSession: boolean;
  /** Every run whose requesters this vote matched (their floors must all allow it). */
  runs: readonly RunLike[];
  /** Extra requester identities beyond the runs' (an approval row's submitters). */
  submitters?: readonly string[];
  /** Who the gate names as approvers; an open gate falls back to "any other admin". */
  refs: ApproverRefs;
  /** A quorum gate (more than one approval required) never gets the escape. */
  quorum: boolean;
  /** `interrupt` or the approval kind, for the audit row. */
  surface: string;
}

export interface SoleAdminRecord { reason: 'sole_admin'; otherApprovers: 0; checkedAt: string }

export type SoleAdminVerdict =
  | { allowed: true; record: SoleAdminRecord }
  | { allowed: false; why: 'not_a_person' | 'quorum' | 'mcp_origin' | 'attended_fork' | 'unresolved' | 'not_admin' | 'other_approver' | 'error' };

const NON_PERSON_PREFIX = /^(agent|bearer|apikey|workload|service|system):/i;

/**
 * Is this the Subject of a person who signed in interactively? Read only from the
 * Subject the auth middleware minted for `req.principal` (`requestSubjectV2`), never
 * from a request field or header: the app's own session, or an OIDC / SAML sign-in.
 * API keys, env keys, test seams and anonymous surfaces are `workload` / `anonymous`.
 */
export function isHumanSignInSubject(subject: RunSubjectV2 | undefined): boolean {
  return !!subject && subject.kind === 'user' && (subject.lane === 'session' || subject.lane === 'oidc' || subject.lane === 'saml');
}

function requesterIdsOf(run: RunLike): string[] {
  const m = run.metadata ?? {};
  return [m.actingUserId, m.orgScopeSubject].filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/**
 * the sole-admin self-approval ADR (D1) — may a requester who was just refused approve anyway, as the only
 * admin? Answers from live membership at decide time; fails closed on any doubt
 * (an unreadable member list counts as "someone else exists").
 */
export async function soleAdminSelfApproval(q: SoleAdminQuestion): Promise<SoleAdminVerdict> {
  // Any failure (a membership read, the audit append) is a refusal, never an escape.
  try {
    return await decideSoleAdmin(q);
  } catch (err) {
    log.error('autonomy_sole_admin_check_failed', { tenantId: q.tenantId, gateId: q.gateId, error: err instanceof Error ? err.message : String(err) });
    return { allowed: false, why: 'error' };
  }
}

async function decideSoleAdmin(q: SoleAdminQuestion): Promise<SoleAdminVerdict> {
  if (!q.humanSession || isDelegatedSubject(q.voter) || NON_PERSON_PREFIX.test(q.voter)) return { allowed: false, why: 'not_a_person' };
  if (q.quorum) return { allowed: false, why: 'quorum' };
  for (const run of q.runs) {
    const { floors } = runAutonomyOf(run);
    if (floors.mcpOrigin) return { allowed: false, why: 'mcp_origin' };
    if (floors.forkPosture === 'attended') return { allowed: false, why: 'attended_fork' };
  }
  const decider = await canonicalDecider(q.tenantId, q.voter);
  if (decider === null) return { allowed: false, why: 'unresolved' };
  const access = await resolveEffectiveAccess(q.tenantId, { subject: decider, ...(q.orgId ? { orgId: q.orgId } : {}) });
  if (!(access.scopes as readonly string[]).includes(SOLE_ADMIN_SCOPE)) return { allowed: false, why: 'not_admin' };
  // The voter is always a submitter here (they were refused as a requester), so the
  // shared ADR 0905 D3 helper reduces to "does anyone else exist?".
  const submitters = [...new Set([q.voter, ...q.runs.flatMap(requesterIdsOf), ...(q.submitters ?? [])])];
  const blocked = await selfApprovalBlockedCore({
    tenantId: q.tenantId, approvalId: q.gateId, decidedBy: q.voter, submitters, logTag: 'autonomy_review',
    otherApproverExists: async (who, exclude) => {
      if (await hasDistinctScopeHolder(q.tenantId, SOLE_ADMIN_SCOPE, who, { ...(q.orgId ? { orgId: q.orgId } : {}), alsoExclude: exclude })) return true;
      try {
        const named = await resolveEligibleApprovers(q.refs, { tenantId: q.tenantId, ...(q.orgId ? { orgId: q.orgId } : {}) }, { includeDelegates: false });
        if (named.openGate) return false;
        const excluded = new Set([who, ...exclude]);
        for (const s of named.subjects) {
          const canon = await canonicalDecider(q.tenantId, s);
          if (!excluded.has(s) && (canon === null || !excluded.has(canon))) return true;
        }
        return false;
      } catch (err) {
        log.error('autonomy_sole_admin_named_lookup_failed', { tenantId: q.tenantId, gateId: q.gateId, error: err instanceof Error ? err.message : String(err) });
        return true;
      }
    },
  });
  if (blocked) return { allowed: false, why: 'other_approver' };
  const record: SoleAdminRecord = { reason: 'sole_admin', otherApprovers: 0, checkedAt: new Date().toISOString() };
  // D2 — the durable record. The decision does not proceed without it.
  await appendAudit(q.tenantId, 'autonomy.self_approval.sole_admin', {
    gateId: q.gateId, surface: q.surface, decider, ...(q.orgId ? { orgId: q.orgId } : {}), ...record,
  });
  log.info('autonomy_sole_admin_self_approval', { tenantId: q.tenantId, gateId: q.gateId, surface: q.surface });
  return { allowed: true, record };
}
