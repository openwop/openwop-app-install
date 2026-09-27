/**
 * AI Workflow Author demo seed (ADR 0072) — unit tests for the showcase seeder
 * and the validator's metadata/variables passthrough that carries authoring
 * provenance through persist.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
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
      // validateWorkflowDefinition throws on any structural/gate violation; these
      // are built from deterministic demo nodes so they must validate clean.
      expect(() => validateWorkflowDefinition(s.definition)).not.toThrow();
    }
  });

  it('clear removes only THIS tenant\'s ownership; the shared def survives while another tenant owns it', async () => {
    await seedWorkflowAuthorShowcase(tenantId);
    await seedWorkflowAuthorShowcase(otherTenant);
    const { cleared } = await clearWorkflowAuthorShowcase(tenantId);
    expect(cleared).toBe(WORKFLOW_AUTHOR_SHOWCASE.length);
    expect(await countWorkflowAuthorShowcase(tenantId)).toBe(0);
    // otherTenant still owns it ⇒ its count is intact AND the shared def is NOT deleted
    // (its historical runs must keep replaying).
    expect(await countWorkflowAuthorShowcase(otherTenant)).toBe(WORKFLOW_AUTHOR_SHOWCASE.length);
    expect(getRegisteredWorkflow(LEAD_TRIAGE)).toBeDefined();
  });
});

describe('validator metadata/variables passthrough (provenance survives persist)', () => {
  it('preserves metadata (authoring provenance) through validation', () => {
    const def = validateWorkflowDefinition({
      workflowId: 'authored.prov-1',
      nodes: [{ nodeId: 'n1', typeId: 'core.noop' }],
      metadata: { authoring: { authoredVia: 'workflow-author', intent: 'do a thing', model: 'claude-sonnet-4-6', attempts: 1 } },
    });
    expect((def.metadata?.authoring as Record<string, unknown>)?.intent).toBe('do a thing');
  });

  it('preserves variables when present', () => {
    const def = validateWorkflowDefinition({
      workflowId: 'authored.prov-2',
      nodes: [{ nodeId: 'n1', typeId: 'core.noop' }],
      variables: [{ name: 'intent', type: 'string', required: true }],
    });
    expect(def.variables?.[0]?.name).toBe('intent');
  });

  it('rejects a non-object metadata', () => {
    expect(() =>
      validateWorkflowDefinition({ workflowId: 'authored.prov-3', nodes: [{ nodeId: 'n1', typeId: 'core.noop' }], metadata: 'nope' }),
    ).toThrow();
  });
});
