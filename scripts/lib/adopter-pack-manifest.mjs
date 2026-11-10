/**
 * ADR 1048 — the ADOPTER half of pack attestation: `packs/.adopter-manifest.json`.
 *
 * A white-label adopter (KickTodo, Book AI, …) ships its own packs beside
 * upstream's. Before ADR 1048 the only way to make one dispatch was to edit
 * upstream's `packs/.steward-manifest.json` (a merge tax on every sync) and the
 * only way to floor its side-effect nodes was to edit
 * `executor/sideEffectFloor.generated.ts` (which nobody did — Book AI's 16
 * nodes were unfloored). This file is the adopter-owned replacement for both:
 *
 *   trust   one content digest per adopter pack, the SAME rule as the steward
 *           manifest (`pack-content-digest.mjs`), read at runtime from the SAME
 *           code-anchored `packs/` directory (`host/packTrust.ts`). It yields
 *           the `adopter` tier, evaluated AFTER the steward check.
 *   floor   the adopter's half of the replay.md req 4 floor (`declared`,
 *           `served`, `held`), computed by the shared
 *           `side-effect-floor.mjs` over the attested bytes.
 *   mount   a keyed directory is dev-mounted whatever its prefix, so an adopter
 *           no longer needs `OPENWOP_LOCAL_PACK_PREFIXES` or a hard-coded
 *           prefix row in `mountLocalPacks.ts`.
 *
 * TWO IMPLEMENTATIONS OF THE VALIDATION RULES, PINNED BY A PARITY TEST — the
 * same arrangement as `pack-content-digest.mjs`: the generator runs before the
 * backend build and the Cloud Run image carries no `scripts/lib/`, so the
 * runtime twin is `backend/typescript/src/host/adopterPackManifest.ts`.
 * `test/adr1048-adopter-manifest-parity.test.ts` feeds both the same fixtures.
 * Edit one, edit both.
 *
 * ANY VIOLATION REJECTS THE WHOLE FILE. A manifest that is wrong in one entry
 * is not evidence about the others; partial acceptance is how a shadowing
 * entry would ride in beside honest ones.
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listPackEntries, packContentDigest } from './pack-content-digest.mjs';
import { buildImplIndex } from './packNodeReach.mjs';
import { deriveServedSet, floorOf, scanPackManifests } from './side-effect-floor.mjs';

export const ADOPTER_MANIFEST_FILE = '.adopter-manifest.json';
export const STEWARD_MANIFEST_FILE = '.steward-manifest.json';
/** The protocol's own namespaces. No adopter pack may live under them. */
export const RESERVED_PREFIXES = Object.freeze(['core.openwop.', 'community.openwop.']);
/** Vendor namespaces upstream itself publishes under. An adopter picks its own. */
export const UPSTREAM_VENDOR_PREFIXES = Object.freeze(['vendor.openwop-app.', 'vendor.openwop.', 'vendor.myndhyve.']);
/**
 * ADR 1048 D7 — the ONLY adopter pack ids exempt from `vendor.<adopter>.*`.
 * KickTodo's two packs were first-party under these ids until ADR 1031 P3, and
 * replay pins, typeIds and stored agent ids key on them (ADR 1031 invariant 1),
 * so renaming would break every recorded run. Explicit ids, never a prefix.
 */
export const GRANDFATHERED_ADOPTER_PACK_IDS = Object.freeze(['feature.kicktodo.nodes', 'vendor.openwop-app.kicktodo.agents']);
/** `vendor.<adopter>.<pack…>` — lower-case, dot-separated. */
export const ADOPTER_NAMESPACE = /^vendor\.[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9.-]*$/;
/** ADR 1048 D3 — the replay classes an adopter may DECLARE for its own nodes. */
export const REPLAY_CLASSES = Object.freeze(['served', 'ai-invocation-log', 'pure']);
export const HELD_BUCKETS = Object.freeze(['ai-invocation-log', 'ai-opaque-not-logged', 'deferred-role-semantics', 'declared-pure']);

const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The validation rules, as `[{ code, detail }]` (empty ⇒ valid). Codes are
 * stable: the TS twin returns the same ones for the same input.
 *
 *   ctx.stewardKeys       Set of steward-manifest keys
 *   ctx.pins              Record<pack, version> from `src/adopter/packPins.ts`, or null
 *   ctx.upstreamDeclared  Set of upstream typeIds (MANIFEST_DECLARED_TYPE_IDS)
 *   ctx.packNameOf        (dir) => the `name` in `packs/<dir>/pack.json`, or null
 */
