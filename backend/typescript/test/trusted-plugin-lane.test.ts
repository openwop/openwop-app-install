/**
 * ADR 0367 Phase 2 — the T1 trusted serve lane, pinned over HTTP:
 *  - a pack signed by an operator-PINNED key (manifest + module bytes) serves
 *    its ES module main-frame entry once the 'trusted-plugins' toggle is on;
 *  - EVERY failure path is a uniform 404: toggle off (default), tampered
 *    module bytes, wrong/unknown key, revoked version, missing module;
 *  - /packs tier labeling is honest: 'community' while the lane is off,
 *    'trusted' + trustedEntryPath only when the serve would actually succeed.
 *
 * Fixture: a real temp pack dir (OPENWOP_FRONTEND_PLUGIN_PACK_DIR) with a
 * schema-valid frontend-plugin manifest, the pack.sig.json sidecar (RFC 0117
 * §Signing — the manifest schema is wire-pinned and carries no signing block),
 * a detached Ed25519 manifest signature, and a detached signature over the
 * entry.mjs module bytes. Keyring via OPENWOP_TRUSTED_PACK_KEYS_DIR, mirroring
 * test/pack-signature.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';

// TIMEOUT CLIFF — this file's `beforeAll` does MORE than the ~10s `createApp`
// boot the global `hookTimeout: 30_000` was sized for: it also generates an
// ed25519 keypair, writes and SIGNS a fixture pack, and only then boots. Measured
// unloaded, the whole file costs ~21-24s — a 1.3x margin on a 30s hook budget,
// which is not a margin. It went red in a full run purely because a PARALLEL
// SESSION was running its own backend suite on the same machine.
//
// Per-file rather than raising the global: 537 of the ~540 boot-in-hook files
// really are ~10s, and giving all of them a 2-minute budget would turn every
// genuinely stuck hook into a two-minute hang. The outliers pay for themselves.
//
// The rule, third recurrence now: A HOOK OR TEST WHOSE HONEST COST SITS WITHIN
// ONE ORDER OF MAGNITUDE OF ITS TIMEOUT IS A SCHEDULED FLAKE — it is waiting for
// a busy machine, not for a bug.
vi.setConfig({ hookTimeout: 120_000 });


const PACK_NAME = 'vendor.acme.trusted-demo';
const PLUGIN_ID = 'demo-viewer';
const MODULE_SRC = 'export function mount(el){el.textContent="trusted";return()=>{el.textContent="";};}\n';

let BASE: string;
let server: http.Server;
let packDir: string;
let saveToggle: (status: 'on' | 'off') => Promise<void>;
const H = { authorization: 'Bearer dev-token' };

const trustedUrl = () =>
  `${BASE}/v1/host/openwop-app/ui-plugin/trusted/${encodeURIComponent(PACK_NAME)}/plugins/${PLUGIN_ID}/entry.mjs`;

beforeAll(async () => {
  // ── fixture pack (must exist BEFORE the app module loads: PACKS_DIR is bound at import) ──
  const packsRoot = mkdtempSync(join(tmpdir(), 'trusted-packs-'));
  packDir = join(packsRoot, 'vendor-trusted-demo'); // dir name ≠ manifest name, deliberately
  mkdirSync(packDir);
  const manifest = {
    name: PACK_NAME,
    version: '1.0.0',
    kind: 'frontend-plugin',
    engines: { openwop: '>=1.0.0' },
    uiPlugins: [{ pluginId: PLUGIN_ID, surface: 'artifact-viewer', entry: 'entry.html', hostApi: ['artifact.read'] }],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(packDir, 'pack.json'), manifestBytes);
  writeFileSync(join(packDir, 'entry.html'), '<!doctype html><body>sandbox entry</body>');
  writeFileSync(join(packDir, 'entry.mjs'), MODULE_SRC);
  writeFileSync(join(packDir, 'pack.json.sig'), edSign(null, manifestBytes, privateKey));
  writeFileSync(join(packDir, 'entry.mjs.sig'), edSign(null, Buffer.from(MODULE_SRC), privateKey));
  writeFileSync(join(packDir, 'pack.sig.json'), JSON.stringify({ alg: 'ed25519', keyId: 'test-team-1', manifest: 'pack.json', signatureFile: 'pack.json.sig' }));

  // ── operator keyring ──
  const keysDir = mkdtempSync(join(tmpdir(), 'trusted-keys-'));
  writeFileSync(join(keysDir, 'team.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(join(keysDir, 'index.json'), JSON.stringify([{ keyId: 'test-team-1', file: 'team.pem' }]));

  process.env.OPENWOP_FRONTEND_PLUGIN_PACK_DIR = packsRoot;
  process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR = keysDir;
  delete process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';

  // Dynamic imports so the env above is visible at module-bind time.
  const { createApp } = await import('../src/index.js');
  const { saveConfig, deleteConfig } = await import('../src/host/featureToggles/service.js');
  saveToggle = async (status) => {
    if (status === 'off') { await deleteConfig('trusted-plugins', 'test'); return; }
    await saveConfig({ id: 'trusted-plugins', status, bucketUnit: 'tenant', salt: 'trusted-plugins' }, 'test');
  };
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => {
  delete process.env.OPENWOP_FRONTEND_PLUGIN_PACK_DIR;
  delete process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR;
  delete process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0367 P2 — trusted serve lane', () => {
  it('toggle OFF (the default): trusted serve is a uniform 404 and /packs labels community', async () => {
    await saveToggle('off');
    expect((await fetch(trustedUrl(), { headers: H })).status).toBe(404);
    const list = await (await fetch(`${BASE}/v1/host/openwop-app/ui-plugin/packs`, { headers: H })).json() as { plugins: { packName: string; tier?: string; trustedEntryPath?: string }[] };
    const pl = list.plugins.find((p) => p.packName === PACK_NAME);
    expect(pl?.tier).toBe('community');
    expect(pl?.trustedEntryPath).toBeUndefined();
  });

  it('toggle ON + pinned key: serves the module bytes as JavaScript and labels trusted', async () => {
    await saveToggle('on');
    const res = await fetch(trustedUrl(), { headers: H });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(MODULE_SRC);

    const list = await (await fetch(`${BASE}/v1/host/openwop-app/ui-plugin/packs`, { headers: H })).json() as { plugins: { packName: string; tier?: string; trustedEntryPath?: string }[] };
    const pl = list.plugins.find((p) => p.packName === PACK_NAME);
    expect(pl?.tier).toBe('trusted');
    expect(pl?.trustedEntryPath).toContain('/trusted/');
  });

  it('tampered module bytes → 404 (the signature covers the CODE, not just the manifest)', async () => {
    await saveToggle('on');
    writeFileSync(join(packDir, 'entry.mjs'), MODULE_SRC + '/*evil*/');
    try {
      expect((await fetch(trustedUrl(), { headers: H })).status).toBe(404);
    } finally {
      writeFileSync(join(packDir, 'entry.mjs'), MODULE_SRC);
    }
  });

  it('revoked version → 404 even with a valid signature', async () => {
    await saveToggle('on');
    const revPath = join(mkdtempSync(join(tmpdir(), 'trusted-rev-')), 'revoked.json');
    writeFileSync(revPath, JSON.stringify([`${PACK_NAME}@1.0.0`]));
    process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS = revPath;
    try {
      expect((await fetch(trustedUrl(), { headers: H })).status).toBe(404);
    } finally {
      delete process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS;
    }
  });

  it('unknown key id (empty keyring) → 404', async () => {
    await saveToggle('on');
    const prev = process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR;
    delete process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR;
    try {
      expect((await fetch(trustedUrl(), { headers: H })).status).toBe(404);
    } finally {
      process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR = prev;
    }
  });

  it('unknown pack/plugin → uniform 404 (no existence leak)', async () => {
    await saveToggle('on');
    const res = await fetch(`${BASE}/v1/host/openwop-app/ui-plugin/trusted/nope/plugins/none/entry.mjs`, { headers: H });
    expect(res.status).toBe(404);
  });
});
