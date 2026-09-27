#!/usr/bin/env node
// check-vendored-fixtures — parity guard for the vendored `conformance-fixtures/`
// tree (ADR 0550, H48).
//
// ## Why this exists
//
// `conformance-fixtures/` and the pinned `@openwop/openwop-conformance` package
// are TWO INDEPENDENT INPUTS to the same behaviour:
//
//   - `scripts/sync-fixtures.sh` fills the vendored dir from the CORPUS
//     (`../openwop`, read at the `--tag` it is given), never from `node_modules`.
//   - `backend/typescript/package.json` pins the suite package separately.
//   - The HOST reads only the vendored dir (`src/host/index.ts` loads every
//     top-level `*.json` as a black-box workflow and advertises the ids via
//     `capabilities.fixtures`); the SUITE reads only its own package copy.
//
// So the two can disagree while every version string reads the same number.
// H47 (#3315) hit exactly that: bumping the pin to ^1.136.0 while the vendored
// copies of two roundtrip fixtures still carried the pre-rename node spellings
// would have restored an advertise-and-spuriously-fail breakage that looked
// fixed. H47 pinned the two fixtures it touched with a byte test and recorded
// the rest of the tree as unguarded residue. This is that guard.
//
// ## The invariant (ADR 0550 addendum, option (b))
//
//   vendored ⊇ pinned, byte-for-byte on the intersection, and every vendored
//   path NOT in the pinned package is named in HOST_AUTHORED below.
//
// Option (a) — split the tree so vendored == pinned exactly, host-authored
// content moved to a sibling dir — was weighed and REJECTED. Three grounds,
// recorded in ADR 0550 § "Vendored conformance-fixtures parity (H48)":
//
//   1. `scripts/sync-packs.sh` already answered this identical question for
//      `packs/` (one dir mixing canonical `core.openwop.*`/`vendor.*` with
//      repo-owned `feature.*`/`community.*`) by keeping ONE dir and making the
//      sync family-scoped. Splitting here would give the repo two contradictory
//      policies for one question.
//   2. The wire BLESSES a mixed advert: `schemas/capabilities.schema.json`
//      §fixtures says "Hosts MAY advertise vendor-prefixed IDs; clients MUST
//      tolerate unknown IDs", and the suite ships `OPENWOP_OPTED_OUT_FIXTURES`
//      documented for precisely "the host auto-loads every `conformance-*.json`
//      on disk". Moving the host-authored fixtures out of the loaded dir would
//      make the host STOP advertising fixtures it can genuinely run.
//   3. The deploy bundle's contents are asserted by HARDCODED path lists
//      (`scripts/build-whitelabel-zip.sh`, the `cut-app-release` skill). A
//      sibling dir nobody adds to them ships an image missing `form-content/` —
//      red in the release lane only.
//
// ## Scope: the WHOLE tree, compared against the PINNED PACKAGE
//
// `check-vendored-schemas.mjs` deliberately guards only a load-bearing SUBSET,
// because it diffs against corpus `main` and guarding all ~57 would force a
// re-vendor PR on every unrelated upstream schema edit. **That objection does
// not transfer here**: this guard diffs against the PIN, so drift can only
// appear when someone bumps the pin — and at that moment being forced to
// re-vendor is the entire point, not churn. Hence the whole tree, including
// `connection-packs/` and `trigger-events/`, which no in-repo reader names and
// which were missing PRECISELY BECAUSE nothing named them.
//
// Run from the repo root: `node scripts/check-vendored-fixtures.mjs`
//   --list-host-authored   print the allowlist, one path per line (this is how
//                          `scripts/sync-fixtures.sh` learns what to preserve —
//                          ONE source of truth, not two copies that drift).

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED = join(ROOT, 'conformance-fixtures');

/**
 * Paths under `conformance-fixtures/` that this REPO owns — they exist in no
 * released corpus and must survive a `sync-fixtures.sh` run.
 *
 * A trailing `/` marks a directory prefix; everything under it is covered.
 *
 * Each entry states WHO WROTE IT and WHO READS IT. An entry without a reader is
 * dead weight the next cleanup should delete, and an entry that later appears
 * in the pinned package is a lie this guard fails on (see STALE below) — the
 * corpus having adopted the file means the allowlist must drop it.
 */
