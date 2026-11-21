/**
 * Test data/transport/capsule only. No trust, import-lifetime, registry or engine
 * algorithm is implemented here. Used by two REAL host OS processes.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

export const PACK = 'vendor.nodepolicy.cold';
export const TYPE = PACK + '.probe';
export const OPERATOR = 'user:node-import-cold-operator';
export const REGISTRY = 'https://node-import-cold.invalid';
export const VERSIONS = ['1.0.0', '1.1.0'] as const;
export type Version = typeof VERSIONS[number];
export type Capsule = { root: string; nonce: string } & (
  { phase: 'prepared' } |
  { phase: 'old-exited'; oldPid: number; oldExitCode: 0; oldDigest: string; oldControl: string }
);
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function record(value: unknown): Record<string, unknown> {
  assert(isRecord(value), 'Expected an actual object'); return value;
}
export function text(value: unknown): string { assert.equal(typeof value, 'string'); return String(value); }
export function integer(value: unknown): number {
  assert(typeof value === 'number' && Number.isSafeInteger(value)); return value;
}
export function layout(root: string) {
  return { root, packDir: join(root, 'packs'), assets: join(root, 'assets'),
    control: join(root, 'evaluated.txt'), capsule: join(root, 'capsule.json'),
    home: join(root, 'home'), temp: join(root, 'tmp'),
    oldHost: join(root, 'host-old'), freshHost: join(root, 'host-fresh') };
}
export function owned(root: string, path: string): void {
  const child = relative(root, path);
  assert(child !== '' && !child.startsWith('..') && !isAbsolute(child), 'Fixture path escaped its root');
}
function requirePrivate(path: string, directory: boolean): void {
  const getuid = process.getuid;
  assert(typeof getuid === 'function', 'Fixture requires POSIX owner checks');
  const info = lstatSync(path);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(directory ? info.isDirectory() : info.isFile(), true);
  assert.equal(info.uid, getuid());
  assert.equal(info.mode & 0o777, directory ? 0o700 : 0o600);
}
function writePrivate(root: string, path: string, data: string | Buffer): void {
  owned(root, path); writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
  requirePrivate(path, false);
}
/** Only ordinary launch metadata crosses into the child; no credential bag. */
export function childEnvironment(root: string): NodeJS.ProcessEnv {
  const p = layout(root);
  for (const path of [root, p.home, p.temp, p.oldHost, p.freshHost]) requirePrivate(path, true);
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', HOME: p.home, TMPDIR: p.temp };
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TZ'] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
export function valueFor(nonce: string, version: Version): string {
  return 'node-import-cold ' + nonce.slice(0, 8) + ' ' + version;
}
export function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export function writeCapsule(capsule: Capsule): void {
  const p = layout(capsule.root); requirePrivate(capsule.root, true);
  const next = join(capsule.root, 'capsule-next.json');
  writePrivate(capsule.root, next, JSON.stringify(capsule) + '\n');
  owned(capsule.root, p.capsule); renameSync(next, p.capsule); chmodSync(p.capsule, 0o600);
  requirePrivate(p.capsule, false);
}
export function readCapsule(path: string, expectedNonce: string): Capsule {
  requirePrivate(path, false);
  const root = realpathSync(dirname(path)); requirePrivate(root, true);
  assert(basename(root).startsWith('node-import-cold-'));
  assert.equal(path, layout(root).capsule);
  const raw = record(JSON.parse(readFileSync(path, 'utf8')));
  assert.equal(raw.root, root); assert.equal(raw.nonce, expectedNonce);
  assert(/^[a-f0-9]{24}$/.test(expectedNonce));
  if (raw.phase === 'prepared') return { root, nonce: expectedNonce, phase: 'prepared' };
  assert.equal(raw.phase, 'old-exited');
  const oldPid = integer(raw.oldPid); assert(oldPid > 0);
  assert.equal(raw.oldExitCode, 0);
  const oldDigest = text(raw.oldDigest); assert(/^[a-f0-9]{64}$/.test(oldDigest));
  return { root, nonce: expectedNonce, phase: 'old-exited', oldPid, oldExitCode: 0,
    oldDigest, oldControl: text(raw.oldControl) };
}
export function createFixture(): Capsule {
  assert.equal(process.env.NODE_ENV, 'test');
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'node-import-cold-')));
  chmodSync(root, 0o700); requirePrivate(root, true);
  const p = layout(root), nonce = randomBytes(12).toString('hex');
  try {
    for (const path of [p.packDir, p.assets, p.home, p.temp, p.oldHost, p.freshHost]) mkdirSync(path, { mode: 0o700 });
    const key = generateKeyPairSync('ed25519');
    writePrivate(root, join(p.assets, 'key.pub'), key.publicKey.export({ type: 'spki', format: 'pem' }).toString());
    for (const version of VERSIONS) {
      const source = join(root, 'source-' + version);
      mkdirSync(join(source, 'schemas'), { recursive: true, mode: 0o700 });
      const manifest = Buffer.from(JSON.stringify({
        name: PACK, kind: 'node', version, engines: { openwop: '>=1.0.0 <3.0.0' },
        nodes: [{ typeId: TYPE, version, role: 'pure' }], runtime: { format: 'esm', entry: './index.mjs' },
      }));
      writePrivate(root, join(source, 'pack.json'), manifest);
      writePrivate(root, join(source, 'schemas/value.mjs'), 'export const value = ' + JSON.stringify(valueFor(nonce, version)) + ';\n');
      writePrivate(root, join(source, 'index.mjs'), [
        "import { appendFileSync } from 'node:fs';",
        "import { value } from './schemas/value.mjs';",
        'appendFileSync(' + JSON.stringify(p.control) + ', ' + JSON.stringify(version + '\n') + ');',
        'export const nodes = { ' + JSON.stringify(TYPE) + ': async (ctx) => ({status:"success",outputs:{value,processId:process.pid,tenant:ctx.tenantId}}) };',
        '',
      ].join('\n'));
      const archive = join(p.assets, version + '.tgz');
      const tar = spawnSync('tar', ['-czf', archive, '-C', source, 'pack.json', 'index.mjs', 'schemas'], { encoding: 'utf8' });
      assert.equal(tar.status, 0, tar.stderr); chmodSync(archive, 0o600);
      const integrity = 'sha256-' + createHash('sha256').update(readFileSync(archive)).digest('base64');
      writePrivate(root, join(p.assets, version + '.sig'), sign(null, manifest, key.privateKey));
      writePrivate(root, join(p.assets, version + '.json'), JSON.stringify({
        name: PACK, version, integrity, signing: { keyId: 'node-import-cold-key', scheme: 'ed25519-canonical-json' },
      }));
    }
    // No private signing key, provider credential or inherited environment is persisted.
    const capsule: Capsule = { root, nonce, phase: 'prepared' }; writeCapsule(capsule); return capsule;
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
export function childProfile(root: string, version: Version): Record<string, string> {
  return {
    OPENWOP_STORAGE_DSN: 'memory://', OPENWOP_PACK_DIR: layout(root).packDir,
    OPENWOP_REGISTRY_URL: REGISTRY, OPENWOP_INSTALL_PACKS: PACK + '@' + version,
    OPENWOP_MOUNT_LOCAL_PACKS: 'true', OPENWOP_LOCAL_PACK_PREFIXES: '',
    OPENWOP_PACK_ISOLATION: 'off', OPENWOP_RELEASE_BUS: 'off',
    OPENWOP_TEST_AUTH_ENABLED: 'true', OPENWOP_AUTH_DISABLE_COOKIES: 'false',
    OPENWOP_FEATURE_TOGGLES_DEV_OPEN: 'false', OPENWOP_DEMO_MODE: 'false',
    OPENWOP_SUPERADMIN_REQUIRE_MFA: 'false', OPENWOP_SUPERADMIN_TENANTS: OPERATOR,
    OPENWOP_SESSION_SECRET: 'node-import-cold-local-session-secret-at-least32',
    OPENWOP_SESSION_COOKIE_NAME: '__session',
    OPENWOP_BYOK_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString('hex'),
    OPENWOP_I18N_LOCALES: '', OTEL_EXPORTER_OTLP_ENDPOINT: '',
    OPENWOP_BYOK_KMS_KEY: '', OPENWOP_MCP_SERVER_URL: '', OPENWOP_CLAMAV_HOST: '',
  };
}
export function closedRegistry(root: string) {
  const p = layout(root), requests: string[] = [], unexpected: string[] = [];
  const previous = globalThis.fetch, native = previous.bind(globalThis);
  let ownOrigin: string | null = null;
  const replacement: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (ownOrigin !== null && url.origin === ownOrigin) return native(input, { ...init, redirect: 'error' });
    if (url.origin !== REGISTRY || method !== 'GET') {
      unexpected.push(method + ' ' + url.origin + url.pathname); throw new Error('Unadmitted fixture transport');
    }
    requests.push(url.href);
    if (url.pathname === '/.well-known/openwop-registry.json') return new Response(JSON.stringify({
      signingKeys: [{ keyId: 'node-import-cold-key', permittedNamespaces: ['vendor.*'] }],
      endpoints: { publicKey: '/keys/{keyId}.pub', versionManifest: '/v1/packs/{name}/-/{version}.json',
        v1: { versionManifest: '/v1/packs/{name}/-/{version}.json', versionTarball: '/v1/packs/{name}/-/{version}.tgz', versionSignature: '/v1/packs/{name}/-/{version}.sig' },
        v2: { versionManifest: '/v2/packs/{name}/-/{version}.json', versionTarball: '/v2/packs/{name}/-/{version}.tgz', versionSignature: '/v2/packs/{name}/-/{version}.sig' } },
    }), { status: 200 });
    if (url.pathname === '/keys/node-import-cold-key.pub') return new Response(readFileSync(join(p.assets, 'key.pub'), 'utf8'));
    for (const version of VERSIONS) for (const ext of ['json', 'tgz', 'sig']) {
      if (url.pathname === '/v2/packs/' + PACK + '/-/' + version + '.' + ext) {
        return new Response(new Uint8Array(readFileSync(join(p.assets, version + '.' + ext))), { status: 200 });
      }
    }
    unexpected.push(method + ' ' + url.origin + url.pathname); throw new Error('Unadmitted registry resource');
  };
  globalThis.fetch = replacement;
  return { requests, unexpected, allowOrigin(base: string) {
    const url = new URL(base); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
    assert(!url.username && !url.password); ownOrigin = url.origin;
  }, restore() { assert.equal(globalThis.fetch, replacement); globalThis.fetch = previous; } };
}
