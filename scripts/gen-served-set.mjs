#!/usr/bin/env node
/**
 * ADR 0572 P2 — the served-set ratchet.
 *
 * replay.md requirement 4, as the spec steward ruled it (upstream #999):
 * requirements 1 and 2 are TWO obligations. A typeId is DISCHARGED only by
 * SERVING the source run's recorded outcome, keyed on
 * `(sourceRunId, nodeId, attempt)`. A guarded-seam THROW satisfies "do not
 * perform" and NOT "resolve the outcome" — it is a BACKSTOP, and a throw-only
 * host is "safe and non-conformant".
 *
 * So the served set has exactly two arms:
 *   1. ADR 0341 fast path      — the classifier short-circuits and serves.
 *   2. ADR 0326 invocation log — the node runs, the provider call is served
 *                                from the record (source-keyed; verified at
 *                                `aiProviders/aiProvidersHost.ts:729-752`).
 * Everything else in the floor is UNDISCHARGED: safe today, and it FAILS a
 * replay that requirement 4 says must succeed.
 *
 * WHY A RATCHET AND NOT A HARD FAILURE. A build that reds on every undischarged
 * typeId is a gate nobody can land through, and a gate that gets disabled in a
 * week is worse than none. The baseline may only SHRINK.
 *
 * WHY BUCKETED, which is the steward's correction of my first proposal. I
 * rejected a 257-row exemption list as a rubber stamp and then proposed a
 * 240-row baseline — the name change was doing the work. A reviewer cannot
 * check 214 opaque ids. They CAN check "a bucket moved". So the diff a human
 * reads is a bucket moving.
 *
 * HOW THE ARMS ARE DERIVED — by reading each node's FUNCTION BODY, never its
 * name, and TRANSITIVELY since ADR 0572 P3. Four attempts and what each cost:
 *   - typeId regex (`/generate|classify|extract/`)  — the exact trap that filed
 *     `core.db.sql-query` as a read on the strength of the word "query".
 *     Discarded before use.
 *   - "does this pack call AI"                      — code-derived but far too
 *     coarse: 20+ packs hold one AI node and that does not make its siblings
 *     AI-served.
 *   - resolve typeId -> exported fn -> read the body — correct, and it took
 *     three parser fixes (arrow consts, FACTORY indirection, inline
 *     factory-call mappings) to go 107 -> 62 -> 10 unresolved. Every one of
 *     those waves was THIS PARSER, not a gap in the packs.
 *   - P3: read the body TRANSITIVELY, and stop matching `callAI` as a
 *     SUBSTRING. Both halves were real defects, in opposite directions:
 *       under-detection — a node wrapping a local helper that calls
 *         `ctx.callAI` read as "no AI" (`core.rag.retriever-basic`,
 *         `core.rag.vector-{query,upsert}`);
 *       over-detection  — `/callAI/` matches `callAIWithTools`, which does NOT
 *         touch the invocation log, so `core.ai.toolCalling` was counted
 *         DISCHARGED while a replay would re-fire its provider call.
 *     A false discharge is the worst cell in this table: it is a claim of
 *     protection, not a gap in one.
 *
 * The residue is NOT silently bucketed. `unresolved` is its own list, because a
 * node this script cannot read is a node a human must classify — and quietly
 * defaulting it into a bucket is how a ratchet starts lying. Nor is the AI
 * residue: a node reaching a host AI capability that is NOT the invocation log
 * (the media providers, `callAIWithTools`, `aiEnvelope`, `agentRuntime`) lands
 * in `ai-opaque-not-invocation-logged` — undischarged, and named so the next
 * pass can see what it is looking at.
 *
 * BUILD-ONLY, NEVER RUNTIME (the steward's condition (a)). The baseline lives
 * under `docs/steward/`, outside `backend/typescript/src`, so an executor
 * import is structurally implausible rather than merely discouraged; a test
 * pins it anyway. An entry here means "not yet served", NOT "may execute during
 * a replay" — at runtime it still reaches the seam and throws. If this file
 * ever becomes an input to the executor's decision, the fail-closed inversion
 * is gone and we have rebuilt the allowlist that started this.
 *
 *   node scripts/gen-served-set.mjs           # write the baseline
 *   node scripts/gen-served-set.mjs --check   # CI: fail on GROWTH, report counts
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildImplIndex, classifyNodeReach, DEFERRED_SEMANTICS_ROLES } from './lib/packNodeReach.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const B = join(ROOT, 'backend/typescript');
const OUT = join(ROOT, 'docs/steward/SERVED-SET-BASELINE.json');

/** The floor, from the committed P1 snapshot — derived there, not re-derived. */
function floor() {
  const gen = readFileSync(join(B, 'src/executor/sideEffectFloor.generated.ts'), 'utf8');
  const m = gen.match(/MANIFEST_SIDE_EFFECT_FLOOR[^=]*=\s*new Set\(\[([\s\S]*?)\n\]\);/);
  if (!m) throw new Error('could not parse MANIFEST_SIDE_EFFECT_FLOOR — run gen-side-effect-floor.mjs first');
  const out = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (out.length === 0) throw new Error('parsed an EMPTY floor — refusing to report a served set against nothing');
  return out;
}

