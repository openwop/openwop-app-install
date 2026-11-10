#!/usr/bin/env node
/**
 * gen-steward-manifest — the `steward` half of the ADR 0555 pack trust model.
 *
 * Writes `packs/.steward-manifest.json`: one content digest per vendored pack
 * directory. At runtime `host/packTrust.ts` classifies a pack `steward` iff its
 * bytes fold to the digest committed here.
 *
 *   node scripts/gen-steward-manifest.mjs            # regenerate
 *   node scripts/gen-steward-manifest.mjs --check    # CI gate, exit 1 on drift
 *   node scripts/gen-steward-manifest.mjs --adopter  # ADR 1048: an ADOPTER tree's
 *                                                    # packs/.adopter-manifest.json
 *
 * ── ADR 1048: TWO MANIFESTS, ONE PARTITION ────────────────────────────────
 *
 * In an adopter tree (a white-label downstream with `backend/typescript/src/adopter/`)
 * the adopter's own packs are attested by `packs/.adopter-manifest.json`, which
 * `--adopter` writes — never by this file, which stays upstream's. So:
 *
 *   - the plain run skips every directory the adopter manifest claims. Upstream
 *     has no adopter manifest, so its output is byte-identical to before;
 *   - `--adopter` claims every directory NOT in the committed steward manifest,
 *     and refuses outright when `src/adopter/` is absent (inert upstream);
 *   - `--check` checks both, and that every pack directory is keyed in exactly
 *     one of them. The adopter manifest's validation rules (no steward key, no
 *     protocol namespace, name = directory, keys and versions = ADOPTER_PACK_PINS)
 *     live in `scripts/lib/adopter-pack-manifest.mjs`.
 *
 * ── WHY A COMMITTED DIGEST AND NOT "IT IS IN THE PACKS DIR" ───────────────
 *
 * ADR 0555 defines `steward` as "shipped in the release artifact and covered by
 * its provenance", and separately forbids "an environment flag promoting an
 * unsigned pack to trusted". Deriving steward from the dev mount violates the
 * second rule outright, and worse than the rule anticipates: `mountLocalPacks`
 * is steered by TWO env vars — `OPENWOP_LOCAL_PACKS_DIR` (an arbitrary absolute
 * path) and `OPENWOP_LOCAL_PACK_PREFIXES` (a CSV that REPLACES the default
 * allowlist). Together they do not promote *a pack*; they redefine what the
 * steward corpus IS. `OPENWOP_LOCAL_PACKS_DIR=/tmp/x OPENWOP_LOCAL_PACK_PREFIXES=evil.`
 * would mint steward trust for anything on disk.
 *
 * A committed manifest closes that by construction: a directory nobody
 * committed a digest for is not steward, wherever it was mounted from.
 *
 * ── THE LIMITATION, STATED PLAINLY ────────────────────────────────────────
 *
 * This is attestation BY REPO, not by signature. Anyone who can land a commit
 * can add a pack and its digest in the same PR. That is the same trust boundary
 * as the source code itself, which is the right boundary for a tier named
 * `steward` — but it is strictly weaker than signing the vendored packs at
 * release time. Signing is the successor (ADR 0555, alternatives); it needs the
 * Ed25519 key reachable from Cloud Build, which `gcloud run deploy --source .`
 * does not provide today.
 *
 * ── DRIFT IS AN OUTAGE, WHICH IS WHY --check IS A CI GATE ─────────────────
 *
 * The runtime policy fails CLOSED. If a vendored pack changes and this manifest
 * is not regenerated, that pack stops being steward and stops dispatching. Ship
 * enough of those and the product is down. So `--check` runs in `scripts/ci.sh`
 * and is not optional — it is the tripwire, and its failure message says exactly
 * which packs drifted and how to fix it.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryModule } from './lib/entry-module.mjs';
import { listPackEntries, packContentDigest } from './lib/pack-content-digest.mjs';
import {
  ADOPTER_SRC_REL,
  adopterCensus,
  adopterClaimedDirs,
  buildAdopterManifest,
  checkCommittedAdopterManifest,
  readAdopterManifest,
  serialiseManifest,
} from './lib/adopter-pack-manifest.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKS_DIR = join(ROOT, 'packs');
const MANIFEST_PATH = join(PACKS_DIR, '.steward-manifest.json');

/** Shadow dirs preserved by `mountLocalPacks`' shadow pass are never loadable. */
function isParkedPackDirName(name) {
  return /\.registry-[0-9]/.test(name);
}

