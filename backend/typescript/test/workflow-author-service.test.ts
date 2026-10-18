/**
 * AI Workflow Author (ADR 0072) — SERVICE unit tests. Exercises the authoring
 * brain's invariants directly (no HTTP):
 *   - closed-world: an out-of-catalog typeId is rejected (the core protocol
 *     invariant — inventing a typeId would `unknown_typeid` at run time)
 *   - structural: a malformed candidate is rejected with errors (no throw)
 *   - RFC 0022 §C gate: a core.dispatch mapping node is refused when the host
 *     does not advertise `agents.dispatchMapping` (shared validator path)
 *   - persist registers a valid candidate through the shared registry, lets a
 *     tenant overwrite its OWN workflow, and refuses another tenant's (B1/HIGH-2)
 *
 * Gap ids: ADR 0596 / `WFAWF-13` (the surface-gated leg used to `return`, then
 * `skip`, because the bare unit env registers no surface-gated node — it now
 * declares one in a temp pack, so the leg always runs).
 *
 * Sabotage witnesses (grade-tests w18): `findUnknownTypeIds` bypassed on the
 * validate door and on the persist door; the legal set widened from runnable to
 * catalog-wide; the empty-`nodes` guard removed; validate's catch reporting ok;
 * the RFC 0022 §C gate disabled; the durable register skipped; the CAS made
 * unconditional (self-overwrite 409s); the foreign-owner guard disabled.
 */

import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDefaultPackDir } from '../src/packs/registryInstaller.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import {
  validateAuthoredWorkflow,
  persistAuthoredWorkflow,
  buildAuthoringCatalog,
} from '../src/features/workflow-author/workflowAuthorService.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { setCapabilityOverlay, resetCapabilityOverlay } from '../src/host/capabilityOverlay.js';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';

const TENANT = 'ws-svc';
// A pack-declared node whose typeId prefix maps to `host.mcp`
// (`bootstrap/hostSurfaceMap.ts`), which this bare unit env does not advertise —
// so the catalog lists it but withholds it for a missing host surface.
const OFFMENU_PACK = 'vendor.test.wfau-offmenu';
const OFFMENU_TYPE = 'core.openwop.mcp.wfau-offmenu-fixture';
let offMenuDir = '';

beforeAll(async () => {
  // Populate the in-process node registry so `core.noop` is a legal catalog typeId.
  ensureNodesRegistered();
  // persist now records tenant ownership (ADR 0163) → needs a wired kv store.
  initHostExtPersistence(await openStorage('memory://'));
  offMenuDir = join(resolveDefaultPackDir(), OFFMENU_PACK);
  mkdirSync(offMenuDir, { recursive: true });
  writeFileSync(join(offMenuDir, 'pack.json'), JSON.stringify({
    name: OFFMENU_PACK, version: '1.0.0', kind: 'node',
    nodes: [{ typeId: OFFMENU_TYPE, version: '1.0.0', label: 'Off-menu fixture' }],
  }));
});
afterAll(() => {
  rmSync(offMenuDir, { recursive: true, force: true });
  __resetHostExtPersistence();
});
afterEach(() => resetCapabilityOverlay());

const noopWorkflow = (id: string) => ({
  workflowId: id,
  nodes: [{ nodeId: 'n1', typeId: 'core.noop', outputRole: 'primary' as const }],
});

