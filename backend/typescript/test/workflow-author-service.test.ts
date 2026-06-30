/**
 * AI Workflow Author (ADR 0072) — SERVICE unit tests. Exercises the authoring
 * brain's invariants directly (no HTTP):
 *   - closed-world: an out-of-catalog typeId is rejected (the core protocol
 *     invariant — inventing a typeId would `unknown_typeid` at run time)
 *   - structural: a malformed candidate is rejected with errors (no throw)
 *   - RFC 0022 §C gate: a core.dispatch mapping node is refused when the host
 *     does not advertise `agents.dispatchMapping` (shared validator path)
 *   - persist registers a valid candidate through the shared registry
 */

import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import {
  validateAuthoredWorkflow,
  persistAuthoredWorkflow,
  buildAuthoringCatalog,
} from '../src/features/workflow-author/workflowAuthorService.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { OpenwopError } from '../src/types.js';
import { setCapabilityOverlay, resetCapabilityOverlay } from '../src/host/capabilityOverlay.js';

beforeAll(() => {
  // Populate the in-process node registry so `core.noop` is a legal catalog typeId.
  ensureNodesRegistered();
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

  it('the live catalog actually contains core.noop', () => {
    const cat = buildAuthoringCatalog();
    expect(cat.nodes.some((n) => n.typeId === 'core.noop')).toBe(true);
  });

  it('rejects a node this host cannot run (missing host surface) — closed-world honesty', () => {
    // A node withheld from the authoring menu *only* for a missing host surface
    // is NOT a legal typeId (it would register a workflow that fails at run).
    const cat = buildAuthoringCatalog();
    const offMenu = cat.excluded.find((e) => /missing host surface/.test(e.reason));
    if (!offMenu) return; // no surface-gated node present in this environment
    const v = validateAuthoredWorkflow({
      workflowId: 'authored.unrunnable',
      nodes: [{ nodeId: 'n1', typeId: offMenu.typeId }],
    });
    expect(v.ok, `${offMenu.typeId} should be rejected as not runnable here`).toBe(false);
    expect(v.errors.join(' ')).toMatch(/Unknown node typeId/);
  });
});

describe('workflow-author service — structural validation (no throw)', () => {
  it('rejects a candidate with no nodes', () => {
    const v = validateAuthoredWorkflow({ workflowId: 'authored.empty', nodes: [] });
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-object candidate', () => {
    const v = validateAuthoredWorkflow('not an object');
    expect(v.ok).toBe(false);
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
  it('registers a valid candidate through the shared registry', () => {
    const id = 'authored.persist-1';
    const out = persistAuthoredWorkflow(noopWorkflow(id));
    expect(out.workflowId).toBe(id);
    expect(out.nodeCount).toBe(1);
    expect(getRegisteredWorkflow(id)?.workflowId).toBe(id);
  });

  it('throws on an out-of-catalog typeId (never registers an unrunnable graph)', () => {
    expect(() =>
      persistAuthoredWorkflow({ workflowId: 'authored.persist-bad', nodes: [{ nodeId: 'n1', typeId: 'made.up' }] }),
    ).toThrow(OpenwopError);
    expect(getRegisteredWorkflow('authored.persist-bad')).toBeUndefined();
  });
});
