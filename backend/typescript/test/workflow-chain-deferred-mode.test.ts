/**
 * RFC 0124 (WCP4) — deferred-parameter expansion mode, increment 1.
 *
 * Path A (default) freezes `{{params.*}}` into config/inputs at expansion. Deferred
 * mode (opt-in) instead materializes chain params as run-overridable `variables[]`
 * + a `configurableSchema` bare-param alias, and rewrites WHOLE-VALUE `{{params.x}}`
 * `node.inputs` tokens to variable-sourced PortValues — so one owned workflow is
 * re-runnable with different values per run, still token-free/portable. Everything
 * else (config, embedded/nested inputs) falls back to expansion-time freeze (the
 * spec-sanctioned §Rewrite-targets fallback; the prompt-body PromptTemplate lift is
 * a follow-up). A `x-openwop-sensitive` param is fail-closed unless it lands in a
 * deferrable (never-persisted) position — the §Security at-rest-leak gate.
 */
import { describe, it, expect } from 'vitest';
import { expandChain, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';
import {
  seedRunVariables,
  snapshotRunVariables,
  deferredConfigurableInputs,
} from '../src/host/variablesRuntime.js';

/** whole-value input token + embedded config token + a defaulted param. */
const nonSensitive: WorkflowChain = {
  chainId: 'test.deferred',
  version: '1.0.0',
  label: 'Deferred test',
  description: 'd',
  parameters: {
    type: 'object',
    required: ['topic'],
    properties: {
      topic: { type: 'string' }, // used as a WHOLE-VALUE node input
      region: { type: 'string', default: 'us' }, // used EMBEDDED in config
    },
  },
  dag: {
    nodes: [
      {
        id: 'a',
        typeId: 'core.noop',
        config: { note: 'region={{params.region}}' }, // embedded → freeze (fallback)
        inputs: { topic: '{{params.topic}}' }, // whole-value → variable PortValue
      },
    ],
  },
};

/** a secret-class param declared via the manifest hint. */
const sensitiveInput: WorkflowChain = {
  chainId: 'test.deferred.sensitive',
  version: '1.0.0',
  label: 'Sensitive',
  description: 'd',
  parameters: {
    type: 'object',
    required: ['apiKey'],
    properties: { apiKey: { type: 'string', 'x-openwop-sensitive': true } },
  },
  dag: { nodes: [{ id: 'a', typeId: 'core.noop', inputs: { key: '{{params.apiKey}}' } }] },
};

const varBySuffix = (def: ReturnType<typeof expandChain>, suffix: string) =>
  (def.variables ?? []).find((v) => v.name.endsWith(suffix));

describe('RFC 0124 — deferred-parameter mode (increment 1)', () => {
  it('materializes variables[] + configurableSchema alias; whole-value input → variable PortValue; embedded config → frozen', () => {
    const def = expandChain(nonSensitive, { deferred: true, params: { topic: 'AI ops', region: 'eu' } });

    // metadata marks the mode.
    expect(def.metadata?.expansionMode).toBe('deferred');

    // params materialized as run variables with the provided value as default.
    const topicVar = varBySuffix(def, '_topic')!;
    const regionVar = varBySuffix(def, '_region')!;
    expect(topicVar).toBeDefined();
    expect(topicVar.required).toBe(true); // declared required
    expect(topicVar.defaultValue).toBe('AI ops');
    expect(regionVar.required).toBe(false);
    expect(regionVar.defaultValue).toBe('eu');

    // configurableSchema is a valid JSON Schema keyed by the BARE param name (the
    // run-time override key); the bare→prefixed mapping lives in metadata.
    const props = (def.configurableSchema as { properties: Record<string, { type?: string }> }).properties;
    expect(props.topic).toEqual({ type: 'string' });
    expect(props.region).toEqual({ type: 'string' });
    const aliases = def.metadata?.deferredParameterAliases as Record<string, string>;
    expect(aliases.topic).toBe(topicVar.name);
    expect(aliases.region).toBe(regionVar.name);

    // whole-value input token → variable-sourced PortValue.
    const node = def.nodes[0];
    expect(node.inputs!.topic).toEqual({ type: 'variable', variableName: topicVar.name });

    // embedded config token → frozen (fallback); no residual tokens anywhere.
    expect((node.config as { note: string }).note).toBe('region=eu');
    expect(JSON.stringify(def.nodes)).not.toContain('{{params');
    expect(JSON.stringify(def.nodes)).not.toContain('{{inputs');
  });

  it('is deterministic and collision-safe: different params ⇒ different workflowId', () => {
    const a = expandChain(nonSensitive, { deferred: true, params: { topic: 'X' } });
    const b = expandChain(nonSensitive, { deferred: true, params: { topic: 'Y' } });
    expect(expandChain(nonSensitive, { deferred: true, params: { topic: 'X' } })).toEqual(a);
    expect(a.workflowId).not.toBe(b.workflowId); // default differs → distinct persisted def
  });

  it('SENSITIVE param in a whole-value node INPUT → FAIL CLOSED (RFC 0124 §Security amendment: no source:secret PortValue in v1)', () => {
    // Amendment (2026-07-04): a sensitive param is deferrable ONLY in a prompt-body
    // position (→ source:secret PromptVariable). A whole-value node input would
    // materialize a plaintext source:variable value (no {type:"secret"} PortValue
    // exists), so it MUST fail closed rather than bag the secret.
    expect(() => expandChain(sensitiveInput, { deferred: true, params: { apiKey: 'secret-123' } })).toThrow(
      /sensitive_param_not_deferrable/,
    );
  });

  it('SENSITIVE param in a frozen (config) position → FAIL CLOSED (secret-at-rest gate)', () => {
    const inConfig: WorkflowChain = {
      ...sensitiveInput,
      dag: { nodes: [{ id: 'a', typeId: 'core.noop', config: { auth: '{{params.apiKey}}' } }] },
    };
    expect(() => expandChain(inConfig, { deferred: true, params: { apiKey: 'x' } })).toThrow(
      /sensitive_param_not_deferrable/,
    );
  });

  it('SENSITIVE param in NON-deferred (Path A) mode → FAIL CLOSED (freeze would leak)', () => {
    expect(() => expandChain(sensitiveInput, { deferred: false, params: { apiKey: 'x' } })).toThrow(
      /sensitive_param_not_deferrable/,
    );
    // default (non-deferred) path also fails closed.
    expect(() => expandChain(sensitiveInput, { params: { apiKey: 'x' } })).toThrow(
      /sensitive_param_not_deferrable/,
    );
  });

  it('configurable override (bare param) reaches the deferred variable bag; default otherwise', () => {
    const def = expandChain(nonSensitive, { deferred: true, params: { topic: 'AI ops', region: 'us' } });
    const topicVar = varBySuffix(def, '_topic')!;
    const regionVar = varBySuffix(def, '_region')!;

    // POST /v1/runs {configurable:{topic:'override'}} → the bare-param override is
    // mapped onto the prefixed variable and wins; unset params fall to defaults.
    const overlay = deferredConfigurableInputs(def, { topic: 'override' }, undefined);
    seedRunVariables('run-cfg', def.variables, overlay);
    const bag = snapshotRunVariables('run-cfg')!;
    expect(bag[topicVar.name]).toBe('override');
    expect(bag[regionVar.name]).toBe('us'); // default, not overridden

    // no configurable → both fall to their materialized defaults.
    seedRunVariables('run-def', def.variables, deferredConfigurableInputs(def, undefined, undefined));
    const bag2 = snapshotRunVariables('run-def')!;
    expect(bag2[topicVar.name]).toBe('AI ops');
    expect(bag2[regionVar.name]).toBe('us');
  });

  it('fork replays the same bound configurable value (RFC 0124 / R4 determinism)', () => {
    const def = expandChain(nonSensitive, { deferred: true, params: { topic: 'AI ops' } });
    const topicVar = varBySuffix(def, '_topic')!;
    // original run overrides via configurable.
    seedRunVariables('orig', def.variables, deferredConfigurableInputs(def, { topic: 'override' }, undefined));
    // a fork inherits the source `configurable` and re-seeds through the same
    // alias path → byte-identical bound value (no machine-local drift).
    seedRunVariables('fork', def.variables, deferredConfigurableInputs(def, { topic: 'override' }, undefined));
    expect(snapshotRunVariables('fork')![topicVar.name]).toBe(
      snapshotRunVariables('orig')![topicVar.name],
    );
    expect(snapshotRunVariables('fork')![topicVar.name]).toBe('override');
  });

  it('non-deferred workflow: deferredConfigurableInputs is a no-op (no alias map)', () => {
    const def = expandChain(nonSensitive, { params: { topic: 'AI ops' } }); // Path A — no aliases
    const inputs = { some: 'value' };
    expect(deferredConfigurableInputs(def, { topic: 'x' }, inputs)).toBe(inputs); // unchanged reference
  });

  it('Path A (non-deferred) is unchanged for a non-sensitive chain: freezes, no variables[]', () => {
    const def = expandChain(nonSensitive, { params: { topic: 'AI ops', region: 'eu' } });
    expect(def.variables).toBeUndefined();
    expect(def.metadata?.expansionMode).toBe('expansion-time');
    expect(def.nodes[0].inputs!.topic).toBe('AI ops'); // frozen whole-value
    expect((def.nodes[0].config as { note: string }).note).toBe('region=eu');
  });
});
