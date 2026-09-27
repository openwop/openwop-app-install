#!/usr/bin/env node
/**
 * Validate the event payloads this host actually WRITES against the corpus
 * `$def` the codemap names for each type (ADR 0702).
 *
 * Usage:
 *   node scripts/audit-event-payloads.mjs --run     # run the backend suite, then audit
 *   node scripts/audit-event-payloads.mjs           # audit whatever samples exist
 *   node scripts/audit-event-payloads.mjs --json    # machine-readable
 *
 * THE NUMBER THIS EXISTS FOR IS THE DENOMINATOR, not the violation count.
 * A violation list is only as good as the sample set behind it, and the honest
 * question is "which types did the suite never produce a single payload for?"
 * Those are the types where a green run means nothing at all.
 *
 * Provenance: `myndhyve-1` measured that 31 of 355 conformance scenarios apply
 * Ajv, and the ones that do validate hand-written literals — correct by
 * construction. That makes the suite strong on a wrong VALUE and blind to a
 * missing REQUIRED KEY. Two real defects on this host (`output.chunk`,
 * `interrupt.resolved`) shipped through a lane that was EXIT=0, 490 files, 0 red.
 * See `backend/typescript/src/storage/eventPayloadAudit.ts`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BE = join(ROOT, 'backend', 'typescript');
// ESM ignores NODE_PATH, so resolve the backend's deps from the backend.
const req = createRequire(join(BE, 'package.json'));

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
let dir = process.env.OPENWOP_PAYLOAD_AUDIT;

if (args.has('--run')) {
  dir = mkdtempSync(join(tmpdir(), 'owp-payload-audit-'));
  process.stderr.write(`▶ running the backend suite with the payload recorder (samples → ${dir})\n`);
  try {
    execFileSync('node', ['node_modules/vitest/vitest.mjs', 'run'], {
      cwd: BE,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, OPENWOP_PAYLOAD_AUDIT: dir, OPENWOP_SKIP_TESTCONTAINERS: '1' },
      maxBuffer: 1 << 28,
    });
  } catch {
    // A red suite still produced samples, and the audit is about payload shape,
    // not about the suite passing. Say so rather than exiting on someone else's
    // failing test.
    process.stderr.write('  (the suite exited non-zero — auditing the samples it did produce)\n');
  }
}

if (!dir) {
  console.error('audit-event-payloads: pass --run, or set OPENWOP_PAYLOAD_AUDIT to a directory of samples.');
  process.exit(2);
}

// ── load the samples ───────────────────────────────────────────────────────
const samples = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (line.trim()) samples.push(JSON.parse(line));
  }
}
if (samples.length === 0) {
  // ZERO IS NOT A CLEAN RESULT. An empty sample set means the recorder never
  // ran — a wrong directory, an unwired seam, a suite that booted nothing —
  // and printing "0 violations" for it would be the exact empty-means-green
  // failure this whole script exists to close.
  console.error('audit-event-payloads: ZERO samples. The recorder did not run — this is a broken');
  console.error('  measurement, NOT a clean audit. Check OPENWOP_PAYLOAD_AUDIT reached the suite');
  console.error(`  and that eventEraAdapter still calls recordPayloadSample. (dir: ${dir})`);
  process.exit(2);
}

// ── the corpus side ────────────────────────────────────────────────────────
const payloads = JSON.parse(readFileSync(join(ROOT, 'schemas', 'v2', 'run-event-payloads.schema.json'), 'utf8'));
const typeIndex = payloads.$defs?._typeIndex?.properties ?? {};
const defNameFor = (type) => {
  const ref = typeIndex[type]?.$ref;
  return typeof ref === 'string' ? ref.replace(/^#\/\$defs\//, '') : undefined;
};

const Ajv = req('ajv/dist/2020.js').default ?? req('ajv/dist/2020.js');
const addFormats = req('ajv-formats').default ?? req('ajv-formats');
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
// The defs `$ref` each other and `ids.schema.json`; compile against the whole
// document so a `$ref` resolves rather than throwing.
ajv.addSchema(payloads, 'run-event-payloads.schema.json');
// Register every schema the document `$ref`s, TRANSITIVELY.
//
// MEASURED twice while writing this, which is the point of the note. First with
// only the payloads document registered: `ids.schema.json#/$defs/nodeId` was
// unresolvable and Ajv threw for 15 of 22 samples — INCLUDING `outputChunk` and
// `interruptResolved`, the two defects that motivated the script. Those rows
// were recorded as "not validated" and dropped, and the summary printed
// `payloads VALIDATED 7` as though that were a result.
//
// Then, with direct refs registered, two defs STILL would not compile:
// `ids.schema.json` itself refs `subject.schema.json`. A one-level walk is the
// same bug one level down, so the walk is transitive and an unresolvable ref is
// fatal rather than skipped.
//
// The auditor reproduced, inside itself, the exact empty-means-green failure it
// was built to catch. Twice.
const registered = new Set(['run-event-payloads.schema.json']);

/**
 * Collect `$ref` values by WALKING THE PARSED DOCUMENT, not by matching the
 * text.
 *
 * The regex version of this was wrong three times, each time in a way that made
 * the audit quietly narrower:
 *   1. only the payloads doc registered  → `ids.schema.json` unresolvable, 15 of
 *      22 samples silently unvalidated, including both defects that motivated
 *      the script.
 *   2. direct refs only                  → `ids.schema.json` refs
 *      `subject.schema.json`; two defs still uncompilable.
 *   3. one ref SPELLING only             → refs appear as a bare name, a `./`
 *      relative path AND an absolute URL; two more uncompilable.
 * And the fix for (3) matched a schema filename mentioned inside a prose
 * `description`, trying to load a file named after half an English sentence.
 *
 * A substring match is not a parse. `$ref` is a KEY in the schema language; ask
 * for the key.
 */
