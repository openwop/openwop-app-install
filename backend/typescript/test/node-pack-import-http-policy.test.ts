/**
 * Real createApp, cookie session authority, marketplace auth/toggle gates,
 * signed installer and final error middleware. Only external registry transport
 * is controlled. No mocked route/installer/trust/lifetime/registry algorithm.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { captureLocalEnvironment, cookieClient, executeValue, localOverrides, record, sha, signedRegistry, stringField } from './helpers/nodePackPolicyFixture.js';

const OPERATOR = 'user:node-import-policy-operator', MEMBER = 'user:node-import-policy-member';
const MKT = '/host/openwop-app/marketplace';
let fixture: ReturnType<typeof signedRegistry> | undefined;
let environment: ReturnType<typeof captureLocalEnvironment> | undefined;
let server: Server | undefined, base = '';
beforeAll(async () => {
  fixture = signedRegistry('http', ['1.0.0', '1.1.0']);
  environment = captureLocalEnvironment(localOverrides(fixture.packDir, fixture.registry, 'none', OPERATOR, true));
  const { testAuthSeamStartupError } = await import('../src/routes/authTestSeam.js');
  expect(testAuthSeamStartupError({ ...environment.original, OPENWOP_TEST_AUTH_ENABLED: 'true' }), 'local auth fixture admission').toBeNull();
  const { createApp } = await import('../src/index.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'node-policy-http', serviceVersion: '0.0.0', enableConsoleTracer: false });
  const { enableTenantOverride } = await import('../src/host/featureToggles/service.js');
  for (const tenant of [OPERATOR, MEMBER]) {
    const outcome = await enableTenantOverride('marketplace', tenant, 'node-import-policy-fixture');
    expect(['enabled', 'already-on'], 'actual local tenant toggle admission').toContain(outcome);
  }
  const started = await new Promise<Server>((resolve, reject) => {
    const own = app.listen(0, '127.0.0.1', () => resolve(own));
    own.once('error', reject);
  });
  server = started;
  const address = started.address();
  if (address === null || typeof address === 'string') throw new Error('Owned loopback server did not bind TCP');
  base = 'http://127.0.0.1:' + address.port;
  fixture.allowLocalOrigin(base);
});
afterAll(async () => {
  try {
    if (server) {
      const own = server;
      await new Promise<void>((resolve, reject) => own.close((error) => error ? reject(error) : resolve()));
    }
  } finally { try { fixture?.close(); } finally { environment?.restore(); } }
});

it('an admitted operator gets truthful loaded-pack409 and unchanged no-op, while a real nonoperator cannot install', async () => {
  if (!fixture || !base) throw new Error('Real HTTP fixture did not finish admission');
  const { installPackFromRegistry, verifyInstalledPack } = await import('../src/packs/registryInstaller.js');
  const { loadPackFromManifest } = await import('../src/packs/tarballLoader.js');
  const { getNodeRegistry } = await import('../src/executor/nodeRegistry.js');
  const { packContentDigest } = await import('../src/packs/packContentDigest.js');
  // Genuine signed desired-version positive before its denial at a loaded path.
  const cold = join(fixture.root, 'cold'); mkdirSync(cold);
  expect(await installPackFromRegistry({ name: fixture.name, version: '1.1.0' }, { packDir: cold, registry: fixture.registry })).toEqual({ installed: true });
  const fresh = await loadPackFromManifest(join(cold, fixture.name));
  if (!fresh) throw new Error('Valid signed cold candidate did not load');
  expect(fresh.version).toBe('1.1.0');
  expect(await executeValue(fresh)).toEqual({ status: 'success', outputs: { value: 'value-1.1.0' } });

  const ordinary = cookieClient(base), operator = cookieClient(base);
  for (const [client, tenant, email] of [[ordinary, MEMBER, 'member-node-import@example.invalid'], [operator, OPERATOR, 'operator-node-import@example.invalid']] as const) {
    const login = await client.post('/host/openwop-app/test/login', { tenantId: tenant, email });
    expect(login.status, 'actual durable-user session issuance').toBe(201);
    expect(stringField(login.body.user, 'userId').length, 'opaque durable user ID').toBeGreaterThan(0);
    expect(client.hasCookie(), 'actual cookie retained for the next request').toBe(true);
  }
  const memberRead = await ordinary.get(MKT + '/listings');
  expect(memberRead.status).toBe(200);
  expect(record(memberRead.body.viewer).canAdminister).toBe(false);
  const operatorRead = await operator.get(MKT + '/listings');
  expect(operatorRead.status).toBe(200);
  expect(record(operatorRead.body.viewer).canAdminister).toBe(true);
  const beforeDeniedRequest = fixture.requests.length;
  const denied = await ordinary.post(MKT + '/install', { packName: fixture.name, version: '1.0.0' });
  expect(denied.status).toBe(403);
  expect(denied.body.error).toBe('forbidden');
  expect(denied.body.message).toContain('requires a superadmin principal');
  expect(fixture.requests).toHaveLength(beforeDeniedRequest);

  const installed = await operator.post(MKT + '/install', { packName: fixture.name, version: '1.0.0' });
  expect(installed.status).toBe(200);
  expect(installed.body).toMatchObject({ packName: fixture.name, version: '1.0.0', installed: true, alreadyInstalled: false });
  const registry = getNodeRegistry();
  // The cold positive registered the same type at its own path. Load the actual
  // signed old path through the real loader so THIS owned graph is registered;
  // never clear a registry/cache or mistake the cold control for this graph.
  const old = await loadPackFromManifest(join(fixture.packDir, fixture.name));
  if (!old) throw new Error('Actual installed old module did not load');
  expect(registry.get(fixture.typeId)).toBe(old);
  expect(old.version).toBe('1.0.0');
  expect(old.packOrigin).toMatchObject({ packName: fixture.name, packVersion: '1.0.0', tier: 'operator-trusted' });
  expect(await executeValue(old)).toEqual({ status: 'success', outputs: { value: 'value-1.0.0' } });
  const directory = join(fixture.packDir, fixture.name), digest = packContentDigest(directory);
  const before = ['pack.json', 'index.mjs', 'schemas/value.mjs', '.openwop-installed.json'].map((path) => [path, sha(join(directory, path))]);
  const marker = readFileSync(join(directory, '.openwop-installed.json'), 'utf8');
  const requests = fixture.requests.length;
  const noop = await operator.post(MKT + '/install', { packName: fixture.name, version: '1.0.0' });
  expect(noop.status).toBe(200);
  expect(noop.body).toMatchObject({ installed: false, alreadyInstalled: true, reason: 'already_installed' });
  expect(fixture.requests).toHaveLength(requests);
  expect(registry.get(fixture.typeId)).toBe(old);
  const refused = await operator.post(MKT + '/install', { packName: fixture.name, version: '1.1.0' });
  expect(refused.status).toBe(409);
  expect(refused.body.error).toBe('conflict');
  expect(record(refused.body.details)).toMatchObject({ packName: fixture.name, version: '1.1.0', reason: 'pack_restart_required' });
  expect(refused.body.message).toContain('Configure the desired version for startup and restart');
  expect(refused.headers.get('cache-control')).toContain('no-store');
  const rendered = JSON.stringify(refused.body);
  for (const privateValue of [fixture.root, fixture.registry, fixture.publicPem]) expect(rendered).not.toContain(privateValue);
  expect(packContentDigest(directory)).toBe(digest);
  expect(['pack.json', 'index.mjs', 'schemas/value.mjs', '.openwop-installed.json'].map((path) => [path, sha(join(directory, path))])).toEqual(before);
  expect(readFileSync(join(directory, '.openwop-installed.json'), 'utf8')).toBe(marker);
  expect(verifyInstalledPack(directory)).toBeNull();
  expect(registry.get(fixture.typeId)).toBe(old);
  expect(old.version).toBe('1.0.0');
  expect(await executeValue(old)).toEqual({ status: 'success', outputs: { value: 'value-1.0.0' } });
  expect(fixture.unexpected).toEqual([]);
});
