#!/usr/bin/env node
/**
 * NON-VACUITY FLOOR for the date-bomb sweep (H74).
 *
 * The sweep's failure mode is not "a bomb goes undetected" — it is "the sweep
 * ran and swept nothing", which reads identically in the log. Two ways that
 * happens, both one edit away:
 *
 *   - the setup file stops being listed in a workspace's `setupFiles`, so the
 *     suite runs with a normal clock under a step named "date-bomb sweep";
 *   - the env var is renamed on one side, so one workspace silently opts out.
 *
 * Either leaves a green step whose name is a claim nobody checks. This asserts
 * the claim: in EACH workspace, with the sweep enabled, a probe observes a clock
 * advanced by the configured horizon — and the probe must actually EXECUTE, so
 * "0 tests ran" fails here rather than passing as an absence of failures.
 *
 * That last part is the whole point. A floor that accepts an empty run is the
 * same defect one level up, and this file exists because a sweep whose SCOPE
 * excluded the frontend read exactly like a sweep that had covered it.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAYS = Number(process.env.OPENWOP_CLOCKSHIFT_DAYS ?? '365');

/** Each workspace and the probe that proves its clock is shifted. */
const LANES = [
  { ws: 'backend/typescript', probe: 'test/clockshift-armed.test.ts' },
  { ws: 'frontend/react', probe: 'src/test/__tests__/clockshift-armed.test.ts' },
];

let failed = false;

for (const { ws, probe } of LANES) {
  let out = '';
  try {
    out = execFileSync(
      'node',
      // NOTE no `--reporter=basic`: it fails to load in this vitest version
      // (module-runner error), which would make this floor report a false
      // negative about the very thing it is checking.
      [join(ROOT, ws, 'node_modules', 'vitest', 'vitest.mjs'), 'run', probe],
      {
        cwd: join(ROOT, ws),
        encoding: 'utf8',
        env: { ...process.env, OPENWOP_CI_CLOCKSHIFT: '1', OPENWOP_SKIP_TESTCONTAINERS: '1' },
        maxBuffer: 32 * 1024 * 1024,
      },
    );
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    failed = true;
    console.error(`✗ check-clockshift-armed: ${ws} — the probe did not pass with the sweep enabled.`);
    console.error(out.split('\n').filter((l) => /✗|×|FAIL|Error|expected/.test(l)).slice(0, 8).join('\n'));
    continue;
  }

  // VACUITY: a probe that was not collected reports zero tests and exits 0.
  const m = /Tests\s+(\d+)\s+passed/.exec(out);
  const passed = m ? Number(m[1]) : 0;
  if (passed < 1) {
    failed = true;
    console.error(
      `✗ check-clockshift-armed: ${ws} — the probe ran ZERO tests, so this lane asserts nothing. `
        + `Was ${probe} renamed, moved, or excluded?`,
    );
    continue;
  }
  console.log(`✓ check-clockshift-armed: ${ws} — clock advanced ~${DAYS}d, probe executed (${passed} assertion file).`);
}

if (failed) {
  console.error(
    '\n  The date-bomb sweep is only worth its runtime if the clock is really shifted in every workspace it names.\n'
      + '  Fix the lane above, or remove it from scripts/ci.sh rather than leaving a step whose name overstates it.',
  );
  process.exit(1);
}
