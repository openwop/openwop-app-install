/**
 * ADR 0130 Phase 4c — resolveModelRouteWithIntent (classify only when needed).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { setRouterConfig, setRouterEnabled } from '../src/features/model-router/configService.js';
import { resolveModelRouteWithIntent } from '../src/features/model-router/resolveRouteWithIntent.js';

const T = 'mri-tenant';
const ORG = 'org-mri';
const intentCfg = {
  rules: [{ when: { kind: 'intentIs', intent: 'code' }, target: { provider: 'anthropic', model: 'coder' } }],
  fallback: { provider: 'openai', model: 'general' },
};
const noIntentCfg = {
  rules: [{ when: { kind: 'always' }, target: { provider: 'openai', model: 'general' } }],
  fallback: { provider: 'openai', model: 'general' },
};

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('resolveModelRouteWithIntent', () => {
  it('classifies + routes when an intentIs rule matches', async () => {
    await setRouterConfig(T, ORG, 'u', intentCfg);
    await setRouterEnabled(T, ORG, 'u', true);
    const classify = vi.fn(async () => 'code');
    const d = await resolveModelRouteWithIntent(T, ORG, {}, 'write a python function', 0, undefined, classify);
    expect(classify).toHaveBeenCalledOnce();
    expect(d?.target).toMatchObject({ provider: 'anthropic', model: 'coder' });
  });

  it('does NOT classify when no rule needs the intent (no extra LLM call)', async () => {
    await setRouterConfig(T, ORG, 'u', noIntentCfg);
    await setRouterEnabled(T, ORG, 'u', true);
    const classify = vi.fn(async () => 'code');
    await resolveModelRouteWithIntent(T, ORG, {}, 'anything', 0, undefined, classify);
    expect(classify).not.toHaveBeenCalled();
  });

  it('returns null when the router is off (no classify)', async () => {
    const classify = vi.fn(async () => 'code');
    expect(await resolveModelRouteWithIntent('no-tenant', ORG, {}, 'x', 0, undefined, classify)).toBeNull();
    expect(classify).not.toHaveBeenCalled();
  });
});
