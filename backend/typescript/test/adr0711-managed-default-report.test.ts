/**
 * ADR 0711 option B — `GET /byok/active-config` REPORTS the effective managed default.
 *
 * WHY A REPORTING TEST AND NOT A DISPATCH TEST. The managed default already existed at
 * dispatch before this change: `host/exchange/dispatchTurn.ts` and `bootstrap/nodes.ts`
 * both fall through to `managed:openwop-free` when a run carries no credentialRef. The
 * defect was that this ROUTE answered `config: null`, so the SPA gated on it and showed
 * "Connect an AI provider" — blocking a user before a run that would have dispatched
 * fine. So the property under test is what the route SAYS, measured at the HTTP boundary.
 *
 * THE DISCRIMINATOR IS THE POINT. Reporting the default without `stored:false` would be
 * worse than reporting nothing: `useBYOKConfig` caches a vouched-for config to
 * localStorage, so the fallback would be laundered into a user's choice, survive after an
 * operator set a real binding, and be re-PUT by the heal path — which for a plain member
 * now 403s. Leg 2 pins that the flag distinguishes the two.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

let server: Server;
let BASE = '';
const AC = '/v1/host/openwop-app/byok/active-config';

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `optionb-${Date.now()}@acme.test` }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}
function call(path: string, cookie: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('ADR 0711 option B — the effective default is reported, not invented', () => {
  it('leg 1: with nothing stored the route answers with `stored` present and a boolean', async () => {
    const c = await login();
    const r = await call(AC, c);
    expect(r.status).toBe(200);
    const body = await r.json() as { config: unknown; valid: boolean; stored?: boolean };
    // The discriminator must EXIST whether or not a managed key is seeded in this
    // harness — its absence is what makes a default indistinguishable from a choice.
    expect(typeof body.stored, 'the `stored` discriminator must be present on every response').toBe('boolean');
    expect(body.stored, 'nothing is stored in a fresh workspace').toBe(false);
  });

  it('leg 2: a default is never reported as `stored` — and a real binding always is', async () => {
    const c = await login();
    const before = await (await call(AC, c)).json() as { stored?: boolean; config: unknown };
    expect(before.stored).toBe(false);

    // Store a real binding and prove the SAME field flips. Without this the flag could be
    // hard-coded false and leg 1 would still pass.
    expect((await call('/v1/host/openwop-app/byok/secrets', c, 'POST', { credentialRef: 'byok:google', value: 'AIza-optionb' })).status).toBe(201);
    const put = await call(AC, c, 'PUT', { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google' });
    expect(put.status, await put.text()).toBe(200);

    const after = await (await call(AC, c)).json() as { stored?: boolean; config: { credentialRef: string } | null };
    expect(after.stored, 'a chosen binding MUST report stored:true').toBe(true);
    expect(after.config?.credentialRef).toBe('byok:google');
  });

  it('leg 3: with NO managed key seeded the route reports no default at all', async () => {
    // THE HONESTY CONSTRAINT, and it needs a deterministic oracle rather than a branch.
    // `valid` drives whether the SPA renders chat, so a default reported on an unseeded
    // host would replace "connect a provider" with a chat that fails on first send — one
    // false statement swapped for a worse one.
    //
    // THE FIRST VERSION OF THIS LEG BRANCHED on whether a default came back and asserted
    // something in each arm. It passed with the readiness check REMOVED — both arms were
    // satisfiable, so it measured nothing. This harness seeds no `MINIMAX_API_KEY`, so
    // `getManagedProviderStatuses()` reports the managed tier not-ready and the ONE correct
    // answer is no default. Deleting the readiness check reds this leg.
    const c = await login();
    const body = await (await call(AC, c)).json() as { config: unknown; valid: boolean; stored?: boolean };
    expect(body.config, 'no managed key is seeded here, so there is no default to report').toBeNull();
    expect(body.valid, 'nothing to dispatch on means valid MUST be false').toBe(false);
    expect(body.stored, 'still not stored — the discriminator is about the binding, not the tier').toBe(false);
  });

  it('leg 4: with a managed key SEEDED the default IS reported — the happy path', async () => {
    // THE CAPABILITY ITSELF, which legs 1-3 never observed. Leg 1 asserts only
    // `stored === false` and leg 3 asserts `config` is NULL, so hard-wiring
    // `effectiveManagedDefault()` to `return null` left the feature dead and all three
    // green. The ADR's proof row cited legs 1 and 3 for "the default is reported"; leg 3
    // asserts the opposite. Caught by /grade-code.
    //
    // Seeding the env key and bootstrapping is what makes `getManagedProviderStatuses()`
    // report ready, which is the precondition the report is gated on.
    const prev = process.env.MINIMAX_API_KEY;
    process.env.MINIMAX_API_KEY = 'sk-adr0711-optionb';
    try {
      const { bootstrapManagedProvider } = await import('../src/providers/managedProvider.js');
      await bootstrapManagedProvider();
      const c = await login();
      const body = await (await call(AC, c)).json() as {
        config: { provider: string; credentialRef: string } | null; valid: boolean; stored?: boolean;
      };
      expect(body.config, 'a seeded managed tier MUST be reported as the effective default').not.toBeNull();
      expect(body.config?.credentialRef).toBe('managed:openwop-free');
      expect(body.config?.provider, 'the USER-FACING tile id, never the underlying provider').toBe('openwop-free');
      expect(body.stored, 'reported, not chosen').toBe(false);
      expect(body.valid, 'the key resolves, so the SPA may render chat on it').toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MINIMAX_API_KEY; else process.env.MINIMAX_API_KEY = prev;
    }
  });
});
