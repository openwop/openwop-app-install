/**
 * Runtime workflow-chain pack install — the in-app marketplace (ADR 0163 follow-on).
 *
 * POST /host/openwop-app/workflow-chain-packs/install installs a pack from the
 * registry AT RUNTIME (reusing the Ed25519/SRI-verified installer) and hot-reloads
 * the chain registry. Asserts the operator gate (superadmin), input validation,
 * the upstream-error → canonical-status mapping, and the success contract. The
 * verified installer itself is unit-tested elsewhere; here it's mocked so the route
 * contract is exercised without network.
 *
 * Sabotage-witnessed (wave 64, probes 8fw5g1-pi-*): the superadmin gate, the path-safe
 * name, the tombstone, the SemVer check, the 201/200 split and the 404 / 422 error
 * mappings each turn their case red. The installer mock is RESET before every case
 * (clearing alone keeps queued `mockResolvedValueOnce` answers), so cases pass in any order.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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
  server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  PORT = (server.address() as AddressInfo).port;
});
beforeEach(() => {
  mockInstall.mockReset();
  process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true'; // any authed caller = superadmin (case 1 undoes it)
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN;
});

const url = (p: string) => `http://127.0.0.1:${PORT}/host/openwop-app${p}`;
async function cookie(): Promise<string> {
  const r = await fetch(url('/workflows'));
  return r.headers.get('set-cookie')!.split(';')[0]!;
}
interface ErrorBody { error?: string; message?: string; details?: Record<string, unknown> }
const install = (c: string, body: unknown) => fetch(url('/workflow-chain-packs/install'), {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: c }, body: JSON.stringify(body),
});

describe('runtime workflow-chain pack install (ADR 0163 follow-on)', () => {
  it('denies a non-superadmin caller (operator-only global mutation)', async () => {
    delete process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN; // a plain tenant is not superadmin
    try {
      const r = await install(await cookie(), { name: 'core.openwop.workflows.x', version: '1.0.0' });
      expect(r.status).toBe(403);
      expect((await r.json()) as ErrorBody).toMatchObject({ error: 'forbidden', message: 'Installing workflow packs requires a superadmin principal.' });
      expect(mockInstall).not.toHaveBeenCalled();
    } finally {
      process.env.OPENWOP_FEATURE_TOGGLES_DEV_OPEN = 'true';
    }
  });

  /**
   * ADR 0660 D4 — born red. This lane carried NONE of the hardening its two siblings
   * (`features/marketplace/routes.ts`, `packs/agentPackRegistry.ts`) have had for
   * months: an unsafe name flowed into `join(packDir, name)` and then
   * `rmSync(destDir, {recursive, force})`, and a pack an operator had tombstoned
   * re-installed silently. Superadmin-gated, so an operator footgun and a tombstone
   * bypass rather than a tenant-reachable hole — but the same "a defect closed on one
   * lane survives on its sibling" shape found in four consecutive features of this loop.
   */
  it('refuses a traversal pack name BEFORE touching the filesystem (D4)', async () => {
    for (const name of ['../../etc', 'core/../../escape', '..']) {
      const r = await install(await cookie(), { name, version: '1.0.0' });
      expect(r.status, name).toBe(400);
      expect((await r.json()) as ErrorBody, name).toMatchObject({ error: 'validation_error', message: 'A pack name is required and must be path-safe.', details: { field: 'name' } });
    }
    expect(mockInstall, 'the installer is never reached, so no path is ever joined').not.toHaveBeenCalled();
  });

  it('refuses re-installing a pack the operator tombstoned (409), and allows it after restore (D4)', async () => {
    const { tombstonePack, restorePack } = await import('../src/host/packTombstones.js');
    const name = 'core.openwop.workflows.market-intel';
    await tombstonePack(name, 'test');
    try {
      const r = await install(await cookie(), { name, version: '1.0.0' });
      expect(r.status).toBe(409);
      expect((await r.json()) as ErrorBody).toMatchObject({ error: 'conflict', message: 'Pack is removed from this host. Restore it first.' });
      expect(mockInstall).not.toHaveBeenCalled();
    } finally {
      await restorePack(name);
    }
    // CONTROL — the guard is not a blanket refusal.
    mockInstall.mockResolvedValueOnce({ installed: true });
    expect((await install(await cookie(), { name, version: '1.0.0' })).status).toBe(201);
  });

  it('validates that name + version are present', async () => {
    const r = await install(await cookie(), { name: 'core.openwop.workflows.x' });
    expect(r.status).toBe(400);
    expect((await r.json()) as ErrorBody).toMatchObject({ error: 'validation_error', details: { field: 'version' } });
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('installs + hot-reloads, returning the install result', async () => {
    mockInstall.mockResolvedValueOnce({ installed: true });
    const r = await install(await cookie(), { name: 'core.openwop.workflows.market-intel', version: '1.0.0' });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { installed: boolean; newChains: string[] };
    expect(body.installed).toBe(true);
    expect(Array.isArray(body.newChains)).toBe(true);
    expect(mockInstall).toHaveBeenCalledWith({ name: 'core.openwop.workflows.market-intel', version: '1.0.0' }, expect.objectContaining({ packDir: expect.any(String) }));
  });

  it('reports an already-installed pack with 200 (idempotent)', async () => {
    mockInstall.mockResolvedValueOnce({ installed: false, reason: 'already_installed' });
    const r = await install(await cookie(), { name: 'core.openwop.workflows.market-intel', version: '1.0.0' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { reason?: string }).reason).toBe('already_installed');
  });

  it('maps an unknown pack to 404', async () => {
    mockInstall.mockRejectedValueOnce(new Error('manifest_fetch_failed (404): https://packs.openwop.dev/v1/packs/nope/-/1.0.0.json'));
    const r = await install(await cookie(), { name: 'nope', version: '1.0.0' });
    expect(r.status).toBe(404);
    expect((await r.json()) as ErrorBody).toMatchObject({ error: 'not_found', details: { packName: 'nope', version: '1.0.0' } });
  });

  it('maps a verification failure to 422', async () => {
    mockInstall.mockRejectedValueOnce(new Error('pack_signature_invalid'));
    const r = await install(await cookie(), { name: 'core.openwop.workflows.tampered', version: '1.0.0' });
    expect(r.status).toBe(422);
    expect((await r.json()) as ErrorBody).toMatchObject({ error: 'validation_error', message: '"core.openwop.workflows.tampered" failed signature or integrity verification and was not installed.' });
  });
});