/** typeId -> manifest role, for reporting WHICH held-back reason applies. */
function packRoles() {
  const roles = new Map();
  for (const d of readdirSync(join(ROOT, 'packs')).sort()) {
    const p = join(ROOT, 'packs', d, 'pack.json');
    if (!existsSync(p)) continue;
    let json;
    try { json = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    for (const n of Array.isArray(json.nodes) ? json.nodes : []) {
      const typeId = n.typeId ?? n.id;
      if (typeof typeId === 'string' && !roles.has(typeId)) roles.set(typeId, n.role);
    }
  }
  return roles;
}

/** Arm 1 — the ADR 0341 fast path, read from what the CLASSIFIER actually
 *  consults: the derived served set (ADR 0572 P3, primary) UNION the retained
 *  hand-list (which still covers the manifest-less in-tree conformance nodes).
 *  Parsing only one of the two would report a shrink the executor never made. */
function fastPathPredicate() {
  const src = readFileSync(join(B, 'src/executor/sideEffects.ts'), 'utf8');
  const m = src.match(/SIDE_EFFECTING_TYPE_PATTERNS[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (!m) throw new Error('could not parse SIDE_EFFECTING_TYPE_PATTERNS');
  const res = [...m[1].matchAll(/^\s*(\/(?:[^/\\\n]|\\.)+\/[gimsuy]*)\s*,/gm)].map((x) => {
    const last = x[1].lastIndexOf('/');
    return new RegExp(x[1].slice(1, last), x[1].slice(last + 1));
  });
  if (res.length === 0) throw new Error('parsed zero allowlist patterns — every node would read as undischarged');
  // The generated union the classifier checks FIRST. Absent it, this script
  // would measure the pre-P3 world and call the difference progress.
  const gen = readFileSync(join(B, 'src/executor/sideEffectFloor.generated.ts'), 'utf8');
  const gm = gen.match(/MANIFEST_FAST_PATH_SERVED[^=]*=\s*new Set\(\[([\s\S]*?)\n\]\);/);
  if (!gm) throw new Error('could not parse MANIFEST_FAST_PATH_SERVED — run gen-side-effect-floor.mjs first');
  const derived = new Set([...gm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  if (derived.size === 0) throw new Error('parsed an EMPTY served set — every floor node would read as undischarged');
  // Assert the wiring, do not assume it. A generated set the classifier never
  // reads is the "generated file nothing consumes" failure ADR 0572 names.
  if (!/MANIFEST_FAST_PATH_SERVED\.has\(typeId\)/.test(src)) {
    throw new Error('sideEffects.ts does not consult MANIFEST_FAST_PATH_SERVED — the derived set is not wired into the classifier');
  }
  return (t) => derived.has(t) || res.some((re) => re.test(t));
}

const FLOOR = floor();
const isFastPath = fastPathPredicate();
const impl = buildImplIndex(ROOT);
const ROLES = packRoles();

const served = { 'fast-path': [], 'invocation-log': [] };
const undischarged = { 'ai-opaque-not-invocation-logged': [], 'deferred-role-semantics': [], 'needs-fast-path-classification': [] };
const unresolved = [];

for (const t of FLOOR) {
  if (isFastPath(t)) { served['fast-path'].push(t); continue; }
  const reach = classifyNodeReach(t, impl);
  if (reach.kind === 'unresolved') { unresolved.push({ typeId: t, why: reach.why }); continue; }
  // Arm 2 — reaches `ctx.callAI`, the ONE invocation-logged path. The node runs
  // live and the log serves the provider call from the SOURCE run.
  if (reach.kind === 'invocation-log') { served['invocation-log'].push(t); continue; }
  if (reach.kind === 'ai-opaque') { undischarged['ai-opaque-not-invocation-logged'].push(t); continue; }
  // No AI reach and still not fast-pathed ⇒ a role whose fast-path semantics
  // ADR 0572 holds open (`gate` suspends; `streaming-output` would lose its
  // frames), or something the generator declined for a reason worth naming.
  if (DEFERRED_SEMANTICS_ROLES.includes(ROLES.get(t))) undischarged['deferred-role-semantics'].push(t);
  else undischarged['needs-fast-path-classification'].push(t);
}

const counts = {
  floor: FLOOR.length,
  served: served['fast-path'].length + served['invocation-log'].length,
  undischarged: Object.values(undischarged).reduce((a, v) => a + v.length, 0),
  unresolved: unresolved.length,
};

/**
 * The fast-path served set BY MANIFEST ROLE — reported and recorded, not just
 * totalled.
 *
 * `replay.md` requirement 4 binds `role: "side-effect"`. This host serves a
 * WIDER set on purpose (requirement 4: "may classify additional nodes as
 * side-effecting, and it MUST NOT classify fewer"), so a reviewer must be able
 * to see how far past the binding set it goes WITHOUT diffing 212 ids. A single
 * `served 237` hides exactly the judgement call worth reviewing.
 */
const servedByRole = {};
for (const t of served['fast-path']) {
  const r = ROLES.get(t) ?? '(unknown)';
  servedByRole[r] = (servedByRole[r] ?? 0) + 1;
}

const baseline = {
  $comment: [
    'ADR 0572 P2 — the served-set ratchet. GENERATED by scripts/gen-served-set.mjs.',
    'An entry means "not yet SERVED on replay" — NOT "may execute during a replay".',
    'At runtime an undischarged node still reaches a guarded seam and throws.',
    'BUILD-ONLY: nothing under backend/typescript/src may import this file.',
    'EXIT CONDITION: this baseline reaches zero, at which point replay.',
    'sideEffectSuppression can return to "recorded-outcome" — true by construction',
    'rather than by census — and this file and its check are deleted together.',
  ],
  counts,
  servedByRole,
  served: { 'fast-path': served['fast-path'].sort(), 'invocation-log': served['invocation-log'].sort() },
  undischarged: Object.fromEntries(Object.entries(undischarged).map(([k, v]) => [k, [...v].sort()])),
  unresolved: unresolved.sort((a, b) => a.typeId.localeCompare(b.typeId)),
};
const rendered = `${JSON.stringify(baseline, null, 2)}\n`;

const report = () => {
  console.log(`  floor ${counts.floor}   served ${counts.served}   undischarged ${counts.undischarged}   unresolved ${counts.unresolved}`);
  console.log(`    served: fast-path ${served['fast-path'].length}, invocation-log ${served['invocation-log'].length}`);
  // Requirement 4 binds `role: side-effect`; anything else served is a
  // DELIBERATE widening and a reviewer should see its size without diffing ids.
  for (const [r, n] of Object.entries(servedByRole).sort((x, y) => y[1] - x[1])) {
    console.log(`      ${String(n).padStart(3)}  served, role:${r}${r === 'side-effect' ? '  (the set requirement 4 binds)' : '  (deliberate widening — ADR 0572 P3)'}`);
  }
  for (const [k, v] of Object.entries(undischarged)) console.log(`    ${String(v.length).padStart(3)}  ${k}`);
  if (unresolved.length) console.log(`    ${String(unresolved.length).padStart(3)}  unresolved — a human must classify these; they are NOT bucketed`);
};

if (process.argv.includes('--check')) {
  if (!existsSync(OUT)) {
    console.error('✗ no served-set baseline — run: node scripts/gen-served-set.mjs');
    process.exit(1);
  }
  const prev = JSON.parse(readFileSync(OUT, 'utf8'));
  // ALWAYS print the counts, pass or fail. A ratchet that only speaks when it
  // fails cannot report the failure mode it actually has: stalling. The steward
  // asked for instrumentation; this is the specific form.
  report();
  const grew = counts.undischarged > prev.counts.undischarged || counts.unresolved > prev.counts.unresolved;
  if (grew) {
    console.error(`\n✗ the served-set ratchet GREW: undischarged ${prev.counts.undischarged} -> ${counts.undischarged}, unresolved ${prev.counts.unresolved} -> ${counts.unresolved}.`);
    console.error('  A new floor node is not served on replay. Serve it, or explain why in the ADR — the baseline may only shrink.');
    process.exit(1);
  }
  if (counts.undischarged < prev.counts.undischarged || counts.unresolved < prev.counts.unresolved) {
    console.error(`\n✗ the ratchet SHRANK (${prev.counts.undischarged} -> ${counts.undischarged}) but the baseline was not updated.`);
    console.error('  Run: node scripts/gen-served-set.mjs   — progress must be recorded, or the next growth is measured against a stale floor.');
    process.exit(1);
  }
  // STALENESS, which is a different failure from growth or shrink — and until
  // now was UNDETECTABLE here. The two comparisons above read only
  // `undischarged` and `unresolved`; a new node that lands SERVED moves `floor`
  // and `served` while leaving both counters untouched, so `--check` printed
  // "baseline current" over a baseline that named neither the node nor the
  // right floor. Measured: floor 281 -> 283, served 238 -> 240, servedByRole
  // side-effect 187 -> 189, undischarged 43 -> 43, unresolved 0 -> 0 — green.
  // This is not a ratchet direction (a served node is progress, and failing on
  // it would penalise the good outcome); it is an "the artifact no longer
  // describes the tree" check, with the same one-command exit as the shrink.
  const drift = Object.entries({ floor: counts.floor, served: counts.served })
    .filter(([k, v]) => prev.counts[k] !== v)
    .map(([k, v]) => `${k} ${prev.counts[k]} -> ${v}`)
    .concat(
      Object.entries(servedByRole)
        .filter(([r, n]) => (prev.servedByRole?.[r] ?? 0) !== n)
        .map(([r, n]) => `servedByRole.${r} ${prev.servedByRole?.[r] ?? 0} -> ${n}`),
    );
  if (drift.length > 0) {
    console.error(`\n✗ the served-set baseline is STALE: ${drift.join(', ')}.`);
    console.error('  The undischarged/unresolved counters did not move, so the ratchet above cannot see this.');
    console.error('  Run: node scripts/gen-served-set.mjs   — a baseline that does not describe the tree cannot bound the next change.');
    process.exit(1);
  }
  console.log('served-set baseline current.');
} else {
  writeFileSync(OUT, rendered);
  console.log(`✓ wrote ${OUT}`);
  report();
}
