/**
 * Territory-scoped CRM record visibility (ADR 0272 P4) — the resolver the
 * `territories` feature registers into the core `crmRecordVisibility` seam. It
 * narrows READ only (WRITE stays org-scoped, ADR 0054 D5); position affects data
 * scope, roles affect capability (preserves ADR 0006's authority-from-roles
 * invariant — a caller still needs `workspace:read` to reach CRM at all).
 *
 * Rule (active model only): a caller sees a company/deal iff they are a MEMBER of,
 * or MANAGE (an ancestor of), a territory the record is assigned to — OR they hold
 * `host:territories:view-all`. No active model ⇒ no scoping (all visible).
 * Fail-closed: no territory match + no override ⇒ not visible.
 *
 * A record not yet materialized (created after activation, before re-sync) is
 * LAZILY evaluated against the active model's rules here, so a fresh record is
 * scoped correctly without waiting for a re-sync (closes the no-CRM-write-hook gap).
 *
 * NOTE: run-context (ctx.features.crm) reads + the run.metadata active-model
 * FREEZE (registerRunStartContributor, replay-safe :fork) land in P5 alongside
 * the workflow surface; P4 enforces the live HTTP read path.
 *
 * @see docs/adr/0272-sales-territory-management.md §4.4
 */

import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { createLogger } from '../../observability/logger.js';
import { setCrmVisibilityResolver, type CrmVisibilityQuery } from '../../host/crmRecordVisibility.js';

const log = createLogger('territories.visibility');
import { getActiveModelRef, listTerritories, type Territory } from './entities/territories.js';
import { listAssignmentsForModel, listRules, orderRules, firstMatch, type AssignmentRule } from './entities/assignment.js';
import type { Deal } from '../crm/entities/deals.js';
import type { Company } from '../crm/entities/companies.js';

/**
 * A1 — per-(tenant,org) assignment index so a CRM list read is O(1) lookups, not
 * 3 collection scans (territories + assignments + rules) every time. Keyed by the
 * ACTIVE model id: a peer instance's activation changes that id, so this instance
 * rebuilds on its next read (multi-instance self-heal). A short TTL bounds
 * cross-instance staleness from a re-sync on the SAME model; `invalidate*` clears
 * it eagerly on this instance after a materialize/reassign. The lazy-eval path
 * (cached rules) still handles records created after the index was built, so a
 * cold/stale index only costs a fallback — never a visibility leak.
 */
interface TerritoryIndex {
  modelId: string;
  assignVersion: number; // cross-instance invalidation stamp (bumped on materialize)
  builtAt: number;
  territories: Territory[];
  dealRules: AssignmentRule[]; // pre-ordered (priority desc)
  companyRules: AssignmentRule[];
  terrOfDeal: Map<string, string>;
  terrOfCompany: Map<string, string>;
}
const INDEX_TTL_MS = 300_000; // 5-min memory backstop; coherence is by (modelId, assignVersion)
const INDEX_MAX = 500; // bound resident memory on a long-lived multi-tenant instance (FIFO evict)
const indexCache = new Map<string, TerritoryIndex>();
// Length-prefixed composite key (matches the entities-layer convention) so
// ('a::b','c') and ('a','b::c') can't collide.
const indexKey = (tenantId: string, orgId: string): string => `${tenantId.length}|${tenantId}|${orgId}`;

/** Drop the cached index for an org (a local eager invalidate after /reassign;
 *  the durable assignVersion is the cross-instance mechanism). */
export function invalidateTerritoryIndex(tenantId: string, orgId: string): void {
  indexCache.delete(indexKey(tenantId, orgId));
}

async function getTerritoryIndex(tenantId: string, orgId: string, modelId: string, assignVersion: number): Promise<TerritoryIndex> {
  const key = indexKey(tenantId, orgId);
  const hit = indexCache.get(key);
  if (hit && hit.modelId === modelId && hit.assignVersion === assignVersion && Date.now() - hit.builtAt < INDEX_TTL_MS) return hit;
  const [territories, assigns, rules] = await Promise.all([
    listTerritories(tenantId, orgId, modelId),
    listAssignmentsForModel(tenantId, orgId, modelId),
    listRules(tenantId, orgId, modelId),
  ]);
  const terrOfDeal = new Map<string, string>();
  const terrOfCompany = new Map<string, string>();
  for (const a of assigns) (a.target === 'deal' ? terrOfDeal : terrOfCompany).set(a.recordId, a.territoryId);
  const idx: TerritoryIndex = { modelId, assignVersion, builtAt: Date.now(), territories, dealRules: orderRules(rules, 'deal'), companyRules: orderRules(rules, 'company'), terrOfDeal, terrOfCompany };
  if (!indexCache.has(key) && indexCache.size >= INDEX_MAX) { const oldest = indexCache.keys().next().value; if (oldest !== undefined) indexCache.delete(oldest); }
  indexCache.set(key, idx);
  log.debug('territory visibility index rebuilt', { tenantId, orgId, modelId, assignVersion, territories: territories.length, assignments: terrOfDeal.size + terrOfCompany.size });
  return idx;
}

