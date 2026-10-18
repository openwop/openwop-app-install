/**
 * ADR 0874 D2 — async chunks are `c-[hash].js` unless something keys on their name.
 *
 * The budget gate runs as the REAL script in a child process against fixture
 * `dist/` trees (the `gates.test.ts` convention), so a weakened gate reds here.
 *
 * Sabotage (wave 51 probes): widening LAZY_LOCALE_CHUNK or matching NAMED_CHUNKS by
 * prefix (chunkNames.mjs) reds case 2; dropping the dead-override check or its
 * `default`-distribution guard (check-bundle-budget.mjs) reds cases 4-6.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkFileName } from '../chunkNames.mjs';

const BUDGET_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-bundle-budget.mjs');

describe('chunkFileName', () => {
  it('keeps the manualChunks names readable', () => {
    for (const name of ['i18n', 'firebase', 'katex', 'markdown', 'i18n-pt-BR', 'i18n-fr', 'i18n-es']) {
      expect(chunkFileName({ name })).toBe('assets/[name]-[hash].js');
    }
  });

  it('hash-names every other async chunk', () => {
    for (const name of ['CompanyDetailPage', 'routes', 'i18n-de', 'katex2', 'index']) {
      expect(chunkFileName({ name })).toBe('assets/c-[hash].js');
    }
  });
});

describe('check-bundle-budget — named overrides', () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'owp-chunknames-')); });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  /** Build a fixture `dist/assets` holding `files` (tiny bodies) and run the real gate. */
  function runBudget(files: string[], env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(root, 'dist-'));
    mkdirSync(join(dir, 'dist', 'assets'), { recursive: true });
    for (const f of files) writeFileSync(join(dir, 'dist', 'assets', f), 'export const x = 1;\n');
    const res = spawnSync(process.execPath, [BUDGET_SCRIPT], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, OPENWOP_DISTRIBUTION: 'default', ...env },
    });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  }

  const HEALTHY = ['index-AbCdEf12.js', 'i18n-AbCdEf12.js', 'katex-AbCdEf12.js', 'c-AbCdEf12.js'];

  it('passes a build whose every override key matches a named chunk', () => {
    const r = runBudget(HEALTHY);
    expect(r.out).toContain('✓ check-bundle-budget: entry chunk');
    expect(r.code).toBe(0);
  });

  it('refuses an override key whose chunk was not built (dead override)', () => {
    const r = runBudget(HEALTHY.filter((f) => !f.startsWith('katex-')));
    expect(r.out).toContain('PER_CHUNK_GZIP_BUDGET key "katex" matches no built chunk');
    expect(r.code).toBe(1);
  });

  it('does not count a lazy locale chunk as the eager i18n chunk', () => {
    const r = runBudget([...HEALTHY.filter((f) => !f.startsWith('i18n-')), 'i18n-pt-BR-AbCdEf12.js']);
    expect(r.out).toContain('PER_CHUNK_GZIP_BUDGET key "i18n" matches no built chunk');
    expect(r.code).toBe(1);
  });

  it('skips the dead-override check for a named distribution', () => {
    const r = runBudget(HEALTHY.filter((f) => !f.startsWith('katex-')), { OPENWOP_DISTRIBUTION: 'kicktodo' });
    expect(r.out).not.toContain('matches no built chunk');
    expect(r.out).toContain('✓ check-bundle-budget: entry chunk');
    expect(r.code).toBe(0);
  });
});
