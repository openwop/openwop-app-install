/**
 * ADR 0130 Phase 3a — resolveModelRoute (config + probe + routeTurn).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { setRouterConfig, setRouterEnabled } from '../src/features/model-router/configService.js';
import { resolveModelRoute } from '../src/features/model-router/resolveRoute.js';

const T = 'mrr-tenant';
const ORG = 'org-mrr';
const cfg = {
  rules: [{ when: { kind: 'tokensOver', threshold: 5000 }, target: { provider: 'anthropic', model: 'big' } }],
  fallback: { provider: 'anthropic', model: 'small' },
};

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('resolveModelRoute', () => {
  it('returns null when no config exists (router off → explicit model kept)', async () => {
    expect(await resolveModelRoute('no-tenant', ORG, { tokenEstimate: 9000 }, 0)).toBeNull();
  });

  it('returns null when config exists but is not enabled', async () => {
    await setRouterConfig(T, ORG, 'u1', cfg);
    expect(await resolveModelRoute(T, ORG, { tokenEstimate: 9000 }, 0)).toBeNull();
  });

  it('routes via routeTurn when enabled', async () => {
    await setRouterConfig(T, ORG, 'u1', cfg);
    await setRouterEnabled(T, ORG, 'u1', true);
    const big = await resolveModelRoute(T, ORG, { tokenEstimate: 9000 }, 0);
    expect(big?.target).toMatchObject({ provider: 'anthropic', model: 'big' });
    const small = await resolveModelRoute(T, ORG, { tokenEstimate: 100 }, 0);
    expect(small?.target).toMatchObject({ provider: 'anthropic', model: 'small' }); // fallback
  });
});
