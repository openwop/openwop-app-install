/**
 * Feature-surface toggle gate (host/featureSurfaces.ts) — the ALWAYS-ON
 * carve-out (ADR 0027 / ADR 0014). Regression lock for the latent bug that the
 * cms Phase-3 surface surfaced: `gate()` resolved every surface's toggle and
 * DENIED when none was registered — so an always-on feature (no `toggleDefault`,
 * e.g. cms / assistant / agent-knowledge) had its `ctx.features.<id>` surface
 * wrongly refused on EVERY call through the real runtime path
 * (`buildHostSurfaceBundle` → `buildFeatureSurfaces` → `gate`). The shipped
 * `feature.{assistant,agent-knowledge}.nodes` packs were dead-on-arrival through
 * that path; their tests masked it by calling the raw surface builders.
 *
 * This drives the REAL gated path (the bundle) and asserts BOTH branches:
 *   - an always-on surface resolves (never `host_capability_disabled`);
 *   - a default-OFF toggled surface is still denied (the gate isn't neutered).
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, res); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

// Invoke a surface's first method with empty args and return the thrown error
// code (if any). The gate runs BEFORE the method body, so even a downstream
// validation/not-found error proves the gate did NOT deny.
const callFirstMethod = async (surface: Record<string, (a: Record<string, unknown>) => Promise<unknown>>): Promise<string | undefined> => {
  const method = Object.keys(surface)[0]!;
  try {
    await surface[method]!({});
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

describe('feature-surface gate — always-on carve-out (ADR 0027)', () => {
  // The always-on features (no toggleDefault) that ship a ctx.features.<id>
  // surface. cms is the one this change added; assistant + agent-knowledge were
  // dead-on-arrival before the fix.
  it.each(['cms', 'assistant', 'agent-knowledge'])(
    'resolves the always-on "%s" surface through the bundle (never host_capability_disabled)',
    async (id) => {
      const bundle = buildHostSurfaceBundle({ tenantId: 'gate-tenant' });
      const surface = bundle.features[id] as Record<string, (a: Record<string, unknown>) => Promise<unknown>>;
      expect(surface, `always-on feature '${id}' must expose a surface`).toBeTruthy();
      const code = await callFirstMethod(surface);
      expect(code, `'${id}' surface must not be gate-denied`).not.toBe('host_capability_disabled');
      expect(code).not.toBe('host_capability_missing');
    },
  );

  it('still DENIES a default-OFF toggled surface (the gate is not neutered)', async () => {
    // priority-matrix is a real feature whose toggle defaults OFF; a tenant that
    // never enabled it must get the uniform refusal on its surface.
    const bundle = buildHostSurfaceBundle({ tenantId: 'gate-tenant' });
    const surface = bundle.features['priority-matrix'] as Record<string, (a: Record<string, unknown>) => Promise<unknown>>;
    expect(surface).toBeTruthy();
    const code = await callFirstMethod(surface);
    expect(code).toBe('host_capability_disabled');
  });
});
