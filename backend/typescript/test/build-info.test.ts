/**
 * ADR 0518 — deploy provenance, and its honesty rule.
 *
 * The whole value of this surface is that a verification script can trust it. A
 * commit it reports MUST be one a deploy actually stamped; anything else — a
 * branch name, an uninterpolated CI placeholder, an empty string — has to read as
 * `unknown` so the script FAILS rather than passing against a fiction. A
 * confidently-wrong commit is strictly worse than no commit: it would restore
 * exactly the false assurance (asset hashes "matching" a clobbering deploy) that
 * made the 2026-08-03 double-clobber invisible for an hour.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCommit, buildDeployedAt, buildInfo } from '../src/host/buildInfo.js';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
let saved: Record<string, string | undefined>;
let emptyMetaDir: string;

beforeEach(() => {
  saved = {
    c: process.env.OPENWOP_BUILD_COMMIT,
    d: process.env.OPENWOP_BUILD_DEPLOYED_AT,
    m: process.env.OPENWOP_BUILD_META_DIR,
  };
  delete process.env.OPENWOP_BUILD_COMMIT;
  delete process.env.OPENWOP_BUILD_DEPLOYED_AT;
  // Pin the IMAGE source to an empty dir so these env-var assertions stay
  // deterministic. Without this the suite is environment-dependent: since the
  // 2026-08-10 correction `buildCommit()` prefers `build-meta/commit.txt`, and
  // that file EXISTS on any machine where someone has run
  // `scripts/write-build-commit.mjs` (it is gitignored, so CI and a fresh clone
  // do not have it and would pass while a maintainer's checkout went red).
  emptyMetaDir = mkdtempSync(join(tmpdir(), 'owp-build-meta-empty-'));
  process.env.OPENWOP_BUILD_META_DIR = emptyMetaDir;
});
afterEach(() => {
  if (saved.c === undefined) delete process.env.OPENWOP_BUILD_COMMIT; else process.env.OPENWOP_BUILD_COMMIT = saved.c;
  if (saved.d === undefined) delete process.env.OPENWOP_BUILD_DEPLOYED_AT; else process.env.OPENWOP_BUILD_DEPLOYED_AT = saved.d;
  if (saved.m === undefined) delete process.env.OPENWOP_BUILD_META_DIR; else process.env.OPENWOP_BUILD_META_DIR = saved.m;
  rmSync(emptyMetaDir, { recursive: true, force: true });
});

describe('buildCommit', () => {
  it('reports a stamped full SHA', () => {
    process.env.OPENWOP_BUILD_COMMIT = SHA;
    expect(buildCommit()).toBe(SHA);
    expect(buildInfo().stamped).toBe(true);
  });

  it('accepts a short SHA (deploy scripts abbreviate)', () => {
    process.env.OPENWOP_BUILD_COMMIT = 'a1b2c3d';
    expect(buildCommit()).toBe('a1b2c3d');
  });

  it('is `unknown` when the deploy did not stamp anything', () => {
    expect(buildCommit()).toBe('unknown');
    expect(buildInfo().stamped).toBe(false);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a branch name', 'main'],
    ['an uninterpolated placeholder', '$COMMIT_SHA'],
    ['a too-short fragment', 'abc'],
    ['a non-hex string', 'zzzzzzzzzz'],
    ['a SHA with trailing junk', `${SHA}-dirty`],
  ])('refuses to echo %s back as provenance', (_label, value) => {
    process.env.OPENWOP_BUILD_COMMIT = value;
    expect(buildCommit()).toBe('unknown');
    expect(buildInfo().stamped).toBe(false);
  });

  it('never substitutes the package version or a timestamp for a missing commit', () => {
    const info = buildInfo();
    expect(info.commit).toBe('unknown');
    expect(info.commit).not.toMatch(/^\d+\.\d+\.\d+$/);
    expect(info.commit).not.toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});

describe('buildDeployedAt', () => {
  it('normalises a valid timestamp to ISO', () => {
    process.env.OPENWOP_BUILD_DEPLOYED_AT = '2026-08-03T12:00:00Z';
    expect(buildDeployedAt()).toBe('2026-08-03T12:00:00.000Z');
  });

  it('is null when absent or unparseable — never "now"', () => {
    expect(buildDeployedAt()).toBeNull();
    process.env.OPENWOP_BUILD_DEPLOYED_AT = 'not a date';
    expect(buildDeployedAt()).toBeNull();
  });
});
