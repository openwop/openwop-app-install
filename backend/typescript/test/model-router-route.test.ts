/**
 * ADR 0130 Phase 1 — the pure per-turn model-routing selector.
 */
import { describe, it, expect } from 'vitest';
import { routeTurn, type ModelRouterConfig, type CapabilityProbe } from '../src/features/model-router/routeTurn.js';

const probe: CapabilityProbe = (provider) => (provider === 'anthropic' || provider === 'google' ? ['vision', 'tools'] : ['tools']);

const config: ModelRouterConfig = {
  rules: [
    { when: { kind: 'tokensOver', threshold: 8000 }, target: { provider: 'anthropic', model: 'big' } },
    { when: { kind: 'attachment' }, target: { provider: 'openai', model: 'no-vision' } }, // intentionally non-vision
    { when: { kind: 'always' }, target: { provider: 'openai', model: 'cheap' } },
  ],
  fallback: { provider: 'anthropic', model: 'default' }, // vision-capable
  cooldownMs: 60_000,
};

describe('routeTurn', () => {
  it('matches a threshold rule', () => {
    const d = routeTurn({ tokenEstimate: 9000 }, config, probe, 0);
    expect(d).toMatchObject({ reason: 'rule', target: { provider: 'anthropic', model: 'big' } });
  });

  it('falls through to the always rule for a small turn', () => {
    const d = routeTurn({ tokenEstimate: 100 }, config, probe, 0);
    expect(d.target).toMatchObject({ provider: 'openai', model: 'cheap' });
  });

  it('NEVER routes an attachment turn to a non-vision target (skips the non-vision rule → vision fallback)', () => {
    const d = routeTurn({ hasAttachment: true, tokenEstimate: 100 }, config, probe, 0);
    // the `attachment`→openai/no-vision rule is filtered out (no vision); the
    // always→openai/cheap rule is also non-vision → filtered; lands on the vision fallback.
    expect(probe(d.target.provider)).toContain('vision');
    expect(d.target).toMatchObject({ provider: 'anthropic' });
  });

  it('applies cooldown stickiness when the sticky target is still eligible', () => {
    const d = routeTurn({ tokenEstimate: 9000 }, config, probe, 1000, { lastTarget: { provider: 'google', model: 'sticky' }, lastAtMs: 0 });
    expect(d).toMatchObject({ reason: 'cooldown', target: { provider: 'google', model: 'sticky' } });
  });

  it('drops a sticky target that is no longer eligible (attachment + sticky non-vision)', () => {
    const d = routeTurn({ hasAttachment: true }, config, probe, 1000, { lastTarget: { provider: 'openai', model: 'no-vision' }, lastAtMs: 0 });
    expect(d.reason).not.toBe('cooldown'); // sticky non-vision is ineligible for an attachment turn
    expect(probe(d.target.provider)).toContain('vision');
  });

  it('expires cooldown after the window', () => {
    const d = routeTurn({ tokenEstimate: 100 }, config, probe, 70_000, { lastTarget: { provider: 'google', model: 'sticky' }, lastAtMs: 0 });
    expect(d.reason).not.toBe('cooldown');
  });

  it('is deterministic', () => {
    expect(routeTurn({ tokenEstimate: 9000 }, config, probe, 0)).toEqual(routeTurn({ tokenEstimate: 9000 }, config, probe, 0));
  });
});

import { routeTurn as routeTurnIntent } from '../src/features/model-router/routeTurn.js';
describe('routeTurn — intentIs rule (ADR 0130 Phase 4)', () => {
  const probe = () => ['vision', 'tools'];
  const cfg = {
    rules: [{ when: { kind: 'intentIs' as const, intent: 'code' }, target: { provider: 'anthropic', model: 'coder' } }],
    fallback: { provider: 'openai', model: 'general' },
  };
  it('routes when the pre-classified intent matches', () => {
    const d = routeTurnIntent({ intent: 'code' }, cfg, probe, 0);
    expect(d.target).toMatchObject({ provider: 'anthropic', model: 'coder' });
    expect(d.reason).toBe('rule');
  });
  it('falls back when the intent does not match', () => {
    const d = routeTurnIntent({ intent: 'chat' }, cfg, probe, 0);
    expect(d.target).toMatchObject({ provider: 'openai', model: 'general' });
    expect(d.reason).toBe('fallback');
  });
  it('falls back when no intent feature is present', () => {
    expect(routeTurnIntent({}, cfg, probe, 0).reason).toBe('fallback');
  });
});
