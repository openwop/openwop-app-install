/**
 * The DECISION LOGIC of `check-test-types.mjs`, extracted so it can be tested
 * without a two-minute `tsc` pass.
 *
 * It lives apart from the script for one reason: every defect this module now
 * guards against SHIPPED, passed review, and was found only by hand-running the
 * failure case (see `docs/steward/CODEBASE-ASSESSMENT.md` § Merge-gate tooling,
 * GATE-2/GATE-3). Probes that are run once and discarded protect nothing. These
 * functions are pure so the probes can become assertions.
 */

/** The measured count at the commit that introduced this check. Lower it whenever
 *  you drive the real number down; NEVER raise it to make a red run green. */
export const FILE_BASELINE = 169;

/**
 * Resolve the effective baseline, honouring an env override that may only ever
 * TIGHTEN the gate.
 *
 * As first shipped the override was read with no ceiling, so
 * `OPENWOP_TEST_TYPES_BASELINE=99999` turned any red run green AND printed
 * "down 99797" as though that were progress. A gate anyone can raise from the
 * environment is not a gate. Lowering it is still useful ("would we pass at
 * 150?"), so that direction stays open.
 *
 * @returns {{ok: true, baseline: number, note?: string} | {ok: false, error: string}}
 */
export function resolveBaseline(envValue, fileBaseline = FILE_BASELINE) {
  if (envValue === undefined || envValue === '') return { ok: true, baseline: fileBaseline };
  const n = Number(envValue);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    return { ok: false, error: `OPENWOP_TEST_TYPES_BASELINE=${envValue} is not a count.` };
  }
  if (n > fileBaseline) {
    return {
      ok: false,
      error:
        `refusing OPENWOP_TEST_TYPES_BASELINE=${n} — it is HIGHER than the committed ` +
        `baseline (${fileBaseline}). The override may only tighten this gate, never ` +
        'loosen it. To accept more debt, change it in the file in a reviewed commit — ' +
        'that is the point of a ratchet.',
    };
  }
  return { ok: true, baseline: n, note: `baseline tightened to ${n} via OPENWOP_TEST_TYPES_BASELINE` };
}

/**
 * Classify a tsc invocation: did it CHECK the project, or did it fail to run?
 *
 * This distinction is the whole reason the check is trustworthy. Without it, tsc
 * failing to run — bad path, missing binary, unknown flag — yielded 0 or 1
 * matched lines, which is BELOW the baseline, so the check exited 0 and reported
 * an improvement nobody earned. MEASURED before the fix: a missing tsconfig
 * reported "down 201"; a missing binary reported "down 202". A tool built to
 * catch failed-read-as-empty had shipped an instance of it.
 *
 * The discriminator is the FILE POSITION, not the error code. A per-file
 * diagnostic is `path(line,col): error TSxxxx`; a project-level failure has no
 * file prefix. Classifying by code RANGE was the first fix and it was WRONG —
 * TS6133 ("declared but never read") sits in the TS6xxx range yet is an ordinary
 * diagnostic, so that version failed the happy path.
 *
 * @param {{output: string, status: number, spawnFailed?: boolean, spawnCode?: string}} result
 * @returns {{ok: true, count: number, errors: string[]} | {ok: false, reason: string, detail: string}}
 */
export function classifyTscResult({ output = '', status = 0, spawnFailed = false, spawnCode = '' }) {
  // tsc never ran at all — no exit status exists to interpret.
  if (spawnFailed) {
    return {
      ok: false,
      reason: 'spawn-failed',
      detail: `could not RUN tsc (${spawnCode || 'unknown error'}). This is a broken check, not a clean codebase.`,
    };
  }

  const lines = output.split('\n').filter((l) => /error TS\d+/.test(l));

  // A project-level failure ("specified path does not exist", "unknown compiler
  // option") carries no file prefix — nothing was type-checked, so the count is
  // meaningless however small it looks.
  const globalError = lines.find((l) => /^\s*error TS\d+/.test(l));
  if (globalError) {
    return {
      ok: false,
      reason: 'project-level-error',
      detail: globalError.trim(),
    };
  }

  // Non-zero exit with nothing countable means tsc failed in a shape this parser
  // does not understand. An unreadable result is a failure, never zero errors.
  if (status !== 0 && lines.length === 0) {
    return {
      ok: false,
      reason: 'unparseable',
      detail: `tsc exited ${status} but emitted no parseable diagnostics: ${output.trim().slice(0, 300)}`,
    };
  }

  return { ok: true, count: lines.length, errors: lines };
}