/** A caller's territory visibility:
 *  - `visible`: territories they may see records in (member-of ∪ managed subtree);
 *  - `subtree`: territories whose FULL subtree they may see (managed roots + descendants).
 *  The subtree expansion uses its OWN visited guard (`subtree`), NOT `visible` — otherwise
 *  a caller who is both `managerSubjectId` AND a `memberSubjectId` of the same node would
 *  have it pre-added to `visible`, short-circuit the walk, and drop the whole subtree
 *  (Wave-1 review HIGH). */
export function territoryVisibility(territories: Territory[], caller: string): { visible: Set<string>; subtree: Set<string> } {
  const managed: string[] = [];
  const visible = new Set<string>();
  for (const t of territories) {
    if (t.memberSubjectIds.includes(caller)) visible.add(t.territoryId);
    if (t.managerSubjectId === caller) managed.push(t.territoryId);
  }
  const children = new Map<string, string[]>();
  for (const t of territories) if (t.parentTerritoryId) children.set(t.parentTerritoryId, [...(children.get(t.parentTerritoryId) ?? []), t.territoryId]);
  const subtree = new Set<string>();
  const stack = [...managed]; // a manager sees their whole subtree
  while (stack.length) {
    const id = stack.pop()!;
    if (subtree.has(id)) continue; // guard on `subtree`, independent of membership
    subtree.add(id);
    visible.add(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return { visible, subtree };
}

/** The flat set of territories a caller may see records in. */
export function visibleTerritoryIds(territories: Territory[], caller: string): Set<string> {
  return territoryVisibility(territories, caller).visible;
}

async function resolve(q: CrmVisibilityQuery): Promise<ReadonlySet<string>> {
  const { tenantId, orgId, target, records, callerSubject, modelId } = q;
  const all = new Set(records.map((r) => r.recordId));
  if (!callerSubject) return all; // system read

  // Self-gate on toggle STATE (the resolver is registered unconditionally at
  // boot, like routes): territories OFF for this caller ⇒ NO scoping ⇒ allow-all,
  // so the CRM surface is byte-unchanged when the feature is disabled.
  const toggle = await resolveOne('territories', { tenantId, userId: callerSubject });
  if (!toggle || !toggle.enabled) return all;

  const access = await resolveEffectiveAccess(tenantId, { subject: callerSubject, orgId });
  if (!access.scopes.includes('workspace:read')) {
    log.warn('territory visibility fail-closed: caller lacks workspace:read', { tenantId, orgId, target });
    return new Set(); // fail-closed (route also gates)
  }
  if (access.scopes.includes('host:territories:view-all')) return all; // admin override

  // Live HTTP read → resolve the active model + its assignment version in one
  // pointer read; a run-frozen `modelId` uses version -1 (TTL-bounded cache).
  let idxModelId: string;
  let idxVersion: number;
  if (modelId) { idxModelId = modelId; idxVersion = -1; }
  else {
    const ref = await getActiveModelRef(tenantId, orgId);
    if (!ref) return all; // no active model ⇒ territory scoping is inactive
    idxModelId = ref.modelId; idxVersion = ref.assignVersion;
  }

  const idx = await getTerritoryIndex(tenantId, orgId, idxModelId, idxVersion); // A1: cached, not 3 scans/read
  const mine = visibleTerritoryIds(idx.territories, callerSubject);
  const terrOf = target === 'deal' ? idx.terrOfDeal : idx.terrOfCompany;
  const ordered = target === 'deal' ? idx.dealRules : idx.companyRules;

  const visible = new Set<string>();
  for (const { recordId, record } of records) {
    let terr = terrOf.get(recordId);
    if (!terr) terr = firstMatch(ordered, target, record as Deal | Company)?.territoryId; // lazy-eval unmaterialized record
    if (terr && mine.has(terr)) visible.add(recordId);
  }
  return visible;
}

/** Register the resolver at feature boot (called from feature.ts). Idempotent. */
export function registerTerritoryVisibility(): void {
  setCrmVisibilityResolver(resolve);
}
