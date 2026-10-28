/**
 * ADR 0130 Phase 3a / ADR 0714 D1 / ADR 0820 §8.2 — resolveModelRoute (stored
 * config + capability probe + routeTurn).
 *
 * Breaks if a tenant with no config, or a stored-but-disabled config, gets a
 * route (the router's documented OFF posture), if an enabled config stops
 * routing through its rules/fallback, or if an attachment turn whose stored
 * fallback is non-vision is routed (or refused SILENTLY) instead of refused and
 * logged.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { setRouterConfig, setRouterEnabled } from '../src/features/model-router/configService.js';
import { resolveModelRoute } from '../src/features/model-router/resolveRoute.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { modelRouterFeature } from '../src/features/model-router/feature.js';

// Every routable provider is vision-capable since MiniMax stopped being a user BYOK
// provider (ADR 0990 D6), so the product can no longer persist a text-only target.
// The ADR 0714 refusal still guards a future text-only provider; to witness it, the
// capability probe reports `openai` as text-only in this file only.
vi.mock('../src/host/modelCapabilityProbe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/modelCapabilityProbe.js')>();
  return {
    ...actual,
    probeProviderCapabilities: (provider: string) =>
      provider === 'openai' ? [] : actual.probeProviderCapabilities(provider),
  };
});

const T = 'mrr-tenant';
const ORG = 'org-mrr';
const T2 = 'mrr-tenant-nonvision';
// Its OWN tenant: `setRouterConfig` PRESERVES `enabled`, so sharing `T` with the
// enabled case below made this case order-dependent (red when shuffled after it).
const T_OFF = 'mrr-tenant-off';
const cfg = {
  rules: [{ when: { kind: 'tokensOver', threshold: 5000 }, target: { provider: 'anthropic', model: 'big' } }],
  fallback: { provider: 'anthropic', model: 'small' },
};

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  // ADR 0820 §8.2 — the router resolves only while its feature is enabled; register the
  // default (ON) the way boot does. The refusal arm lives in adr0820-core-reclass.test.ts.
  registerToggleDefault(modelRouterFeature.toggleDefault!);
});

describe('resolveModelRoute', () => {
  it('returns null when no config exists (router off → explicit model kept)', async () => {
    expect(await resolveModelRoute('no-tenant', ORG, { tokenEstimate: 9000 }, 0)).toBeNull();
  });

  it('returns null when config exists but is not enabled', async () => {
    const stored = await setRouterConfig(T_OFF, ORG, 'u1', cfg);
    expect(stored.enabled).toBe(false); // the DEFAULT, not a leftover
    expect(await resolveModelRoute(T_OFF, ORG, { tokenEstimate: 9000 }, 0)).toBeNull();
  });

  // ADR 0714 D1 — the END-TO-END refusal, through the REAL config store.
  //
  // Why this block exists as a separate arm: sabotaging the belt in `resolveRoute`
  // originally changed NOTHING detectable — the refusal was real but unwitnessed, the
  // same shape ADR 0708 D1 closed one iteration earlier. A refusal nobody can observe is
  // indistinguishable from a silent downgrade.
  it('an ATTACHMENT turn is REFUSED (null) when the stored fallback is not vision-capable, and the refusal is REPORTED', async () => {
    const nonVision = {
      rules: [{ when: { kind: 'tokensOver', threshold: 5000 }, target: { provider: 'openai', model: 'text' } }],
      // `openai` is routable, so `asTarget` ACCEPTS it as a fallback; the mocked probe
      // above makes it text-only, so the config is persisted through the product's
      // own write path, not injected.
      fallback: { provider: 'openai', model: 'text-only' },
    };
    await setRouterConfig(T2, ORG, 'u1', nonVision);
    await setRouterEnabled(T2, ORG, 'u1', true);

    // `createLogger` writes one JSON line per event to stderr/stdout (logger.ts:81,83),
    // so capture THERE — a console spy sees nothing, which is how this witness first
    // reported a green on an empty capture.
    const lines: string[] = [];
    const capture = (c: string | Uint8Array): boolean => { lines.push(String(c)); return true; };
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    try {
      const d = await resolveModelRoute(T2, ORG, { hasAttachment: true, tokenEstimate: 100 }, 0);
      expect(d, 'never route an attachment turn to a target we just judged ineligible').toBeNull();
    } finally { out.mockRestore(); err.mockRestore(); }

    // The refusal must be OBSERVABLE, not merely correct: an operator whose routing
    // silently stops applying to attachment turns has no other way to find out.
    const blob = lines.join('');
    expect(blob, 'the decline is logged').toContain('model_route_declined_no_vision_target');
  });

  it('CONTROL — the SAME stored config routes normally without an attachment', async () => {
    // Without this, a resolver that returned null unconditionally would pass the leg above.
    await setRouterConfig(T2, ORG, 'u1', {
      rules: [{ when: { kind: 'always' }, target: { provider: 'openai', model: 'text' } }],
      fallback: { provider: 'openai', model: 'text-only' },
    });
    await setRouterEnabled(T2, ORG, 'u1', true);
    const d = await resolveModelRoute(T2, ORG, { tokenEstimate: 100 }, 0);
    expect(d?.target).toMatchObject({ provider: 'openai', model: 'text' });
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
