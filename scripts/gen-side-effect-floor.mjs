#!/usr/bin/env node
/**
 * replay.md requirement 4 — DERIVE the side-effect floor from the pack
 * manifests, never hand-write it.
 *
 * Requirement 4: a pack manifest's node `role: "side-effect"` declaration is
 * binding on the host, and "a host's own classifier is a floor ABOVE this
 * declaration and never a substitute: it may classify additional nodes as
 * side-effecting, and it MUST NOT classify fewer."
 *
 * The hand-maintained allowlist in `executor/sideEffects.ts` is exactly the
 * mechanism that requirement exists to stop us relying on alone, and it has
 * drifted twice on record: ADR 0563 (`core.storage.blob-put`) and the ten
 * `core.openwop.http.*` senders (ADR 0533's correction note). Both times the
 * manifest declared `side-effect` and nothing read it.
 *
 * WHAT THIS GENERATES
 * ===================
 * TWO sets. The floor's MEMBERSHIP, and — since ADR 0572 Phase 3 — the subset
 * of it the ADR 0341 fast path SERVES, which `isSideEffectingNode` now consults.
 *
 * P1 emitted membership only and said so, because a naive union is provably
 * wrong: `executor.ts` runs `replayServed ?? await module.execute(ctx)`, so a
 * typeId the classifier returns true for is NEVER EXECUTED on a replay, and
 * unioning the `core.openwop.ai.*` nodes would stop the mock provider running
 * and kill the RFC 0041 §B divergence machinery.
 *
 * That objection was AI-SPECIFIC and it survives — as a SUBTRACTION, not as a
 * veto on the whole union. The spec steward (upstream #999) ruled requirements
 * 1 and 2 to be two obligations: a guarded-seam THROW satisfies "do not perform"
 * and NOT "resolve the outcome", so a throw is a backstop and a throw-only host
 * is "safe and non-conformant". A floor typeId is discharged only by SERVING the
 * source run's recorded outcome. For the AI class the ADR 0326 invocation log is
 * that serving mechanism, one level down, which is why those nodes keep running
 * live. For everything else in the floor, the fast path is it.
 *
 * So the served set is `floor MINUS (anything reaching a host AI capability)
 * MINUS (roles whose fast-path semantics are unresolved) MINUS (anything this
 * build cannot read)`. Each subtraction leaves the node UNDISCHARGED and
 * counted by the ratchet — never exempt, never silently absorbed.
 * `scripts/lib/packNodeReach.mjs` owns the reach analysis and its failure
 * direction.
 *
 * WHAT IT DOES ENFORCE, TODAY
 * ===========================
 * Every manifest node MUST declare a role from the closed taxonomy. A missing
 * or unrecognized role is a BUILD FAILURE, not a default — fail closed, fail
 * loud. That catches the typo class (`"side_effect"`) which would otherwise
 * silently drop a node out of protection, and it means a new node arrives as a
 * reviewed diff rather than an assumption.
 *
 * The floor binds role `side-effect` UNION the `side-effectful` capability. The
 * capability is the wider signal — 60 nodes carry it while declaring another
 * role — and classifying additional nodes is the direction requirement 4
 * permits. Never the subtraction.
 *
 *   node scripts/gen-side-effect-floor.mjs            # write the snapshot
 *   node scripts/gen-side-effect-floor.mjs --check    # CI: fail on drift
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildImplIndex, classifyNodeReach, DEFERRED_SEMANTICS_ROLES } from './lib/packNodeReach.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKS = join(ROOT, 'packs');
const OUT = join(ROOT, 'backend/typescript/src/executor/sideEffectFloor.generated.ts');

/** The closed role taxonomy (ADR 0473 P2). Anything outside it is a failure,
 *  not an unknown to be tolerated — see the header. */
const ROLES = new Set(['pure', 'read', 'gate', 'action', 'side-effect', 'streaming-output']);
const SIDE_EFFECT_CAPABILITY = 'side-effectful';

