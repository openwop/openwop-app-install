/**
 * AI Workflow Author demo seed (ADR 0072, WFAWF-6 / ADR 0596 R2, ADR 0789) —
 * unit tests for the showcase seeder: per-tenant ownership, idempotency, stable
 * replay-safe ids, the illustrative badge, closed-world node types, and a
 * tenant-scoped clear that never deletes the shared definition. Plus the
 * validator's refusal of a non-object `metadata`.
 *
 * Sabotage witnesses (grade-tests w18): ownership not recorded; `created`
 * counted unconditionally; count ignoring archive/absence; a showcase id
 * renamed; the showcase/illustrative badge flipped; a showcase built from a
 * non-runnable typeId; clear deleting the shared def or miscounting; the
 * non-object `metadata` guard removed.
 *
 * The validator's metadata/variables PASSTHROUGH cases lived here and were cut
 * in w18 as redundant: `workflow-author-node-pack.test.ts` › "a model cannot
 * FORGE the attribution" (authoring.intent survives) and
 * `workflow-author-write-integrity.test.ts` › "seeds a rich head" (variables
 * survive) both went red under the same sabotage.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { findUnknownTypeIds } from '../src/host/nodeCatalogBuilder.js';
import {
  seedWorkflowAuthorShowcase,
  clearWorkflowAuthorShowcase,
  countWorkflowAuthorShowcase,
  WORKFLOW_AUTHOR_SHOWCASE,
} from '../src/host/workflowAuthorSeed.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { getOwned } from '../src/host/workflowOwnership.js';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';

// WFAWF-6 (ADR 0596 R2) — the showcase seed is now TENANT-OWNED (mirrors
// demoWalkthroughsSeed): register the shared def by id (ids unchanged for replay)
// AND record per-tenant ownership, which is what lists it in that tenant's builder
// gallery. These assertions are born red against the old host-global seeder: it
// recorded NO ownership (so `getOwned` was null) and its count/clear were
// host-global (so a second tenant "saw" the first tenant's seed).
const tenantId = 'org:wfawf6-test';
const otherTenant = 'org:wfawf6-other';
const LEAD_TRIAGE = 'openwop-app.authored.lead-triage';

beforeAll(async () => {
  ensureNodesRegistered();
  initHostExtPersistence(await openStorage('memory://'));
});
afterAll(() => __resetHostExtPersistence());
beforeEach(async () => {
  await clearWorkflowAuthorShowcase(tenantId);
  await clearWorkflowAuthorShowcase(otherTenant);
});

describe('workflow-author demo seed — tenant-owned (WFAWF-6)', () => {
  it('seeds the showcase workflows per tenant, idempotently, and records ownership', async () => {
    const first = await seedWorkflowAuthorShowcase(tenantId);
    expect(first.created).toBe(WORKFLOW_AUTHOR_SHOWCASE.length);
    expect(await countWorkflowAuthorShowcase(tenantId)).toBe(WORKFLOW_AUTHOR_SHOWCASE.length);

    // Ownership is what makes each showcase list in the builder gallery + the `/`
    // picker (both read the tenant OWNERSHIP index) and be editable/removable.
    // The old host-global seeder recorded none — this is the core WFAWF-6 fix.
    for (const s of WORKFLOW_AUTHOR_SHOWCASE) {
      expect(await getOwned(tenantId, s.definition.workflowId)).not.toBeNull();
      expect(getRegisteredWorkflow(s.definition.workflowId)).toBeDefined();
    }

    // re-seed creates nothing (deterministic ids ⇒ no "-2" duplicates).
    expect((await seedWorkflowAuthorShowcase(tenantId)).created).toBe(0);
  });

  it('is PER-TENANT — a second tenant does not see the first tenant\'s showcase', async () => {
    await seedWorkflowAuthorShowcase(tenantId);
    // Born red under the old host-global seeder: count() ignored the tenant, so
    // otherTenant reported the first tenant's 2 seeded workflows.
    expect(await countWorkflowAuthorShowcase(otherTenant)).toBe(0);
    expect(await getOwned(otherTenant, LEAD_TRIAGE)).toBeNull();
  });

  it('keeps the ids UNCHANGED so pre-migration runs still resolve (replay-safe)', async () => {
    await seedWorkflowAuthorShowcase(tenantId);
    // The host-global by-id registry still resolves these exact ids for run/:fork/replay.
    expect(getRegisteredWorkflow(LEAD_TRIAGE)).toBeDefined();
    expect(getRegisteredWorkflow('openwop-app.authored.doc-summary')).toBeDefined();
  });

  it('badges seeded workflows as illustrative showcase', async () => {
    await seedWorkflowAuthorShowcase(tenantId);
    const def = getRegisteredWorkflow(LEAD_TRIAGE);
    expect(def).toBeDefined();
    expect((def?.metadata as Record<string, unknown>)?.showcase).toBe(true);
    expect(((def?.metadata as Record<string, unknown>)?.authoring as Record<string, unknown>)?.illustrative).toBe(true);
  });

  it('seeded workflows use only real, runnable catalog typeIds (closed-world)', () => {
    for (const s of WORKFLOW_AUTHOR_SHOWCASE) {
      // Structural validity (the shared validator) AND closed-world membership:
      // `validateWorkflowDefinition` checks typeId GRAMMAR only, so the closed-world
      // half is `findUnknownTypeIds` against the RUNNABLE set (grade-tests w18 —
      // the case used to assert only the first half under this title).
      const def = validateWorkflowDefinition(s.definition);
      expect(findUnknownTypeIds(def), `${s.definition.workflowId} uses only runnable typeIds`).toEqual([]);
    }
  });

  it('clear removes only THIS tenant\'s ownership; the shared def is never deleted (ADR 0789)', async () => {
    await seedWorkflowAuthorShowcase(tenantId);
    await seedWorkflowAuthorShowcase(otherTenant);
    const { cleared } = await clearWorkflowAuthorShowcase(tenantId);
    expect(cleared).toBe(WORKFLOW_AUTHOR_SHOWCASE.length);
    expect(await countWorkflowAuthorShowcase(tenantId)).toBe(0);
    // otherTenant still owns it ⇒ its count is intact. The shared def is NOT deleted —
    // since ADR 0789 clear never deletes it at all (forked/retracted tenants still
    // have runs stamped with the id), not merely "while another tenant owns it".
    expect(await countWorkflowAuthorShowcase(otherTenant)).toBe(WORKFLOW_AUTHOR_SHOWCASE.length);
    expect(getRegisteredWorkflow(LEAD_TRIAGE)).toBeDefined();
  });
});

describe('validator — a non-object metadata is refused', () => {
  it('rejects a non-object metadata', () => {
    expect(() =>
      validateWorkflowDefinition({ workflowId: 'authored.prov-3', nodes: [{ nodeId: 'n1', typeId: 'core.noop' }], metadata: 'nope' }),
    ).toThrowError(/`metadata` MUST be an object/);
  });
});
