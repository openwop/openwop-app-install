/**
 * UX_UPGRADE-marketplace R2 — MKT2-B1 / MKT2-B2.
 *
 * R1 fixed EXACTLY this shape on the sibling screen (MKT-G1: "a thrown
 * `fetchBundleCommerce` was folded into `[]` — the LEGITIMATE billing-off shape
 * — so a transient failure rendered the paid store as 'nothing for sale'") and
 * recorded `/marketplace` as "CLEAN this pass". It was clean in the frontend.
 * `listListings()` carried the identical defect one layer down, in the file R1
 * never opened, and from there it reached four lanes at once.
 *
 * MKT2-B1: `catch { return [] }` around the pack-dir read turned "the catalog
 * could not be read" into "the catalog is empty" — and because `getListing()`
 * is `listListings().find(...)`, it ALSO made every pack report not-found, so
 * enablement/remove/purge refused with a 404 blaming the wrong thing.
 *
 * MKT2-B2: `installed` means "has a registry install marker". It was rendered
 * as "Not installed" for packs mounted from the checkout that the executor is
 * actively running, behind an Install button that cannot succeed for them.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `readdirSync` cannot be spied in ESM (the module namespace is not
 * configurable), so the failure is injected through a passthrough mock: every
 * other fs call is the real one, and only the directory read throws, and only
 * while `failRead` is set. That keeps the rest of the scan honest — the test
 * still builds real manifests off a real temp tree.
 */
const failRead = { code: '' };
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    readdirSync: ((...args: Parameters<typeof actual.readdirSync>) => {
      if (failRead.code) {
        const e = new Error(`${failRead.code}: injected`) as NodeJS.ErrnoException;
        e.code = failRead.code;
        throw e;
      }
      return actual.readdirSync(...args);
    }) as typeof actual.readdirSync,
  };
});

import { listListings, getListing } from '../src/features/marketplace/listingService.js';

/** A pack dir holding one registry-installed pack and one checkout-mounted one. */
function aPackDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'mkt-r2-'));
  const dir = join(root, 'packs');
  mkdirSync(dir);

  // (a) registry-installed: a real directory carrying the install marker.
  const reg = join(dir, 'vendor.example.registry-pack');
  mkdirSync(reg);
  writeFileSync(join(reg, 'pack.json'), JSON.stringify({ name: 'vendor.example.registry-pack', version: '1.0.0' }));
  writeFileSync(join(reg, '.openwop-installed.json'), JSON.stringify({ name: 'vendor.example.registry-pack', version: '1.0.0' }));

  // (b) checkout-mounted: a SYMLINK with no marker — what mountLocalPacks makes.
  const real = join(root, 'checkout-pack');
  mkdirSync(real);
  writeFileSync(join(real, 'pack.json'), JSON.stringify({ name: 'feature.example.nodes', version: '2.0.0' }));
  symlinkSync(real, join(dir, 'feature.example.nodes'));

  return dir;
}

let packDir = '';
let priorPackDir: string | undefined;
beforeEach(() => {
  // Capture-and-restore: env outlives a FILE inside a vitest worker, so leaking
  // it would point every later file in this worker at the wrong pack tree.
  priorPackDir = process.env.OPENWOP_PACK_DIR;
  packDir = aPackDir();
  process.env.OPENWOP_PACK_DIR = packDir;
});
afterEach(() => {
  failRead.code = '';
  if (priorPackDir === undefined) delete process.env.OPENWOP_PACK_DIR;
  else process.env.OPENWOP_PACK_DIR = priorPackDir;
  try { rmSync(join(packDir, '..'), { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('MKT2-B1 — an unreadable catalog is never rendered as an empty one', () => {
  it('THROWS when the pack dir cannot be read, naming the real cause', () => {
    failRead.code = 'EACCES';
    // The distinguishing behaviour: NOT `[]`.
    expect(() => listListings()).toThrowError(/could not be read/i);
  });

  it('still returns [] when the dir is ABSENT — the one empty it may invent', () => {
    // The negative control. Without it, "a failure throws" would be satisfied by
    // a function that also 500s a brand-new host with no packs installed yet,
    // which is the case the original `[]` existed to serve.
    process.env.OPENWOP_PACK_DIR = join(packDir, 'does-not-exist');
    expect(listListings()).toEqual([]);
  });

  it('a read failure does not make every pack report NOT FOUND', () => {
    // `getListing` is the existence gate for pack-enablement PUT, DELETE and
    // purge. Folding the failure to `[]` made it answer "no such pack" — a
    // positive claim — for packs that exist, and the routes 404'd on it.
    expect(getListing('feature.example.nodes'), 'present when the catalog reads').toBeTruthy();
    failRead.code = 'EIO';
    expect(() => getListing('feature.example.nodes'), 'must not answer "absent" from a failed read').toThrow();
  });
});

describe('MKT2-B2 — "not installed" and "not present" are different claims', () => {
  it('separates a registry install from a checkout mount', () => {
    // BOTH origins asserted in one test on purpose: a fixture with only one of
    // them would pass against a discriminator hard-coded to that answer.
    const all = listListings();
    const registry = all.find((l) => l.packName === 'vendor.example.registry-pack');
    const local = all.find((l) => l.packName === 'feature.example.nodes');

    expect(registry?.installed, 'a marker means registry-installed').toBe(true);
    expect(registry?.origin).toBe('registry');

    expect(local?.installed, 'no marker — this part was always true').toBe(false);
    expect(local?.origin, 'but it is mounted and running, not missing').toBe('local');
  });
});
