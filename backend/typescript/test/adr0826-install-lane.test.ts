/**
 * ADR 0826 D4 — ONE registry-install lane (`packs/installLane.ts`).
 *
 * Three routes + the boot installer each hand-copied their preflight, and they
 * had drifted (semver on 1 of 3 routes, tombstone on 2, keys dir on 2, error
 * mapping on 1 — the chain lane echoed raw messages with registry URLs, `MKT2-29`).
 * The ratchet below makes a fourth hand-rolled caller a red test, not a review
 * comment; the rest pins what the lane refuses.
 *
 * Sabotage witnesses (wave 10): a route calling the installer directly → ratchet
 * red; a route skipping assertInstallable → route ratchet red; name / SemVer /
 * tombstone / revoked (exact + wildcard) checks removed → their refusal cases red;
 * the URL scrub removed → unknown-failure red; the content-refused or unreachable
 * mapping removed → its case red; the boot revoked check removed → boot case red.
 * Ceiling: both ratchet cases are TEXT scans and count comments — they police the
 * spelling of the call, not the call (a recorded ceiling, baseline unchanged).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertInstallable, translateInstallError } from '../src/packs/installLane.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { revokePack, __clearPackRevocations, REVOKE_ALL_VERSIONS } from '../src/host/packRevocations.js';
import { tombstonePack, restorePack } from '../src/host/packTombstones.js';
import { ensureRegistryPacksInstalled } from '../src/bootstrap/installRegistryPacks.js';
import { registryInstallStatus } from '../src/host/registryInstallStatus.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});
afterAll(async () => {
  await __clearPackRevocations();
  __resetHostExtPersistence();
});

describe('ADR 0826 D4 — the install-lane ratchet', () => {
  it('only the lane and the boot installer CALL installPackFromRegistry', () => {
    const allowed = new Set(['packs/installLane.ts', 'bootstrap/installRegistryPacks.ts', 'packs/registryInstaller.ts']);
    const callers = tsFiles(SRC)
      .filter((f) => /\binstallPackFromRegistry\s*\(/.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(SRC, f).split('\\').join('/'))
      .sort();
    // Non-vacuous: the scan must actually find the sanctioned callers.
    expect(callers).toEqual(expect.arrayContaining(['packs/installLane.ts', 'bootstrap/installRegistryPacks.ts']));
    expect(callers.filter((c) => !allowed.has(c)), 'a route installs around the lane — call assertInstallable + installFromConfiguredRegistry').toEqual([]);
  });

  it('every install ROUTE goes through assertInstallable', () => {
    for (const route of ['features/marketplace/routes.ts', 'routes/agentPackRegistry.ts', 'routes/workflows.ts']) {
      const text = readFileSync(join(SRC, route), 'utf-8');
      expect(text, route).toMatch(/assertInstallable\(/);
      expect(text, route).toMatch(/installFromConfiguredRegistry\(/);
    }
  });
});

describe('ADR 0826 D4 — what the lane refuses before any byte is fetched', () => {
  it('a path-unsafe name or a non-SemVer version is a 400', () => {
    for (const name of ['../../etc', 'a/b', '..', '']) {
      expect(() => assertInstallable({ name, version: '1.0.0' }), name).toThrow(expect.objectContaining({ httpStatus: 400 }));
    }
    for (const version of ['1.0', '1.0.0/../../x', 'latest', '', undefined]) {
      expect(() => assertInstallable({ name: 'acme.widgets', version }), String(version)).toThrow(expect.objectContaining({ httpStatus: 400 }));
    }
    expect(assertInstallable({ name: 'acme.widgets', version: '1.2.3-beta.1+build.5' })).toEqual({ name: 'acme.widgets', version: '1.2.3-beta.1+build.5' });
  });

  it('a tombstoned pack is a 409 (restore first)', async () => {
    await tombstonePack('acme.removed', 'test');
    try {
      expect(() => assertInstallable({ name: 'acme.removed', version: '1.0.0' })).toThrow(expect.objectContaining({ httpStatus: 409 }));
    } finally {
      await restorePack('acme.removed');
    }
  });

  it('a REVOKED version is a 409 — exact and wildcard — and the fix version is not blocked', async () => {
    await revokePack({ packName: 'acme.bad', version: '1.0.0', by: 'test', reason: 'compromised' });
    await revokePack({ packName: 'acme.publisher-gone', version: REVOKE_ALL_VERSIONS, by: 'test', reason: 'publisher compromised' });
    expect(() => assertInstallable({ name: 'acme.bad', version: '1.0.0' })).toThrow(expect.objectContaining({ httpStatus: 409, code: 'conflict' }));
    expect(() => assertInstallable({ name: 'acme.publisher-gone', version: '9.9.9' })).toThrow(expect.objectContaining({ httpStatus: 409 }));
    // Revoking 1.0.0 must not block 1.0.1 — the remediation path stays open.
    expect(assertInstallable({ name: 'acme.bad', version: '1.0.1' }).version).toBe('1.0.1');
  });
});

describe('ADR 0826 D4 — error mapping never leaks the registry topology (MKT2-29)', () => {
  it('an unknown failure keeps its reason but not its URL', () => {
    const e = translateInstallError(new Error('weird_failure at https://internal-registry.corp.example/tree/packs/x/-/1.0.0.json'), 'x', '1.0.0');
    expect(e.httpStatus).toBe(502);
    expect(e.message).toContain('weird_failure');
    expect(e.message).not.toContain('internal-registry.corp.example');
    expect(e.message, 'the URL is REPLACED, not merely truncated').toContain('<registry>');
  });

  it('a closed-world refusal is a 422 with its own reason', () => {
    const e = translateInstallError(new Error('pack_content_refused: prompts/sys.md is a symlink'), 'x', '1.0.0');
    expect(e.httpStatus).toBe(422);
    expect((e.details as { reason?: string }).reason).toBe('pack_content_refused');
  });

  it('an unreachable registry is a 502 runner_unavailable, not a validation error', () => {
    const e = translateInstallError(new Error('pack_registry_unreachable: https://r.example/.well-known/openwop-registry.json did not answer'), 'x', '1.0.0');
    expect(e.code).toBe('runner_unavailable');
    expect(e.httpStatus).toBe(502);
    // The DEDICATED branch, not the catch-all (which is also a scrubbed 502
    // runner_unavailable — the wave-10 probe removing the branch stayed green).
    expect(e.message).toMatch(/unavailable right now/);
    expect(e.message).not.toContain('r.example');
  });
});

describe('ADR 0826 /architect A5 — the BOOT installer refuses a revoked pin', () => {
  it('a revoked version in OPENWOP_INSTALL_PACKS is counted as refused and never fetched', async () => {
    await revokePack({ packName: 'acme.boot-pinned', version: '2.0.0', by: 'test', reason: 'kill' });
    const prevPins = process.env.OPENWOP_INSTALL_PACKS;
    const prevFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => { fetched += 1; throw new Error('must not fetch'); }) as typeof globalThis.fetch;
    process.env.OPENWOP_INSTALL_PACKS = 'acme.boot-pinned@2.0.0';
    try {
      await ensureRegistryPacksInstalled([]);
      const status = registryInstallStatus();
      expect(status.failed).toEqual([expect.objectContaining({ name: 'acme.boot-pinned', version: '2.0.0', code: 'pack_revoked' })]);
      expect(fetched, 'the registry was never contacted for a revoked pin').toBe(0);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevPins === undefined) delete process.env.OPENWOP_INSTALL_PACKS;
      else process.env.OPENWOP_INSTALL_PACKS = prevPins;
    }
  });
});