describe('workflow-author service — closed-world typeIds', () => {
  it('accepts a workflow built only from catalog typeIds', () => {
    const v = validateAuthoredWorkflow(noopWorkflow('authored.ok-1'));
    expect(v.ok, JSON.stringify(v.errors)).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('rejects an invented (out-of-catalog) typeId', () => {
    const v = validateAuthoredWorkflow({
      workflowId: 'authored.bad-1',
      nodes: [{ nodeId: 'n1', typeId: 'totally.made.up.node' }],
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/Unknown node typeId 'totally\.made\.up\.node'/);
  });

  it('rejects a node this host cannot run (missing host surface) — closed-world honesty', () => {
    // A node withheld from the authoring menu *only* for a missing host surface
    // is NOT a legal typeId (it would register a workflow that fails at run).
    const cat = buildAuthoringCatalog();
    const offMenu = cat.excluded.find((e) => e.typeId === OFFMENU_TYPE && /missing host surface/.test(e.reason));
    // ADR 0673 D4 (`WFAWF-13`) — this used to `return` when no surface-gated node was
    // present, so a probe that ran NOTHING reported PASSED. Two changes make it honest:
    //
    //   1. a non-vacuity FLOOR — the catalog must have loaded nodes at all, so an empty
    //      catalog (a broken fixture) can never be mistaken for "nothing to check";
    //   2. an explicit SKIP rather than a silent return, so the absence is visible in the
    //      report instead of counted as a pass.
    //
    // MEASURED at HEAD: this bare unit environment registers no surface-gated node, so the
    // leg had genuinely had nothing to assert — which is exactly what the silent return hid.
    // grade-tests w18: the skip is gone. The file now DECLARES a surface-gated node (the
    // temp pack in `beforeAll`), so the leg always runs, and its absence is a red.
    expect(cat.nodes.some((n) => n.typeId === 'core.noop'), 'the catalog must load the local registry').toBe(true);
    expect(offMenu, `${OFFMENU_TYPE} must be withheld for a missing host surface`).toBeDefined();
    const v = validateAuthoredWorkflow({
      workflowId: 'authored.unrunnable',
      nodes: [{ nodeId: 'n1', typeId: offMenu!.typeId }],
    });
    expect(v.ok, `${offMenu!.typeId} should be rejected as not runnable here`).toBe(false);
    expect(v.errors.join(' ')).toMatch(/Unknown node typeId/);
  });
});

describe('workflow-author service — structural validation (no throw)', () => {
  it('rejects a candidate with no nodes', () => {
    const v = validateAuthoredWorkflow({ workflowId: 'authored.empty', nodes: [] });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/`nodes` MUST be a non-empty array/);
  });

  it('rejects a non-object candidate', () => {
    const v = validateAuthoredWorkflow('not an object');
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual(['Request body MUST be a JSON object.']);
  });
});

describe('workflow-author service — RFC 0022 §C capability gate', () => {
  it('refuses a core.dispatch mapping node when the host does not advertise the capability', () => {
    setCapabilityOverlay('agents.dispatchMapping', false);
    const v = validateAuthoredWorkflow({
      workflowId: 'authored.dispatch',
      nodes: [{ nodeId: 'd', typeId: 'core.dispatch', config: { inputMapping: { a: 'b' } } }],
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/dispatchMapping/);
  });
});

describe('workflow-author service — persist', () => {
  it('registers a valid candidate through the shared registry', async () => {
    const id = 'authored.persist-1';
    const out = await persistAuthoredWorkflow(noopWorkflow(id), { tenantId: TENANT });
    expect(out.workflowId).toBe(id);
    expect(out.nodeCount).toBe(1);
    expect(getRegisteredWorkflow(id)?.workflowId).toBe(id);
  });

  it('throws on an out-of-catalog typeId (never registers an unrunnable graph)', async () => {
    await expect(
      persistAuthoredWorkflow({ workflowId: 'authored.persist-bad', nodes: [{ nodeId: 'n1', typeId: 'made.up' }] }, { tenantId: TENANT }),
    ).rejects.toMatchObject({ code: 'validation_error', details: { unknownTypeIds: ['made.up'] } });
    expect(getRegisteredWorkflow('authored.persist-bad')).toBeUndefined();
  });

  it('the same tenant may overwrite its OWN workflow (autosave)', async () => {
    const id = 'authored.persist-self';
    await persistAuthoredWorkflow(noopWorkflow(id), { tenantId: TENANT });
    const revised = { ...noopWorkflow(id), nodes: [...noopWorkflow(id).nodes, { nodeId: 'n2', typeId: 'core.noop' }] };
    const out = await persistAuthoredWorkflow(revised, { tenantId: TENANT });
    expect(out).toMatchObject({ workflowId: id, nodeCount: 2 });
    expect(getRegisteredWorkflow(id)?.nodes.map((n) => n.nodeId), 'the overwrite LANDED').toEqual(['n1', 'n2']);
  });

  it('another tenant CANNOT overwrite a workflow this tenant authored (typed conflict)', async () => {
    const id = 'authored.persist-foreign';
    await persistAuthoredWorkflow(noopWorkflow(id), { tenantId: TENANT });
    await expect(
      persistAuthoredWorkflow(noopWorkflow(id), { tenantId: 'ws-other' }),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'owned_by_other_tenant' } });
  });
});
