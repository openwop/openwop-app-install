/**
 * chainRequirements (day-1 UX P3 — the template pre-flight derivation).
 * Pure over (chain, known typeIds, provider-exists) — pins:
 *  - uninstalled node typeIds surface (deduped), installed ones don't;
 *  - connectionRef bindings dedupe and map to the RFC 0095 provider id
 *    (final dot segment of the connection-pack name);
 *  - providerInstalled reflects the host predicate;
 *  - a chain with no refs and fully-known types derives to empty (the
 *    "runs with zero connections" gallery signal).
 *
 * Owner: the chain loader pre-flight (ADR 0163; `pinMismatches` ADR 0766 D3;
 * gated features ADR 0191 P2; node count ADR 0773 P11). Tracker TST-CEA-2.
 * Red when (w67g3, witnessed): the connection refs stop being a Set; the
 * provider id stops taking the last dot segment; the gate regex drops `.hitl.`;
 * always-on features stop being filtered; the node-type list stops being
 * deduped (the twice-missing `vendor.gone`); `nodeCount` counts distinct types
 * instead of steps (the repeated `core.a`).
 */
import { describe, expect, it } from 'vitest';

import { chainRequirements, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';

function chain(nodes: Array<{ typeId: string; connectionRef?: string }>): WorkflowChain {
  return {
    chainId: 'test.chain',
    version: '1.0.0',
    label: 'Test',
    description: 'test',
    parameters: {},
    dag: {
      nodes: nodes.map((n, i) => ({
        id: `n${i}`,
        typeId: n.typeId,
        ...(n.connectionRef ? { config: { connectionRef: n.connectionRef } } : {}),
      })),
    },
  };
}

describe('chainRequirements', () => {
  it('derives missing typeIds + provider bindings, deduped', () => {
    const c = chain([
      { typeId: 'core.a', connectionRef: 'core.openwop.connections.microsoft365' },
      { typeId: 'core.a', connectionRef: 'core.openwop.connections.microsoft365' },
      { typeId: 'vendor.gone' },
      { typeId: 'vendor.gone' }, // missing twice → reported once
      { typeId: 'core.b', connectionRef: 'core.openwop.connections.netsuite' },
    ]);
    const known = new Set(['core.a', 'core.b']);
    const req = chainRequirements(c, known, (id) => id === 'microsoft365');

    expect(req.missingNodeTypeIds).toEqual(['vendor.gone']);
    expect(req.approvalGateCount).toBe(0);
    expect(req.connections).toEqual([
      { ref: 'core.openwop.connections.microsoft365', providerId: 'microsoft365', providerInstalled: true },
      { ref: 'core.openwop.connections.netsuite', providerId: 'netsuite', providerInstalled: false },
    ]);
  });

  it('a zero-config chain derives to empty requirements', () => {
    const c = chain([{ typeId: 'core.a' }, { typeId: 'core.b' }]);
    const req = chainRequirements(c, new Set(['core.a', 'core.b']), () => true);
    expect(req.missingNodeTypeIds).toEqual([]);
    expect(req.connections).toEqual([]);
    expect(req.approvalGateCount).toBe(0);
  });

  it('counts human-approval gates (the pre-flight trust signal)', () => {
    const c = chain([
      { typeId: 'core.chat.approvalGate' },
      { typeId: 'core.openwop.hitl.form' },
      { typeId: 'core.a' },
      { typeId: 'core.a' }, // a repeated type is still a step
    ]);
    const req = chainRequirements(c, new Set(['core.a', 'core.chat.approvalGate', 'core.openwop.hitl.form']), () => true);
    expect(req.approvalGateCount).toBe(2);
    // ADR 0773 P11 — the template chip's size: every step, gates included
    // (4 steps over 3 distinct types).
    expect(req.nodeCount).toBe(4);
  });

  it('a bare (non-dotted) ref falls back to itself as the provider id', () => {
    const c = chain([{ typeId: 'core.a', connectionRef: 'servicenow' }]);
    const req = chainRequirements(c, new Set(['core.a']), (id) => id === 'servicenow');
    expect(req.connections).toEqual([{ ref: 'servicenow', providerId: 'servicenow', providerInstalled: true }]);
  });

  describe('requiredFeatures (ADR 0191 Phase 2 — toggle-gated surfaces)', () => {
    // Resolver stands in for getToggleDefault: crm/analytics are gated (have a
    // toggle default), kb is always-on (no default → null → omitted).
    const resolveFeature = (id: string): { label: string } | null =>
      id === 'crm' ? { label: 'CRM' } : id === 'analytics' ? { label: 'Analytics' } : null;

    it('derives distinct gated features from feature.<id>.nodes.* typeIds, with labels', () => {
      const c = chain([
        { typeId: 'feature.crm.nodes.get-company' },
        { typeId: 'feature.crm.nodes.list-deals' }, // same feature → deduped
        { typeId: 'feature.analytics.nodes.query' },
        { typeId: 'core.ai.chatCompletion' }, // not a feature node
      ]);
      const req = chainRequirements(c, new Set(), () => false, resolveFeature);
      expect(req.requiredFeatures).toEqual([
        { id: 'crm', label: 'CRM' },
        { id: 'analytics', label: 'Analytics' },
      ]);
    });

    it('omits ALWAYS-ON features (resolver returns null — e.g. kb)', () => {
      const c = chain([
        { typeId: 'feature.kb.nodes.rag' }, // always-on → not a requirement
        { typeId: 'feature.crm.nodes.triage-enriched' },
      ]);
      const req = chainRequirements(c, new Set(), () => false, resolveFeature);
      expect(req.requiredFeatures).toEqual([{ id: 'crm', label: 'CRM' }]);
    });

    it('defaults to no required features when no resolver is supplied (back-compat)', () => {
      const c = chain([{ typeId: 'feature.crm.nodes.query' }]);
      const req = chainRequirements(c, new Set(), () => false);
      expect(req.requiredFeatures).toEqual([]);
    });
  });
});