export function validateAdopterManifest(m, ctx) {
  const v = [];
  const add = (code, detail) => v.push({ code, detail });
  if (!isPlainObject(m) || m.version !== 1 || !isPlainObject(m.packs)) {
    add('shape', 'expected { version: 1, packs: { … } }');
    return v;
  }
  const pins = ctx.pins ?? {};
  for (const [key, e] of Object.entries(m.packs)) {
    if (!isPlainObject(e) || typeof e.digest !== 'string' || typeof e.files !== 'number'
      || !(typeof e.version === 'string' || e.version === null)
      || !isStringArray(e.declared) || !isStringArray(e.served)
      || !isPlainObject(e.held) || !Object.values(e.held).every(isStringArray)
      || (e.servedUnresolved !== undefined && !isStringArray(e.servedUnresolved))
      || (e.replayClass !== undefined && !isPlainObject(e.replayClass))) {
      add('shape', `${key}: entry is not { version, files, digest, declared[], served[], held{}, servedUnresolved[]?, replayClass{}? }`);
      continue;
    }
    if (ctx.stewardKeys.has(key)) add('shadows_steward', `${key} is a steward-manifest key`);
    if (RESERVED_PREFIXES.some((p) => key.startsWith(p))) add('reserved_prefix', `${key} uses a protocol namespace`);
    else if (!GRANDFATHERED_ADOPTER_PACK_IDS.includes(key)
      && (!ADOPTER_NAMESPACE.test(key) || UPSTREAM_VENDOR_PREFIXES.some((p) => key.startsWith(p)))) {
      add('namespace', `${key} is not vendor.<adopter>.* (and is not a grandfathered id)`);
    }
    const name = ctx.packNameOf(key);
    if (name !== key) add('name_dir_mismatch', `packs/${key}/pack.json name is ${name === null ? '(unreadable)' : `'${name}'`}`);
    if (!Object.hasOwn(pins, key)) add('pin_missing', `${key} has no ADOPTER_PACK_PINS entry`);
    else if (pins[key] !== e.version) add('pin_version', `${key}: manifest ${e.version} ≠ pin ${pins[key]}`);
    const declared = new Set(e.declared);
    for (const t of e.declared) {
      if (ctx.upstreamDeclared.has(t)) add('typeid_upstream', `${key}: ${t} is an upstream typeId`);
      if (!t.startsWith(`${key}.`)) add('typeid_namespace', `${key}: ${t} is outside the pack's own namespace`);
    }
    for (const t of [...e.served, ...Object.values(e.held).flat(), ...(e.servedUnresolved ?? [])]) {
      if (!declared.has(t)) add('floor_not_declared', `${key}: ${t} is in the floor half but not declared`);
    }
    for (const [t, cls] of Object.entries(e.replayClass ?? {})) {
      if (t.includes('*') || !declared.has(t)) add('replay_class', `${key}: replayClass names '${t}', which is not one of this pack's own declared typeIds`);
      if (!REPLAY_CLASSES.includes(cls)) add('replay_class', `${key}: ${t} declares '${cls}' (allowed: ${REPLAY_CLASSES.join(', ')})`);
    }
  }
  for (const key of Object.keys(pins)) {
    if (!Object.hasOwn(m.packs, key)) add('pin_unattested', `ADOPTER_PACK_PINS pins ${key}, which the manifest does not attest`);
  }
  return v;
}

// ── reading the tree ────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The committed adopter manifest: `null` when absent; throws when unparseable. */
export function readAdopterManifest(root) {
  const file = join(root, 'packs', ADOPTER_MANIFEST_FILE);
  if (!existsSync(file)) return null;
  try {
    return readJson(file);
  } catch (err) {
    throw new Error(`packs/${ADOPTER_MANIFEST_FILE} is unparseable: ${err.message}`);
  }
}

/** Directories the committed adopter manifest claims. Empty when absent OR
 *  unparseable — callers that must fail on unparseable use `readAdopterManifest`. */
export function adopterClaimedDirs(root) {
  try {
    const m = readAdopterManifest(root);
    return new Set(m && isPlainObject(m.packs) ? Object.keys(m.packs) : []);
  } catch {
    return new Set();
  }
}

