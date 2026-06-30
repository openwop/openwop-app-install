/**
 * ADR 0136 Phase 3 — intersectScopes (ledger ∩ chipset, never-widen composition).
 */
import { describe, it, expect } from 'vitest';
import { intersectScopes, resolveCapabilityScope } from '../src/features/conversation-tools/scopeResolver.js';

describe('intersectScopes (never-widen)', () => {
  it('agent-default on either side ⇒ the other', () => {
    const r = { mode: 'restricted' as const, enabled: ['a'] };
    expect(intersectScopes(undefined, r)).toEqual(r);
    expect(intersectScopes(r, { mode: 'agent-default' })).toEqual(r);
    expect(intersectScopes(undefined, undefined)).toEqual({ mode: 'agent-default' });
  });

  it('enabled = intersection of both restricted enabled lists', () => {
    const out = intersectScopes({ mode: 'restricted', enabled: ['a', 'b', 'c'] }, { mode: 'restricted', enabled: ['b', 'c', 'd'] });
    expect(out.mode).toBe('restricted');
    expect(out.enabled?.sort()).toEqual(['b', 'c']);
  });

  it('prefix-aware: "kb" ∩ "kb.search" keeps the narrower "kb.search"', () => {
    const out = intersectScopes({ mode: 'restricted', enabled: ['kb'] }, { mode: 'restricted', enabled: ['kb.search'] });
    expect(out.enabled).toEqual(['kb.search']);
  });

  it('disabled + requireApproval = union (anything either forbids/gates stays)', () => {
    const out = intersectScopes(
      { mode: 'restricted', disabled: ['x'], requireApproval: ['p'] },
      { mode: 'restricted', disabled: ['y'], requireApproval: ['q'] },
    );
    expect(out.disabled?.sort()).toEqual(['x', 'y']);
    expect(out.requireApproval?.sort()).toEqual(['p', 'q']);
  });

  it('out_of_mandate ledger (enabled:[]) ∩ anything ⇒ NO tools (talk-not-act)', () => {
    const out = intersectScopes({ mode: 'restricted', enabled: ['a', 'b'] }, { mode: 'restricted', enabled: [] });
    const eff = resolveCapabilityScope(['a', 'b', 'c'], out);
    expect(eff.enabled).toEqual([]);
  });

  it('never widens: composing two scopes never enables a tool neither allowed', () => {
    const out = intersectScopes({ mode: 'restricted', enabled: ['a'] }, { mode: 'restricted', enabled: ['b'] });
    const eff = resolveCapabilityScope(['a', 'b'], out);
    expect(eff.enabled).toEqual([]); // a∩b = ∅
  });
});