function refsIn(node, out = new Set()) {
  if (Array.isArray(node)) { for (const v of node) refsIn(v, out); return out; }
  if (node === null || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === '$ref' && typeof v === 'string') {
      const file = v.split('#')[0];
      if (file.endsWith('.schema.json')) out.add(file.split('/').pop());
    } else refsIn(v, out);
  }
  return out;
}

function registerRefs(doc) {
  for (const name of refsIn(doc)) {
    if (registered.has(name)) continue;
    registered.add(name);
    let sub;
    try {
      sub = JSON.parse(readFileSync(join(ROOT, 'schemas', 'v2', name), 'utf8'));
      ajv.addSchema(sub, name);
      // Register under the document's own `$id` too: an absolute-URL ref
      // resolves by `$id`, a bare or relative one by the name.
      if (typeof sub.$id === 'string' && sub.$id !== name) {
        try { ajv.addSchema(sub, sub.$id); } catch { /* already registered */ }
      }
    } catch (e) {
      console.error(`audit-event-payloads: could not register ${name} — every def that $refs it goes UNCHECKED.`);
      console.error(`  ${String(e).slice(0, 200)}`);
      process.exit(2);
    }
    registerRefs(sub);
  }
}
registerRefs(payloads);

const rows = [];
const uncompilable = new Map();
for (const s of samples) {
  const defName = defNameFor(s.type);
  if (defName === undefined) { rows.push({ ...s, defName: null, ok: null, errors: [] }); continue; }
  // A def the `_typeIndex` NAMES but Ajv cannot compile is a broken measurement,
  // not an absent one — see the note above. Collect them and fail at the end
  // with the whole list, rather than skipping each one quietly.
  let validate;
  try {
    validate = ajv.getSchema(`run-event-payloads.schema.json#/$defs/${defName}`);
  } catch (e) { uncompilable.set(defName, String(e).slice(0, 160)); continue; }
  if (!validate) { uncompilable.set(defName, 'getSchema returned undefined'); continue; }
  // ADR 0722 — TWO seams. `payload` is what is PERSISTED; `wire` is that row
  // after the composed major-2 projection (`storage/v2PayloadProjection.ts`),
  // recorded by the same recorder so both come from one write. The corpus
  // validates what a v2 READER receives, so `wire` is the gated number;
  // `payload` stays as the informational one (a v1 owner block at rest is by
  // design — ADR 0625 — and was 156 false reds before the split).
  const ok = validate(s.payload);
  const wireObj = s.wire === undefined ? s.payload : s.wire;
  const wireOk = validate(wireObj);
  const wireErrors = wireOk ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`);
  const okErrors = ok ? [] : (() => { validate(s.payload); return (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`); })();
  rows.push({ ...s, defName, ok, errors: okErrors, wireOk, wireErrors });
}