export function readStewardKeys(root) {
  const file = join(root, 'packs', STEWARD_MANIFEST_FILE);
  if (!existsSync(file)) return new Set();
  try {
    return new Set(Object.keys(readJson(file).packs ?? {}));
  } catch {
    return new Set();
  }
}

export const ADOPTER_SRC_REL = 'backend/typescript/src/adopter';
export const ADOPTER_PINS_REL = `${ADOPTER_SRC_REL}/packPins.ts`;

/**
 * `ADOPTER_PACK_PINS` as data, read from `src/adopter/packPins.ts` — the file
 * ADR 1031 P1's `gen-adopter-features.mjs` re-exports at runtime. Only string
 * literal `'name': 'version'` pairs inside the object literal are read; `null`
 * when the file is absent. (The runtime twin reads the compiled value, so a
 * pin this parse cannot see is a pin/manifest MISMATCH at boot, not a silent pass.)
 */
export function readAdopterPins(root) {
  const file = join(root, ADOPTER_PINS_REL);
  if (!existsSync(file)) return null;
  const src = readFileSync(file, 'utf8');
  const at = src.search(/ADOPTER_PACK_PINS\b[^=]*=\s*\{/);
  if (at < 0) throw new Error(`${ADOPTER_PINS_REL} does not declare ADOPTER_PACK_PINS = { … }`);
  const open = src.indexOf('{', src.indexOf('=', at));
  const close = src.indexOf('}', open);
  const pins = {};
  for (const p of src.slice(open, close).matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g)) pins[p[1]] = p[2];
  return pins;
}

/** Real, loadable pack directories under `packs/` (never dot-dirs, parked
 *  `.registry-<v>` shadows, symlinks, or dirs without a pack.json). */
export function packDirNames(root) {
  const packs = join(root, 'packs');
  if (!existsSync(packs)) return [];
  return readdirSync(packs).sort().filter((name) => {
    if (name.startsWith('.') || /\.registry-[0-9]/.test(name)) return false;
    try {
      const st = lstatSync(join(packs, name));
      if (!st.isDirectory() || st.isSymbolicLink()) return false;
    } catch {
      return false;
    }
    return existsSync(join(packs, name, 'pack.json'));
  });
}

function packNameOf(root) {
  return (dir) => {
    try {
      const name = readJson(join(root, 'packs', dir, 'pack.json')).name;
      return typeof name === 'string' ? name : null;
    } catch {
      return null;
    }
  };
}

// ── building ────────────────────────────────────────────────────────────────

/**
 * Build the adopter manifest for `root`: every pack directory NOT keyed in the
 * committed steward manifest. Throws (never writes a partial file) when:
 *  - `backend/typescript/src/adopter/` is absent — the flag is INERT upstream,
 *    so a new first-party pack can never be mis-claimed as an adopter pack;
 *  - any adopter node has a missing/unknown role, or any typeId conflicts;
 *  - the result breaks any validation rule.
 *
 * The floor half, per pack:
 *   served           floor nodes the reach analysis serves (as upstream), PLUS
 *   servedUnresolved floor nodes it could not read — SERVED, not held. Upstream
 *                    holds those and relies on the ADR 0531 backstop; an
 *                    adopter has no steward reviewing its residue, so the
 *                    unreadable fail CLOSED here (ADR 1048 D5).
 *   held             ai-invocation-log / ai-opaque-not-logged /
 *                    deferred-role-semantics (as upstream), plus declared-pure.
 *   replayClass      hand-declared, carried forward from the committed file
 *                    and applied last: `served` serves, `ai-invocation-log`
 *                    holds live (the provider call replays from the log),
 *                    `pure` holds live (re-run). Per typeId, never a wildcard.
 */
