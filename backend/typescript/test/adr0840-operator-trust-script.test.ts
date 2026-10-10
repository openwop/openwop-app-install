/**
 * ADR 0840 D5 — the operator's signing script and the host's verifier agree.
 * Runs `scripts/ui-plugin-operator-trust.mjs` against a fixture laid out as the
 * corpus vendors it, then hands its output to the host loader. A drift in either
 * canonical form makes the host refuse the pack, and this goes red.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACK = 'core.openwop.conformance.ui-plugin-narrow';
let fixtures = ''; let packs = ''; let keyDir = '';
const saved: Record<string, string | undefined> = {};
const ENV = ['OPENWOP_UI_PLUGIN_OPERATOR_TRUST', 'OPENWOP_UI_PLUGIN_OPERATOR_PACKS_DIR', 'OPENWOP_FRONTEND_PLUGIN_PACK_DIR'];

beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
  fixtures = mkdtempSync(join(tmpdir(), 'owp-0840-script-'));
  packs = mkdtempSync(join(tmpdir(), 'owp-0840-script-packs-'));
  keyDir = mkdtempSync(join(tmpdir(), 'owp-0840-script-key-'));
  mkdirSync(join(fixtures, 'ui'));
  writeFileSync(join(fixtures, 'ui', 'narrow.html'), '<!doctype html><body>n</body>');
  writeFileSync(join(fixtures, 'ui-plugin-pack-narrow.json'), JSON.stringify({
    name: PACK, version: '1.0.0', kind: 'frontend-plugin', engines: { openwop: '>=2.0.0 <3.0.0' },
    uiPlugins: [{ pluginId: 'narrow', surface: 'artifact-viewer', entry: 'ui/narrow.html', hostApi: ['artifact.read'] }],
  }));
  process.env.OPENWOP_UI_PLUGIN_OPERATOR_PACKS_DIR = fixtures;
  process.env.OPENWOP_FRONTEND_PLUGIN_PACK_DIR = packs;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const d of [fixtures, packs, keyDir]) rmSync(d, { recursive: true, force: true });
});

describe('ADR 0840 D5 — scripts/ui-plugin-operator-trust.mjs', () => {
  it('prints an entry the host accepts, and keeps the private key 0600 and unprinted', async () => {
    const keyPath = join(keyDir, 'op.pem');
    const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'ui-plugin-operator-trust.mjs'),
      '--pack', PACK, '--tenant', 'conf-x', '--key', keyPath, '--dir', fixtures], { encoding: 'utf8' });
    expect(out).not.toContain('PRIVATE KEY');
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    process.env.OPENWOP_UI_PLUGIN_OPERATOR_TRUST = out.trim();
    const { __resetOperatorTrustedPacksForTest } = await import('../src/features/ui-plugins/operatorTrustedPacks.js');
    __resetOperatorTrustedPacksForTest();
    const { listFrontendPluginPacks, operatorTrustTenant } = await import('../src/features/ui-plugins/frontendPluginPacks.js');
    expect(listFrontendPluginPacks().map((p) => p.packName)).toEqual([PACK]);
    expect(operatorTrustTenant(PACK)).toBe('conf-x');
  });
});
