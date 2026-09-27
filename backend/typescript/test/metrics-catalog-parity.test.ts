/**
 * ADR 0556 P1 — the static lint sees EVERY catalog entry.
 *
 * WHY THIS EXISTS, and it is not a hypothetical. `check-metric-labels.mjs`
 * parses `metrics.ts` as text, and its P0 guard asserted only that the parse
 * found SOMETHING — on the reasoning that a lint matching nothing passes
 * vacuously. P1 then added a section comment BETWEEN two catalog entries, the
 * `}\s*,\s*{` split stopped matching at that boundary, two entries merged into
 * one chunk, and the lint reported **18 of 19 metrics and exited 0**.
 *
 * So "found something" was the wrong bar. A parser that under-reports is
 * exactly as green as a correct one, and the metric it silently skipped is the
 * one whose forbidden label ships. The bar is a COUNT, checked against the
 * compiled catalog — the only thing the parse can be wrong about that the lint
 * cannot notice on its own.
 *
 * This is a repeat of a class this program keeps finding (`ENG-PACKS-1`, the
 * `skipIf` predicate that made a whole suite vacuous, the merge gates whose
 * entry point never ran). The lesson each time: assert the measurement's
 * COMPLETENESS, not merely its non-emptiness.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { METRIC_CATALOG, FORBIDDEN_LABELS } from '../src/observability/metrics.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LINT = join(REPO_ROOT, 'scripts', 'check-metric-labels.mjs');

function runLint(): { stdout: string; status: number } {
  try {
    return { stdout: execFileSync('node', [LINT], { encoding: 'utf8' }), status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`, status: e.status ?? 1 };
  }
}

describe('ADR 0556 P1 — the cardinality lint parses the WHOLE catalog', () => {
  it('reports exactly as many metrics as the catalog declares', () => {
    const { stdout, status } = runLint();
    expect(status, stdout).toBe(0);

    const reported = Number(stdout.match(/(\d+) metrics/)?.[1]);
    expect(Number.isFinite(reported), `could not read a metric count from: ${stdout}`).toBe(true);
    // The assertion the P0 guard could not make. A dropped entry is invisible in
    // the lint's own output — it prints a smaller number and still exits 0.
    expect(reported).toBe(METRIC_CATALOG.length);
  });

  it('reports exactly as many labels as the catalog declares', () => {
    const { stdout } = runLint();
    const reported = Number(stdout.match(/(\d+) labels/)?.[1]);
    // Catches a subtler drop than the count above: an entry whose `labels:`
    // array the regex failed to reach still contributes to the metric count
    // (its `name:` matched) while contributing zero labels — so it would be
    // linted as a metric with no labels, which the lint skips as "cannot blow up
    // cardinality".
    expect(reported).toBe(METRIC_CATALOG.reduce((n, m) => n + m.labels.length, 0));
  });

  it('sees the same forbidden-label list the runtime guard uses', () => {
    const { stdout } = runLint();
    const reported = Number(stdout.match(/of (\d+) forbidden names/)?.[1]);
    // The lint extracts FORBIDDEN_LABELS from the source rather than duplicating
    // it, precisely so the two cannot disagree. This pins that the extraction
    // still works — a partial parse here would silently narrow what is forbidden.
    expect(reported).toBe(FORBIDDEN_LABELS.length);
  });
});
