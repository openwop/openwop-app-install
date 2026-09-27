/**
 * `demo-territories` seeder (app-seeding-strategy.md §4 Phase 6, ADR 0272).
 *
 * The sales org over the Phase-3 CRM: 3 territory types, 1 ACTIVE model + 1
 * planning model (demonstrating the one-active-pointer CAS), 8 territories in a
 * 2-level hierarchy (West/East → metros) whose managers/members are the seeded
 * reps, 6 first-match-wins assignment rules over company region/industry, and 4
 * quarters of quotas per leaf with rep splits — then a reassignment so
 * `/attainment` shows real numbers against the Phase-3 deals.
 * `dependsOn: ['demo-people','demo-crm']`.
 *
 * Toggle-gated on `territories`; skips honestly (never flips). Territory/type/
 * model entities have no delete API and (mostly) no `createdBy`, so clear scopes
 * by the demo MODELS (which do carry createdBy) and cascades via tenant-indexed
 * direct handles — leaving no orphans.
 */
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import { getUserByPrincipal } from '../features/users/usersService.js';
import {
  createType, listTypes,
  createModel, listModels, activateModel, getActiveModelId,
  createTerritory, listTerritories,
} from '../features/territories/entities/territories.js';
import { createRule, listRules, reassignActiveModel } from '../features/territories/entities/assignment.js';
import { setQuota, computeAttainment } from '../features/territories/entities/quota.js';
import { personPrincipal } from './seed-data/solsticeDemo.js';

const log = createLogger('seed.demoTerritories');

export const DEMO_TERR_ACTOR = 'demo:territories';
const ACTIVE_MODEL = 'FY26 Territory Plan';
const PLANNING_MODEL = 'FY27 Planning (draft)';

// Direct handles for the no-delete stores (clear-time only).
const territoryStore = new DurableCollection<{ territoryId: string; tenantId: string; modelId?: string }>('crm:territory', (t) => t.territoryId, undefined, (t) => t.tenantId);
const modelStore = new DurableCollection<{ modelId: string; tenantId: string; createdBy?: string }>('crm:territory-model', (m) => m.modelId, undefined, (m) => m.tenantId);
const activeStore = new DurableCollection<{ pointerId: string; tenantId: string; modelId?: string }>('crm:territory-active', (p) => p.pointerId, undefined, (p) => p.tenantId);
const assignmentStore = new DurableCollection<{ assignmentId: string; tenantId: string; modelId?: string }>('crm:territory-assignment', (a) => a.assignmentId, undefined, (a) => a.tenantId);
const ruleStore = new DurableCollection<{ ruleId: string; tenantId: string; modelId?: string }>('crm:territory-rule', (r) => r.ruleId, undefined, (r) => r.tenantId);
const quotaStore = new DurableCollection<{ quotaId: string; tenantId: string; modelId?: string }>('crm:territory-quota', (q) => q.quotaId, undefined, (q) => q.tenantId);

const TYPES = [
  { name: 'Region', priority: 30 },
  { name: 'Segment', priority: 20 },
  { name: 'Named Accounts', priority: 10 },
];

/** 2 roots + 6 metros. Each metro: manager + members (rep slugs) and the
 *  region/industry the assignment rule routes to it. */
const ROOTS = [
  { name: 'West', manager: 'marcus-chen' },
  { name: 'East', manager: 'marcus-chen' },
];
const METROS: { name: string; parent: 'West' | 'East'; rep: string; region: 'West' | 'East'; industry: string }[] = [
  { name: 'Pacific Northwest', parent: 'West', rep: 'priya-nair', region: 'West', industry: 'Grocery' },
  { name: 'California', parent: 'West', rep: 'dana-reyes', region: 'West', industry: 'Hospitality' },
  { name: 'Southwest', parent: 'West', rep: 'priya-nair', region: 'West', industry: 'Food & Beverage' },
  { name: 'Northeast', parent: 'East', rep: 'tomas-okafor', region: 'East', industry: 'Hospitality' },
  { name: 'Southeast', parent: 'East', rep: 'sofia-lindqvist', region: 'East', industry: 'Grocery' },
  { name: 'Midwest', parent: 'East', rep: 'tomas-okafor', region: 'East', industry: 'Food & Beverage' },
];
const QUARTERS = ['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'];

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}

