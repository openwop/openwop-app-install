/**
 * ADR 0078 Phase 4 — governance binding (verification).
 *
 * Pins the invariants the prior phases produce: (a) talent data is confidential-pii
 * and subjectId is in the masking union; (b) a talent subjectId is masked in logs;
 * (c) STRUCTURAL no-auto-side-effect — every meta-workflow with a surfacing/egress node
 * has a core.approvalGate upstream, email.draft is draft-only, and no node can send.
 *
 * Approval-required for the suite is enforced by the in-workflow core.approvalGate +
 * the structural never-send of core.email.draft — NOT governanceService.actionPolicyOf
 * (the assistant action loop, a surface this suite does not use). The suite registers
 * nothing with governanceService.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { classificationOf, isKnownPiiFieldName, isPiiField, maskPiiDeep } from '../src/host/dataClassification.js';
import '../src/features/insights-suite/insightsSuiteService.js'; // declarePiiFields side-effect
import { createLogger } from '../src/observability/logger.js';
import {
  insightsBuiltinWorkflows, weeklyVarianceDefinition, anniversaryDraftDefinition,
} from '../src/features/insights-suite/metaWorkflows.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

function capture(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { lines.push(typeof c === 'string' ? c : Buffer.from(c).toString()); return true; });
  try { fn(); } finally { spy.mockRestore(); }
  return lines.join('');
}

describe('ADR 0078 §4 — (a) classification', () => {
  it('talent snapshot is confidential-pii; subjectId is in the masking union', () => {
    expect(classificationOf('insights.talentSnapshot')).toBe('confidential-pii');
    expect(isPiiField('insights.talentSnapshot', 'subjectId')).toBe(true);
    expect(isKnownPiiFieldName('subjectId')).toBe(true); // → masked everywhere in logs
    // VarianceReport is internal (no person fields) — not confidential-pii.
    expect(classificationOf('insights.varianceReport')).toBe('internal');
  });
});

describe('ADR 0078 §4 — (b) PII masking', () => {
  afterEach(() => vi.restoreAllMocks());

  it('masks a talent subjectId but not the 9-box numbers (no over-masking)', () => {
    const masked = maskPiiDeep({ subjectId: 'u-123', box: 9, performance: 3, readiness: 'ready_now' }) as Record<string, unknown>;
    expect(masked.subjectId).toMatch(/^pii_/);
    expect(masked.box).toBe(9);
    expect(masked.performance).toBe(3);
    expect(masked.readiness).toBe('ready_now'); // generic word NOT in the union → untouched
  });

  it('a logged talent subjectId never reaches stdout verbatim', () => {
    const log = createLogger('test.insights');
    const out = capture(() => log.info('talent scored', { subjectId: 'u-secret-123' }));
    expect(out).not.toContain('u-secret-123');
    expect(out).toMatch(/pii_/);
  });
});

describe('ADR 0078 §4 — (c) structural no-auto-side-effect', () => {
  const hasNode = (def: WorkflowDefinition, typeId: string): boolean => def.nodes.some((n) => n.typeId === typeId);
  const nodeIdOf = (def: WorkflowDefinition, typeId: string): string | undefined => def.nodes.find((n) => n.typeId === typeId)?.nodeId;
  const edges = (def: WorkflowDefinition) => def.edges ?? [];

  it('weekly-variance: the approvalGate is upstream of BOTH render and notify', () => {
    const gate = nodeIdOf(weeklyVarianceDefinition, 'core.approvalGate');
    const render = nodeIdOf(weeklyVarianceDefinition, 'feature.documents.nodes.render');
    const notify = nodeIdOf(weeklyVarianceDefinition, 'core.openwop.integration.notification-push');
    expect(gate && render && notify).toBeTruthy();
    // reachability: gate → render → notify (no surfacing before sign-off)
    const e = edges(weeklyVarianceDefinition);
    expect(e.some((x) => x.sourceNodeId === gate && x.targetNodeId === render)).toBe(true);
    expect(e.some((x) => x.sourceNodeId === render && x.targetNodeId === notify)).toBe(true);
  });

  it('anniversary-draft: an approvalGate exists and email is draft-only (never send)', () => {
    expect(hasNode(anniversaryDraftDefinition, 'core.approvalGate')).toBe(true);
    expect(hasNode(anniversaryDraftDefinition, 'core.email.draft')).toBe(true);
  });

  it('NO meta-workflow references a send-capable node typeId', () => {
    for (const def of insightsBuiltinWorkflows) {
      for (const n of def.nodes) {
        expect(/send|sendmail/i.test(n.typeId), `${def.workflowId}.${n.nodeId} (${n.typeId}) must not be send-capable`).toBe(false);
      }
    }
  });
});