// ── THE DENOMINATOR ────────────────────────────────────────────────────────
const sampledTypes = new Set(samples.map((s) => s.type));
const indexedTypes = Object.keys(typeIndex);
const neverSampled = indexedTypes.filter((t) => !sampledTypes.has(t));
const noDef = [...sampledTypes].filter((t) => defNameFor(t) === undefined);
const violations = rows.filter((r) => r.ok === false);
// SPLIT BY ORIGIN. A sample recorded from a test is a FIXTURE's spelling, not
// this host's behaviour, and mixing them measures neither. See `originOf()` in
// `eventPayloadAudit.ts` — the tell was `run.started` reporting a missing
// `workflowId`, which no host emit site could produce.
// Seams that exist to plant ARBITRARY payloads. A sample from one is a fixture's
// spelling, not this host's behaviour, and counting it measures neither. This is
// a short, named list rather than a heuristic: `eventLogSeedSeam` is the
// conformance seed route, whose entire job is to write whatever a scenario hands
// it. Anything not on this list is real emit code and counts.
const FIXTURE_SEAMS = /routes\/eventLogSeedSeam|conformance\/seams/;
// ADR 0725 — a sample whose NEAREST non-plumbing frame is a TEST FILE was
// appended by the test itself (`getEventLog().append({...})` with a hand-rolled
// payload). That is a fixture's spelling too: no src emit site produced it, so
// nothing in src can be fixed to make it validate. The tell (recorded in
// `originOf`'s docblock) was `run.started` missing `workflowId`; measured
// 2026-09-17 it was four types and two of the three grown error shapes.
const FIXTURE_ORIGIN = /^test\//;
const hostRows = rows.filter((r) => typeof r.origin === 'string' && !FIXTURE_SEAMS.test(r.origin) && !FIXTURE_ORIGIN.test(r.origin));
// Persisted-seam violations (informational) and WIRE-seam violations (gated).
// ADR 0726 — two classes of WIRE error are not this host's projection failing:
//  (a) a bound-kind value whose OPAQUE half is outside the grammar (`r-inline-1`,
//      `int-gate-19`): a FIXTURE minted it — this host mints UUIDs / ≥32-hex —
//      and no projection can bind an id the grammar refuses; the sample is a
//      fixture's spelling flowing through a real emit site;
//  (b) an `anon:` run: its bound ids stay bare BY DECISION (ADR 0704), so a
//      pattern error there is the decision, not a defect.
// Both are reported (informational) and excluded from the gate. Everything else
// on a bound-kind key — a valid opaque under a real tenant left bare — GATES.
const BOUND_KINDS = new Set(['runId', 'parentRunId', 'sourceRunId', 'childRunId', 'interruptId', 'subscriptionId', 'deliveryId', 'effectId']);
const OPAQUE_OK = /^[A-Za-z0-9._~-]{16,128}$/;
const idErrorPath = (e) => /^\/([A-Za-z]+) must match pattern/.exec(e)?.[1];
function isFixtureOrAnonIdError(row, e) {
  const key = idErrorPath(e);
  if (key === undefined || !BOUND_KINDS.has(key)) return false;
  if (typeof row.tenant === 'string' && row.tenant.startsWith('anon:')) return true;
  const v = row.wire?.[key];
  if (typeof v !== 'string') return false;
  const opaque = v.includes('/') ? v.slice(v.indexOf('/') + 1) : v;
  return !OPAQUE_OK.test(opaque);
}
for (const r of hostRows) {
  if (r.wireOk !== false || !Array.isArray(r.wireErrors)) continue;
  const gated = r.wireErrors.filter((e) => !isFixtureOrAnonIdError(r, e));
  if (gated.length !== r.wireErrors.length) { r.informationalIdErrors = r.wireErrors.length - gated.length; r.wireErrors = gated; if (gated.length === 0) r.wireOk = true; }
}
const informationalIdRows = hostRows.filter((r) => r.informationalIdErrors).length;
const hostViolations = hostRows.filter((r) => r.wireOk === false);
const persistedViolations = hostRows.filter((r) => r.ok === false);
const hostTypes = new Set(hostRows.map((r) => r.type));

