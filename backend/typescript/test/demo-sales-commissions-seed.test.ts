/**
 * `demo-sales-commissions` round-trip (ADR 0280).
 * One AE plan + a computed statement per rep for the quarter(s) they closed won
 * deals — real (non-zero) numbers, one walked to paid; idempotent; clears clean.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { openStorage } from '../src/storage/index.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { seedDemoCrm } from '../src/host/demoCrmSeed.js';
import { seedDemoTerritories } from '../src/host/demoTerritoriesSeed.js';
import { seedDemoCommissions, clearDemoCommissions, countDemoCommissions } from '../src/host/demoSalesCommissionsSeed.js';
import { listPlans } from '../src/features/sales-commissions/entities/plan.js';
import { listStatements } from '../src/features/sales-commissions/entities/statement.js';
import { listOrgs } from '../src/host/accessControlService.js';

const ON = { status: 'on' as const, bucketUnit: 'tenant' as const };

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerToggleDefault({ id: 'crm', salt: 'crm', ...ON });
  registerToggleDefault({ id: 'territories', salt: 'territories', ...ON });
  registerToggleDefault({ id: 'sales-commissions', salt: 'sales-commissions', ...ON });
});

describe('demo-sales-commissions seeder', () => {
  it('seeds a plan + real per-rep statements (draft→approved→paid); idempotent; clears clean', async () => {
    const tenantId = 'demo-comm-t1';
    await seedDemoPeople(tenantId);
    await seedDemoCrm(tenantId);
    await seedDemoTerritories(tenantId);
    const orgId = (await listOrgs(tenantId))[0]!.orgId;

    const first = await seedDemoCommissions(tenantId);
    expect(first.created).toBeGreaterThan(1);

    const plans = (await listPlans(tenantId, orgId)).filter((p) => p.createdBy === 'demo:commissions');
    expect(plans).toHaveLength(1);

    // Statements exist with real (non-zero) totals, and one reached 'paid'.
    const statements = await listStatements(tenantId, orgId, { planId: plans[0]!.planId }, true, undefined);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.some((s) => s.total > 0)).toBe(true);
    expect(statements.some((s) => s.status === 'paid')).toBe(true);

    // Idempotent.
    const before = await countDemoCommissions(tenantId);
    const second = await seedDemoCommissions(tenantId);
    expect(second.created).toBe(0);
    expect(await countDemoCommissions(tenantId)).toBe(before);

    // Clear → zero.
    await clearDemoCommissions(tenantId);
    expect(await countDemoCommissions(tenantId)).toBe(0);
    expect((await listPlans(tenantId, orgId)).filter((p) => p.createdBy === 'demo:commissions')).toHaveLength(0);

    expect((await seedDemoCommissions(tenantId)).created).toBeGreaterThan(1);
  });
});
