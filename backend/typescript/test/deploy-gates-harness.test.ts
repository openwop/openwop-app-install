/**
 * DGATE-3 — run the deploy-gate harness inside the lane people actually run.
 *
 * WHY THIS EXISTS. `scripts/test-deploy-gates.sh` is the ONLY executable
 * coverage of `preflight-deploy.sh` / `deploy.sh` / `verify-deploy.sh`, and
 * `scripts/ci.sh` runs it BEFORE the vitest lanes. On 2026-08-10 (#3106) a new
 * preflight gate landed without the fixture line its pass-expecting cases
 * needed; three of them flipped and `npm run ci` aborted for EVERY session in
 * the repo until #3108.
 *
 * The tooling was not missing — `npm run ci` would have caught it. The author
 * ran the backend vitest suite (1440 files, 10442 tests, green) and reported
 * THAT as "the gate". So the fix is not another gate in the lane that was
 * skipped; it is putting this coverage in the lane that was actually run. A
 * tripwire that only fires when you run the thing you already skipped is worth
 * nothing.
 *
 * WHY NOT A STATIC PARITY CHECK. The obvious alternative — assert the count of
 * `# ── Gate N:` headers in `preflight-deploy.sh` matches the harness — keys on
 * COMMENTS, and would pass the moment someone writes the header whether or not
 * they add a fixture: it asserts the easy thing, not the thing that broke. The
 * label-parity variant is measurably worse: `preflight` emits
 * `BACKWARD|FETCH|STALE|UNKNOWN|WAIVED` labels the harness never mentions
 * literally (it asserts EXIT CODES), so such a gate would go red today against
 * five fully-covered gates. A gate whose first act is false positives teaches
 * people to disable it.
 *
 * WHY THIS IS SAFE UNDER THE VITEST POOL — by construction, not by luck:
 *   - the harness binds an EPHEMERAL port and writes the assigned value to a
 *     file, so ~10 concurrent workers cannot collide on it;
 *   - its git repos are throwaway trees under `mktemp`, independent of this
 *     checkout's branch state;
 *   - shelling out from a backend test is established precedent —
 *     `test/source-hygiene.test.ts:25` is ungated, runs every CI pass, and
 *     execs `git` from the repo root. The only novel part here is that the
 *     binary is `bash`.
 *
 * KNOWN COST, accepted: `npm run ci` now runs the harness twice (once at
 * `ci.sh:155`, once here) for ~2.5s. The lanes have different audiences — the
 * merge gate vs. the person iterating on backend tests, who is exactly the
 * person who broke it. Deliberately NOT deduped behind an env flag: a
 * conditional skip is how this test would quietly stop running.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const harness = join(repoRoot, 'scripts/test-deploy-gates.sh');

describe('deploy gates — the shell harness runs inside the backend suite (DGATE-3)', () => {
  it('the harness exists where ci.sh and this test both expect it', () => {
    // If someone moves or renames it, fail HERE with a clear message rather than
    // letting `bash` produce a bare 127 below.
    expect(existsSync(harness), `${harness} is missing — ci.sh:155 runs it too`).toBe(true);
  });

  it(
    'every deploy-gate case passes',
    () => {
      let stdout = '';
      try {
        stdout = execFileSync('bash', [harness], {
          cwd: repoRoot,
          encoding: 'utf8',
          // The harness spawns processes and does git work. On a loaded machine
          // (this repo runs several sessions at once) it is SLOW, not wrong, so
          // the timeout is generous — a bare timeout would read like a real
          // failure and send the next person chasing a defect that isn't there.
          timeout: 120_000,
        });
      } catch (err) {
        // Surface the harness's own output. A wrapped "exit 1" with no stdout is
        // undebuggable, and the harness already names each failing case.
        const e = err as { stdout?: string; stderr?: string; message?: string };
        throw new Error(
          `scripts/test-deploy-gates.sh FAILED.\n` +
            `Adding a preflight gate usually needs a matching fixture line in the harness ` +
            `(Gate 4 needed \`stamp_head\`).\n\n--- stdout ---\n${e.stdout ?? ''}\n` +
            `--- stderr ---\n${e.stderr ?? ''}\n--- error ---\n${e.message ?? String(err)}`,
        );
      }

      // Exit 0 alone is not enough: a harness that silently ran ZERO cases would
      // also exit 0. Pin the summary line so an empty run cannot read as a pass —
      // the same vacuity this whole gate exists to prevent.
      expect(stdout).toMatch(/deploy-gates: \d+ passed, 0 failed/);
      const passed = Number(/deploy-gates: (\d+) passed/.exec(stdout)?.[1] ?? 0);
      expect(passed).toBeGreaterThan(10);
    },
    130_000,
  );
});
