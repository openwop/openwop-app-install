/**
 * Edge-condition normalization at the ingest seams — ADR 0207 §Phase 2.
 *
 * Regression guard for the silently-dropped-edge bug: a workflow registered via
 * `validateWorkflowDefinition` (the `POST /v1/host/openwop-app/workflows` path)
 * carrying the WIRE condition shape `{type,left,right}` used to be cast straight
 * through, so the executor saw `path`/`op` undefined and dropped the edge
 * (fail-closed dead branch, no error). Both ingest seams now route through the
 * one shared `normalizeEdgeCondition`, so the register route honestly honors the
 * wire shape it advertises accepting.
 *
 * The tests close the loop end-to-end: they feed the WIRE shape through the real
 * `validateWorkflowDefinition` and assert the normalized condition then gates a
 * real `evaluateCondition` call (the executor authority) — proving the edge now
 * fires/drops as authored instead of vanishing.
 */
import { describe, expect, it } from 'vitest';
import {
  mapEdgeCondition,
  normalizeEdgeCondition,
} from '../src/host/edgeConditionMapping.js';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';
import { evaluateCondition, type EdgeCondition } from '../src/executor/scheduler.js';

const twoNodeDef = (condition: unknown) => ({
  workflowId: 'test.edge-cond',
  nodes: [
    { nodeId: 'a', typeId: 'core.noop' },
    { nodeId: 'b', typeId: 'core.noop' },
  ],
  edges: [{ edgeId: 'e1', sourceNodeId: 'a', targetNodeId: 'b', condition }],
});

describe('normalizeEdgeCondition — the shared ingest mapper', () => {
  it('maps the WIRE shape {type,left,right} → host {path,op,value}', () => {
    expect(normalizeEdgeCondition({ type: 'equals', left: 'status', right: 'major' }, 'e1')).toEqual({
      path: 'status',
      op: 'eq',
      value: 'major',
    });
    expect(normalizeEdgeCondition({ type: 'notEquals', left: 'x', right: 1 }, 'e1')).toEqual({
      path: 'x',
      op: 'neq',
      value: 1,
    });
    expect(normalizeEdgeCondition({ type: 'contains', left: 'tags', right: 'urgent' }, 'e1')).toEqual({
      path: 'tags',
      op: 'contains',
      value: 'urgent',
    });
  });

  it('passes the HOST-native shape {path,op,value} through unchanged (first-party builder)', () => {
    expect(normalizeEdgeCondition({ path: 'k', op: 'eq', value: 'v' }, 'e1')).toEqual({
      path: 'k',
      op: 'eq',
      value: 'v',
    });
    // value-less host ops survive (truthy/falsy/exists carry no operand).
    expect(normalizeEdgeCondition({ path: 'k', op: 'truthy' }, 'e1')).toEqual({ path: 'k', op: 'truthy' });
    // a falsy operand value is preserved by key-presence (not truthiness) checks.
    expect(normalizeEdgeCondition({ path: 'k', op: 'eq', value: 0 }, 'e1')).toEqual({ path: 'k', op: 'eq', value: 0 });
  });

  it('rejects fail-closed: expression/regex (no host op), unknown op, empty path, non-object', () => {
    expect(() => normalizeEdgeCondition({ type: 'expression', expression: 'x>1' }, 'e1')).toThrow(
      /chain_edge_condition_unsupported/,
    );
    expect(() => normalizeEdgeCondition({ type: 'regex', left: 'x', right: '.*' }, 'e1')).toThrow(
      /chain_edge_condition_unsupported/,
    );
    expect(() => normalizeEdgeCondition({ op: 'bogus', path: 'x' }, 'e1')).toThrow(
      /chain_edge_condition_invalid/,
    );
    expect(() => normalizeEdgeCondition({ op: 'eq', value: 'v' }, 'e1')).toThrow(/needs a non-empty 'path'/);
    expect(() => normalizeEdgeCondition({ type: 'equals', right: 'v' }, 'e1')).toThrow(/non-empty 'left'/);
    expect(() => normalizeEdgeCondition('nope', 'e1')).toThrow(/MUST be an object/);
    expect(() => normalizeEdgeCondition([1, 2], 'e1')).toThrow(/MUST be an object/);
  });
});

describe('mapEdgeCondition — the wire→host core (shared with chain expansion)', () => {
  it('preserves a falsy `right` operand via key-presence', () => {
    expect(mapEdgeCondition({ type: 'equals', left: 'flag', right: false }, 'e')).toEqual({
      path: 'flag',
      op: 'eq',
      value: false,
    });
  });
  it('omits value when `right` is absent', () => {
    expect(mapEdgeCondition({ type: 'equals', left: 'flag' }, 'e')).toEqual({ path: 'flag', op: 'eq' });
  });
});

describe('validateWorkflowDefinition — the register-route ingest seam (end-to-end)', () => {
  it('REGRESSION: a WIRE-shaped condition survives ingest and gates a real evaluateCondition', () => {
    const def = validateWorkflowDefinition(twoNodeDef({ type: 'equals', left: 'severity', right: 'major' }));
    const cond = def.edges?.[0]?.condition as EdgeCondition;
    // Before the fix this arrived as {type,left,right} and the executor dropped it.
    expect(cond).toEqual({ path: 'severity', op: 'eq', value: 'major' });
    // The executor authority now gates on the normalized shape as authored.
    expect(evaluateCondition(cond, { severity: 'major' })).toBe(true);
    expect(evaluateCondition(cond, { severity: 'routine' })).toBe(false);
  });

  it('BACKWARD-COMPAT: a HOST-shaped condition round-trips unchanged', () => {
    const def = validateWorkflowDefinition(twoNodeDef({ path: 'k', op: 'contains', value: 'x' }));
    expect(def.edges?.[0]?.condition).toEqual({ path: 'k', op: 'contains', value: 'x' });
  });

  it('rejects a wire expression/regex condition at ingest (fail-closed, not a dead edge)', () => {
    expect(() => validateWorkflowDefinition(twoNodeDef({ type: 'regex', left: 'x', right: '.*' }))).toThrow(
      /chain_edge_condition_unsupported/,
    );
  });
});

describe('RFC 0134 — truthy/falsy operators (ADR 0472 F2 unblock)', () => {
  it('maps wire truthy/falsy → host truthy/falsy ops, no `right`', () => {
    expect(mapEdgeCondition({ type: 'truthy', left: 'approved' }, 'e')).toEqual({ path: 'approved', op: 'truthy' });
    expect(mapEdgeCondition({ type: 'falsy', left: 'approved' }, 'e')).toEqual({ path: 'approved', op: 'falsy' });
  });
  it('ignores a stray `right` on truthy/falsy (meaningless, not an error — RFC 0134)', () => {
    expect(mapEdgeCondition({ type: 'truthy', left: 'x', right: 42 }, 'e')).toEqual({ path: 'x', op: 'truthy' }); // stray right DROPPED
  });
  it('rejects a truthy/falsy condition missing `left` (never a silently dead edge)', () => {
    expect(() => mapEdgeCondition({ type: 'truthy' }, 'e')).toThrow(/chain_edge_condition_invalid/);
  });
  it('normalizeEdgeCondition passes host-native truthy/falsy through', () => {
    expect(normalizeEdgeCondition({ path: 'approved', op: 'truthy' }, 'e')).toEqual({ path: 'approved', op: 'truthy' });
    expect(normalizeEdgeCondition({ type: 'falsy', left: 'approved' }, 'e')).toEqual({ path: 'approved', op: 'falsy' });
  });
});
