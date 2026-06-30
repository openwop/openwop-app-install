/**
 * Runtime workflow-chain pack install — the in-app marketplace (ADR 0163 follow-on).
 *
 * POST /v1/host/openwop-app/workflow-chain-packs/install installs a pack from the
 * registry AT RUNTIME (reusing the Ed25519/SRI-verified installer) and hot-reloads
 * the chain registry. Asserts the operator gate (superadmin), input validation,
 * the upstream-error → canonical-status mapping, and the success contract. The
 * verified installer itself is unit-tested elsewhere; here it's mocked so the route
 * contract is exercised without network.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { mockInstall } = vi.hoisted(() => ({ mockInstall: vi.fn() }));
vi.mock('../src/packs/registryInstaller.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/packs/registryInstaller.js')>();
  return { ...actual, installPackFromRegistry: (...args: unknown[]) => mockInstall(...args) };
});

const { createApp } = await import('../src/index.js');

let server: http.Server;
let PORT: number;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = '';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  PORT = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
});

const url = (p: string) => `http://127.0.0.1:${PORT}/v1/host/openwop-app${p}`;
async function cookie(): Promise<string> {
  const r = await fetch(url('/workflows'));
  return r.headers.get('set-cookie')!.split(';')[0]!;
}
const install = (c: string, body: unknown) => fetch(url('/workflow-chain-packs/install'), {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: c }, body: JSON.stringify(body),
});

describe('runtime workflow-chain pack install (ADR 0163 follow-on)', () => {
  it('denies a non-superadmin caller (operator-only global mutation)', async () => {
    delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN; // a plain tenant is not superadmin
    const r = await install(await cookie(), { name: 'core.openwop.workflows.x', version: '1.0.0' });
    expect(r.status).toBe(403);
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('validates that name + version are present', async () => {
    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true'; // any authed caller = superadmin
    const r = await install(await cookie(), { name: 'core.openwop.workflows.x' });
    expect(r.status).toBe(400);
  });

  it('installs + hot-reloads, returning the install result', async () => {
    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    mockInstall.mockResolvedValueOnce({ installed: true });
    const r = await install(await cookie(), { name: 'core.openwop.workflows.market-intel', version: '1.0.0' });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { installed: boolean; newChains: string[] };
    expect(body.installed).toBe(true);
    expect(Array.isArray(body.newChains)).toBe(true);
    expect(mockInstall).toHaveBeenCalledWith({ name: 'core.openwop.workflows.market-intel', version: '1.0.0' }, expect.objectContaining({ packDir: expect.any(String) }));
  });

  it('reports an already-installed pack with 200 (idempotent)', async () => {
    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    mockInstall.mockResolvedValueOnce({ installed: false, reason: 'already_installed' });
    const r = await install(await cookie(), { name: 'core.openwop.workflows.market-intel', version: '1.0.0' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { reason?: string }).reason).toBe('already_installed');
  });

  it('maps an unknown pack to 404', async () => {
    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    mockInstall.mockRejectedValueOnce(new Error('manifest_fetch_failed (404): https://packs.openwop.dev/v1/packs/nope/-/1.0.0.json'));
    const r = await install(await cookie(), { name: 'nope', version: '1.0.0' });
    expect(r.status).toBe(404);
  });

  it('maps a verification failure to 422', async () => {
    process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    mockInstall.mockRejectedValueOnce(new Error('pack_signature_invalid'));
    const r = await install(await cookie(), { name: 'core.openwop.workflows.tampered', version: '1.0.0' });
    expect(r.status).toBe(422);
  });
});
