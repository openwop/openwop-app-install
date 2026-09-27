/**
 * ADR 0550 P1 — the conformance quarantine is SHRINK-ONLY.
 *
 * `conformance/quarantine.json` excludes known-failing scenarios so the rest of
 * the suite can be a blocking gate. That is only defensible while the list can
 * shrink and cannot quietly grow — otherwise "quarantine the failure" becomes
 * the cheapest way to make any conformance regression go away, and the gate
 * degrades into decoration.
 *
 * See `conformance/QUARANTINE.md` for the reasoning and the burn-down.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface Quarantine {
  maxEntries: number;
  entries: { file: string; reason: string; since: string }[];
}

const BACKEND = join(__dirname, '..');
const Q = JSON.parse(
  readFileSync(join(BACKEND, 'conformance', 'quarantine.json'), 'utf8'),
) as Quarantine;
const SUITE_ROOT = join(BACKEND, 'node_modules', '@openwop', 'openwop-conformance');

describe('ADR 0550 P1 — quarantine hygiene', () => {
  it('never exceeds its recorded ceiling', () => {
    // The ratchet. Lower `maxEntries` in the same commit that removes an entry;
    // raising it is a reviewed decision that means a claimed capability broke.
    expect(Q.entries.length).toBeLessThanOrEqual(Q.maxEntries);
  });

  it('the ceiling is not slack — it equals the current size', () => {
    // A ceiling above the current size is pre-authorised growth, which is the
    // thing the ratchet exists to prevent.
    expect(Q.maxEntries).toBe(Q.entries.length);
  });

  it('every entry carries a reason and a date', () => {
    for (const e of Q.entries) {
      expect(e.reason.length, `${e.file} needs a reason`).toBeGreaterThan(20);
      expect(e.since, `${e.file} needs a since date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('has no duplicate entries', () => {
    const files = Q.entries.map((e) => e.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it('every quarantined scenario still EXISTS in the installed suite', () => {
    // A stale filename is the dangerous case: the scenario was renamed or
    // removed upstream, the exclusion silently matches nothing, and the entry
    // now documents a failure that no longer has that name — while the RENAMED
    // scenario runs ungated, or does not run at all. Either way the ledger is
    // lying. Skips only when the suite is not installed at all.
    if (!existsSync(SUITE_ROOT)) return;
    const missing = Q.entries
      .map((e) => e.file)
      .filter((f) => !existsSync(join(SUITE_ROOT, f)));
    expect(missing).toEqual([]);
  });

  it('quarantined scenarios are not ALSO in the opted-out profile list', () => {
    // The two lists mean opposite things: opt-out says "we do not claim this",
    // quarantine says "we claim it and are failing it". A scenario in both is
    // a failure dressed as an honest absence — precisely the dishonesty ADR
    // 0548 invariant 3 exists to prevent.
    const runTs = readFileSync(join(BACKEND, 'conformance', 'run.ts'), 'utf8');
    const optedOut = [...runTs.matchAll(/'(openwop-[a-z0-9-]+)',\s*\/\//g)].map((m) => m[1]);
    for (const e of Q.entries) {
      // Scenario files are named after their scenario id, e.g.
      // `envelope-truncated.test.ts` ↔ `openwop-envelope-truncated`.
      const id = `openwop-${e.file.replace(/^src\/scenarios\//, '').replace(/\.test\.ts$/, '')}`;
      expect(optedOut, `${e.file} is quarantined AND opted out`).not.toContain(id);
    }
  });

  it('the CI gate actually runs the conformance suite', () => {
    // The step this quarantine exists to make possible. Without it the
    // quarantine is bookkeeping for a gate nobody runs — which is the exact
    // state ADR 0550 P0 found.
    const ci = readFileSync(join(BACKEND, '..', '..', 'scripts', 'ci.sh'), 'utf8');
    expect(ci).toMatch(/backend\/typescript" && npm run test:conformance/);
  });

  it('the harness still honours the no-quarantine escape hatch', () => {
    // Being able to see the REAL state is what keeps the ledger honest.
    const runTs = readFileSync(join(BACKEND, 'conformance', 'run.ts'), 'utf8');
    expect(runTs).toContain('OPENWOP_CONFORMANCE_NO_QUARANTINE');
  });
});
