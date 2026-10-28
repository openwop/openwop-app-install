/**
 * ADR 0963 D8 — `__setMockArchiveGuardForTest` turns off the guard that keeps the
 * autonomous loop from running Work-Twin mock archives. It exists for suites that
 * test loop mechanics over the all-mock seeded demo. A production caller would
 * silently reopen what the user paused (ADR 0939), so nothing under `src/` may
 * call it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

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
    const callers = walk(src).filter((f) => /__setMockArchiveGuardForTest\s*\(/.test(
      readFileSync(f, 'utf8').replace(/export function __setMockArchiveGuardForTest[^\n]*/, ''),
    ));
    expect(callers).toEqual([]);
  });
});