function scan() {
  if (!existsSync(PACKS)) throw new Error(`no packs dir at ${PACKS}`);
  const nodes = new Map(); // typeId -> { pack, role, caps }
  const conflicts = [];
  const unclassified = [];
  for (const dir of readdirSync(PACKS).sort()) {
    const manifest = join(PACKS, dir, 'pack.json');
    if (!existsSync(manifest)) continue;
    let json;
    try {
      json = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch (err) {
      // An unreadable manifest is NOT "a pack with no nodes" — that reading is
      // how a parse error becomes a silently smaller floor.
      throw new Error(`${dir}/pack.json is unparseable: ${err.message}`);
    }
    if (!Array.isArray(json.nodes)) continue;
    for (const n of json.nodes) {
      const typeId = n.typeId ?? n.id;
      if (typeof typeId !== 'string' || typeId.length === 0) {
        throw new Error(`${dir}/pack.json has a node with no typeId`);
      }
      const role = typeof n.role === 'string' ? n.role : null;
      const caps = Array.isArray(n.capabilities) ? n.capabilities.filter((c) => typeof c === 'string') : [];
      if (role === null || !ROLES.has(role)) unclassified.push({ typeId, pack: dir, role: role ?? '(absent)' });
      const prior = nodes.get(typeId);
      if (prior && (prior.role !== role || prior.caps.includes(SIDE_EFFECT_CAPABILITY) !== caps.includes(SIDE_EFFECT_CAPABILITY))) {
        // Two packs declaring one typeId differently: whichever the loader reads
        // last would decide whether a replay re-fires. Never let that be luck.
        conflicts.push(`${typeId}: ${prior.role}@${prior.pack} vs ${role}@${dir}`);
      }
      if (!prior) nodes.set(typeId, { pack: dir, role, caps });
    }
  }
  return { nodes, conflicts, unclassified };
}

/**
 * ADR 0572 P3 — the subset of the floor the ADR 0341 fast path SERVES.
 *
 * Returns `{ served, held: { … } }`. Everything not in `served` is held back
 * WITH ITS REASON, so the caller can report why rather than emitting a number.
 */
function deriveServedSet(nodes, floor) {
  const impl = buildImplIndex(ROOT);
  const served = [];
  const held = { 'ai-invocation-log': [], 'ai-opaque-not-logged': [], 'deferred-role-semantics': [], unresolved: [] };
  for (const typeId of floor) {
    const role = nodes.get(typeId)?.role;
    if (DEFERRED_SEMANTICS_ROLES.includes(role)) { held['deferred-role-semantics'].push(typeId); continue; }
    const reach = classifyNodeReach(typeId, impl);
    if (reach.kind === 'unresolved') held.unresolved.push(typeId);
    else if (reach.kind === 'invocation-log') held['ai-invocation-log'].push(typeId);
    else if (reach.kind === 'ai-opaque') held['ai-opaque-not-logged'].push(typeId);
    else served.push(typeId);
  }
  // An empty served set is indistinguishable from "the reach analysis broke",
  // and it would emit a classifier union that classifies nothing while every
  // check stayed green — the could-not-fail shape this program keeps finding.
  if (served.length === 0) throw new Error('derived an EMPTY fast-path served set from a non-empty floor — refusing to write a classifier union that classifies nothing');
  return { served: served.sort(), held };
}

function render(nodes) {
  const floor = [...nodes]
    .filter(([, v]) => v.role === 'side-effect' || v.caps.includes(SIDE_EFFECT_CAPABILITY))
    .map(([typeId]) => typeId)
    .sort();
  const { served, held } = deriveServedSet(nodes, floor);
  const all = [...nodes.keys()].sort();
  const byRole = new Map();
  for (const [, v] of nodes) byRole.set(v.role, (byRole.get(v.role) ?? 0) + 1);
  const census = [...byRole].sort((a, b) => b[1] - a[1]).map(([r, n]) => ` *   ${String(n).padStart(4)}  ${r}`).join('\n');

  return `/**
 * GENERATED by \`scripts/gen-side-effect-floor.mjs\` — do not edit by hand.
 * Regenerate after changing any pack manifest; \`--check\` runs in CI.
 *
 * replay.md requirement 4's floor, DERIVED from the pack manifests: every node
 * declaring \`role: "side-effect"\` or the \`side-effectful\` capability.
 *
 * TWO SETS, AND ONLY ONE OF THEM IS PROTECTION.
 *
 * \`MANIFEST_SIDE_EFFECT_FLOOR\` is MEMBERSHIP — the nodes requirement 4 binds.
 * Membership is not a discharge and citing it as coverage is the error P1's
 * header was written to prevent.
 *
 * \`MANIFEST_FAST_PATH_SERVED\` is the subset \`isSideEffectingNode\` consults
 * (ADR 0572 P3). A typeId here is short-circuited on a replay fork and served
 * the SOURCE run's recorded outcome for \`(sourceRunId, nodeId, attempt)\`, or
 * failed closed with \`replay_source_missing\` — requirement 2, discharged.
 *
 * WHAT IS SUBTRACTED, AND WHY EACH SUBTRACTION IS NOT AN EXEMPTION. \`executor.ts\`
 * runs \`replayServed ?? await module.execute(ctx)\`, so a classified typeId is
 * NEVER EXECUTED on a replay. That is correct for a node whose effect is the
 * execution, and wrong for a node whose discharge is the ADR 0326 invocation
 * log — it runs live and the log serves the provider call underneath it, which
 * is what keeps RFC 0041 §B divergence injection alive. So anything reaching a
 * host AI capability is held back, as is any role whose fast-path semantics ADR
 * 0572 records as unresolved (\`gate\`, \`streaming-output\`), as is anything the
 * build cannot read. Held back means UNDISCHARGED and counted by the served-set
 * ratchet under \`docs/steward/\` — never exempt. (The census file is named in
 * ADR 0572, not here: a build-only invariant forbids \`src/\` from referencing
 * it, and that guard matches the filename in ANY spelling, comments included.)
 *
 * Manifest census at generation time (${nodes.size} distinct typeIds):
${census}
 *
 * Floor ${floor.length} = served ${served.length} + held ${Object.values(held).reduce((a, v) => a + v.length, 0)}:
${Object.entries(held).map(([k, v]) => ` *   ${String(v.length).padStart(4)}  held: ${k}`).join('\n')}
 */

/** Every manifest typeId in the floor: role \`side-effect\` UNION the
 *  \`side-effectful\` capability. The capability is the wider signal; binding
 *  both is the "classify additional, never fewer" direction requirement 4
 *  permits. */
export const MANIFEST_SIDE_EFFECT_FLOOR: ReadonlySet<string> = new Set([
${floor.map((t) => `  '${t}',`).join('\n')}
]);

/** The floor subset the ADR 0341 fast path SERVES on a replay fork — the set
 *  \`isSideEffectingNode\` unions (ADR 0572 P3). Derived, never hand-written:
 *  that is the whole point of requirement 4, which exists because the
 *  hand-maintained allowlist drifted twice on record (ADR 0563's
 *  \`core.storage.blob-put\`, ADR 0533's ten \`core.openwop.http.*\` senders).
 *
 *  A typeId ABSENT here is not "safe to re-execute" — it is "not yet served",
 *  and at runtime it still reaches an ADR 0531 seam and throws. */
export const MANIFEST_FAST_PATH_SERVED: ReadonlySet<string> = new Set([
${served.map((t) => `  '${t}',`).join('\n')}
]);

/** Every manifest typeId, floor or not — the denominator. A consumer that
 *  reports coverage without this cannot tell "all covered" from "nothing
 *  scanned". */
export const MANIFEST_DECLARED_TYPE_IDS: ReadonlySet<string> = new Set([
${all.map((t) => `  '${t}',`).join('\n')}
]);
`;
}

const check = process.argv.includes('--check');
const { nodes, conflicts, unclassified } = scan();

let failed = false;
if (unclassified.length > 0) {
  failed = true;
  console.error(`\n✗ ${unclassified.length} manifest node(s) declare no recognized role.`);
  console.error(`  A missing/unknown role is a build failure, never a default — an unclassified`);
  console.error(`  node must not reach a replay on the strength of nobody having decided.`);
  console.error(`  Valid roles: ${[...ROLES].join(', ')}\n`);
  for (const u of unclassified) console.error(`    ${u.typeId}  [${u.pack}]  role=${u.role}`);
}
if (conflicts.length > 0) {
  failed = true;
  console.error(`\n✗ ${conflicts.length} typeId(s) declared with conflicting roles across packs:`);
  for (const c of conflicts) console.error(`    ${c}`);
}
if (failed) process.exit(1);

const rendered = render(nodes);
const floorCount = (rendered.match(/^ {2}'/gm) ?? []).length;
if (floorCount === 0) {
  // The generator must never emit an empty snapshot and call it success.
  console.error('✗ generated an EMPTY floor — the scan found nothing; refusing to write.');
  process.exit(1);
}

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== rendered) {
    console.error('\n✗ sideEffectFloor.generated.ts is stale — a pack manifest changed.');
    console.error('  Run: node scripts/gen-side-effect-floor.mjs\n');
    process.exit(1);
  }
  console.log(`✓ side-effect floor snapshot current (${nodes.size} nodes scanned)`);
} else {
  writeFileSync(OUT, rendered);
  console.log(`✓ wrote ${OUT} (${nodes.size} nodes scanned)`);
}
