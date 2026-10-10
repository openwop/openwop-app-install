/**
 * grade-code C-5 — `ensureRegistryPacksInstalled`, the boot install, end to end
 * over its branches: install, skip (non-strict, vendored newer), refuse (strict,
 * pin below vendored), tombstone, a throwing install, and a duplicated pin.
 *
 * The invariant `verify-deploy.sh` leans on is `installed + failed === attempted`
 * — a refusal is an attempt, a skip is not — so every case asserts it.
 *
 * Decisions witnessed: ADR 0655 D5 (EMWF-2, never downgrade below the vendored
 * copy), NP-V2 P7 (failures counted for /readiness + verify-deploy), ADR 0194 P4
 * (tombstoned packs never reinstalled), grade-data D-4 (skips + bootAt).
 * Sabotage witnesses (wave 10): dedupe removed → pin-twice red; tombstone check
 * removed → tombstone red; refusals not counted → strict red; thrown code dropped
 * → throwing red; feature lane mislabeled / dropped under `none` → feature red;
 * vendored-newer skip not recorded → non-strict red; bootAt stamped only on the
 * first run → bootAt red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let packDir = '';
const installed: string[] = [];
const throwFor = new Map<string, { code?: string }>();
const tombstoned = new Set<string>();

vi.mock('../src/packs/registryInstaller.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/packs/registryInstaller.js')>();
  return {
    ...real,
    resolveDefaultPackDir: () => packDir,
    installPackFromRegistry: async (t: { name: string; version: string }) => {
      const e = throwFor.get(t.name);
      if (e) throw Object.assign(new Error(`refused ${t.name}`), e);
      installed.push(`${t.name}@${t.version}`);
      return { installed: true };
    },
  };
});
vi.mock('../src/host/packTombstones.js', () => ({ isTombstoned: (n: string) => tombstoned.has(n) }));

const { ensureRegistryPacksInstalled } = await import('../src/bootstrap/installRegistryPacks.js');
const { registryInstallStatus } = await import('../src/host/registryInstallStatus.js');

function vendor(name: string, version: string): void {
  mkdirSync(join(packDir, name), { recursive: true });
  writeFileSync(join(packDir, name, 'pack.json'), JSON.stringify({ name, version }));
}
function balanced(): void {
  const s = registryInstallStatus();
  expect(s.installed + s.failed.length, 'installed + failed === attempted').toBe(s.attempted);
}

beforeEach(() => {
  packDir = mkdtempSync(join(tmpdir(), 'owp-boot-install-'));
  installed.length = 0;
  throwFor.clear();
  tombstoned.clear();
  delete process.env.OPENWOP_STRICT_REGISTRY;
});
afterEach(() => {
  rmSync(packDir, { recursive: true, force: true });
  delete process.env.OPENWOP_INSTALL_PACKS;
  delete process.env.OPENWOP_STRICT_REGISTRY;
});

describe('ensureRegistryPacksInstalled (grade-code C-5)', () => {
  it('installs an absent pin and counts it', async () => {
    process.env.OPENWOP_INSTALL_PACKS = 'core.a@1.0.0';
    await ensureRegistryPacksInstalled();
    expect(installed).toEqual(['core.a@1.0.0']);
    expect(registryInstallStatus()).toMatchObject({ attempted: 1, installed: 1, failed: [], skipped: [] });
    balanced();
  });

  it('non-strict: a vendored copy newer than the pin is kept and recorded as skipped, not attempted', async () => {
    process.env.OPENWOP_INSTALL_PACKS = 'core.a@1.0.0';
    vendor('core.a', '1.2.0');
    await ensureRegistryPacksInstalled();
    expect(installed).toEqual([]);
    expect(registryInstallStatus()).toMatchObject({ attempted: 0, skipped: [{ name: 'core.a', version: '1.0.0', reason: 'vendored_newer' }] });
    balanced();
  });

  it('strict: the same drift is REFUSED — a counted failure with its code', async () => {
    process.env.OPENWOP_INSTALL_PACKS = 'core.a@1.0.0';
    process.env.OPENWOP_STRICT_REGISTRY = 'true';
    vendor('core.a', '1.2.0');
    await ensureRegistryPacksInstalled();
    expect(registryInstallStatus()).toMatchObject({ attempted: 1, installed: 0, failed: [{ name: 'core.a', lane: 'pinned', code: 'pin_below_vendored' }] });
    balanced();
  });

  it('a tombstoned pack is skipped before classification — never a failure, even under strict drift', async () => {
    process.env.OPENWOP_INSTALL_PACKS = 'core.a@1.0.0';
    process.env.OPENWOP_STRICT_REGISTRY = 'true';
    vendor('core.a', '1.2.0');
    tombstoned.add('core.a');
    await ensureRegistryPacksInstalled();
    expect(registryInstallStatus()).toMatchObject({ attempted: 0, failed: [], skipped: [{ reason: 'tombstoned' }] });
    balanced();
  });

  it('a throwing install is a failure carrying the thrown code (or install_failed)', async () => {
    process.env.OPENWOP_INSTALL_PACKS = 'core.a@1.0.0,core.b@1.0.0,core.c@1.0.0';
    throwFor.set('core.a', { code: 'pack_engine_unsupported' });
    throwFor.set('core.b', {});
    await ensureRegistryPacksInstalled();
    const s = registryInstallStatus();
    expect(s.installed).toBe(1);
    expect(s.failed.map((f) => `${f.name}:${f.code}`).sort()).toEqual(['core.a:pack_engine_unsupported', 'core.b:install_failed']);
    balanced();
  });

  it('a pin listed twice is ONE attempt', async () => {
    process.env.OPENWOP_INSTALL_PACKS = 'core.a@1.0.0,core.a@1.0.0';
    await ensureRegistryPacksInstalled();
    expect(installed).toEqual(['core.a@1.0.0']);
    expect(registryInstallStatus().attempted).toBe(1);
    balanced();
  });

  it('a feature-required pack absent from disk is attempted in the `feature` lane, even with installs disabled', async () => {
    process.env.OPENWOP_INSTALL_PACKS = 'none';
    throwFor.set('feature.x.nodes', {});
    await ensureRegistryPacksInstalled([{ name: 'feature.x.nodes', version: '1.0.0' }]);
    expect(registryInstallStatus().failed).toEqual([{ name: 'feature.x.nodes', version: '1.0.0', lane: 'feature', code: 'install_failed' }]);
    balanced();
  });

  it('stamps bootAt on each run (grade-data D-4)', async () => {
    // Two runs at two fixed instants: a stamp taken only on the FIRST run (or
    // never refreshed) cannot satisfy both. Fake Date only — the run is async I/O.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      process.env.OPENWOP_INSTALL_PACKS = 'none';
      vi.setSystemTime(new Date('2031-03-01T00:00:00.000Z'));
      await ensureRegistryPacksInstalled();
      expect(registryInstallStatus().bootAt).toBe('2031-03-01T00:00:00.000Z');
      vi.setSystemTime(new Date('2031-03-02T00:00:00.000Z'));
      await ensureRegistryPacksInstalled();
      expect(registryInstallStatus().bootAt).toBe('2031-03-02T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});
