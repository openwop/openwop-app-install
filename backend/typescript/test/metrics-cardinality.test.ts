/**
 * ADR 0556 P0 — the RUNTIME half of the cardinality lint.
 *
 * An unbounded label turns a metric into a per-entity time series and takes the
 * collector down. The failure is operational, arrives late, and is invisible to
 * a test that merely asserts a counter incremented — so the guard has to be
 * tested for what it REFUSES, not for what it records.
 *
 * The static lint (`scripts/check-metric-labels.mjs`) catches a bad label in the
 * catalog. It cannot catch a label whose NAME is computed at the call site,
 * which is what this covers. Neither half substitutes for the other.
 *
 * Assertions here check the violation LEDGER, not just the surviving attributes.
 * "The bad label is absent from the output" would also pass if the guard dropped
 * everything, or ran on nothing at all — an absence is weak evidence. The ledger
 * says the guard actually fired, and on which label.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  FORBIDDEN_LABELS,
  METRIC_CATALOG,
  _resetMetricsForTest,
  addCount,
  guardAttributes,
  labelViolations,
  recordValue,
  type MetricSpec,
} from '../src/observability/metrics.js';

const spec = (name: string): MetricSpec => {
  const s = METRIC_CATALOG.find((m) => m.name === name);
  if (!s) throw new Error(`test fixture drift: ${name} is not in the catalog`);
  return s;
};

beforeEach(() => { _resetMetricsForTest(); });

describe('ADR 0556 P0 — the guard refuses unbounded labels', () => {
  it('drops a FORBIDDEN label and records the violation', () => {
    const s = spec('openwop.run.completed');
    const out = guardAttributes(s, { workflow_kind: 'chain', status: 'completed', runId: 'run_abc123' });
    expect(out).toEqual({ workflow_kind: 'chain', status: 'completed' });
    // The ledger is the positive evidence: the guard RAN and refused this label.
    expect(labelViolations().get('openwop.run.completed:runId')).toBe(1);
  });

  it('drops an UNDECLARED label even when it looks harmless', () => {
    // The catalog is closed. A label nobody thought about is exactly the one
    // that turns out to be a customer name.
    const s = spec('openwop.run.completed');
    const out = guardAttributes(s, { status: 'failed', region: 'us-central1' });
    expect(out).toEqual({ status: 'failed' });
    expect(labelViolations().get('openwop.run.completed:region')).toBe(1);
  });

  it('keeps the MEASUREMENT when it drops a label — never the other way round', () => {
    // A counter that silently under-counts is worse than one missing a
    // dimension: the first corrupts the number an operator alerts on.
    const s = spec('openwop.run.completed');
    const out = guardAttributes(s, { workflow_kind: 'chain', tenantId: 't_1' });
    expect(out.workflow_kind).toBe('chain');
    expect(Object.keys(out)).not.toContain('tenantId');
  });

  it('refuses a forbidden name even if a catalog entry declared it', () => {
    // Defence in depth: the static lint should stop this reaching main, but a
    // guard whose only protection is another check is not a guard.
    const rogue: MetricSpec = {
      name: 'openwop.test.rogue', description: 'x', kind: 'counter',
      labels: ['runId', 'ok'],
    };
    const out = guardAttributes(rogue, { runId: 'r1', ok: 'yes' });
    expect(out).toEqual({ ok: 'yes' });
    expect(labelViolations().get('openwop.test.rogue:runId')).toBe(1);
  });

  it('counts repeat violations but logs once (the ledger accumulates)', () => {
    const s = spec('openwop.run.completed');
    for (let i = 0; i < 5; i++) guardAttributes(s, { runId: `run_${i}` });
    // 5 distinct VALUES, one offending KEY — which is precisely the shape of the
    // outage this prevents.
    expect(labelViolations().get('openwop.run.completed:runId')).toBe(5);
    expect(labelViolations().size).toBe(1);
  });

  it('passes a fully-legal attribute set through untouched', () => {
    // The negative control. Without it, a guard that dropped EVERYTHING would
    // satisfy every assertion above.
    const s = spec('openwop.http.server.duration');
    const legal = { route: '/v1/runs/:runId', method: 'GET', status_class: '2xx' };
    expect(guardAttributes(s, legal)).toEqual(legal);
    expect(labelViolations().size).toBe(0);
  });

  it('the route TEMPLATE is legal while the resolved path is not', () => {
    // `route: '/v1/runs/:runId'` is one series; `path: '/v1/runs/run_abc'` is one
    // series PER RUN. The distinction is the whole point, so it is pinned.
    const s = spec('openwop.http.server.duration');
    const out = guardAttributes(s, { route: '/v1/runs/:runId', path: '/v1/runs/run_abc' });
    expect(out).toEqual({ route: '/v1/runs/:runId' });
    expect(labelViolations().get('openwop.http.server.duration:path')).toBe(1);
  });
});

describe('ADR 0556 P0 — the catalog is the only way to emit', () => {
  it('an undeclared metric throws at the call site', () => {
    // The one case worth throwing on: it surfaces during development, not in a
    // request path, and silently inventing a metric is how a catalog stops
    // being the source of truth.
    expect(() => addCount('openwop.not.declared', 1)).toThrow(/not in METRIC_CATALOG/);
  });

  it('using a counter as a histogram (or vice versa) throws', () => {
    expect(() => recordValue('openwop.run.completed', 1)).toThrow(/not a histogram/);
    expect(() => addCount('openwop.run.duration', 1)).toThrow(/not a counter/);
  });

  it('recording through the real instrument still guards', () => {
    // Exercises addCount's path rather than guardAttributes directly — the
    // guard has to be wired in, not merely exist.
    addCount('openwop.run.started', 1, { workflow_kind: 'chain', tenantId: 'acme' });
    expect(labelViolations().get('openwop.run.started:tenantId')).toBe(1);
  });
});

describe('ADR 0556 P0 — the forbidden list is not vacuous', () => {
  it('covers the id shapes this codebase actually uses', () => {
    // Guards against the list being emptied or trimmed to something toothless:
    // every name here is a real identifier field in this repo.
    for (const name of ['tenantId', 'runId', 'userId', 'workflowId', 'path']) {
      expect(FORBIDDEN_LABELS).toContain(name);
    }
  });

  it('no catalog entry declares a forbidden label', () => {
    // The static lint enforces this in the gate; asserting it here too means a
    // catalog edit fails the unit suite even if someone runs only vitest.
    for (const m of METRIC_CATALOG) {
      for (const label of m.labels) {
        expect(FORBIDDEN_LABELS, `${m.name} declares forbidden label '${label}'`).not.toContain(label);
      }
    }
  });
});
