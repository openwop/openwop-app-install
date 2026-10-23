/**
 * ADR 0874 amendment (2026-10-18) — a named white-label distribution may declare
 * an entry share; the host ceiling stays 129 kB for the default build.
 *
 * Runs the REAL `check-bundle-budget.mjs` on a fixture `dist/` whose entry is
 * incompressible random bytes ~300 B over the host ceiling. Red under: the share
 * applying to the default distribution, no cap, a share without a reason (missing,
 * whitespace-only or under 10 characters), a share reported but not added to the
 * budget, an undeclared share, or the report folding the share into one number.
 * Every exit-1 case asserts the MESSAGE, because every refusal path exits 1.
 * Sabotage-witnessed: w55g1-es-* probes (round 1) and w55g1-es-*-r2 (round 2).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUDGET_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-bundle-budget.mjs');
const HOST_CEILING = 129 * 1024;

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'owp-entryshare-')); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

function run(distribution: string, manifest: Record<string, unknown> | null, entryBytes = HOST_CEILING + 300) {
  const dir = mkdtempSync(join(root, 'case-'));
  mkdirSync(join(dir, 'dist', 'assets'), { recursive: true });
  // Random bytes do not compress, so gzip size ≈ entryBytes (+ a few header bytes).
  writeFileSync(join(dir, 'dist', 'assets', 'index-AbCdEf12.js'), randomBytes(entryBytes));
  for (const f of ['i18n-AbCdEf12.js', 'katex-AbCdEf12.js', 'c-AbCdEf12.js']) writeFileSync(join(dir, 'dist', 'assets', f), 'export const x = 1;\n');
  const dists = join(dir, 'distributions');
  mkdirSync(dists);
  if (manifest) writeFileSync(join(dists, `${distribution}.json`), JSON.stringify({ name: distribution, ...manifest }));
  const res = spawnSync(process.execPath, [BUDGET_SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, OPENWOP_DISTRIBUTION: distribution, OPENWOP_DISTRIBUTIONS_DIR: dists },
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

const REASON = 'route metadata + the eager offline sign-out cleanup';

describe('declared distribution entry share (ADR 0874 amendment)', () => {
  it('the default build is held to the host ceiling: ~300 B over fails', () => {
    const r = run('default', null);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/over the ENTRY budget of 129\.0 kB/);
  });

  it('a named distribution with a declared share passes, and the report keeps the host number separate', () => {
    const r = run('bookai', { entryShareBytes: 1024, entryShareReason: REASON });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/= host 129\.0 kB \+ 'bookai' declared entry share 1024 B/);
    // The share is APPLIED, not only reported: 129 kB + 1024 B = 130.0 kB.
    expect(r.out).toMatch(/\(budget 130\.0 kB =/);
  });

  it('a named distribution WITHOUT a declaration is held to the host ceiling too', () => {
    const r = run('bookai', { bundles: [] });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/over the ENTRY budget of 129\.0 kB/);
    expect(r.out).not.toMatch(/declared entry share/);
  });

  it('the share is capped at 1 KiB', () => {
    const r = run('bookai', { entryShareBytes: 2048, entryShareReason: REASON });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/over the 1024 B cap/);
  });

  it('a share needs a reason', () => {
    const r = run('bookai', { entryShareBytes: 512 });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/needs an entryShareReason/);
    // Present but empty of content, and present but too short (trimmed < 10), are refused the same way.
    for (const entryShareReason of ['            ', '   short  ']) {
      const bad = run('bookai', { entryShareBytes: 512, entryShareReason });
      expect(bad.code).toBe(1);
      expect(bad.out).toMatch(/needs an entryShareReason/);
    }
  });

  it('the default distribution can never declare one', () => {
    const r = run('default', { entryShareBytes: 512, entryShareReason: REASON });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not allowed on the default distribution/);
  });

  it('the share is not slack beyond itself: host ceiling + share + 200 B still fails', () => {
    const r = run('bookai', { entryShareBytes: 512, entryShareReason: REASON }, HOST_CEILING + 512 + 200);
    expect(r.code).toBe(1);
    // 129 kB + 512 B = 132 608 B = 129.5 kB.
    expect(r.out).toMatch(/over the ENTRY budget of 129\.5 kB/);
  });
});
