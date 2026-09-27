/**
 * The conformance runner may point the pinned suite at the sibling `../openwop`
 * corpus ONLY when the two are the same version. MEASURED 2026-08-16: with the
 * sibling `main` at 1.110.0 and the pin at 1.106.0, openwop#1009's new
 * `$ref` made the pinned `fixtures-valid.test.ts` throw at `ajv.compile` on
 * every app branch — a red caused by no app commit. And the naive fallback
 * (vendored tarball) is itself degraded: six 1.106.0 always-on scenarios
 * ENOENT on prose the tarball omits. So on a mismatch the runner exports the
 * sibling at the pinned version's TAG. See conformance/conformanceRoot.ts.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { conformanceTagFor, decideConformanceRoot, describeConformanceRoot } from '../conformance/conformanceRoot.js';

const base = {
  explicitRoot: undefined,
  siblingRoot: '/x/openwop',
  siblingHasFixtures: true,
  siblingVersion: '1.106.0',
  installedVersion: '1.106.0',
  siblingHasInstalledTag: true,
} as const;

describe('conformance root — the suite only evaluates a corpus at its own version', () => {
  it('uses the sibling working tree when versions match', () => {
    const d = decideConformanceRoot({ ...base });
    expect(d).toEqual({ use: 'sibling', root: '/x/openwop', version: '1.106.0' });
    expect(describeConformanceRoot(d)).toContain('== pinned suite');
  });

  it('on a NEWER sibling (the 2026-08-16 breakage) uses the tag for the pinned version, never the working tree', () => {
    const d = decideConformanceRoot({ ...base, siblingVersion: '1.110.0' });
    expect(d).toEqual({ use: 'sibling-tag', tag: 'openwop-conformance/v1.106.0', version: '1.106.0', siblingVersion: '1.110.0' });
    const msg = describeConformanceRoot(d);
    expect(msg).toContain('1.110.0');
    expect(msg).toContain('openwop-conformance/v1.106.0');
    expect(msg).toContain('bump the pin');
  });

  it('on an OLDER sibling too — mismatch is mismatch', () => {
    const d = decideConformanceRoot({ ...base, siblingVersion: '1.100.0' });
    expect(d.use).toBe('sibling-tag');
  });

  it('on a mismatch with NO tag for the pinned version, falls back to the vendored corpus and says how to fix it', () => {
    const d = decideConformanceRoot({ ...base, siblingVersion: '1.110.0', siblingHasInstalledTag: false });
    expect(d).toEqual({ use: 'vendored', reason: 'version-mismatch-no-tag', siblingVersion: '1.110.0', installedVersion: '1.106.0' });
    const msg = describeConformanceRoot(d);
    expect(msg).toContain('fetch --tags');
    expect(msg).toContain('openwop-conformance/v1.106.0');
  });

  it('an unreadable sibling version is a mismatch, not a match', () => {
    const d = decideConformanceRoot({ ...base, siblingVersion: undefined });
    expect(d).toMatchObject({ use: 'sibling-tag', siblingVersion: '(unreadable)' });
  });

  it('reports no-sibling separately', () => {
    const d = decideConformanceRoot({ ...base, siblingHasFixtures: false });
    expect(d).toEqual({ use: 'vendored', reason: 'no-sibling' });
  });

  it('an explicit OPENWOP_CONFORMANCE_ROOT always wins, even on a mismatch', () => {
    const d = decideConformanceRoot({ ...base, explicitRoot: '/elsewhere/openwop', siblingVersion: '9.9.9' });
    expect(d).toEqual({ use: 'explicit', root: '/elsewhere/openwop' });
  });

  it('the tag name follows the spec repo release convention', () => {
    expect(conformanceTagFor('1.106.0')).toBe('openwop-conformance/v1.106.0');
  });

  it('LIVE: the decision the runner makes on this machine follows from the two package.json files and the tag', () => {
    // Not a fixed expectation — the sibling moves. What is pinned is that the
    // decision is a function of observable inputs, so a reader can tell WHICH
    // corpus the last conformance lane measured.
    const installed = JSON.parse(readFileSync(resolve('node_modules/@openwop/openwop-conformance/package.json'), 'utf8')) as { version: string };
    const siblingRoot = resolve(process.cwd(), '..', '..', '..', 'openwop');
    const siblingPkg = resolve(siblingRoot, 'conformance', 'package.json');
    const siblingHasFixtures = existsSync(resolve(siblingRoot, 'conformance', 'fixtures'));
    const siblingVersion = existsSync(siblingPkg)
      ? (JSON.parse(readFileSync(siblingPkg, 'utf8')) as { version?: string }).version
      : undefined;
    let siblingHasInstalledTag = false;
    if (siblingHasFixtures) {
      try {
        execFileSync('git', ['-C', siblingRoot, 'rev-parse', '--verify', '--quiet', `refs/tags/${conformanceTagFor(installed.version)}^{commit}`], { stdio: 'pipe' });
        siblingHasInstalledTag = true;
      } catch {
        siblingHasInstalledTag = false;
      }
    }
    const d = decideConformanceRoot({ explicitRoot: undefined, siblingRoot, siblingHasFixtures, siblingVersion, installedVersion: installed.version, siblingHasInstalledTag });
    if (!siblingHasFixtures) expect(d).toEqual({ use: 'vendored', reason: 'no-sibling' });
    else if (siblingVersion === installed.version) expect(d.use).toBe('sibling');
    else if (siblingHasInstalledTag) expect(d).toMatchObject({ use: 'sibling-tag', version: installed.version });
    else expect(d).toMatchObject({ use: 'vendored', reason: 'version-mismatch-no-tag' });
  });
});
