/**
 * Run admission preflight P0 — run admission preflight, required-parameter check (D2).
 *
 * CC-CHAIN-9: `market-intel.shift-digest` declares `previous` required; a run
 * started without it was admitted (201), spent on AI discovery, and reached the
 * shift node with `{}` (run 198f9325). The check names the missing parameter.
 *
 * Shadow by default (run-admission-preflight ADR D1 correction; ADR 0504 measured a run-start
 * refusal and withdrew it): the findings are recorded, and only
 * `OPENWOP_RUN_PREFLIGHT=enforce` turns them into a 422 refusal.
 *
 * Red when: a declared-required param with no value anywhere yields no finding;
 * a value from ANY legitimate source (frozen param, default, run input, deferred
 * alias, variable default) still yields one; a definition not expanded from a
 * chain yields one; the mode defaults to anything but shadow; or the refusal
 * loses its reason code or findings.
 */
import { describe, expect, it } from 'vitest';
import { requiredParamFindings, runPreflightMode, runPreflightRefusal, type ChainParamDecl } from '../src/host/runPreflight.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

const DECL: ChainParamDecl = {
  required: ['briefId', 'previous'],
  properties: { briefId: {}, previous: { description: 'the earlier digest to compare against' }, platform: { default: 'web' } },
};
const lookup = (id: string): ChainParamDecl | null => (id === 'market-intel.shift-digest' ? DECL : null);

function def(over: { params?: Record<string, unknown>; metadata?: Record<string, unknown>; variables?: WorkflowDefinition['variables'] } = {}): WorkflowDefinition {
  return {
    workflowId: 'wf.copy.shift', name: 'Shift digest', nodes: [], edges: [],
    ...(over.variables ? { variables: over.variables } : {}),
    metadata: { expandedFrom: { chainId: 'market-intel.shift-digest', version: '1.3.0', params: over.params ?? {} }, ...(over.metadata ?? {}) },
  } as unknown as WorkflowDefinition;
}
const names = (fs: { param: string }[]): string[] => fs.map((f) => f.param).sort();

describe('Run admission preflight D2 — required chain parameters', () => {
  it('names every declared-required parameter that has no value anywhere (CC-CHAIN-9)', () => {
    const f = requiredParamFindings(def(), {}, lookup);
    expect(names(f)).toEqual(['briefId', 'previous']);
    const previous = f.find((x) => x.param === 'previous')!;
    expect(previous).toMatchObject({ kind: 'param_required', chainId: 'market-intel.shift-digest', description: 'the earlier digest to compare against' });
    expect(previous.message).toContain('"previous"');
  });

  it('accepts a value from each legitimate source', () => {
    // frozen at expansion
    expect(names(requiredParamFindings(def({ params: { briefId: 'b1', previous: 'd0' } }), {}, lookup))).toEqual([]);
    // run inputs by bare name (how campaign orchestration passes briefId)
    expect(names(requiredParamFindings(def(), { briefId: 'b1', previous: 'd0' }, lookup))).toEqual([]);
    // RFC 0124 deferred alias, filled by input or by its variable default
    const aliased = def({ metadata: { deferredParameterAliases: { previous: 'n1_previous' } }, variables: [{ name: 'n1_previous', defaultValue: 'd0' }] });
    expect(names(requiredParamFindings(aliased, { briefId: 'b1' }, lookup))).toEqual([]);
    expect(names(requiredParamFindings(def({ metadata: { deferredParameterAliases: { previous: 'n1_previous' } } }), { briefId: 'b1', n1_previous: 'd0' }, lookup))).toEqual([]);
    // a declared default
    expect(names(requiredParamFindings(def(), { briefId: 'b1', previous: 'd0' }, () => ({ required: ['platform'], properties: { platform: { default: 'web' } } })))).toEqual([]);
  });

  it('treats an empty string or null as missing, not supplied', () => {
    expect(names(requiredParamFindings(def({ params: { briefId: '' } }), { previous: null }, lookup))).toEqual(['briefId', 'previous']);
  });

  it('has nothing to say about a definition that was not expanded from a chain, or an unknown chain', () => {
    const plain = { workflowId: 'wf', name: 'x', nodes: [], edges: [] } as unknown as WorkflowDefinition;
    expect(requiredParamFindings(plain, {}, lookup)).toEqual([]);
    expect(requiredParamFindings(def(), {}, () => null)).toEqual([]);
  });
});

describe('Run admission preflight D1 — mode and refusal', () => {
  it('defaults to shadow; only an explicit value turns it off or on', () => {
    expect(runPreflightMode({})).toBe('shadow');
    expect(runPreflightMode({ OPENWOP_RUN_PREFLIGHT: 'nonsense' })).toBe('shadow');
    expect(runPreflightMode({ OPENWOP_RUN_PREFLIGHT: 'enforce' })).toBe('enforce');
    expect(runPreflightMode({ OPENWOP_RUN_PREFLIGHT: 'OFF' })).toBe('off');
  });

  it('the refusal is a 422 validation_error carrying the reason code and every finding', () => {
    const findings = requiredParamFindings(def(), {}, lookup);
    const err = runPreflightRefusal(findings);
    expect(err.code).toBe('validation_error');
    expect(err.httpStatus).toBe(422);
    expect(err.details).toMatchObject({ reason: 'run_preflight_failed' });
    expect((err.details as { findings: unknown[] }).findings).toHaveLength(2);
    expect(err.message).toContain('(1 more)');
  });
});
