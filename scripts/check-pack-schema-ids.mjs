#!/usr/bin/env node
/**
 * Pack-internal schema `$id` must name the pack's CURRENT version.
 *
 * PORTED from openwop-registry (where the same check found 26 drifts across 11
 * packs). Running it here found **122 drifts across 17 packs** — a larger
 * population than the registry's, because this repo is where node packs are
 * AUTHORED and the registry only sees them at publish time. Enforcing at the
 * authoring end is what stops the drift being published in the first place.
 *
 * CONTRIBUTING.md § "Pack-internal JSON Schemas" makes this normative: the `$id`
 * MUST be `https://packs.openwop.dev/<pack>/<version>/<file>`, the version
 * segment MUST match `pack.json.version`, and *"Pack `version` bump: regenerate
 * every `$id` in the pack's `schemas/` directory to the new version."*
 *
 * WHY THIS IS A FILE AND NOT A HEREDOC. This check previously existed ONLY as an
 * inline `node -e` block inside `.github/workflows/packs-check.yml`. That meant
 * it could not be run locally, could not be unit-tested, could not be
 * sabotage-probed, and was absent from `scripts/registry-check.sh` — the repo's
 * own `npm run check`. So a routine version bump turned `main` red and stayed
 * red for four days, because the only way to observe the gate was to push.
 *
 * CONTRIBUTING.md also claimed `scripts/precheck-packs.mjs` "SHOULD catch drift".
 * It does not check `$id` at all. An unrunnable gate plus a false claim about a
 * different gate is how this became invisible.
 *
 * Usage:  node scripts/check-pack-schema-ids.mjs [--fix]
 *   (no flag) report drift and exit 1
 *   --fix     rewrite each drifted `$id` in place, then report
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FIX = process.argv.includes('--fix');
const PACKS = 'packs';
/** Floors near the measured population — see the guard below. */
const MIN_PACKS = 200;
const MISSING_ID_CEILING = 64;
const MIN_SCHEMAS = 1100;

if (!existsSync(PACKS)) {
  console.error(`✗ check-pack-schema-ids: no ${PACKS}/ directory — run from the registry repo root.`);
  process.exit(1);
}

const drifts = [];
let packsScanned = 0;
let schemasScanned = 0;
/** Schemas with no `$id` at all — normatively required, so absence is a finding. */
const missingId = [];

