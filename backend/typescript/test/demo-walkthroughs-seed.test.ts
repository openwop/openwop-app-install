/**
 * ADR 0435 — the sample walkthroughs are SEEDED demo data, not builtins.
 *
 * Three things must stay true, and each has bitten a comparable surface before:
 *   1. the two sample ids are ABSENT from the builtin set (a builtin is
 *      host-owned — that is exactly what made the old cards undeletable),
 *      while the page-spotlight walkthroughs the manual-test runner launches
 *      by id REMAIN builtins;
 *   2. seeding is idempotent and records per-tenant OWNERSHIP (ownership is
 *      what puts a walkthrough in "Your walkthroughs" and lets it be edited /
 *      removed), and clearing removes it again;
 *   3. `walkthroughIds.ts` re-declares the two node type ids that
 *      `walkthroughNodes.ts` owns (deliberately, to keep the seeder off the
 *      node-registration import path) — so they must be pinned equal.
 *
 * TST-CVA-4. Red when: a sample definition is dropped (the two ids are pinned),
 * the example-data seeder id is renamed, an archived sample still counts or
 * re-seeds as a no-op, or the clear stops removing ownership. Counts are pinned
 * as the literal 2, not read from `DEMO_WALKTHROUGHS.length`, so a dropped
 * definition cannot move the expectation with it.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { DEMO_WALKTHROUGHS, seedDemoWalkthroughs, clearDemoWalkthroughs, countDemoWalkthroughs } from '../src/host/demoWalkthroughsSeed.js';
import { WALKTHROUGH_WORKFLOWS } from '../src/features/walkthroughs/feature.js';
import { WALKTHROUGH_STEP_TYPE_ID, WALKTHROUGH_CHECKPOINT_TYPE_ID, CAMPAIGN_STUDIO_WALKTHROUGH_ID, CHAT_WALKTHROUGH_ID, LEGACY_CAMPAIGN_STUDIO_ID } from '../src/features/walkthroughs/walkthroughIds.js';
import { WALKTHROUGH_STEP_TYPE_ID as NODE_STEP_ID, WALKTHROUGH_CHECKPOINT_TYPE_ID as NODE_CHECKPOINT_ID } from '../src/features/walkthroughs/walkthroughNodes.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { getOwned, recordOwnership } from '../src/host/workflowOwnership.js';
import { EXAMPLE_DATA_SEEDERS } from '../src/host/exampleDataSeeders.js';

const builtinIds = (): string[] => WALKTHROUGH_WORKFLOWS.map((d) => d.workflowId);

describe('sample walkthroughs are seeded demo data (ADR 0435)', () => {
  it('the two sample walkthroughs are NOT builtins', () => {
    expect(builtinIds()).not.toContain(CAMPAIGN_STUDIO_WALKTHROUGH_ID);
    expect(builtinIds()).not.toContain(CHAT_WALKTHROUGH_ID);
  });

  it('keeps the page-spotlight walkthroughs + the legacy replay alias as builtins', () => {
    // Manual-test infrastructure must resolve for EVERY tenant, seeded or not.
    expect(builtinIds()).toContain('walkthrough.agents.roster');
    expect(builtinIds()).toContain('walkthrough.runs.index');
    // Pre-rename runs still replay (ADR 0376).
    expect(builtinIds()).toContain(LEGACY_CAMPAIGN_STUDIO_ID);
  });

  it('ships a `demo-walkthroughs` step on the example-data dashboard', () => {
    expect(EXAMPLE_DATA_SEEDERS.map((s) => s.id)).toContain('demo-walkthroughs');
  });

  it('carries both sample definitions with real steps (no vacuous pass)', () => {
    expect(DEMO_WALKTHROUGHS.map((d) => d.workflowId)).toEqual([CAMPAIGN_STUDIO_WALKTHROUGH_ID, CHAT_WALKTHROUGH_ID]);
    for (const def of DEMO_WALKTHROUGHS) {
      expect(def.nodes.length).toBeGreaterThan(0);
      expect(def.metadata?.walkthrough).toBe(true);
    }
  });

  it('pins the duplicated node type ids against their owning module', () => {
    expect(WALKTHROUGH_STEP_TYPE_ID).toBe(NODE_STEP_ID);
    expect(WALKTHROUGH_CHECKPOINT_TYPE_ID).toBe(NODE_CHECKPOINT_ID);
  });
});

describe('demo-walkthroughs seeder', () => {
  const tenantId = 't-walkthrough-seed';
  const SAMPLE_COUNT = 2;

  beforeAll(async () => {
    initHostExtPersistence(await openStorage('memory://'));
  });

  beforeEach(async () => {
    await clearDemoWalkthroughs(tenantId);
  });

  it('seeds tenant-owned walkthroughs, idempotently', async () => {
    const first = await seedDemoWalkthroughs(tenantId);
    expect(first.created).toBe(SAMPLE_COUNT);
    expect(await countDemoWalkthroughs(tenantId)).toBe(SAMPLE_COUNT);

    // Ownership is what makes it listable + editable + removable in the app.
    for (const def of DEMO_WALKTHROUGHS) {
      expect(await getOwned(tenantId, def.workflowId)).not.toBeNull();
      expect(getRegisteredWorkflow(def.workflowId)).toBeDefined();
    }

    const second = await seedDemoWalkthroughs(tenantId);
    expect(second.created).toBe(0); // re-seed creates nothing (no "-2" duplicates)
    expect(await countDemoWalkthroughs(tenantId)).toBe(SAMPLE_COUNT);
  });

  it('clears what it seeded', async () => {
    await seedDemoWalkthroughs(tenantId);
    const cleared = await clearDemoWalkthroughs(tenantId);
    expect(cleared.cleared).toBe(SAMPLE_COUNT);
    expect(await countDemoWalkthroughs(tenantId)).toBe(0);
    for (const def of DEMO_WALKTHROUGHS) {
      expect(await getOwned(tenantId, def.workflowId)).toBeNull();
    }
  });

  it('an ARCHIVED (removed) sample stops counting and re-seeds as a create', async () => {
    // The walkthroughs page's Remove verb archives. Live-verified regression:
    // counting an archived row as present made /example-data report 2 for a
    // page showing 1, and made re-seeding a no-op with no way back but Clear.
    await seedDemoWalkthroughs(tenantId);
    const [first] = DEMO_WALKTHROUGHS;
    const owned = await getOwned(tenantId, first!.workflowId);
    await recordOwnership(tenantId, first!.workflowId, {
      name: owned?.name ?? '', nodeCount: owned?.nodeCount ?? 0, archivedAt: '2026-07-19T00:00:00.000Z',
    });

    expect(await countDemoWalkthroughs(tenantId)).toBe(SAMPLE_COUNT - 1);

    const again = await seedDemoWalkthroughs(tenantId);
    expect(again.created).toBe(1); // the archived one comes back
    expect(await countDemoWalkthroughs(tenantId)).toBe(SAMPLE_COUNT);
    expect((await getOwned(tenantId, first!.workflowId))?.archivedAt).toBeUndefined();
  });

  it('a second tenant keeps its copy when the first clears', async () => {
    const other = `${tenantId}-other`;
    await seedDemoWalkthroughs(tenantId);
    await seedDemoWalkthroughs(other);
    await clearDemoWalkthroughs(tenantId);

    expect(await countDemoWalkthroughs(other)).toBe(SAMPLE_COUNT);
    expect(await getOwned(other, CHAT_WALKTHROUGH_ID)).not.toBeNull();
    // The global def must survive so the other tenant's runs still resolve.
    expect(getRegisteredWorkflow(CHAT_WALKTHROUGH_ID)).toBeDefined();
    await clearDemoWalkthroughs(other);
  });
});
