/**
 * Owned test data/transport only. The installer, trust, import-lifetime map,
 * resolver and HTTP middleware remain real. Never forwards external requests.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { vi } from 'vitest';
import type { NodeContext, NodeModule } from '../../src/executor/types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected a real object response');
  return value;
}
export function stringField(value: unknown, key: string): string {
  const field = record(value)[key];
  if (typeof field !== 'string') throw new Error('Missing string field: ' + key);
  return field;
}
export function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export function captureLocalEnvironment(overrides: Readonly<Record<string, string>>): {
  original: NodeJS.ProcessEnv; restore: () => void;
} {
  if (process.env.NODE_ENV !== 'test') throw new Error('Node policy fixtures require the actual test runtime');
  const original = { ...process.env };
  const prior = new Map(Object.keys(overrides).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
  return { original, restore: () => {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  } };
}
export function localOverrides(packDir: string, registry: string, installs: string, allowlistedTenant: string, testAuth: boolean): Record<string, string> {
  return {
    OPENWOP_STORAGE_DSN: 'memory://', OPENWOP_PACK_DIR: packDir,
    OPENWOP_REGISTRY_URL: registry, OPENWOP_INSTALL_PACKS: installs,
    OPENWOP_RELEASE_BUS: 'off',
    OPENWOP_MOUNT_LOCAL_PACKS: 'true',
    // Empty override restores the actual committed first-party prefix defaults.
    OPENWOP_LOCAL_PACK_PREFIXES: '',
    OPENWOP_TEST_AUTH_ENABLED: testAuth ? 'true' : 'false',
    OPENWOP_AUTH_DISABLE_COOKIES: 'false', OPENWOP_FEATURE_TOGGLES_DEV_OPEN: 'false',
    OPENWOP_DEMO_MODE: 'false', OPENWOP_SUPERADMIN_REQUIRE_MFA: 'false',
    OPENWOP_SUPERADMIN_TENANTS: allowlistedTenant,
    OPENWOP_SESSION_SECRET: 'node-policy-fixture-session-secret-at-least-32-characters',
    OPENWOP_SESSION_COOKIE_NAME: '__session',
    // Synthetic local AES fixture key, not a provider key or a disk-key write.
    OPENWOP_BYOK_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString('hex'),
    OPENWOP_I18N_LOCALES: '', OTEL_EXPORTER_OTLP_ENDPOINT: '',
    OPENWOP_BYOK_KMS_KEY: '', OPENWOP_MCP_SERVER_URL: '', OPENWOP_CLAMAV_HOST: '',
  };
}
export function signedRegistry(tag: 'startup' | 'http', versions: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'node-policy-' + tag + '-'));
  const packDir = join(root, 'packs'); mkdirSync(packDir);
  const control = join(root, 'executed.txt');
  const name = 'vendor.nodepolicy.' + tag, typeId = name + '.probe';
  const registry = 'https://node-import-policy-' + tag + '.invalid', keyId = 'key-' + tag;
  const key = generateKeyPairSync('ed25519');
  const publicPem = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const bundles = new Map<string, { tar: Buffer; signature: Buffer; integrity: string }>();
  try {
    for (const version of versions) {
      if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Fixture version is not a path segment');
      const source = join(root, 'source-' + version); mkdirSync(join(source, 'schemas'), { recursive: true });
      const manifest = Buffer.from(JSON.stringify({
        name, kind: 'node', version, engines: { openwop: '>=1.0.0 <3.0.0' },
        nodes: [{ typeId, version, role: 'pure' }], runtime: { format: 'esm', entry: './index.mjs' },
      }));
      writeFileSync(join(source, 'pack.json'), manifest);
      writeFileSync(join(source, 'schemas/value.mjs'), 'export const value = ' + JSON.stringify('value-' + version) + ';\n');
      // Only this owned file records actual native top-level evaluation.
      writeFileSync(join(source, 'index.mjs'), [
        "import { appendFileSync } from 'node:fs';",
        "import { value } from './schemas/value.mjs';",
        'appendFileSync(' + JSON.stringify(control) + ', ' + JSON.stringify(version + '\n') + ');',
        'export const nodes = { ' + JSON.stringify(typeId) + ': async () => ({status:"success",outputs:{value}}) };',
        '',
      ].join('\n'));
      const archive = join(root, version + '.tgz');
      const result = spawnSync('tar', ['-czf', archive, '-C', source, 'pack.json', 'index.mjs', 'schemas'], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error('Real fixture tar failed: ' + result.stderr);
      const tar = readFileSync(archive);
      bundles.set(version, { tar, signature: sign(null, manifest, key.privateKey), integrity: 'sha256-' + createHash('sha256').update(tar).digest('base64') });
    }
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
  const requests: string[] = [], unexpected: string[] = [];
  let localOrigin: string | null = null;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (localOrigin !== null && url.origin === localOrigin) return nativeFetch(input, { ...init, redirect: 'error' });
    if (url.origin !== registry || method !== 'GET') {
      unexpected.push(method + ' ' + url.origin + url.pathname); throw new Error('Unadmitted fixture transport');
    }
    requests.push(url.href);
    const ok = (body: string) => new Response(body, { status: 200 });
    if (url.pathname === '/.well-known/openwop-registry.json') return ok(JSON.stringify({
      signingKeys: [{ keyId, permittedNamespaces: ['vendor.*'] }],
      endpoints: { publicKey: '/keys/{keyId}.pub',
        versionManifest: '/v1/packs/{name}/-/{version}.json',
        v2: { versionManifest: '/v2/packs/{name}/-/{version}.json', versionTarball: '/v2/packs/{name}/-/{version}.tgz', versionSignature: '/v2/packs/{name}/-/{version}.sig' } },
    }));
    if (url.pathname === '/keys/' + keyId + '.pub') return ok(publicPem);
    for (const [version, bundle] of bundles) {
      const base = '/v2/packs/' + name + '/-/' + version;
      if (url.pathname === base + '.json') return ok(JSON.stringify({ name, version, integrity: bundle.integrity, signing: { keyId, scheme: 'ed25519-canonical-json' } }));
      if (url.pathname === base + '.tgz') return new Response(new Uint8Array(bundle.tar), { status: 200 });
      if (url.pathname === base + '.sig') return new Response(new Uint8Array(bundle.signature), { status: 200 });
    }
    unexpected.push(method + ' ' + url.origin + url.pathname); throw new Error('Unadmitted fixture registry resource');
  });
  return { root, packDir, control, name, typeId, registry, publicPem, requests, unexpected,
    allowLocalOrigin(base: string) {
      const url = new URL(base);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) throw new Error('Only an owned loopback server is admitted');
      localOrigin = url.origin;
    },
    close() { fetchSpy.mockRestore(); rmSync(root, { recursive: true, force: true }); },
  };
}
export async function executeValue(module: NodeModule) {
  const context: NodeContext = {
    runId: 'node-import-policy', nodeId: 'probe', tenantId: 'node-import-policy', inputs: {}, config: {},
    configurable: {}, secrets: {}, attempt: 1,
    emit: () => Promise.reject(new Error('Unexpected node fixture effect')),
  };
  return module.execute(context);
}
export function cookieClient(base: string) {
  const origin = new URL(base);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw new Error('HTTP fixture forbids deployed targets');
  let cookie = '';
  async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
    const response = await fetch(base + path, { method, headers: {
      'content-type': 'application/json', 'OpenWOP-Version': '2', 'accept-language': 'en',
      ...(cookie ? { cookie } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const responseHeaders: Headers & { getSetCookie?: () => string[] } = response.headers;
    if (typeof responseHeaders.getSetCookie !== 'function') throw new Error('Native response cookie API is unavailable');
    for (const value of responseHeaders.getSetCookie()) {
      const matched = /(__session=[^;]+)/.exec(value);
      const next = matched?.[1]; if (next) cookie = next;
    }
    const value: unknown = await response.json();
    return { status: response.status, body: record(value), headers: response.headers };
  }
  return { get: (path: string) => call('GET', path), post: (path: string, body?: unknown) => call('POST', path, body),
    hasCookie: () => cookie.startsWith('__session=') };
}
