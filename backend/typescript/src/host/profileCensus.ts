/**
 * ADR 0981 P2 — the strict-profile census.
 *
 * Before an operator turns on membership enforcement or the superadmin second
 * factor, they need to know WHO those rules would refuse. Neither answer exists
 * as data at rest: switching into a shared workspace is already membership-gated,
 * so the population enforcement would deny is members whose ROLE lacks a scope
 * and keys whose issuer lost it — a decision, not a list. So the census records
 * the decision the rule WOULD have made on real traffic, while the rule is off,
 * under the strict profile only. It never refuses anything.
 *
 * Recorded: opaque RFC 0048 subjects (`user:<hash>`), tenant ids and scope names.
 * Never a credential, email or token. Per process and since boot: a multi-instance
 * deployment reads one instance's view per request, and the report says so.
 */
import { enterprisePosture } from './deployPosture.js';

/** Re-ask the same (tenant, subject) question at most this often. The
 *  membership decision reads the member index, groups and custom roles, so a
 *  busy caller must not cost that on every protocol request. */
const SAMPLE_TTL_MS = 10 * 60_000;
/** Bounds on what one process remembers — a census, not a log. */
const MAX_SAMPLED = 5_000;
const MAX_RECORDED = 1_000;

interface WouldDeny {
  subject: string;
  tenantId: string;
  scopes: Set<string>;
  basis: string;
  count: number;
  lastSeen: string;
}

const sampledAt = new Map<string, number>();
const wouldDeny = new Map<string, WouldDeny>();
const superadminsWithoutFactor = new Map<string, { count: number; lastSeen: string }>();
const pending = new Set<Promise<void>>();
const startedAt = new Date().toISOString();

function remember<V>(map: Map<string, V>, key: string, value: V, cap: number): void {
  if (!map.has(key) && map.size >= cap) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

/** Should this (tenant, subject, scope) be decided now? False under any profile
 *  but strict, and within the sampling window of the last ask. */
export function shouldSampleMembership(tenantId: string, subject: string | undefined, scope: string): boolean {
  if (!enterprisePosture()) return false;
  const key = `${tenantId}\u0000${subject ?? ''}\u0000${scope}`;
  const now = Date.now();
  const last = sampledAt.get(key);
  if (last !== undefined && now - last < SAMPLE_TTL_MS) return false;
  remember(sampledAt, key, now, MAX_SAMPLED);
  return true;
}

/** Record the outcome of a shadow membership decision. Called off the request
 *  path; an error in the decision is swallowed (a census never fails a request). */
export function recordMembershipShadow(
  tenantId: string,
  subject: string | undefined,
  scope: string,
  decision: Promise<{ allowed: boolean; basis: string }>,
): void {
  const settled = decision
    .then((d) => {
      if (d.allowed) return;
      const who = subject ?? '(anonymous)';
      const key = `${tenantId}\u0000${who}`;
      const prior = wouldDeny.get(key);
      const scopes = prior?.scopes ?? new Set<string>();
      scopes.add(scope);
      remember(wouldDeny, key, {
        subject: who,
        tenantId,
        scopes,
        basis: d.basis,
        count: (prior?.count ?? 0) + 1,
        lastSeen: new Date().toISOString(),
      }, MAX_RECORDED);
    })
    .catch(() => undefined)
    .finally(() => pending.delete(settled));
  pending.add(settled);
}

/** Record a superadmin person acting without a verified second factor while the
 *  requirement is off, under the strict profile only. */
export function recordSuperadminWithoutFactor(subject: string): void {
  if (!enterprisePosture()) return;
  const prior = superadminsWithoutFactor.get(subject);
  remember(superadminsWithoutFactor, subject, {
    count: (prior?.count ?? 0) + 1,
    lastSeen: new Date().toISOString(),
  }, MAX_RECORDED);
}

/** The strict-profile hatches in effect, by NAME only. Operator-only (ADR 0981
 *  Q5): a public reader must not learn which risks were accepted. */
export function profileHatchesInEffect(env: NodeJS.ProcessEnv = process.env): string[] {
  const hatches: string[] = [];
  if (env.OPENWOP_ALLOW_INSECURE_AUTH_POSTURE === 'true') hatches.push('OPENWOP_ALLOW_INSECURE_AUTH_POSTURE');
  if (env.OPENWOP_ALLOW_EPHEMERAL_STORAGE === 'true') hatches.push('OPENWOP_ALLOW_EPHEMERAL_STORAGE');
  if ((env.OPENWOP_ALLOW_INMEMORY_SURFACES ?? '').trim()) hatches.push('OPENWOP_ALLOW_INMEMORY_SURFACES');
  // ADR 0981 P3 — the two rows added on acceptance.
  if (env.OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION === 'true') hatches.push('OPENWOP_ALLOW_UNENFORCED_AUTHORIZATION');
  if (env.OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA === 'true') hatches.push('OPENWOP_ALLOW_SUPERADMIN_WITHOUT_MFA');
  return hatches;
}

export interface ProfileCensusReport {
  profile: 'strict' | 'evaluation';
  hatches: string[];
  window: { scope: 'this-instance'; since: string };
  membership: {
    enforced: boolean;
    wouldDeny: { principals: number; tenants: number; entries: Array<{ subject: string; tenantId: string; scopes: string[]; basis: string; count: number; lastSeen: string }> };
  };
  superadminMfa: {
    required: boolean;
    withoutFactor: { principals: number; entries: Array<{ subject: string; count: number; lastSeen: string }> };
  };
}

/** `enforced`/`required` come from the rules' own owners (`isAuthorizationEnforced`,
 *  `superadminMfaRequired`), passed in so this module imports neither of them. */
export function profileCensusReport(rules: { membershipEnforced: boolean; superadminMfaRequired: boolean }): ProfileCensusReport {
  const entries = [...wouldDeny.values()].map((e) => ({
    subject: e.subject, tenantId: e.tenantId, scopes: [...e.scopes].sort(), basis: e.basis, count: e.count, lastSeen: e.lastSeen,
  }));
  return {
    profile: enterprisePosture() ? 'strict' : 'evaluation',
    hatches: profileHatchesInEffect(),
    window: { scope: 'this-instance', since: startedAt },
    membership: {
      enforced: rules.membershipEnforced,
      wouldDeny: {
        principals: new Set(entries.map((e) => e.subject)).size,
        tenants: new Set(entries.map((e) => e.tenantId)).size,
        entries,
      },
    },
    superadminMfa: {
      required: rules.superadminMfaRequired,
      withoutFactor: {
        principals: superadminsWithoutFactor.size,
        entries: [...superadminsWithoutFactor.entries()].map(([subject, v]) => ({ subject, ...v })),
      },
    },
  };
}

/** Test affordance — wait for in-flight shadow decisions to land. */
export async function _settleProfileCensusForTesting(): Promise<void> {
  await Promise.all([...pending]);
}

/** Test affordance — forget everything recorded. */
export function _resetProfileCensusForTesting(): void {
  sampledAt.clear();
  wouldDeny.clear();
  superadminsWithoutFactor.clear();
}
