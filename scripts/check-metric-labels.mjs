#!/usr/bin/env node
/**
 * ADR 0556 P0 — the STATIC half of the cardinality lint.
 *
 * Fails if a metric in `METRIC_CATALOG` declares a label that can take an
 * unbounded number of values. An unbounded label turns a metric into a
 * per-entity time series and takes the collector down; the failure is
 * operational, arrives late, and is invisible to a unit test that only asserts a
 * counter incremented.
 *
 * WHY BOTH HALVES. The runtime guard (`guardAttributes`) catches a label whose
 * NAME is computed at the call site, which no static pass can see. This catches
 * a bad label in the catalog itself — before it is ever recorded, and without
 * needing the code path to execute. Neither substitutes for the other, which is
 * why ADR 0556 P0's gate says "static/runtime tests" rather than picking one.
 *
 * Reads the TypeScript source directly rather than importing it: this runs in
 * the gate before/independently of a build, and a lint that needs its subject
 * compiled first is a lint that gets skipped.
 *
 * Usage: node scripts/check-metric-labels.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'backend', 'typescript', 'src', 'observability', 'metrics.ts');

const source = readFileSync(SRC, 'utf8');

/** Pull the FORBIDDEN_LABELS array out of the module so the script and the
 *  runtime guard cannot disagree about what is forbidden. Duplicating the list
 *  here would be the drift this whole program keeps finding. */
function forbiddenLabels() {
  const m = source.match(/export const FORBIDDEN_LABELS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error('could not locate FORBIDDEN_LABELS in metrics.ts — did it move?');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/**
 * Extract `{ name, labels }` for each catalog entry.
 *
 * > CORRECTED (ADR 0556 P1). This split the block on `}\s*,\s*{`, which assumes
 * > catalog entries are separated by nothing but punctuation. P1 added a
 * > section comment BETWEEN two entries and the split stopped matching there,
 * > silently merging two objects into one chunk — from which only the first
 * > `name:` was read. The lint then reported 18 of 19 metrics and exited 0.
 * >
 * > That is the vacuous-parse failure this file's own guard below was written
 * > to prevent, in its partial form: the guard asserted the parse found
 * > SOMETHING, and something is not everything. Splitting on the entry START
 * > (`name:`) removes the assumption — a comment, a blank line or a trailing
 * > property cannot separate an entry from its own name. `check-metric-catalog-
 * > parity.test.ts` now pins the COUNT against the compiled catalog, because a
 * > parser that under-reports is exactly as green as one that is correct.
 */
function catalogEntries() {
  const block = source.match(/export const METRIC_CATALOG[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error('could not locate METRIC_CATALOG in metrics.ts — did it move?');
  const body = block[1];
  const starts = [...body.matchAll(/name:\s*'([^']+)'/g)];
  const entries = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].index;
    const to = i + 1 < starts.length ? starts[i + 1].index : body.length;
    const chunk = body.slice(from, to);
    const labelsRaw = chunk.match(/labels:\s*\[([^\]]*)\]/)?.[1] ?? '';
    entries.push({ name: starts[i][1], labels: [...labelsRaw.matchAll(/'([^']+)'/g)].map((x) => x[1]) });
  }
  return entries;
}

// A parse failure exits 1 with a READABLE message rather than an uncaught stack
// trace. Verified by renaming the symbol the regex looks for: rc=1 either way,
// but a gate that fails with a stack trace gets read as "the lint is broken"
// instead of "the file moved, fix the lint".
let forbidden;
let catalog;
try {
  forbidden = forbiddenLabels();
  catalog = catalogEntries();
} catch (err) {
  console.error(`✗ check-metric-labels: ${err instanceof Error ? err.message : String(err)}`);
  console.error('  This lint parses metrics.ts as TEXT. If the declarations were renamed or');
  console.error('  restructured, update the patterns here — do NOT delete the check.');
  process.exit(1);
}

// A parse that finds nothing would pass vacuously — the exact failure mode this
// program keeps hitting. Assert the extraction WORKED before trusting its result.
if (forbidden.length === 0) {
  console.error('✗ check-metric-labels: FORBIDDEN_LABELS parsed as empty — the check would pass vacuously.');
  process.exit(1);
}
if (catalog.length === 0) {
  console.error('✗ check-metric-labels: METRIC_CATALOG parsed as empty — the check would pass vacuously.');
  process.exit(1);
}

const violations = [];
for (const { name, labels } of catalog) {
  if (labels.length === 0) continue; // a metric with no labels cannot blow up cardinality
  for (const label of labels) {
    if (forbidden.includes(label)) violations.push({ name, label });
  }
}

if (violations.length > 0) {
  console.error('✗ check-metric-labels: unbounded label(s) declared in METRIC_CATALOG:\n');
  for (const v of violations) {
    console.error(`    ${v.name} declares '${v.label}' — unbounded; one time series per value.`);
  }
  console.error('\n  Use a BOUNDED dimension instead (a route template, a status class, a kind).');
  console.error('  If you need per-entity detail, that belongs on a span or a log line, not a metric.\n');
  process.exit(1);
}

console.log(
  `✓ check-metric-labels: ${catalog.length} metrics, `
  + `${catalog.reduce((n, c) => n + c.labels.length, 0)} labels, `
  + `0 of ${forbidden.length} forbidden names declared.`,
);
