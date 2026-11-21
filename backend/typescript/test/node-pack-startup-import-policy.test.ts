/**
 * Real createApp cold startup. A delegated first-post-install observer records
 * actual disk state; it does not replace installation, loading or org setup.
 * Each file owns its pack directory and native entry URLs; no module/cache reset.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { captureLocalEnvironment, executeValue, localOverrides, record, signedRegistry } from './helpers/nodePackPolicyFixture.js';

const boundary = vi.hoisted(() => ({
  packDir: '', name: '', observations: new Array<{ version: string | null; marker: boolean }>(),
}));
vi.mock('../src/host/featureDefaultOrgs.js', async (original) => {
  const real = await original<typeof import('../src/host/featureDefaultOrgs.js')>();
  return { ...real, ensureFeatureDefaultOrgs: (...args: Parameters<typeof real.ensureFeatureDefaultOrgs>) => {
    if (!boundary.packDir || !boundary.name) throw new Error('Startup observer was not configured');
    const directory = join(boundary.packDir, boundary.name), path = join(directory, 'pack.json');
    const raw: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    const version = raw === null ? null : record(raw).version;
    boundary.observations.push({ version: typeof version === 'string' ? version : null,
      marker: existsSync(join(directory, '.openwop-installed.json')) });
    return real.ensureFeatureDefaultOrgs(...args);
  } };
});

let fixture: ReturnType<typeof signedRegistry> | undefined;
let environment: ReturnType<typeof captureLocalEnvironment> | undefined;
let app: Awaited<ReturnType<typeof import('../src/index.js')['createApp']>> | undefined;
beforeAll(async () => {
  fixture = signedRegistry('startup', ['1.1.0']);
  boundary.packDir = fixture.packDir; boundary.name = fixture.name;
  expect(existsSync(join(fixture.packDir, fixture.name)), 'owned target starts absent').toBe(false);
  environment = captureLocalEnvironment(localOverrides(fixture.packDir, fixture.registry, fixture.name + '@1.1.0', '', false));
  const { testAuthSeamStartupError } = await import('../src/routes/authTestSeam.js');
  // Evaluate the real deployment refusal against the unmodified initial env,
  // before constructing an app or serving any test seam.
  expect(testAuthSeamStartupError({ ...environment.original, OPENWOP_TEST_AUTH_ENABLED: 'true' }), 'local fixture admission').toBeNull();
  const { createApp } = await import('../src/index.js');
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'node-policy-startup', serviceVersion: '0.0.0', enableConsoleTracer: false });
});
afterAll(() => { try { fixture?.close(); } finally { environment?.restore(); } });

it('cold requested-version installation completes before the actual post-install bootstrap boundary and first lazy execution', async () => {
  if (!fixture || !app) throw new Error('Real cold app did not finish fixture admission');
  // If createApp drops its await, this real synchronous next-call observation
  // sees an absent marker while the installer is suspended on its first fetch.
  expect(boundary.observations).toEqual([{ version: '1.1.0', marker: true }]);
  expect(fixture.requests).toContain(fixture.registry + '/v2/packs/' + fixture.name + '/-/1.1.0.sig');
  expect(fixture.unexpected).toEqual([]);
  const { registryInstallStatus } = await import('../src/host/registryInstallStatus.js');
  expect(registryInstallStatus()).toMatchObject({ attempted: 1, installed: 1, failed: [] });
  const { getNodeRegistry } = await import('../src/executor/nodeRegistry.js');
  const registry = getNodeRegistry();
  expect(registry.get(fixture.typeId), 'the pack was installed, not eagerly executed').toBeNull();
  expect(existsSync(fixture.control), 'no native entry ran during construction').toBe(false);
  const module = await registry.resolve(fixture.typeId); // Actual boot-installed lazy resolver.
  if (!module) throw new Error('Actual resolver did not return the signed requested pack');
  expect(module.version).toBe('1.1.0');
  expect(module.packOrigin).toMatchObject({ packName: fixture.name, packVersion: '1.1.0', tier: 'operator-trusted' });
  expect(await executeValue(module)).toEqual({ status: 'success', outputs: { value: 'value-1.1.0' } });
  expect(readFileSync(fixture.control, 'utf8')).toBe('1.1.0\n');
  const same = await registry.resolve(fixture.typeId);
  expect(same).toBe(module);
  expect(readFileSync(fixture.control, 'utf8'), 'ordinary resolution retains the same native graph').toBe('1.1.0\n');
  expect(fixture.unexpected).toEqual([]);
});
