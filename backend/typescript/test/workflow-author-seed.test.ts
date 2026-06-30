/**
 * AI Workflow Author demo seed (ADR 0072) — unit tests for the showcase seeder
 * and the validator's metadata/variables passthrough that carries authoring
 * provenance through persist.
 */

import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import {
  seedWorkflowAuthorShowcase,
  clearWorkflowAuthorShowcase,
  countWorkflowAuthorShowcase,
  WORKFLOW_AUTHOR_SHOWCASE,
} from '../src/host/workflowAuthorSeed.js';
import { getRegisteredWorkflow } from '../src/host/workflowsRegistry.js';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';

beforeAll(() => ensureNodesRegistered());
afterEach(() => clearWorkflowAuthorShowcase());

describe('workflow-author demo seed', () => {
  it('seeds the showcase workflows, idempotently', () => {
    const first = seedWorkflowAuthorShowcase();
    expect(first.created).toBe(WORKFLOW_AUTHOR_SHOWCASE.length);
    expect(countWorkflowAuthorShowcase()).toBe(WORKFLOW_AUTHOR_SHOWCASE.length);
    // re-seed creates nothing (non-destructive)
    expect(seedWorkflowAuthorShowcase().created).toBe(0);
  });

  it('badges seeded workflows as illustrative showcase', () => {
    seedWorkflowAuthorShowcase();
    const def = getRegisteredWorkflow('openwop-app.authored.lead-triage');
    expect(def).toBeDefined();
    expect((def?.metadata as Record<string, unknown>)?.showcase).toBe(true);
    expect(((def?.metadata as Record<string, unknown>)?.authoring as Record<string, unknown>)?.illustrative).toBe(true);
  });

  it('seeded workflows use only real, runnable catalog typeIds (closed-world)', () => {
    seedWorkflowAuthorShowcase();
    for (const s of WORKFLOW_AUTHOR_SHOWCASE) {
      // validateWorkflowDefinition throws on any structural/gate violation; these
      // are built from deterministic demo nodes so they must validate clean.
      expect(() => validateWorkflowDefinition(s.definition)).not.toThrow();
    }
  });

  it('clear removes only the canonical showcase ids', () => {
    seedWorkflowAuthorShowcase();
    const { cleared } = clearWorkflowAuthorShowcase();
    expect(cleared).toBe(WORKFLOW_AUTHOR_SHOWCASE.length);
    expect(countWorkflowAuthorShowcase()).toBe(0);
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