if (asJson) {
  console.log(JSON.stringify({
    samples: samples.length,
    sampledTypes: sampledTypes.size,
    indexedTypes: indexedTypes.length,
    neverSampled,
    noDef,
    uncompilable: Object.fromEntries(uncompilable),
    violations: rows.filter((r) => r.wireOk === false).map((v) => ({ type: v.type, origin: v.origin, defName: v.defName, keys: Object.keys((v.wire ?? v.payload) ?? {}), errors: v.wireErrors })),
    persistedViolations: persistedViolations.map((v) => ({ type: v.type, origin: v.origin, defName: v.defName, keys: Object.keys(v.payload ?? {}), errors: v.errors })),
    hostViolatingTypes: [...new Set(hostViolations.map((v) => v.type))].sort(),
  }, null, 2));
} else {
  console.log(`\nevent-payload audit — ${samples.length} distinct (type, key-set) samples over ${sampledTypes.size} types\n`);
  console.log(`  corpus _typeIndex names          ${indexedTypes.length} types`);
  console.log(`  this host produced a sample for  ${indexedTypes.length - neverSampled.length}`);
  console.log(`  NEVER SAMPLED (a green run says nothing about these)  ${neverSampled.length}`);
  console.log(`  sampled types with NO corpus def (vendor / host-only) ${noDef.length}`);
  console.log(`\n  payloads VALIDATED  ${rows.filter((r) => r.ok !== null).length}`);
  console.log(`  payloads VIOLATING  ${violations.length}   (all origins)`);
  console.log('');
  console.log(`  === HOST-EMITTED ONLY — the number that is about this host ===`);
  console.log(`  host payload samples   ${hostRows.length} over ${hostTypes.size} types`);
  console.log(`  fixture-minted / anon-tenant id rows (informational, ADR 0726/0704)  ${informationalIdRows}`);
  console.log(`  host WIRE violations   ${hostViolations.length} over ${new Set(hostViolations.map((v) => v.type)).size} types   <- gated (post-projection)`);
  console.log(`  host persisted viol.   ${persistedViolations.length} over ${new Set(persistedViolations.map((v) => v.type)).size} types   (informational; v1 owner block at rest is by design)`);
  console.log(`  defs UNCOMPILABLE   ${uncompilable.size}   <- a broken measurement, not a clean one\n`);
  for (const [d, why] of uncompilable) console.log(`  ! ${d}: ${why}`);
  const byOrigin = new Map();
  for (const v of hostViolations) byOrigin.set(v.origin, (byOrigin.get(v.origin) ?? 0) + 1);
  console.log('  violations by EMITTING FILE:');
  for (const [o, n] of [...byOrigin].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)} ${o}`);
  console.log('');
  for (const v of hostViolations) {
    console.log(`  ✗ ${v.type}  (def ${v.defName})  <- ${v.origin}`);
    console.log(`      wire keys: {${Object.keys((v.wire ?? v.payload) ?? {}).join(', ')}}`);
    for (const e of v.wireErrors.slice(0, 6)) console.log(`      ${e}`);
  }
  if (noDef.length) console.log(`\n  no corpus def (expected for vendor types): ${noDef.sort().join(', ')}`);
  if (neverSampled.length) console.log(`\n  never sampled: ${neverSampled.sort().join(', ')}`);
  console.log();
}

// ── A.4 (ADR 0722): the error-SHAPE ledger, the check the type ratchet cannot make ──
// The type-level ratchet stayed 31/31 green across a corpus bump that regressed
// two admitted types (2.2.0 closed `interruptResolved.decision` to an enum;
// `approval.granted`/`approval.overridden` are `$ref`s to it). A type already on
// the baseline can acquire a NEW KIND of violation and "violating set ==
// baseline" stays true. What caught it was diffing error SHAPES across the bump
// — so that diff is now a ledger of `<type> :: <path-class> <message-class>`
// PAIRS, gated shrink-only as a SET, with `--write-shapes` to (re)generate
// after a fix.
//
// CORRECTED 2026-09-17 (cleanup loop it.1): the first cut of this ledger gated
// on per-shape COUNTS, and the very next comment block below already says why
// that cannot work — "the sample count moves with test ordering". The recorder
// (`storage/eventPayloadAudit.ts`) keeps ONE sample per (type, key-set) PER
// WORKER PROCESS, so the count of samples carrying a given error is a function
// of how vitest spread the tests across forks, not of the code: the baseline
// was written at 188 `/F must match pattern "X"`, the next full run on the
// same tree measured 191, and a diff touching no emitter went red. Counts are
// still printed (informational); the gate is presence of a (type, shape) pair.
function shapeOf(e) { return e.replace(/'[^']*'/g, "'X'").replace(/"[^"]*"/g, '"X"').replace(/^\/[A-Za-z0-9_.]+/, '/F'); }
const shapesNow = new Map();
for (const v of hostViolations) for (const e of v.wireErrors) {
  const k = `${v.type} :: ${shapeOf(e)}`;
  shapesNow.set(k, (shapesNow.get(k) ?? 0) + 1);
}
const shapesFile = join(ROOT, 'scripts', 'event-payload-shapes-baseline.json');
if (args.has('--write-shapes')) {
  writeFileSync(shapesFile, JSON.stringify({
    _comment: ['ADR 0722 A.4 — the SET of `<type> :: <error-shape>` pairs observed over WIRE-seam violations, shrink-only.',
      'A pair that is NEW fails the gate: that is a corpus tightening (or a new emit) landing inside an',
      'already-admitted type, which the type-level ratchet is structurally blind to. The values are sample',
      'counts and are INFORMATIONAL ONLY — they move with vitest worker distribution (one sample per',
      '(type, key-set) per worker), so a gate on them reds on unrelated diffs (measured 188 → 191, 2026-09-17).',
      'Regenerate with `node scripts/audit-event-payloads.mjs --ratchet --write-shapes` after a FIX, never after a bump.'],
    measured: new Date().toISOString().slice(0, 10),
    shapes: Object.fromEntries([...shapesNow].sort()),
  }, null, 2) + '\n');
  console.log(`  wrote ${shapesNow.size} (type, error-shape) pairs to ${shapesFile}`);
}

// ── the shrink-only ratchet ────────────────────────────────────────────────
// Types, not counts. The sample count moves with test ordering and flake, and a
// gate that moves for reasons unrelated to the code is one people re-baseline
// on reflex until it means nothing.
let ratchetFail = 0;
if (args.has('--ratchet')) {
  const baselineFile = join(ROOT, 'scripts', 'event-payload-violations-baseline.json');
  const baseline = new Set(JSON.parse(readFileSync(baselineFile, 'utf8')).types);
  const now = new Set(hostViolations.map((v) => v.type));
  const added = [...now].filter((t) => !baseline.has(t)).sort();
  // A type that STOPPED violating must leave the file. A stale admission is
  // what makes a ratchet stop ratcheting: it silently widens the allowance
  // every time the code improves.
  const stale = [...baseline].filter((t) => !now.has(t) && sampledTypes.has(t)).sort();
  // A baselined type the run never SAMPLED is neither fixed nor broken — it is
  // unmeasured, and calling it stale would instruct a deletion that hides a real
  // violation the next time coverage reaches it.
  const unmeasured = [...baseline].filter((t) => !sampledTypes.has(t)).sort();
  console.log(`  ratchet: ${now.size} violating / ${baseline.size} admitted / ${unmeasured.length} admitted-but-unsampled`);
  if (added.length) {
    console.log(`  ✗ NEW violating types (a wire gap this host has not admitted):`);
    for (const t of added) console.log(`      ${t}`);
    ratchetFail = 1;
  }
  if (stale.length) {
    console.log(`  ✗ STALE admissions — these validate now; delete them from ${baselineFile}:`);
    for (const t of stale) console.log(`      ${t}`);
    ratchetFail = 1;
  }
  // A.4 — the (type, shape) SET may only shrink. Types is the stable coarse
  // gate; this is the fine one. Presence, not count (see the correction above).
  if (existsSync(shapesFile)) {
    const shapeBase = JSON.parse(readFileSync(shapesFile, 'utf8')).shapes ?? {};
    const legacyCountLedger = Object.keys(shapeBase).some((k) => !k.includes(' :: '));
    if (legacyCountLedger) {
      console.log(`  ✗ ${shapesFile} is the pre-correction per-shape COUNT ledger; regenerate it with --write-shapes`);
      ratchetFail = 1;
    } else {
      const newPairs = [...shapesNow.keys()].filter((k) => !(k in shapeBase)).sort();
      // A baselined pair whose TYPE was sampled but which no sample reproduced is
      // reported, not failed: which VALUE the recorder kept for a key-set is
      // order-dependent, so absence is weak evidence of a fix. Delete it from the
      // file when the fix is known, and the gate tightens from there.
      const quiet = Object.keys(shapeBase).filter((k) => !shapesNow.has(k) && sampledTypes.has(k.split(' :: ')[0])).sort();
      if (newPairs.length) {
        console.log('  ✗ NEW error shapes (a tightening or new emit inside an admitted type):');
        for (const k of newPairs) console.log(`      ${String(shapesNow.get(k)).padStart(4)}×  ${k}`);
        ratchetFail = 1;
      } else console.log(`  ✓ error shapes: ${shapesNow.size} (type, shape) pair(s) observed, ${Object.keys(shapeBase).length} admitted, none new`);
      if (quiet.length) {
        console.log(`  · ${quiet.length} admitted pair(s) not reproduced this run (sampling is order-dependent; delete from the baseline only after a known fix):`);
        for (const k of quiet.slice(0, 12)) console.log(`      ${k}`);
        if (quiet.length > 12) console.log(`      … ${quiet.length - 12} more`);
      }
    }
  } else console.log('  (no shapes baseline yet — run once with --write-shapes)');
  if (!ratchetFail) console.log('  ✓ event-payload ratchet: violating set == baseline');
}

if (args.has('--run') && dir.includes('owp-payload-audit-')) rmSync(dir, { recursive: true, force: true });
// An uncompilable def is as fatal as a violation: it means a type the corpus
// names went UNCHECKED while the summary looked complete.
// Under --ratchet the question is "did the set MOVE", not "is it empty": 31
// admitted types cannot be fixed in one change, and a gate that is red from the
// day it lands is a gate nobody reads.
process.exit(args.has('--ratchet')
  ? (ratchetFail || (uncompilable.size > 0 ? 1 : 0))
  : (hostViolations.length > 0 || uncompilable.size > 0 ? 1 : 0));