export const HOST_AUTHORED = [
  // ADR 0533 / RFC 0140 replay side-effect suppression. HOST-AUTHORED despite
  // ADR 0533's implementation record calling them "verbatim from the corpus" —
  // `git log --all --diff-filter=A -- 'conformance/fixtures/conformance-replay-effect*.json'`
  // in `openwop/openwop` returns NOTHING; no file by either name has ever
  // existed there. (The corpus's own RFC 0140 fixture is
  // `conformance-replay-side-effect.json`, which IS vendored and IS canonical.)
  // See the ADR 0533 correction note.
  //
  // REFERENCED BY: `backend/typescript/conformance/witness-boot-rfc0140.ts`,
  // whose comment justifies leaving `OPENWOP_ENABLE_CONFORMANCE_NODES` at its
  // default by naming them. They are ALSO the only in-tree exercise of
  // `conformance.effect.emit` — the node ADR 0533 registered + classified and
  // ADR 0572's side-effect floor names — so deleting them orphans that node
  // rather than merely removing two JSON files.
  //
  // NOT executed by any scenario: the corpus never names these ids
  // (`git grep conformance-replay-effect origin/main -- conformance/` is empty)
  // and the RFC 0140 scenario drives `conformance-replay-side-effect` instead.
  // H48 evaluated deleting them on that basis and KEPT them for the cascade
  // above; the dishonest-advert concern that motivated the question is fixed at
  // its root instead — `fixtureNeedsConformanceNodes` now covers the bare
  // `conformance.` prefix, so both are advertised only when their node is
  // actually registered. See the ADR 0533 correction.
  'conformance-replay-effect.json',
  'conformance-replay-effect-unreached.json',
  // RFC 0137 §Instantiation form-content witness (#2976). The CORPUS ships the
  // RFC, `spec/v1/form-content-packs.md`, the manifest schema and two scenarios
  // — and ZERO fixtures; a host must supply its own template pack for
  // `form-content-instantiation` to instantiate anything.
  //
  // Read by: `conformance/run.ts` and `test/form-content-seam.test.ts` via
  // `OPENWOP_FORM_CONTENT_CONFORMANCE_FIXTURES`, through the real
  // `formContentPackLoader`. Deleting this dir turns both RFC 0137
  // instantiation legs red under `OPENWOP_REQUIRE_BEHAVIOR`.
  'form-content/',
];

/** `true` when `rel` is the allowlist entry itself or lives under an allowlisted dir. */
function isHostAuthored(rel) {
  return HOST_AUTHORED.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));
}

if (process.argv.includes('--list-host-authored')) {
  for (const a of HOST_AUTHORED) console.log(a);
  process.exit(0);
}

/** Every file under `dir`, as `/`-joined paths relative to it. Sorted, stable. */
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, base, out);
    else out.push(relative(base, abs).split(sep).join('/'));
  }
  return out;
}

// ── Resolve the PINNED package's fixture dir ────────────────────────────────
// Resolved from `backend/typescript` (where the devDependency is declared),
// not from this script's own location.
const req = createRequire(join(ROOT, 'backend', 'typescript', 'package.json'));
let pinnedDir;
let pinnedVersion = 'unknown';
try {
  const pkgJson = req.resolve('@openwop/openwop-conformance/package.json');
  pinnedDir = join(dirname(pkgJson), 'fixtures');
  pinnedVersion = JSON.parse(readFileSync(pkgJson, 'utf8')).version ?? 'unknown';
} catch {
  pinnedDir = null;
}

if (!pinnedDir || !existsSync(pinnedDir)) {
  // A production image runs `npm ci --omit=dev` and has no conformance package.
  // Refusing to run there would make this guard un-runnable in exactly the
  // context where it is irrelevant. SKIP loudly rather than fail or lie.
  console.warn(
    'check-vendored-fixtures: SKIPPED — @openwop/openwop-conformance is not installed ' +
      '(normal for `npm ci --omit=dev`). Run `npm ci` in backend/typescript to verify.',
  );
  process.exit(0);
}

// ── The remedy, spelled with the tag the pin names ──────────────────────────
// `sync-fixtures.sh` REQUIRES `--tag` (2026-09-23) and reads the fixtures out of
// that tag, so every remediation line here must name one — and the only tag that
// satisfies THIS guard is the one carrying the installed suite version. A bare
// `sync-fixtures.sh` used to be printed instead; against a corpus clone ahead of
// the pin it vendored the wrong release and failed this guard for the opposite
// reason, which is how an adopter found it.
const pinnedTag = `openwop-conformance/v${pinnedVersion}`;
const SYNC_CMD = `bash scripts/sync-fixtures.sh --tag ${pinnedTag}`;

if (!existsSync(VENDORED)) {
  console.error('check-vendored-fixtures: conformance-fixtures/ is ABSENT — the Docker image and the');
  console.error(`  white-label bundle both COPY it, and src/host/index.ts loads it. Run \`${SYNC_CMD}\`.`);
  process.exit(1);
}

