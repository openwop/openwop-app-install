/**
 * Subject display resolution (ADR 0192 D2) — the ONE place a subjectRef
 * (`user:<id>` / `agent:<id>`, ADR 0041) becomes a human-readable display name
 * for roster / message / presence projections. Raw refs must never render as UI.
 *
 * Shaped like the `subjectOrgScope` / `subjectAccess` seams: CORE defines the
 * seam, the OWNING FEATURE registers the resolver (feature→core; core never
 * imports the feature). The `user:*` identity owner is the users service
 * (ADR 0002/0003 — `User.displayName`, PII-declared, keyed by the same userId
 * the ref carries → POINT lookups, no collection scans on hot paths).
 * accessControl members are deliberately NOT consulted: `OrgMember` is
 * org-scoped with an optional subject binding, while channels are
 * membership-governed and tenant-scoped (the architect finding 3/4 boundary).
 *
 * `agent:*` resolves from the participant's add-time `displayLabel` when the
 * caller has it (zero reads), else the optional agent-label resolver, else a
 * humanized id tail — never the raw ref.
 */

import type { SubjectRef } from './conversationStore.js';

export interface SubjectDisplay {
  kind: 'user' | 'agent' | 'other';
  displayName: string;
  /** Set when no resolver knew the subject and `displayName` is the humanized
   *  id tail. In-app rosters show it; a public surface (the blog byline)
   *  omits it, because a hash means nothing to an anonymous reader. */
  fallback?: true;
}

type UserDisplayResolver = (tenantId: string, userIds: readonly string[]) => Promise<Map<string, string>>;
/** ADR 0379 P2 — tenant-threaded (aligning with UserDisplayResolver): user
 *  agents live under the (tenant, agentId) registry key, so a label lookup
 *  without the tenant would silently miss them. */
type AgentLabelResolver = (tenantId: string, agentIds: readonly string[]) => Promise<Map<string, string>>;

/** Display names for the HOST OPERATOR's own accounts, looked up without a
 *  tenant: only users whose personal tenant is on the
 *  `OPENWOP_SUPERADMIN_TENANTS` allowlist resolve, everyone else is absent. */
type OperatorDisplayResolver = (userIds: readonly string[]) => Promise<Map<string, string>>;

let userResolver: UserDisplayResolver | null = null;
let operatorResolver: OperatorDisplayResolver | null = null;
let agentResolver: AgentLabelResolver | null = null;

/** The users feature registers this at init (ADR 0192 D2). */
export function setUserDisplayResolver(fn: UserDisplayResolver): void {
  userResolver = fn;
}

/** The users feature registers this at init. Used ONLY by the system site's
 *  public byline (the operator's own marketing site, where only superadmins
 *  author): a tenant-scoped lookup cannot see the operator, whose user record
 *  lives in their personal tenant, not in `host:site`. */
export function setOperatorDisplayResolver(fn: OperatorDisplayResolver): void {
  operatorResolver = fn;
}

/** Resolve user ids to display names for allowlisted operators only. Absent
 *  resolver or any failure → an empty map (the caller shows no name). */
export async function resolveOperatorDisplayNames(userIds: readonly string[]): Promise<Map<string, string>> {
  if (!userIds.length || !operatorResolver) return new Map();
  return operatorResolver(userIds).catch(() => new Map<string, string>());
}

/** Optional — a registry-backed agent-label lookup for agent members whose
 *  participant record predates `displayLabel` stamping. */
export function setAgentLabelResolver(fn: AgentLabelResolver): void {
  agentResolver = fn;
}

/** Humanize an id tail as the last-resort display ("north-star-42" → "north-star-42",
 *  `oidc:a1b2…` hash → its first 8 chars). Deliberately short + stable. */
function fallbackName(ref: SubjectRef): string {
  // ADR 0593 §C9 (review F5 / `CMSA-13`) — strip EVERY leading kind prefix, not
  // just the first. `userRef` is a naive `` `user:${id}` `` and `User.userId` is
  // itself `user:<32-hex>` on this host, so callers routinely build
  // `user:user:<hex>`. Stripping one prefix then returned `user:<hex>` — THE RAW
  // INTERNAL PRINCIPAL — which is precisely what this module's header promises
  // can never happen, and it reached an anonymous RSS `<dc:creator>`.
  //
  // The double prefix is accidentally LOAD-BEARING for the lookup itself (the
  // users resolver is keyed on the full `user:<hex>` userId, which is what the
  // single strip yields), so "just stop double-prefixing" would break name
  // resolution everywhere. The honest fix is here, at the seam that makes the
  // promise: normalize the tail rather than trusting its shape.
  let tail = ref;
  for (;;) {
    const next = tail.replace(/^(?:user|agent|other):/, '');
    if (next === tail) break;
    tail = next;
  }
  // A hash-looking tail (no separators, long) truncates; a slug-ish tail keeps.
  return /^[a-f0-9]{16,}$/i.test(tail) ? tail.slice(0, 8) : tail;
}

/**
 * Batch-resolve display names for a set of refs. `knownAgentLabels` lets the
 * caller pass participant `displayLabel`s it already holds (zero extra reads).
 * Absent resolvers degrade to fallbacks — never a raw ref, never a throw.
 */
export async function resolveSubjectDisplays(
  tenantId: string,
  refs: readonly SubjectRef[],
  knownAgentLabels?: ReadonlyMap<string, string>,
): Promise<Map<SubjectRef, SubjectDisplay>> {
  const out = new Map<SubjectRef, SubjectDisplay>();
  const userIds: string[] = [];
  const agentIdsToResolve: string[] = [];

  for (const ref of new Set(refs)) {
    if (ref.startsWith('user:')) {
      userIds.push(ref.slice('user:'.length));
    } else if (ref.startsWith('agent:')) {
      const agentId = ref.slice('agent:'.length);
      const known = knownAgentLabels?.get(agentId);
      if (known) out.set(ref, { kind: 'agent', displayName: known });
      else agentIdsToResolve.push(agentId);
    } else {
      out.set(ref, { kind: 'other', displayName: fallbackName(ref), fallback: true });
    }
  }

  const [userNames, agentNames] = await Promise.all([
    userIds.length && userResolver ? userResolver(tenantId, userIds).catch(() => new Map<string, string>()) : Promise.resolve(new Map<string, string>()),
    agentIdsToResolve.length && agentResolver ? agentResolver(tenantId, agentIdsToResolve).catch(() => new Map<string, string>()) : Promise.resolve(new Map<string, string>()),
  ]);

  for (const id of userIds) {
    const ref = `user:${id}`;
    const name = userNames.get(id);
    out.set(ref, name ? { kind: 'user', displayName: name } : { kind: 'user', displayName: fallbackName(ref), fallback: true });
  }
  for (const id of agentIdsToResolve) {
    const ref = `agent:${id}`;
    const name = agentNames.get(id);
    out.set(ref, name ? { kind: 'agent', displayName: name } : { kind: 'agent', displayName: fallbackName(ref), fallback: true });
  }
  return out;
}

