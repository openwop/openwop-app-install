/**
 * ADR 0130 Phase 5 (cost-router) — the composite
 * `difficultyAtLeast` condition + the pure `classifyDifficulty` heuristic.
 */
import { describe, it, expect } from 'vitest';
import {
  routeTurn,
  classifyDifficulty,
  type ModelRouterConfig,
  type CapabilityProbe,
  type TurnFeatures,
} from '../src/features/model-router/routeTurn.js';
import { validateRouterConfig } from '../src/features/model-router/configService.js';

const probe: CapabilityProbe = (p) => (p === 'anthropic' ? ['vision', 'tools'] : ['tools']);

describe('classifyDifficulty — token tiers + bumps', () => {
  const f = (o: TurnFeatures) => classifyDifficulty(o);
  it('token tiers: <500 low, <4000 medium, else high', () => {
    expect(f({ tokenEstimate: 100 })).toBe('low');
    expect(f({ tokenEstimate: 500 })).toBe('medium');
    expect(f({ tokenEstimate: 3999 })).toBe('medium');
    expect(f({ tokenEstimate: 4000 })).toBe('high');
    expect(f({})).toBe('low'); // no tokens ⇒ low
  });
  it('an attachment bumps one level (capped at high)', () => {
    expect(f({ tokenEstimate: 100, hasAttachment: true })).toBe('medium');
    expect(f({ tokenEstimate: 3999, hasAttachment: true })).toBe('high');
    expect(f({ tokenEstimate: 4000, hasAttachment: true })).toBe('high'); // capped
  });
  // The retired intent bump (CHAT-FIRST-PORT A8, gone with the `intentIs` kind) is
  // no longer part of the heuristic — only the token tier + the attachment bump.
});

describe('routeTurn — a single difficultyAtLeast cost rule', () => {
  const config: ModelRouterConfig = {
    rules: [
      { when: { kind: 'difficultyAtLeast', level: 'high' }, target: { provider: 'anthropic', model: 'premium' } },
      { when: { kind: 'always' }, target: { provider: 'openai', model: 'cheap' } },
    ],
    fallback: { provider: 'anthropic', model: 'default' },
  };
  it('routes a hard turn to premium, an easy turn to cheap', () => {
    expect(routeTurn({ tokenEstimate: 5000 }, config, probe, 0)?.target.model).toBe('premium');
    expect(routeTurn({ tokenEstimate: 100 }, config, probe, 0)?.target.model).toBe('cheap');
    // medium turn does NOT reach the high threshold → cheap
    expect(routeTurn({ tokenEstimate: 1000 }, config, probe, 0)?.target.model).toBe('cheap');
  });
});

describe('config validation — difficultyAtLeast', () => {
  it('accepts a valid level', () => {
    const cfg = validateRouterConfig({
      rules: [{ when: { kind: 'difficultyAtLeast', level: 'medium' }, target: { provider: 'anthropic', model: 'y' } }],
      fallback: { provider: 'anthropic', model: 'y' },
    });
    expect(cfg.rules[0]!.when).toEqual({ kind: 'difficultyAtLeast', level: 'medium' });
  });
  it('rejects a bad level', () => {
    expect(() => validateRouterConfig({
      rules: [{ when: { kind: 'difficultyAtLeast', level: 'extreme' }, target: { provider: 'anthropic', model: 'y' } }],
      fallback: { provider: 'anthropic', model: 'y' },
    })).toThrow(/difficultyAtLeast/);
  });
});
