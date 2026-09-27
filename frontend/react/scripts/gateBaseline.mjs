/**
 * ONE rule for every ratchet baseline that can be overridden from the
 * environment (ADR 0598 §Correction 3).
 *
 * THE DEFECT, MEASURED. `const BASELINE = Number(process.env.X ?? '190')` reads
 * a typo as `NaN`, and EVERY comparison against `NaN` is false — including
 * `count > BASELINE`. So `X=zero` did not raise the bar or lower it, it REMOVED
 * it, and the run still printed a tick with "baseline NaN" in small type:
 *
 *     OPENWOP_SILENT_READ_NOTICE_BASELINE_0598=0     → ✗ EXIT=1  (correct)
 *     OPENWOP_SILENT_READ_NOTICE_BASELINE_0598=zero  → ✓ EXIT=0  (baseline NaN)
 *
 * `check-live-regions.mjs` had already learned this and written it down — "an
 * override that cannot be read is an operator MISTAKE, not permission to assert
 * nothing" — in the SAME commit that shipped the unguarded sibling. That is the
 * argument for one shared rule rather than N hand-written copies: the copy that
 * does not get written is the one that fails.
 *
 * ENUMERATED, not sampled. The review named two sites. `grep -n 'Number(process.env'
 * frontend/react/scripts/` finds **twelve** across ten gates, of which exactly
 * **two** carried the guard. All twelve now route through here.
 *
 * THE CEILING. Every one of the twelve compares `count > BASELINE`, so a LOWER
 * value tightens and a HIGHER value loosens. An override that loosens a ratchet
 * from the environment is not a gate — `OPENWOP_TEST_TYPES_BASELINE=99999` did
 * exactly that before GATE-3 closed it. Tightening stays open, because "would we
 * pass at 150?" is a real question. To accept more debt, change the number in the
 * file in a reviewed commit: that is what a ratchet is.
 *
 * The empty string is an ERROR, not "unset". `Number('')` is `0`, which for these
 * gates silently means "the strictest possible baseline" — a red run for a reason
 * the operator never asked for, which reads as a real regression.
 */

/**
 * @param {string} name  the env var, for the message
 * @param {string|undefined} rawValue  `process.env[name]`
 * @param {number} fileDefault  the committed baseline
 * @returns {{ok: true, baseline: number, note?: string} | {ok: false, error: string}}
 */
export function resolveGateBaseline(name, rawValue, fileDefault) {
  if (rawValue === undefined) return { ok: true, baseline: fileDefault };
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return { ok: false, error: `${name}=${JSON.stringify(rawValue)} is empty. Unset it to use the committed baseline (${fileDefault}); an empty value reads as 0 and would redden the run for a reason nobody asked for.` };
  }
  const n = Number(rawValue);
  if (!Number.isInteger(n) || n < 0) {
    return {
      ok: false,
      error:
        `${name}=${JSON.stringify(rawValue)} is not a non-negative integer. `
        + '`Number(…)` yields NaN for a typo and `count > NaN` is false, so this would have '
        + 'silently turned the gate OFF while still printing a tick.',
    };
  }
  if (n > fileDefault) {
    return {
      ok: false,
      error:
        `refusing ${name}=${n} — it is HIGHER than the committed baseline (${fileDefault}). `
        + 'The override may only TIGHTEN a ratchet, never loosen it. To accept more debt, change '
        + 'the number in the file in a reviewed commit — that is the point of a ratchet.',
    };
  }
  return { ok: true, baseline: n, note: n < fileDefault ? `${name} tightened the baseline to ${n}` : undefined };
}

/**
 * The one-line form for a gate script: resolve or DIE. Never returns a number a
 * comparison cannot use.
 *
 * @param {string} gate  the script name, for the message prefix
 * @param {string} name  the env var
 * @param {number} fileDefault  the committed baseline
 * @returns {number}
 */
export function readGateBaseline(gate, name, fileDefault) {
  const r = resolveGateBaseline(name, process.env[name], fileDefault);
  if (!r.ok) {
    console.error(`✗ ${gate}: ${r.error}`);
    process.exit(1);
  }
  if (r.note) console.log(`  (${r.note})`);
  return r.baseline;
}
