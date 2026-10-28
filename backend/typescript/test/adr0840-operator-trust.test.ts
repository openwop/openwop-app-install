/**
 * ADR 0840 D5/D6 (RFC 0238 §D) — the conformance fixture loads only under explicit,
 * pack-scoped operator trust, and its artifact exists only in the tenant the operator
 * named.
 *
 * Laid out as the corpus vendors it (`conformance-fixtures/frontend-plugin-packs/`:
 * a manifest JSON beside its `ui/` entry), signed here with a throwaway key.
 *
 * TST-BWB-7 (grade-tests w62): red when the signature check is skipped (every "refuses a
 * signature…" and the tamper case), when an entry without a tenant is accepted, when the
 * statement hashes anything but the entry bytes on disk (tamper case), or when the
 * fixture artifact is minted for any tenant but the trusted one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACK = 'core.openwop.conformance.ui-plugin-narrow';
const OTHER = 'core.openwop.conformance.ui-plugin-other';
const TENANT = 'conf-0840-trust';
const KEY = 'k-0840-trust-000000001';
const OTHER_KEY = 'k-0840-other-000000001';
const HTML = '<!doctype html><html><body>narrow-fixture</body></html>';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
let fixtures = ''; let emptyPacks = '';
const keys = generateKeyPairSync('ed25519');
const wrongKeys = generateKeyPairSync('ed25519');
const pem = (k: typeof keys) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();

function manifest(name: string) {
  return { name, version: '1.0.0', kind: 'frontend-plugin', engines: { openwop: '>=2.0.0 <3.0.0' },
    uiPlugins: [{ pluginId: 'narrow', surface: 'artifact-viewer', entry: 'ui/narrow.html', hostApi: ['artifact.read'] }] };
}
let canonicalStatement: (v: unknown) => string;
function signFor(name: string, file: string, k = keys, mutate?: (s: Record<string, unknown>) => unknown): string {
  const statement = { pack: name, version: '1.0.0', manifestSha256: sha(readFileSync(join(fixtures, file))), entries: { 'ui/narrow.html': sha(readFileSync(join(fixtures, 'ui', 'narrow.html'))) } };
  const payload = mutate ? mutate(statement) : canonicalStatement(statement);
  return sign(null, Buffer.from(String(payload), 'utf8'), k.privateKey).toString('base64');
}
const trust = (entries: object[]) => { process.env.OPENWOP_UI_PLUGIN_OPERATOR_TRUST = JSON.stringify(entries); };

let mod: typeof import('../src/features/ui-plugins/frontendPluginPacks.js');
let reset: () => void;
const saved: Record<string, string | undefined> = {};
const ENV = ['OPENWOP_UI_PLUGIN_OPERATOR_TRUST', 'OPENWOP_UI_PLUGIN_OPERATOR_PACKS_DIR', 'OPENWOP_FRONTEND_PLUGIN_PACK_DIR', 'OPENWOP_API_KEYS', 'OPENWOP_AUTH_ENFORCE_BEARER', 'OPENWOP_DEPLOY_POSTURE'];

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  fixtures = mkdtempSync(join(tmpdir(), 'owp-0840-fx-'));
  emptyPacks = mkdtempSync(join(tmpdir(), 'owp-0840-empty-'));
  mkdirSync(join(fixtures, 'ui'));
  writeFileSync(join(fixtures, 'ui', 'narrow.html'), HTML);
  writeFileSync(join(fixtures, 'ui-plugin-pack-narrow.json'), JSON.stringify(manifest(PACK)));
  writeFileSync(join(fixtures, 'ui-plugin-pack-other.json'), JSON.stringify(manifest(OTHER)));
  process.env.OPENWOP_UI_PLUGIN_OPERATOR_PACKS_DIR = fixtures;
  process.env.OPENWOP_FRONTEND_PLUGIN_PACK_DIR = emptyPacks;
  mod = await import('../src/features/ui-plugins/frontendPluginPacks.js');
  const op = await import('../src/features/ui-plugins/operatorTrustedPacks.js');
  canonicalStatement = op.canonicalStatement; reset = op.__resetOperatorTrustedPacksForTest;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(fixtures, { recursive: true, force: true }); rmSync(emptyPacks, { recursive: true, force: true });
});
beforeEach(() => { delete process.env.OPENWOP_UI_PLUGIN_OPERATOR_TRUST; reset(); });

const listed = () => mod.listFrontendPluginPacks().map((p) => p.packName);

describe('ADR 0840 D5 — operator trust', () => {
  it('is OFF by default: the vendored fixture loads nothing without a trust entry', () => {
    expect(listed()).toEqual([]);
  });

  it('a valid entry loads exactly the pack it names, and serves the verified bytes', () => {
    trust([{ pack: PACK, tenant: TENANT, publicKey: pem(keys), signature: signFor(PACK, 'ui-plugin-pack-narrow.json') }]);
    expect(listed()).toEqual([PACK]);
    expect(mod.getPluginEntry(PACK, 'narrow')?.bytes.toString()).toBe(HTML);
    expect(mod.operatorTrustTenant(PACK)).toBe(TENANT);
  });

  it('refuses a signature by a different key', () => {
    trust([{ pack: PACK, tenant: TENANT, publicKey: pem(keys), signature: signFor(PACK, 'ui-plugin-pack-narrow.json', wrongKeys) }]);
    expect(listed()).toEqual([]);
  });

  it('refuses a signature over another pack (trust is scoped to the name)', () => {
    trust([{ pack: PACK, tenant: TENANT, publicKey: pem(keys), signature: signFor(OTHER, 'ui-plugin-pack-other.json') }]);
    expect(listed()).toEqual([]);
  });

  it('refuses a signature over the unframed manifest ‖ entry concatenation', () => {
    const concat = Buffer.concat([readFileSync(join(fixtures, 'ui-plugin-pack-narrow.json')), Buffer.from(HTML)]);
    trust([{ pack: PACK, tenant: TENANT, publicKey: pem(keys), signature: sign(null, concat, keys.privateKey).toString('base64') }]);
    expect(listed()).toEqual([]);
  });

  it('refuses a tampered entry', () => {
    const sig = signFor(PACK, 'ui-plugin-pack-narrow.json');
    writeFileSync(join(fixtures, 'ui', 'narrow.html'), `${HTML}<script>evil()</script>`);
    try {
      trust([{ pack: PACK, tenant: TENANT, publicKey: pem(keys), signature: sig }]);
      expect(listed()).toEqual([]);
    } finally {
      writeFileSync(join(fixtures, 'ui', 'narrow.html'), HTML);
    }
  });

  it('refuses an entry missing its tenant', () => {
    trust([{ pack: PACK, publicKey: pem(keys), signature: signFor(PACK, 'ui-plugin-pack-narrow.json') }]);
    expect(listed()).toEqual([]);
  });
});

describe('ADR 0840 D6 — the fixture artifact exists only for the trusted tenant', () => {
  let server: http.Server; let base = '';
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_API_KEYS = `${KEY}:${TENANT},${OTHER_KEY}:other-tenant`;
    process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
    process.env.OPENWOP_DEPLOY_POSTURE = 'bearer-shared';
    const { createApp } = await import('../src/index.js');
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);
  afterAll(async () => { if (server) await new Promise<void>((r) => server.close(() => r())); });

  const read = (key: string) => fetch(`${base}/host/ui-plugins/${encodeURIComponent(PACK)}/narrow/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'openwop-version': '2', 'content-type': 'application/json' },
    body: JSON.stringify({ message: { openwop: 'ui-plugin/1', type: 'request', id: 1, method: 'artifact.read', params: { artifactId: 'ui-plugin-narrow-artifact' } } }),
  });

  it('the trusted tenant reads it, with the canary reference unresolved', async () => {
    trust([{ pack: PACK, tenant: TENANT, publicKey: pem(keys), signature: signFor(PACK, 'ui-plugin-pack-narrow.json') }]);
    const r = await read(KEY);
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; result?: { payload?: unknown } };
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body.result?.payload)).toContain('{{secrets.openwop-conformance-canary-secret}}');
  });

  it('another tenant gets no artifact created for it', async () => {
    trust([{ pack: PACK, tenant: TENANT, publicKey: pem(keys), signature: signFor(PACK, 'ui-plugin-pack-narrow.json') }]);
    const r = await read(OTHER_KEY);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: false, error: { code: 'artifact_not_found' } });
  });
});