for (const dir of readdirSync(PACKS)) {
  const manifest = join(PACKS, dir, 'pack.json');
  if (!existsSync(manifest)) continue;
  let pack;
  try {
    pack = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch (err) {
    console.error(`✗ ${manifest} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  packsScanned += 1;
  // Prefer the manifest's own `name`; fall back to the directory. In the
  // registry these always agree; here a few packs are vendored under a
  // differently-cased directory, and the manifest is the SSoT.
  // Using the directory keeps the expected `$id` identical to the URL the
  // registry actually serves from, which is what a caching consumer resolves.
  const version = pack.version;
  const schemasDir = join(PACKS, dir, 'schemas');
  // §Correction (code review): `!version` used to `continue` — a SKIP. But
  // `packsScanned` was already incremented above, so deleting `"version"` from a
  // manifest left every `$id` in that pack unchecked while the gate exited 0.
  // A missing version is a broken manifest, not a pack to ignore.
  if (!version) {
    console.error(`✗ ${manifest} has no \`version\` — cannot check its schema $ids.`);
    process.exit(1);
  }
  if (!existsSync(schemasDir)) continue;

  for (const file of readdirSync(schemasDir)) {
    if (!file.endsWith('.json')) continue;
    const path = join(schemasDir, file);
    const raw = readFileSync(path, 'utf8');
    let schema;
    try {
      schema = JSON.parse(raw);
    } catch (err) {
      console.error(`✗ ${path} is not valid JSON: ${err.message}`);
      process.exit(1);
    }
    // Count the file BEFORE the `$id` test. §Correction (grade-code): counting
    // after meant DELETING an `$id` silenced its drift AND shrank the number the
    // anti-vacuity floor watches — so removing the field was a way to go green.
    // CONTRIBUTING.md makes `$id` normative, so absence is itself reportable.
    schemasScanned += 1;
    if (typeof schema.$id !== 'string') { missingId.push(path); continue; }
    const expected = `https://packs.openwop.dev/${pack.name ?? dir}/${version}/${file}`;
    if (schema.$id === expected) continue;

    drifts.push({ path, actual: schema.$id, expected });
    if (FIX) writeFileSync(path, raw.replace(`"${schema.$id}"`, `"${expected}"`));
  }
}

// Anti-vacuity: a gate that scanned nothing must not report success. This is the
// failure mode that let a sibling tripwire in openwop-app read 1407 files while
// examining zero nodes — it guarded on the FILE count, not on what it asserted.
// A `> 0` floor is not a guard: 204 of 205 packs could lose their schemas and it
// would still pass. Pin FLOORS near the measured population so a collapse in
// coverage fails loudly, the way a count-what-you-assert guard must.
if (packsScanned < MIN_PACKS || schemasScanned < MIN_SCHEMAS) {
  console.error(
    `✗ check-pack-schema-ids: scanned ${packsScanned} pack(s) (floor ${MIN_PACKS}) and `
    + `${schemasScanned} schema(s) with an $id (floor ${MIN_SCHEMAS}) — coverage collapsed. `
    + 'Refusing to report success. If the corpus legitimately shrank, lower the floors deliberately.',
  );
  process.exit(1);
}

// `$id` is normatively required, and 64 shipped schemas omit it. MEASURED before
// enforcing (ADR 0504's lesson: I once built a correct gate that would have
// blocked 67% of chains and did not ship it). Failing on a 64-case pre-existing
// population would block every unrelated change, so this is a NO-GROWTH ceiling:
// loud about the debt, fatal only if it grows. Whether these schemas should
// carry an `$id` at all is the same normative question as the narrower-rule
// proposal in ADR 0525 §"What this deliberately does NOT do" — decide it cold.
if (missingId.length > MISSING_ID_CEILING) {
  console.error(
    `✗ check-pack-schema-ids: ${missingId.length} schema(s) declare no $id, above the `
    + `recorded ceiling of ${MISSING_ID_CEILING}. CONTRIBUTING.md makes $id normative — `
    + 'add one rather than raising the ceiling.',
  );
  for (const p of missingId.slice(0, 10)) console.error(`  ${p}`);
  process.exit(1);
}
if (missingId.length > 0) {
  console.warn(`⚠ check-pack-schema-ids: ${missingId.length} schema(s) declare no $id (ceiling ${MISSING_ID_CEILING}, pre-existing — tracked).`);
}

if (drifts.length === 0) {
  console.log(`✓ check-pack-schema-ids: ${schemasScanned} schema $id(s) across ${packsScanned} packs all match <pack>/<version>/.`);
  process.exit(0);
}

if (FIX) {
  console.log(`✓ check-pack-schema-ids --fix: rewrote ${drifts.length} $id(s).`);
  for (const d of drifts) console.log(`  ${d.path}\n    ${d.actual}\n    → ${d.expected}`);
  process.exit(0);
}

console.error(`✗ check-pack-schema-ids: ${drifts.length} pack-internal schema $id mismatch(es).`);
for (const d of drifts) {
  console.error(`  ${d.path}\n    $id      ${d.actual}\n    expected ${d.expected}`);
}
console.error(
  '\n  CONTRIBUTING.md § "Pack-internal JSON Schemas": a version bump must regenerate\n'
  + '  every $id in the pack\'s schemas/ directory. Run with --fix to do that.\n'
  + '\n  NOTE: this corrects SOURCE only. Tarballs already published under the old\n'
  + '  version are immutable and stay as they were — re-cutting one would break the\n'
  + '  integrity hash in its version manifest.',
);
process.exit(1);
