/**
 * TODO-4 — RFC 0029 §A `run-configurable` prompt-override layer (layer 0).
 *
 * The optional, non-normative extension: a run may override a prompt ref via
 * `RunOptions.configurable.promptOverrides[kind]`, threaded to the resolver as
 * `runConfigurable`. It is the HIGHEST-precedence layer when present, and emits
 * NO chain entry at all when absent — so a run that doesn't use it keeps a
 * byte-identical resolution trace. This is host-only work: RFC 0029 is Accepted
 * and already sanctions the layer as optional/non-normative.
 */

import { describe, expect, it } from 'vitest';
import {
  resolvePromptRef,
  promptOverridesFromConfigurable,
  type ResolveRequest,
} from '../src/host/promptResolve.js';

const base: ResolveRequest = {
  kind: 'system',
  node: { nodeId: 'n1', config: { systemPromptRef: 'prompt:node-sys' } },
};

describe('RFC 0029 §A — run-configurable prompt-override layer (TODO-4)', () => {
  it('overrides every normative layer when present (highest precedence)', () => {
    const r = resolvePromptRef({ ...base, runConfigurable: { system: 'prompt:run-sys' } });
    expect(r.resolved).toBe('prompt:run-sys');
    expect(r.chain[0]).toMatchObject({ layer: 'run-configurable', applied: true, source: 'prompt:run-sys' });
    // The node ref is now recorded as superseded, not applied.
    const nodeEntry = r.chain.find((c) => c.layer === 'node');
    expect(nodeEntry).toMatchObject({ applied: false, reason: 'superseded by higher-precedence layer' });
  });

  it('emits NO chain entry and changes nothing when absent (back-compat)', () => {
    const r = resolvePromptRef(base); // no runConfigurable
    expect(r.resolved).toBe('prompt:node-sys');
    expect(r.chain.some((c) => c.layer === 'run-configurable')).toBe(false);
    expect(r.chain[0]).toMatchObject({ layer: 'node', applied: true, source: 'prompt:node-sys' });
  });

  it('records a skip (and falls through) when the map has no override for this kind', () => {
    const r = resolvePromptRef({ ...base, runConfigurable: { user: 'prompt:run-user' } });
    expect(r.resolved).toBe('prompt:node-sys'); // node still wins
    expect(r.chain[0]).toMatchObject({ layer: 'run-configurable', applied: false });
    expect(r.chain.find((c) => c.layer === 'node')).toMatchObject({ applied: true });
  });

  it('falls through when the run-configurable value is non-conforming', () => {
    const r = resolvePromptRef({ ...base, runConfigurable: { system: { not: 'a ref' } } });
    expect(r.resolved).toBe('prompt:node-sys');
    expect(r.chain[0]).toMatchObject({ layer: 'run-configurable', applied: false });
  });

  it('accepts the object PromptRef form { templateId, version }', () => {
    const r = resolvePromptRef({
      kind: 'user',
      node: { nodeId: 'n1', config: {} },
      runConfigurable: { user: { templateId: 'greeting', version: '1.2.0' } },
    });
    expect(r.resolved).toBe('prompt:greeting@1.2.0');
    expect(r.chain[0]).toMatchObject({ layer: 'run-configurable', applied: true });
  });
});

describe('promptOverridesFromConfigurable — the call-site wiring helper', () => {
  it('passes a plain-object override map through', () => {
    const map = { system: 'prompt:x' };
    expect(promptOverridesFromConfigurable({ promptOverrides: map })).toBe(map);
  });

  it('returns undefined when the field is absent (→ resolver skips the layer)', () => {
    expect(promptOverridesFromConfigurable({})).toBeUndefined();
    expect(promptOverridesFromConfigurable(undefined)).toBeUndefined();
  });

  it('returns undefined for a non-object promptOverrides (array / scalar), never coercing', () => {
    expect(promptOverridesFromConfigurable({ promptOverrides: ['prompt:x'] })).toBeUndefined();
    expect(promptOverridesFromConfigurable({ promptOverrides: 'prompt:x' })).toBeUndefined();
    expect(promptOverridesFromConfigurable({ promptOverrides: null })).toBeUndefined();
  });
});