export async function countDemoTerritories(tenantId: string): Promise<number> {
  const demoModelIds = new Set((await modelStore.listForTenantIndexed(tenantId)).filter((m) => m.createdBy === DEMO_TERR_ACTOR).map((m) => m.modelId));
  return (await territoryStore.listForTenantIndexed(tenantId)).filter((t) => t.modelId && demoModelIds.has(t.modelId)).length;
}

export async function seedDemoTerritories(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  if (!(await resolveOne('territories', { tenantId }))?.enabled) {
    return { created: 0, details: { skipped: 'territories feature is off' } };
  }
  const orgId = await orgIdFor(tenantId);
  let created = 0;

  const subjectOf = async (slug: string): Promise<string> => {
    const u = await getUserByPrincipal(tenantId, personPrincipal(slug));
    return u?.userId ?? `${DEMO_TERR_ACTOR}:${slug}`;
  };

  // Types (guard by name).
  const existingTypeNames = new Set((await listTypes(tenantId, orgId)).map((t) => t.name));
  const typeIdByName = new Map<string, string>((await listTypes(tenantId, orgId)).map((t) => [t.name, t.territoryTypeId]));
  for (const t of TYPES) {
    if (existingTypeNames.has(t.name)) continue;
    const created0 = await createType(tenantId, orgId, { name: t.name, priority: t.priority }, DEMO_TERR_ACTOR);
    typeIdByName.set(t.name, created0.territoryTypeId);
    created += 1;
  }
  const regionTypeId = typeIdByName.get('Region');

  // Active-plan model (create if missing).
  const models = await listModels(tenantId, orgId);
  const plan = models.find((m) => m.name === ACTIVE_MODEL && m.createdBy === DEMO_TERR_ACTOR)
    ?? await (async () => { created += 1; return createModel(tenantId, orgId, { name: ACTIVE_MODEL }, DEMO_TERR_ACTOR); })();

  const activeId = await getActiveModelId(tenantId, orgId);
  // Build territories/rules/quotas only while the plan is still planning (editable).
  if (activeId !== plan.modelId) {
    const existingTerr = new Map<string, string>((await listTerritories(tenantId, orgId, plan.modelId)).map((t) => [t.name, t.territoryId]));
    // Roots.
    for (const r of ROOTS) {
      if (existingTerr.has(r.name)) continue;
      const t = await createTerritory(tenantId, orgId, plan.modelId, { name: r.name, ...(regionTypeId ? { territoryTypeId: regionTypeId } : {}), parentTerritoryId: null, managerSubjectId: await subjectOf(r.manager) }, DEMO_TERR_ACTOR);
      existingTerr.set(r.name, t.territoryId); created += 1;
    }
    // Metros (leaves).
    for (const m of METROS) {
      if (existingTerr.has(m.name)) continue;
      const rep = await subjectOf(m.rep);
      const t = await createTerritory(tenantId, orgId, plan.modelId, { name: m.name, ...(regionTypeId ? { territoryTypeId: regionTypeId } : {}), parentTerritoryId: existingTerr.get(m.parent) ?? null, managerSubjectId: rep, memberSubjectIds: [rep] }, DEMO_TERR_ACTOR);
      existingTerr.set(m.name, t.territoryId); created += 1;
    }
    // Assignment rules — first-match-wins. Two flavours so BOTH surfaces light up:
    // company rules route accounts by region+industry (the row-visibility carve),
    // and deal rules route by owner (rep) so /attainment has weighted pipeline to
    // sum. (Attainment reads DEAL assignments; a company-only rule set leaves it
    // empty — the reason both are seeded.)
    const haveRules = (await listRules(tenantId, orgId, plan.modelId)).length > 0;
    if (!haveRules) {
      // A deal rule is `owner eq rep` (first-match-wins). Two metros share a rep
      // (Priya: Pacific NW + Southwest; Tomás: Northeast + Midwest), so a deal
      // rule on BOTH would shadow the lower-priority metro (review #1359 LOW).
      // Give each rep exactly one deal rule (their first metro); every metro still
      // gets a company rule (region+industry is already distinct per metro).
      const repHasDealRule = new Set<string>();
      for (const [i, m] of METROS.entries()) {
        const territoryId = existingTerr.get(m.name);
        if (!territoryId) continue;
        const rep = await subjectOf(m.rep);
        await createRule(tenantId, orgId, plan.modelId, {
          territoryId, target: 'company', priority: 100 - i,
          filter: { all: [{ field: 'customFields.region', op: 'eq', value: m.region }, { field: 'industry', op: 'eq', value: m.industry }] },
        });
        created += 1;
        if (!repHasDealRule.has(rep)) {
          repHasDealRule.add(rep);
          await createRule(tenantId, orgId, plan.modelId, {
            territoryId, target: 'deal', priority: 100 - i,
            filter: { field: 'owner', op: 'eq', value: rep },
          });
          created += 1;
        }
      }
    }
    // Quotas — 4 quarters per leaf, split to the metro's rep.
    for (const m of METROS) {
      const territoryId = existingTerr.get(m.name);
      if (!territoryId) continue;
      const rep = await subjectOf(m.rep);
      for (const [qi, period] of QUARTERS.entries()) {
        const amount = 40000 + qi * 8000;
        await setQuota(tenantId, orgId, plan.modelId, territoryId, { period, amount, currency: 'USD', repSplits: [{ subjectId: rep, amount }] });
      }
      created += 1; // one quota set per leaf (review #1359 LOW — was under-counted)
    }
    // Activate the plan ONLY when the single active pointer is free or already
    // ours (review #1359 HIGH). If a FOREIGN model is active, leave the demo plan
    // as planning — activating would CAS-swap the pointer and archive the user's
    // real active sales-org model (archived models can't be re-activated). The
    // honest outcome on that tenant is empty attainment, not a destroyed model.
    if (activeId === null || activeId === plan.modelId) {
      await activateModel(tenantId, orgId, plan.modelId, DEMO_TERR_ACTOR);
    }
  }

  // Materialize assignments + verify attainment ONLY when OUR plan is the active
  // model — never re-materialize / bump assignVersion on a user's active model.
  if ((await getActiveModelId(tenantId, orgId)) === plan.modelId) {
    await reassignActiveModel(tenantId, orgId);
    await computeAttainment(tenantId, orgId, plan.modelId).catch(() => undefined);
  }

  // The standing planning model (stays planning — demonstrates one-active).
  if (!models.some((m) => m.name === PLANNING_MODEL && m.createdBy === DEMO_TERR_ACTOR)) {
    await createModel(tenantId, orgId, { name: PLANNING_MODEL }, DEMO_TERR_ACTOR);
    created += 1;
  }

  const details = { types: TYPES.length, territories: ROOTS.length + METROS.length, quarters: QUARTERS.length };
  log.info('demo_territories_seeded', { tenantId, created, ...details });
  return { created, details };
}

