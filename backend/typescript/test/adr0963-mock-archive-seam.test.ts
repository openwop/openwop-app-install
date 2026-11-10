/**
 * ADR 0963 D8 — `__setMockArchiveGuardForTest` turns off the guard that keeps the
 * autonomous loop from running Work-Twin mock archives. It exists for suites that
 * test loop mechanics over the all-mock seeded demo. A production caller would
 * silently reopen what the user paused (ADR 0939), so nothing under `src/` may
 * call it.
 *
 * The check is TWO-SIDED (wave 73, TST-DRU): it also asserts the seam is still
 * exported where the scan expects it, and that the walk really read `src/`. A
 * one-sided scan stays green when the seam is renamed (nothing left to match) or
 * when the walk silently reads nothing.
 *
 * Sabotage: a src/ caller of the seam reds it (w73g3-mas63-prodcaller); renaming
 * the export in host/heartbeatService.ts reds it (w73g3-mas63-renamed). Any other
 * src/ file naming the identifier at all (an aliased import included) reds it.
 * Measured 2026-11-01: the walk reads 2,344 .ts files; the floor below is slack
 * for deletions, not the measured count.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SEAM = '__setMockArchiveGuardForTest';
const MIN_WALKED_FILES = 2_290; // 2293 after the KickTodo packages left (ADR 1031 P3)

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('the mock-archive guard seam', () => {
  it('is called from no production module', () => {
    const src = join(__dirname, '..', 'src');
    const owner = join(src, 'host', 'heartbeatService.ts');
    const files = walk(src);
    expect(files.length).toBeGreaterThanOrEqual(MIN_WALKED_FILES);
    expect(files).toContain(owner);

    // The seam still exists where the scan expects it, exactly once.
    const ownerText = readFileSync(owner, 'utf8');
    expect(ownerText.split(`export function ${SEAM}(`).length - 1).toBe(1);

    // No call inside the owner module other than its own declaration.
    const ownerBody = ownerText.replace(new RegExp(`export function ${SEAM}\\([^\\n]*`), '');
    expect(new RegExp(`\\b${SEAM}\\b`).test(ownerBody)).toBe(false);

    // No other production module names the identifier at all (aliased imports included).
    const mentions = files.filter((f) => f !== owner && new RegExp(`\\b${SEAM}\\b`).test(readFileSync(f, 'utf8')));
    expect(mentions).toEqual([]);
  });
});