// ── Optional third input: the local corpus, for the which-side-is-stale call ──
// `sync-fixtures.sh` pulls from the CORPUS while this guard asserts against the
// PIN. When they disagree the remedy is the opposite of the usual one, so the
// diagnosis has to distinguish the cases rather than always saying "re-vendor".
//
// READ AT THE TAG, not from the working tree, when the clone has it — the same
// rule `check-vendored-schemas.mjs` applies via `git show <CORPUS_TAG>:<path>`,
// and the same rule the copying side now applies. A diagnosis computed against
// whatever HEAD the sibling clone is on describes a tree the sync will never
// copy: with the clone one release ahead, every `side()` verdict below named the
// wrong stale side. The working tree remains the fallback, labelled as such.
const corpusDir = process.env.OPENWOP_CORPUS_DIR ?? join(ROOT, '..', 'openwop');
const corpusFixtures = join(corpusDir, 'conformance', 'fixtures');
const haveCorpus = existsSync(corpusFixtures);
let corpusVersion = null;
if (haveCorpus) {
  try {
    corpusVersion = JSON.parse(readFileSync(join(corpusDir, 'conformance', 'package.json'), 'utf8')).version ?? null;
  } catch {
    corpusVersion = null;
  }
}
/** `true` when the clone carries the tag the pin names, so it can be read at it. */
const haveCorpusTag =
  haveCorpus &&
  (() => {
    try {
      execFileSync('git', ['-C', corpusDir, 'rev-parse', '--verify', '--quiet', `refs/tags/${pinnedTag}^{commit}`], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return true;
    } catch {
      return false;
    }
  })();
const corpusLabel = haveCorpusTag ? `the corpus at ${pinnedTag}` : 'the corpus working tree';
const corpusText = (rel) => {
  if (!haveCorpus) return null;
  if (haveCorpusTag) {
    try {
      return execFileSync('git', ['-C', corpusDir, 'show', `${pinnedTag}:conformance/fixtures/${rel}`], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  }
  const p = join(corpusFixtures, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
};

// ── Compare ─────────────────────────────────────────────────────────────────
const pinnedFiles = walk(pinnedDir);
const vendoredFiles = walk(VENDORED);
const vendoredSet = new Set(vendoredFiles);
const pinnedSet = new Set(pinnedFiles);

/** In the pin, absent from the vendored tree. The host cannot load it. */
const missing = pinnedFiles.filter((f) => !vendoredSet.has(f));
/** In the vendored tree, in neither the pin nor the allowlist. Unaccounted-for. */
const extra = vendoredFiles.filter((f) => !pinnedSet.has(f) && !isHostAuthored(f));
/** In both, different bytes. */
const drift = pinnedFiles.filter(
  (f) => vendoredSet.has(f) && readFileSync(join(pinnedDir, f), 'utf8') !== readFileSync(join(VENDORED, f), 'utf8'),
);
/** Allowlist rot: an entry naming nothing, or naming something the corpus has since adopted. */
const staleAllowlist = [];
for (const a of HOST_AUTHORED) {
  const covered = vendoredFiles.filter((f) => (a.endsWith('/') ? f.startsWith(a) : f === a));
  if (covered.length === 0) {
    staleAllowlist.push(`${a} — allowlisted but present in NO vendored file; delete the entry`);
    continue;
  }
  const adopted = covered.filter((f) => pinnedSet.has(f));
  if (adopted.length > 0) {
    staleAllowlist.push(
      `${a} — the pinned suite now ships ${adopted.join(', ')}; it is no longer host-authored, drop the entry`,
    );
  }
}

if (missing.length === 0 && extra.length === 0 && drift.length === 0 && staleAllowlist.length === 0) {
  console.log(
    `check-vendored-fixtures: ok — ${vendoredFiles.length} vendored file(s) ⊇ ` +
      `${pinnedFiles.length} from @openwop/openwop-conformance@${pinnedVersion}, ` +
      `byte-identical, ${HOST_AUTHORED.length} host-authored path(s) allowlisted.`,
  );
  process.exit(0);
}

// ── Report ──────────────────────────────────────────────────────────────────
console.error(
  `check-vendored-fixtures: conformance-fixtures/ is OUT OF SYNC with the pinned ` +
    `@openwop/openwop-conformance@${pinnedVersion}.`,
);

/** Which side is stale for one path — the whole point of reading the corpus. */
function side(rel, vendoredHas) {
  const theirs = corpusText(rel);
  if (!haveCorpus) return 'corpus not checked out — cannot say which side is stale';
  if (theirs === null) {
    // A file the TAG does not carry but the clone's working tree does is not
    // host-authored at all — it is a LATER release's fixture, vendored by a sync
    // that read the working tree. Saying "allowlist it" there would write the
    // accident into the allowlist permanently.
    if (vendoredHas && haveCorpusTag && existsSync(join(corpusFixtures, rel))) {
      return `absent at ${pinnedTag} but PRESENT in the corpus working tree (conformance ${corpusVersion ?? '?'}) — this is a LATER release's fixture; re-vendor at the pin (\`${SYNC_CMD}\`) or bump the pin, do NOT allowlist it`;
    }
    return vendoredHas
      ? `absent from ${corpusLabel} too — this file is host-authored; allowlist it or delete it`
      : `the PIN has it and ${corpusLabel} does NOT — ${
          haveCorpusTag
            ? 'the published package and its own tag disagree; report it rather than re-vendoring'
            : 'your corpus checkout is behind the pin; `git -C ../openwop fetch --tags`, then sync AT the tag'
        }`;
  }
  if (!vendoredHas) return `${corpusLabel} HAS it — \`${SYNC_CMD}\` will bring it in`;
  const ours = readFileSync(join(VENDORED, rel), 'utf8');
  const pinned = pinnedSet.has(rel) ? readFileSync(join(pinnedDir, rel), 'utf8') : null;
  if (ours === theirs && pinned !== null && theirs !== pinned) {
    return `vendored MATCHES ${corpusLabel} but that != the pin — the PIN is the stale side; bump it, do not re-sync`;
  }
  if (ours !== theirs) {
    // CORRECTED 2026-09-16 (ADR 0705). This arm returned "it was hand-edited"
    // for EVERY `ours !== theirs`, and that is the wrong diagnosis for the
    // ordinary case. MEASURED while bumping the pin 2.1.5 → 2.2.0: nine
    // fixtures reported hand-editing, and all nine were byte-identical to the
    // corpus at the PREVIOUS tag. Nothing had been edited — the pin moved and
    // the vendored copy had not followed yet, which is what a pin bump IS.
    //
    // A wrong diagnosis is worse than none: it sends the reader hunting a local
    // edit that does not exist, and the honest reading (`sync-fixtures.sh`) was
    // sitting in the same sentence. The distinguishing evidence is cheap and
    // was already in hand — if the corpus and the pin AGREE with each other,
    // the vendored copy is simply behind them both. Only three mutually
    // different values make a hand-edit plausible at all.
    if (pinned !== null && theirs === pinned) {
      return `${corpusLabel} and the pin AGREE; the vendored copy is BEHIND them — \`${SYNC_CMD}\` (this is the normal shape after a pin bump)`;
    }
    return `vendored, ${corpusLabel} and the pin are three DIFFERENT values — a local edit is the likely cause; diff it before re-vendoring, \`${SYNC_CMD}\` would discard it`;
  }
  return `vendored matches ${corpusLabel}`;
}

for (const m of missing) console.error(`  MISSING (in pin, not vendored): ${m}\n      → ${side(m, false)}`);
for (const d of drift) console.error(`  DRIFT   (bytes differ):          ${d}\n      → ${side(d, true)}`);
for (const e of extra) console.error(`  EXTRA   (vendored, unaccounted): ${e}\n      → ${side(e, true)}`);
for (const s of staleAllowlist) console.error(`  ALLOWLIST: ${s}`);

console.error('');
console.error('  The host loads ONLY the vendored dir (src/host/index.ts) and advertises the ids');
console.error('  via capabilities.fixtures; the suite reads ONLY its own package copy. A gap here');
console.error('  means the host runs a different fixture than the scenario asserting against it.');
console.error('');
console.error(`  Re-vendor with:  ${SYNC_CMD}`);
if (corpusVersion && corpusVersion !== pinnedVersion) {
  // This paragraph used to say the sync "will NOT satisfy this guard until the
  // two agree — reconcile the versions first", which was true of the untagged
  // script and sent adopters checking out the shared corpus clone (or building a
  // throwaway worktree) to make a working tree agree with a pin. The tag makes
  // the clone's HEAD irrelevant: the command above reads the release the pin
  // names whatever the checkout is on.
  console.error('');
  console.error(`  ⚠ Your corpus checkout's working tree is conformance ${corpusVersion}; the pin is ${pinnedVersion}.`);
  console.error(`    That does NOT block the command above — it reads ${pinnedTag}, not the working tree.`);
  console.error(`    ${haveCorpusTag ? 'That tag is present in the clone.' : `That tag is MISSING from the clone: git -C ${corpusDir} fetch --tags.`}`);
  console.error('    Moving FORWARD instead is a separate change: bump the @openwop/openwop-conformance pin,');
  console.error('    `npm ci` in backend/typescript, then re-vendor at the new tag in the same commit.');
}
if (extra.length > 0) {
  console.error('');
  console.error('  For an EXTRA file that this repo genuinely owns, add it to HOST_AUTHORED in');
  console.error('  scripts/check-vendored-fixtures.mjs WITH a comment naming who wrote it and who');
  console.error('  reads it — sync-fixtures.sh reads that same list to know what to preserve.');
}
process.exit(1);