export function buildAdopterManifest(root) {
  if (!existsSync(join(root, ADOPTER_SRC_REL))) {
    throw new Error(`--adopter is inert here: ${ADOPTER_SRC_REL}/ does not exist (only an adopter tree claims adopter packs)`);
  }
  const stewardKeys = readStewardKeys(root);
  const committed = readAdopterManifest(root);
  const dirs = packDirNames(root).filter((d) => !stewardKeys.has(d));
  const all = scanPackManifests(root);
  const problems = [];
  for (const u of all.unclassified) if (dirs.includes(u.pack)) problems.push(`${u.typeId} [${u.pack}] declares no recognized role (${u.role})`);
  for (const c of all.conflicts) problems.push(`conflicting roles: ${c}`);
  if (problems.length) throw new Error(`cannot build the adopter manifest:\n    ${problems.join('\n    ')}`);

  const impl = dirs.length ? buildImplIndex(root) : null;
  const packs = {};
  for (const dir of dirs) {
    const packDir = join(root, 'packs', dir);
    const nodes = new Map([...all.nodes].filter(([, v]) => v.pack === dir));
    const floor = floorOf(nodes);
    const { served, held } = floor.length ? deriveServedSet(root, nodes, floor, { impl, allowEmpty: true }) : { served: [], held: { 'ai-invocation-log': [], 'ai-opaque-not-logged': [], 'deferred-role-semantics': [], unresolved: [] } };
    const servedUnresolved = [...held.unresolved].sort();
    const out = {
      served: new Set([...served, ...servedUnresolved]),
      held: { 'ai-invocation-log': new Set(held['ai-invocation-log']), 'ai-opaque-not-logged': new Set(held['ai-opaque-not-logged']), 'deferred-role-semantics': new Set(held['deferred-role-semantics']), 'declared-pure': new Set() },
    };
    const replayClass = { ...(isPlainObject(committed?.packs?.[dir]?.replayClass) ? committed.packs[dir].replayClass : {}) };
    for (const [t, cls] of Object.entries(replayClass)) {
      out.served.delete(t);
      for (const b of Object.values(out.held)) b.delete(t);
      if (cls === 'served') out.served.add(t);
      else if (cls === 'ai-invocation-log' && floor.includes(t)) out.held['ai-invocation-log'].add(t);
      else if (cls === 'pure' && floor.includes(t)) out.held['declared-pure'].add(t);
    }
    const sorted = (s) => [...s].sort();
    let version = null;
    try { const v = readJson(join(packDir, 'pack.json')).version; version = typeof v === 'string' ? v : null; } catch { /* name check reports it */ }
    packs[dir] = {
      version,
      files: listPackEntries(packDir).length,
      digest: packContentDigest(packDir),
      declared: sorted(nodes.keys()),
      served: sorted(out.served),
      held: Object.fromEntries(HELD_BUCKETS.map((b) => [b, sorted(out.held[b])])),
      servedUnresolved: servedUnresolved.filter((t) => out.served.has(t)),
      ...(Object.keys(replayClass).length ? { replayClass: Object.fromEntries(Object.entries(replayClass).sort(([a], [b]) => a.localeCompare(b))) } : {}),
    };
  }
  const manifest = { version: 1, packs };
  const upstreamDeclared = new Set([...all.nodes].filter(([, v]) => !dirs.includes(v.pack)).map(([t]) => t));
  const violations = validateAdopterManifest(manifest, { stewardKeys, pins: readAdopterPins(root), upstreamDeclared, packNameOf: packNameOf(root) });
  if (violations.length) {
    throw new Error(`the adopter manifest would be REJECTED (ADR 1048 D3 — any violation rejects the whole file):\n    ${violations.map((x) => `[${x.code}] ${x.detail}`).join('\n    ')}`);
  }
  return manifest;
}

/** Validate the COMMITTED adopter manifest against the tree (the `--check` rules). */
export function checkCommittedAdopterManifest(root, committed) {
  const stewardKeys = readStewardKeys(root);
  const claimed = new Set(Object.keys(isPlainObject(committed?.packs) ? committed.packs : {}));
  const all = scanPackManifests(root);
  const upstreamDeclared = new Set([...all.nodes].filter(([, v]) => !claimed.has(v.pack)).map(([t]) => t));
  return validateAdopterManifest(committed, { stewardKeys, pins: readAdopterPins(root), upstreamDeclared, packNameOf: packNameOf(root) });
}

export function serialiseManifest(m) {
  return `${JSON.stringify(m, null, 2)}\n`;
}

/** One line per pack for the census: counts by bucket, plus every declared class. */
export function adopterCensus(m) {
  const lines = [];
  for (const [key, e] of Object.entries(m?.packs ?? {})) {
    const held = Object.entries(e.held ?? {}).filter(([, v]) => v.length).map(([k, v]) => `${k} ${v.length}`).join(', ') || 'none';
    lines.push(`${key}@${e.version}: declared ${e.declared.length}, served ${e.served.length} (unresolved→served ${e.servedUnresolved?.length ?? 0}), held ${held}`);
    for (const [t, cls] of Object.entries(e.replayClass ?? {})) lines.push(`    declared replay class: ${t} = ${cls}`);
  }
  return lines;
}
