/**
 * `demo-sales-commissions` seeder (ADR 0280 — sales commissions).
 *
 * One AE commission plan (6% of won-deal value, a 9% accelerator past quota, a
 * per-period cap) over the Phase-3 CRM, then a computed statement per rep for
 * exactly the quarter(s) in which they actually closed deals — so the numbers
 * are real (not $0 placeholders) and the draft→approved→paid lifecycle shows.
 * `dependsOn: ['demo-people','demo-crm','demo-territories']` — people for the rep
 * subjects, crm for the won deals the compute reads, territories for the
 * attainment % that fires the accelerator.
 *
 * Toggle-gated on `sales-commissions`; skips honestly (never flips). Plans carry
 * `createdBy` → demo plans are anchored on the actor; statements have no
 * `createdBy` → anchored on `planId ∈ the demo plans`.
 */
import { createLogger } from '../observability/logger.js';
import { DurableCollection } from './hostExtPersistence.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import { getUserByPrincipal } from '../features/users/usersService.js';
import { listDeals } from '../features/crm/crmEntitiesService.js';
import { createPlan, listPlans, deletePlan } from '../features/sales-commissions/entities/plan.js';
import { computeStatement, listStatements, approveStatement, markStatementPaid } from '../features/sales-commissions/entities/statement.js';
import { personPrincipal } from './seed-data/solsticeDemo.js';

const log = createLogger('seed.demoSalesCommissions');

export const DEMO_COMMISSIONS_ACTOR = 'demo:commissions';
const PLAN_NAME = 'FY26 AE Commission Plan';
const REP_SLUGS = ['dana-reyes', 'priya-nair', 'sofia-lindqvist', 'tomas-okafor'];

// Direct handle for the statement store (no per-row delete API) — clear-time.
const statementStore = new DurableCollection<{ statementId: string; tenantId: string; planId: string }>(
  'commissions:commission-statement', (s) => s.statementId, undefined, (s) => s.tenantId,
);
const planStore = new DurableCollection<{ planId: string; tenantId: string; createdBy?: string }>(
  'commissions:commission-plan', (p) => p.planId, undefined, (p) => p.tenantId,
);

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}

/** `YYYY-Qn` of a `YYYY-MM-DD` close date. */
function quarterOf(dateStr: string): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  return `${m[1]}-Q${Math.ceil(Number(m[2]) / 3)}`;
}

export async function countDemoCommissions(tenantId: string): Promise<number> {
  const demoPlanIds = new Set((await planStore.listForTenantIndexed(tenantId)).filter((p) => p.createdBy === DEMO_COMMISSIONS_ACTOR).map((p) => p.planId));
  const statements = (await statementStore.listForTenantIndexed(tenantId)).filter((s) => demoPlanIds.has(s.planId)).length;
  return demoPlanIds.size + statements;
}

export async function seedDemoCommissions(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  if (!(await resolveOne('sales-commissions', { tenantId }))?.enabled) {
    return { created: 0, details: { skipped: 'sales-commissions feature is off' } };
  }
  const orgId = await orgIdFor(tenantId);
  let created = 0;
  let statements = 0;

  // The plan (idempotent by name + demo actor).
  let plan = (await listPlans(tenantId, orgId)).find((p) => p.name === PLAN_NAME && p.createdBy === DEMO_COMMISSIONS_ACTOR);
  if (!plan) {
    plan = await createPlan(tenantId, orgId, {
      name: PLAN_NAME,
      currency: 'USD',
      assignment: { kind: 'role', ref: 'account-executive' },
      rules: [{ basis: 'deal-won', type: 'percentage', rate: 6, accelerators: [{ attainmentGte: 100, rate: 9 }], cap: 50000 }],
      effectiveFrom: '2026-01-01',
    }, DEMO_COMMISSIONS_ACTOR);
    created += 1;
  }

  // Compute a statement per rep for exactly the quarter(s) they closed won deals.
  const wonByOwner = new Map<string, Set<string>>();
  for (const d of (await listDeals(tenantId, orgId, {}, undefined)).filter((x) => x.status === 'won')) {
    const owner = (d as { owner?: string }).owner;
    const period = quarterOf((d as { closeDate?: string }).closeDate ?? '');
    if (!owner || !period) continue;
    (wonByOwner.get(owner) ?? wonByOwner.set(owner, new Set()).get(owner)!).add(period);
  }

  // Idempotency: never recompute an existing statement — a finalized (paid) one
  // rejects recompute, and a re-seed must not churn draft→approved state either.
  const existing = new Set(
    (await listStatements(tenantId, orgId, { planId: plan.planId }, true, undefined)).map((s) => `${s.subjectId}:${s.period}`),
  );
  let lifecycleDone = existing.size > 0; // already seeded once ⇒ don't re-walk lifecycle
  for (const slug of REP_SLUGS) {
    const user = await getUserByPrincipal(tenantId, personPrincipal(slug));
    const subject = user?.userId;
    if (!subject) continue;
    for (const period of wonByOwner.get(subject) ?? []) {
      if (existing.has(`${subject}:${period}`)) continue;
      const st = await computeStatement(tenantId, orgId, plan.planId, subject, period);
      statements += 1;
      // Walk one statement through the full lifecycle so approved/paid render.
      if (!lifecycleDone && st.total > 0) {
        await approveStatement(tenantId, orgId, st.statementId, DEMO_COMMISSIONS_ACTOR);
        await markStatementPaid(tenantId, orgId, st.statementId, DEMO_COMMISSIONS_ACTOR);
        lifecycleDone = true;
      }
    }
  }

  const details = { plans: created, statements };
  log.info('demo_commissions_seeded', { tenantId, created: created + statements, ...details });
  return { created: created + statements, details };
}

export async function clearDemoCommissions(tenantId: string): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  const orgId = await orgIdFor(tenantId);
  const demoPlans = (await planStore.listForTenantIndexed(tenantId)).filter((p) => p.createdBy === DEMO_COMMISSIONS_ACTOR);
  const demoPlanIds = new Set(demoPlans.map((p) => p.planId));
  let cleared = 0;
  // Statements first (no delete API — direct store), then the plans.
  for (const s of (await statementStore.listForTenantIndexed(tenantId)).filter((x) => demoPlanIds.has(x.planId))) {
    await statementStore.delete(s.statementId); cleared += 1;
  }
  for (const p of demoPlans) { await deletePlan(tenantId, orgId, p.planId); cleared += 1; }
  log.info('demo_commissions_cleared', { tenantId, cleared });
  return { cleared };
}
