/**
 * ADR 0863 D8 — a FULL backend suite started outside a gate waits for a gate
 * that is already running in another worktree of this clone.
 *
 * Gates (`npm run ci`) already queue behind a running vitest. The other
 * direction was open: a bare `vitest run` started mid-gate took the cores the
 * gate's own vitest was using, and the gate's reds stopped being evidence
 * (MEASURED 2026-10-09: a peer suite starting mid-gate took load from ~3 to
 * ~35; a train then went red on a timeout).
 *
 * This waits on the gate's CLAIM only (`preflight-suite.sh --wait-claim`),
 * never on other processes, and never takes the claim. So two waiting suites
 * cannot deadlock on each other. Skipped for:
 *   - a targeted run (file filters or `-t`), which is small, and which the
 *     sessions iterating on a test need to stay instant;
 *   - watch mode;
 *   - the gate's own vitest (`OPENWOP_CI_PREFLIGHT_DONE=1` comes from ci.sh, and
 *     a claim from this worktree never blocks anyway);
 *   - `OPENWOP_VITEST_NO_WAIT=1`, `CI`, or a checkout without the script (the
 *     white-label zip).
 * The wait is capped by `OPENWOP_CI_WAIT_MAX_MIN` (default 90), the same cap
 * the gate uses. At the cap the suite starts anyway; it never fails a run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

const SCRIPT = fileURLToPath(new URL('../../../../scripts/preflight-suite.sh', import.meta.url));

/** Exported for the unit test: why this run does not wait, or null if it does. */
export function skipReason(opts: {
  env: NodeJS.ProcessEnv;
  filenamePattern: readonly string[] | undefined;
  /** False when this vitest no longer has the internal `filenamePattern` field. */
  filenamePatternKnown?: boolean;
  testNamePattern: unknown;
  watch: boolean;
  scriptExists: boolean;
}): string | null {
  if (opts.env.OPENWOP_VITEST_NO_WAIT === '1') return 'OPENWOP_VITEST_NO_WAIT=1';
  if (opts.env.OPENWOP_CI_PREFLIGHT_DONE === '1') return 'inside a gate';
  if (opts.env.CI) return 'CI';
  if (opts.watch) return 'watch mode';
  if (opts.filenamePatternKnown === false) return 'this vitest has no filenamePattern field (cannot tell a targeted run)';
  if ((opts.filenamePattern?.length ?? 0) > 0) return 'targeted run (file filter)';
  if (opts.testNamePattern) return 'targeted run (-t)';
  if (!opts.scriptExists) return 'no scripts/preflight-suite.sh';
  return null;
}

export default function setup(project: TestProject): void {
  const v = project.vitest;
  const skip = skipReason({
    env: process.env,
    // Internal to vitest 4 (a declared class field, set from the CLI's file
    // filters before global setup runs; not in its public types). If an upgrade
    // drops it, this run cannot tell targeted from full, so it does not wait and
    // says so. test/queue-behind-gate.test.ts goes red on that upgrade.
    filenamePattern: (v as unknown as { filenamePattern?: string[] }).filenamePattern,
    filenamePatternKnown: 'filenamePattern' in v,
    testNamePattern: v.config.testNamePattern,
    watch: Boolean(v.config.watch),
    scriptExists: existsSync(SCRIPT),
  });
  if (skip) {
    if (skip.startsWith('this vitest')) process.stderr.write(`queueBehindGate (ADR 0863 D8): not waiting for a running gate: ${skip}.\n`);
    return;
  }
  const capS = Math.max(1, Math.round(Number(process.env.OPENWOP_CI_WAIT_MAX_MIN ?? '90') * 60));
  spawnSync('bash', [SCRIPT, `--wait-claim=${capS}`], { stdio: ['ignore', 'inherit', 'inherit'] });
}