function readPackVersion(packDir) {
  try {
    const m = JSON.parse(readFileSync(join(packDir, 'pack.json'), 'utf-8'));
    return typeof m.version === 'string' ? m.version : null;
  } catch {
    return null;
  }
}

/** Every vendored pack directory, sorted, keyed by DIRECTORY NAME. */
export function buildManifest() {
  const packs = {};
  if (!existsSync(PACKS_DIR)) return { version: 1, packs };
  // ADR 1048 — an adopter-claimed directory is attested by the adopter manifest.
  const claimed = adopterClaimedDirs(ROOT);
  for (const name of readdirSync(PACKS_DIR).sort()) {
    if (name.startsWith('.')) continue;
    if (claimed.has(name)) continue;
    if (isParkedPackDirName(name)) continue;
    const packDir = join(PACKS_DIR, name);
    let st;
    try {
      st = lstatSync(packDir);
    } catch {
      continue;
    }
    // Vendored packs are REAL directories. A symlink in the repo `packs/` tree
    // would point outside the release artifact, so it cannot be steward.
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if (!existsSync(join(packDir, 'pack.json'))) continue;
    packs[name] = {
      version: readPackVersion(packDir),
      files: listPackEntries(packDir).length,
      digest: packContentDigest(packDir),
    };
  }
  return { version: 1, packs };
}

