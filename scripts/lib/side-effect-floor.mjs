/**
 * replay.md requirement 4 — the manifest scan and the served-set derivation,
 * shared by the two generators that emit a floor (ADR 1048 D4):
 *
 *   scripts/gen-side-effect-floor.mjs            upstream's half, written to
 *                                                `executor/sideEffectFloor.generated.ts`
 *   scripts/gen-steward-manifest.mjs --adopter   an adopter's half, carried in
 *                                                `packs/.adopter-manifest.json`
 *
 * Moved here unchanged from `gen-side-effect-floor.mjs` (whose header still
 * carries the reasoning). One copy, because two copies of "which floor nodes
 * are served" drifting apart is how a replay re-fires.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildImplIndex, classifyNodeReach, DEFERRED_SEMANTICS_ROLES } from './packNodeReach.mjs';

/** The closed role taxonomy (ADR 0473 P2). Anything outside it is a failure,
 *  not an unknown to be tolerated. */
export const ROLES = new Set(['pure', 'read', 'gate', 'action', 'side-effect', 'streaming-output']);
export const SIDE_EFFECT_CAPABILITY = 'side-effectful';

/**
 * Every `packs/<dir>/pack.json` node, keyed by typeId: `{ pack, role, caps }`.
 * Role conflicts and unclassified nodes are collected over EVERY pack scanned —
 * an adopter typeId that collides with an upstream one is a conflict like any
 * other. `excludeDirs` drops directories entirely (nothing from them is read).
 */
export function scanPackManifests(root, { excludeDirs = new Set() } = {}) {
  const packs = join(root, 'packs');
  if (!existsSync(packs)) throw new Error(`no packs dir at ${packs}`);
  const nodes = new Map();
  const conflicts = [];
  const unclassified = [];
  for (const dir of readdirSync(packs).sort()) {
    if (excludeDirs.has(dir)) continue;
    const manifest = join(packs, dir, 'pack.json');
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

/** The floor: role `side-effect` UNION the `side-effectful` capability, sorted. */
export function floorOf(nodes) {
  return [...nodes]
    .filter(([, v]) => v.role === 'side-effect' || v.caps.includes(SIDE_EFFECT_CAPABILITY))
    .map(([typeId]) => typeId)
    .sort();
}

/**
 * ADR 0572 P3 — the subset of the floor the ADR 0341 fast path SERVES.
 *
 * Returns `{ served, held: { … } }`. Everything not in `served` is held back
 * WITH ITS REASON, so the caller can report why rather than emitting a number.
 * `impl` may be passed in so one index serves several calls.
 */
export function deriveServedSet(root, nodes, floor, { impl = buildImplIndex(root), allowEmpty = false } = {}) {
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
  // (An adopter pack may legitimately serve nothing — e.g. an agents-only pack —
  // so its caller passes `allowEmpty`.)
  if (!allowEmpty && served.length === 0) throw new Error('derived an EMPTY fast-path served set from a non-empty floor — refusing to write a classifier union that classifies nothing');
  return { served: served.sort(), held };
}