export async function clearDemoTerritories(tenantId: string): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  let cleared = 0;
  const demoModels = (await modelStore.listForTenantIndexed(tenantId)).filter((m) => m.createdBy === DEMO_TERR_ACTOR);
  const demoModelIds = new Set(demoModels.map((m) => m.modelId));

  // Quotas + rules: the delete APIs require a PLANNING model, but the demo model
  // is active — so remove them via the tenant-indexed store, scoped by model.
  for (const q of (await quotaStore.listForTenantIndexed(tenantId)).filter((x) => x.modelId && demoModelIds.has(x.modelId))) {
    await quotaStore.delete(q.quotaId); cleared += 1;
  }
  for (const r of (await ruleStore.listForTenantIndexed(tenantId)).filter((x) => x.modelId && demoModelIds.has(x.modelId))) {
    await ruleStore.delete(r.ruleId); cleared += 1;
  }
  // Assignments + territories + active pointer + models + types (no delete API).
  for (const a of (await assignmentStore.listForTenantIndexed(tenantId)).filter((x) => x.modelId && demoModelIds.has(x.modelId))) {
    await assignmentStore.delete(a.assignmentId);
  }
  for (const t of (await territoryStore.listForTenantIndexed(tenantId)).filter((x) => x.modelId && demoModelIds.has(x.modelId))) {
    await territoryStore.delete(t.territoryId); cleared += 1;
  }
  for (const p of (await activeStore.listForTenantIndexed(tenantId)).filter((x) => x.modelId && demoModelIds.has(x.modelId))) {
    await activeStore.delete(p.pointerId);
  }
  for (const m of demoModels) { await modelStore.delete(m.modelId); cleared += 1; }
  // Territory TYPES (Region/Segment/Named Accounts) are DELIBERATELY left on clear
  // (review #1359 MEDIUM): TerritoryType has no createdBy and seed REUSES a
  // same-named pre-existing type, so deleting by name would adopt-then-delete a
  // user's own 'Region' type. They're inert classification rows — leaving them is
  // the safe asymmetry, and re-seed is idempotent by name.

  log.info('demo_territories_cleared', { tenantId, cleared });
  return { cleared };
}
