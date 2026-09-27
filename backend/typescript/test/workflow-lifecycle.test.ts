/**
 * ADR 0369 Phase 1 — transient/archived definitions are catalog-INVISIBLE by
 * default but always RESOLVABLE by id (runs re-resolve at replay/`:fork`; no
 * per-run snapshot — archive, never dispose).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerWorkflow,
  getRegisteredWorkflow,
  listRegisteredWorkflows,
  deleteRegisteredWorkflow,
} from '../src/host/workflowsRegistry.js';
import { lifecycleOf, catalogVisible, withLifecycle } from '../src/host/workflowLifecycle.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const def = (workflowId: string, lifecycle?: Record<string, unknown>): WorkflowDefinition => ({
  workflowId,
  nodes: [{ nodeId: 'noop', typeId: 'core.openwop.noop' }],
  ...(lifecycle ? { metadata: { lifecycle } } : {}),
});

describe('workflow lifecycle (ADR 0369 P1)', () => {
  const ids = ['lc-live', 'lc-transient', 'lc-archived', 'lc-both'];
  beforeEach(() => { for (const id of ids) deleteRegisteredWorkflow(id); });

  it('lifecycleOf reads only well-formed fields (malformed ⇒ empty)', () => {
    expect(lifecycleOf(def('lc-live'))).toEqual({});
    expect(lifecycleOf(def('lc-live', { transient: 'yes', archivedAt: 42 }))).toEqual({});
    expect(lifecycleOf(def('lc-live', { transient: true, generatedBy: 'agent:x' })))
      .toEqual({ transient: true, generatedBy: 'agent:x' });
  });

  it('transient + archived definitions are hidden from the default list, visible with opt-ins, and ALWAYS resolvable by id', () => {
    registerWorkflow(def('lc-live'));
    registerWorkflow(def('lc-transient', { transient: true, generatedBy: 'workflow-author' }));
    registerWorkflow(def('lc-archived', { archivedAt: '2026-07-15T00:00:00.000Z' }));
    registerWorkflow(def('lc-both', { transient: true, archivedAt: '2026-07-15T00:00:00.000Z' }));

    const defaultIds = listRegisteredWorkflows().map((d) => d.workflowId).filter((i) => ids.includes(i));
    expect(defaultIds).toEqual(['lc-live']);

    const withTransient = listRegisteredWorkflows({ includeTransient: true }).map((d) => d.workflowId).filter((i) => ids.includes(i));
    expect(withTransient.sort()).toEqual(['lc-live', 'lc-transient']);

    const everything = listRegisteredWorkflows({ includeArchived: true, includeTransient: true })
      .map((d) => d.workflowId).filter((i) => ids.includes(i));
    expect(everything.sort()).toEqual(['lc-archived', 'lc-both', 'lc-live', 'lc-transient']);

    // The replay contract: resolution is never filtered.
    for (const id of ids) expect(getRegisteredWorkflow(id)?.workflowId).toBe(id);
  });

  it('withLifecycle merges immutably; undefined removes (promote clears transient, unarchive clears archivedAt)', () => {
    const t = def('lc-transient', { transient: true, generatedBy: 'workflow-author' });
    const promoted = withLifecycle(t, { transient: undefined });
    expect(lifecycleOf(promoted)).toEqual({ generatedBy: 'workflow-author' });
    expect(lifecycleOf(t)).toEqual({ transient: true, generatedBy: 'workflow-author' }); // input untouched
    expect(catalogVisible(promoted)).toBe(true);

    const archived = withLifecycle(promoted, { archivedAt: '2026-07-15T01:00:00.000Z' });
    expect(catalogVisible(archived)).toBe(false);
    expect(catalogVisible(archived, { includeArchived: true })).toBe(true);
    const restored = withLifecycle(archived, { archivedAt: undefined });
    expect(catalogVisible(restored)).toBe(true);
  });
});
