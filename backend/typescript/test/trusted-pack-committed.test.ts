/**
 * ADR 0367 Phase 3 — the COMMITTED partner pack, end-to-end.
 *
 * Unlike trusted-plugin-lane.test.ts (synthetic fixtures), this pins the REAL
 * artifacts shipped in the repo: `packs/vendor.openwop.trusted-demo` (signed
 * with the actual openwop-team-1 publisher key) verified against the COMMITTED
 * public keyring `deploy/trusted-keys/`. If anyone re-serializes pack.json,
 * edits entry.mjs without re-signing, or breaks the keyring index, THIS test
 * goes red — the signature chain is CI-enforced, not folklore.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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


const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACK_NAME = 'vendor.openwop.trusted-demo';
const PLUGIN_ID = 'trusted-demo';

let BASE: string;
let server: http.Server;
const H = { authorization: 'Bearer dev-token' };

beforeAll(async () => {
  // The REAL vendored packs dir (no env override) + the COMMITTED keyring.
  delete process.env.OPENWOP_FRONTEND_PLUGIN_PACK_DIR;
  process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR = resolve(REPO_ROOT, 'deploy', 'trusted-keys');
  delete process.env.OPENWOP_TRUSTED_PACK_REVOCATIONS;
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';

  const { createApp } = await import('../src/index.js');
  const { saveConfig } = await import('../src/host/featureToggles/service.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  // Persistence exists only after boot — the toggle write must follow createApp.
  await saveConfig({ id: 'trusted-plugins', status: 'on', bucketUnit: 'tenant', salt: 'trusted-plugins' }, 'test');
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => {
  delete process.env.OPENWOP_TRUSTED_PACK_KEYS_DIR;
  // `server` is only assigned once beforeAll's boot completes. If that hook
  // failed, an unguarded `server.close()` throws a TypeError that REPLACES the
  // real cause in the report — close only what actually opened.
  if (server) await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 0367 P3 — committed partner pack through the full path', () => {
  it('the committed pack verifies as trusted against the committed keyring', async () => {
    const list = await (await fetch(`${BASE}/v1/host/openwop-app/ui-plugin/packs`, { headers: H })).json() as {
      plugins: { packName: string; pluginId: string; tier?: string; trustedEntryPath?: string }[];
    };
    const pl = list.plugins.find((p) => p.packName === PACK_NAME && p.pluginId === PLUGIN_ID);
    expect(pl, 'the vendored trusted-demo pack must list').toBeTruthy();
    expect(pl?.tier).toBe('trusted');
    expect(pl?.trustedEntryPath).toContain('/trusted/');
  });

  it('serves the committed, signed module bytes with the mount contract intact', async () => {
    const res = await fetch(
      `${BASE}/v1/host/openwop-app/ui-plugin/trusted/${encodeURIComponent(PACK_NAME)}/plugins/${PLUGIN_ID}/entry.mjs`,
      { headers: H },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    const src = await res.text();
    expect(src).toContain('export function mount(el)');
  });

  it('the sandbox fallback entry still serves for the same pack (honest degradation)', async () => {
    const res = await fetch(
      `${BASE}/v1/host/openwop-app/ui-plugin/packs/${encodeURIComponent(PACK_NAME)}/plugins/${PLUGIN_ID}/entry`,
      { headers: H },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