function readCommitted() {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function serialise(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const ADOPTER_MANIFEST_PATH = join(PACKS_DIR, '.adopter-manifest.json');

/** ADR 1048 — write `packs/.adopter-manifest.json` (never touches the steward file). */
function writeAdopter() {
  let built;
  try {
    built = buildAdopterManifest(ROOT);
  } catch (err) {
    console.error(`\n✗ gen-steward-manifest --adopter: ${err.message}\n`);
    return 1;
  }
  writeFileSync(ADOPTER_MANIFEST_PATH, serialiseManifest(built));
  console.log(`✓ gen-steward-manifest --adopter: wrote ${Object.keys(built.packs).length} adopter pack digests to packs/.adopter-manifest.json`);
  for (const line of adopterCensus(built)) console.log(`    ${line}`);
  return 0;
}

/** ADR 1048 — `--check` for the adopter half. Returns the number of failures. */
function checkAdopter() {
  let committed;
  try {
    committed = readAdopterManifest(ROOT);
  } catch (err) {
    console.error(`\n✗ gen-steward-manifest --check: ${err.message}`);
    console.error('  The runtime REJECTS an unparseable adopter manifest: no adopter pack would dispatch.\n');
    return 1;
  }
  if (committed === null) return 0;
  const violations = checkCommittedAdopterManifest(ROOT, committed);
  if (violations.length) {
    console.error('\n✗ gen-steward-manifest --check: packs/.adopter-manifest.json would be REJECTED at boot (ADR 1048 D3):\n');
    for (const x of violations) console.error(`    [${x.code}] ${x.detail}`);
    console.error('\n  Any violation rejects the WHOLE file and no adopter pack dispatches. Fix the cause, then:');
    console.error('\n      node scripts/gen-steward-manifest.mjs --adopter\n');
    return 1;
  }
  let built;
  try {
    built = buildAdopterManifest(ROOT);
  } catch (err) {
    console.error(`\n✗ gen-steward-manifest --check: ${err.message}\n`);
    return 1;
  }
  if (serialiseManifest(built) !== serialiseManifest(committed)) {
    console.error('\n✗ gen-steward-manifest --check: packs/.adopter-manifest.json is stale.\n');
    const names = new Set([...Object.keys(built.packs), ...Object.keys(committed.packs ?? {})]);
    for (const name of [...names].sort()) {
      const a = committed.packs?.[name];
      const b = built.packs[name];
      if (!a) console.error(`    + ${name} — adopter pack not attested (would be UNTRUSTED, cannot dispatch)`);
      else if (!b) console.error(`    - ${name} — attested but no longer an adopter pack directory`);
      else if (a.digest !== b.digest) console.error(`    ~ ${name} — content changed (${a.version} → ${b.version})`);
      else if (JSON.stringify(a) !== JSON.stringify(b)) console.error(`    ~ ${name} — floor half changed (a node moved between served and held, or was added)`);
    }
    console.error('\n  The adopter manifest IS the census: every added pack or node, and every move between');
    console.error('  served and held, lands as a reviewed diff. Regenerate and commit:');
    console.error('\n      node scripts/gen-steward-manifest.mjs --adopter\n');
    return 1;
  }
  console.log(`✓ gen-steward-manifest: ${Object.keys(built.packs).length} adopter packs, all digests and floor halves current`);
  return 0;
}

function main() {
  if (process.argv.includes('--adopter')) return writeAdopter();
  const check = process.argv.includes('--check');
  const built = buildManifest();
  const packCount = Object.keys(built.packs).length;

  if (!check) {
    writeFileSync(MANIFEST_PATH, serialise(built));
    console.log(`✓ gen-steward-manifest: wrote ${packCount} pack digests to packs/.steward-manifest.json`);
    return 0;
  }

  const committed = readCommitted();
  if (!committed) {
    console.error('\n✗ gen-steward-manifest --check: packs/.steward-manifest.json is missing or unparseable.');
    console.error('\n  Every vendored pack would classify `untrusted` and STOP DISPATCHING (ADR 0555 P0');
    console.error('  fails closed). Regenerate with:  node scripts/gen-steward-manifest.mjs\n');
    return 1;
  }

  const added = [];
  const removed = [];
  const changed = [];
  for (const [name, entry] of Object.entries(built.packs)) {
    const prev = committed.packs?.[name];
    if (!prev) added.push(name);
    else if (prev.digest !== entry.digest) changed.push({ name, prev, next: entry });
  }
  for (const name of Object.keys(committed.packs ?? {})) {
    if (!built.packs[name]) removed.push(name);
  }

  // ADR 1048 — every pack directory is keyed in exactly one manifest.
  const adopterFailures = checkAdopter();
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    if (adopterFailures) return 1;
    console.log(`✓ gen-steward-manifest: ${packCount} vendored packs, all digests current`);
    return 0;
  }

  console.error('\n✗ gen-steward-manifest --check: packs/.steward-manifest.json is stale.\n');
  for (const name of added) console.error(`    + ${name} — vendored but not attested (would be UNTRUSTED, cannot dispatch)`);
  for (const name of removed) console.error(`    - ${name} — attested but no longer vendored (stale entry)`);
  for (const { name, prev, next } of changed) {
    const vsn = prev.version === next.version ? next.version : `${prev.version} → ${next.version}`;
    const files = prev.files === next.files ? `${next.files} files` : `${prev.files} → ${next.files} files`;
    console.error(`    ~ ${name} — content changed (${vsn}, ${files}); would be UNTRUSTED`);
    console.error(`        which files:  git status --short packs/${name}`);
  }
  console.error('\n  ADR 0555 P0 fails CLOSED: an unattested pack does not dispatch. If these');
  console.error('  changes are intended, regenerate and commit the manifest:');
  console.error('\n      node scripts/gen-steward-manifest.mjs\n');
  if (added.length && existsSync(join(ROOT, ADOPTER_SRC_REL))) {
    console.error('  This is an ADOPTER tree. If the `+` packs are the adopter\'s own, attest them in');
    console.error('  packs/.adopter-manifest.json instead (ADR 1048) — never edit the steward manifest:');
    console.error('\n      node scripts/gen-steward-manifest.mjs --adopter\n');
  }
  return 1;
}

if (isEntryModule(import.meta.url)) {
  process.exit(main());
}
