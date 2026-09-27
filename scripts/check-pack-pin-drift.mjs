#!/usr/bin/env node
/**
 * check-pack-pin-drift — compare the pack versions this repo VENDORS against the
 * versions production is PINNED to.
 *
 * WHY THIS EXISTS. Production runs `OPENWOP_STRICT_REGISTRY=true`. Under that
 * setting `mountLocalPacks` symlinks every vendored pack into the pack dir, and
 * then the registry installer OVERWRITES the ones named in
 * `OPENWOP_INSTALL_PACKS` with the pinned version. So for any PINNED pack:
 *
 *     merging to this repo ships NOTHING. The registry publish is the ship step.
 *
 * That is not a hypothetical. A sweep on 2026-08-01 found THIRTEEN packs whose
 * pinned version differed from the vendored one, including:
 *   - `core.openwop.ai`      vendored 1.3.2, pinned 1.1.3 — six weeks of merged
 *     AI-node work (3 LLM-exchange waves, image-gen, video-gen, ADR 0458 P2) that
 *     had never executed in production;
 *   - `core.openwop.http`    vendored 2.0.0, pinned 1.1.2 — a full major version,
 *     already published, one config line away the whole time;
 *   - 8 agent packs pinned at 1.0.0 while 1.0.1 (the phantom-tool-id fix) sat
 *     unpublished — so live agent prompts named tools that do not exist.
 *
 * Every one of those was invisible. `check-pack-version-bump.mjs` compares a PR
 * against its merge-base; nothing compared the repo against what production runs.
 *
 * WHY IT IS NOT A CI GATE. The pin list lives in the Cloud Run service config, not
 * in this repo, so an offline CI step cannot see it. This is an OPS tool: run it
 * before/after a deploy, or whenever a pack changes. It reads the pin list from
 * (in order) `--pins <csv>`, `$OPENWOP_INSTALL_PACKS`, or `gcloud run services
 * describe`.
 *
 *   node scripts/check-pack-pin-drift.mjs
 *   node scripts/check-pack-pin-drift.mjs --pins "core.openwop.ai@1.3.2,..."
 *
 * Exit 1 when the repo vendors something NEWER than production runs (work that
 * has not shipped). A pack where production is AHEAD is reported too, but does not
 * fail: that means the repo is stale for THAT pack.
 *
 * CORRECTED 2026-09-15 — this used to finish "...and a `sync-packs.sh` run would
 * fix it — annoying, not undelivered work." Both halves were wrong, and the
 * reassurance was the dangerous part. `sync-packs.sh` is FAMILY-granular: it
 * `rm -rf`s every `core.openwop.*` / `vendor.*` family and re-copies only what
 * canon has. MEASURED on a clean worktree at 108f166fe, a plain run DELETED 17
 * files across six families — five of which the registry has never seen at all
 * (`vendor.openwop.trusted-demo`, `core.openwop.forms.starters`, …) — and
 * reverted every family vendored ahead of canon. So "the repo is stale" and
 * "running the fix destroys unpublished work" are the same command, and this
 * header recommended it. `sync-packs.sh` now refuses that run and names the
 * losses; `sync-packs.sh --check` reports them without changing anything.
 *
 * CORRECTED 2026-09-16 (ADR 0713) — "the registry installer OVERWRITES the ones
 * named in `OPENWOP_INSTALL_PACKS`" and "merging to this repo ships NOTHING" stopped
 * being true on 2026-09-11, and nothing here noticed. ADR 0655 D5 made the
 * installer REFUSE a pin below the vendored version, so in exactly the case this
 * script reports, production keeps and SERVES the vendored copy: the merge DID
 * ship, unsigned, and the pin is inert. MEASURED on the 2026-09-16 production
 * boot: 4 refusals (ai, http, integration, mcp), 53 failed installs, and ZERO
 * successful ones — every pack in production was the image-vendored copy
 * (ADR 0713: the installer could not read a v2 signing block, and 41 pins named
 * v1-only versions). The drift is still worth failing on; what it MEANS is
 * "production runs code the signed registry never saw", not "work did not ship".
 *
 * Note also that the two scripts judge DIFFERENT things: this one compares the
 * repo against production's pin list; the guard compares it against the local
 * registry clone, which may itself be behind its upstream. Neither is "canon"
 * on its own.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = process.env.OPENWOP_CR_SERVICE ?? 'openwop-app-backend';
const REGION = process.env.OPENWOP_CR_REGION ?? 'us-central1';
const PROJECT = process.env.OPENWOP_CR_PROJECT ?? 'openwop-dev';
// The deploy identity, same source deploy.sh and preflight use.
const ACCOUNT = process.env.OPENWOP_DEPLOY_ACCOUNT ?? process.env.CLOUDSDK_CORE_ACCOUNT ?? '';
let readFailure = '';

/** Only these families are registry-installable; `feature.*` / `community.*` live
 *  only in this repo and are never pinned. */
const MANAGED = /^(core\.openwop\.|vendor\.)/;

function pinsFromArgs() {
  const i = process.argv.indexOf('--pins');
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  // Falling through to $OPENWOP_INSTALL_PACKS / gcloud here would answer a DIFFERENT
  // question than the one asked — and could do so in green. An explicit flag with no
  // usable value is a usage error.
  if (value === undefined || value.startsWith('--')) {
    console.error('✗ check-pack-pin-drift: --pins requires a value, e.g. --pins "core.openwop.ai@1.3.2,…"');
    process.exit(2);
  }
  return value;
}

function pinsFromCloudRun() {
  try {
    // execFileSync, NOT execSync: SERVICE/REGION/PROJECT come from the environment,
    // and interpolating them into a shell string makes `OPENWOP_CR_PROJECT='x; rm -rf …'`
    // executable. An argv array never reaches a shell. (Self-inflicted rather than a
    // privilege boundary — this is an operator-run script — but there is no reason to
    // build the string form.)
    const raw = execFileSync(
      'gcloud',
      [
        'run', 'services', 'describe', SERVICE,
        '--region', REGION, '--project', PROJECT, '--format=json',
        // IDENTITY, not ambient state (correction 2026-09-12). deploy.sh passes
        // `--account` to its gcloud calls and #3771 added it to preflight's own
        // three; this script is a fourth caller that neither fix reached, so it
        // still took whoever happened to be active. That is how the failure below
        // gets reached in the first place.
        ...(ACCOUNT ? ['--account', ACCOUNT] : []),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
    );
    const env = JSON.parse(raw).spec.template.spec.containers[0].env ?? [];
    return env.find((e) => e.name === 'OPENWOP_INSTALL_PACKS')?.value;
  } catch (err) {
    // Distinguish "could not look" from "looked and found nothing". The caller
    // turns the first into a refusal; collapsing them is what let an unreadable
    // service report OK.
    readFailure = String(err?.message ?? err).split('\n')[0];
    return undefined;
  }
}

const rawPins = pinsFromArgs() ?? process.env.OPENWOP_INSTALL_PACKS ?? pinsFromCloudRun();
if (!rawPins) {
  // CORRECTED 2026-09-12 — this used to be LOUD AND exit 0, and loudness is not
  // the property that matters. `preflight-deploy.sh:117` branches on the EXIT
  // CODE and maps 0 to `OK  pack pins match the vendored versions`. So an
  // unreadable service reported a MATCH having compared nothing — the exact
  // shape Gate 5 refuses two hundred lines below ("UNREADABLE … refusing to
  // guess"), in the gate immediately above it.
  //
  // MEASURED 2026-09-12: the deploy account's token expired ("Reauthentication
  // failed. cannot prompt during non-interactive execution"), `pinsFromCloudRun`
  // threw, and this printed SKIPPED and exited 0. Nothing in the pipeline
  // noticed. Exit 3 now — distinct from the 1 a real drift returns, so a caller
  // can tell "drifted" from "could not tell".
  // THE DISTINCTION THAT MATTERS, and which the first version of this fix got
  // wrong: a service whose `describe` SUCCEEDED and simply pins nothing is a real,
  // legitimate state — nothing is pinned, so nothing can have drifted. Only a
  // FAILED READ is "could not tell". Collapsing the two made the deploy-gate
  // harness red in three pg-budget fixtures whose fake gcloud answers describe
  // with no pin var; that was the harness correctly refusing an over-broad gate.
  if (!readFailure) {
    console.log('✓ check-pack-pin-drift: the service pins no packs — nothing to compare, nothing can have drifted.');
    process.exit(0);
  }
  console.error('✗ check-pack-pin-drift: CANNOT COMPARE — no pin list.');
  if (readFailure) console.error(`  reading the live pins failed: ${readFailure}`);
  console.error('  Pass --pins "<csv>", set OPENWOP_INSTALL_PACKS, or re-authenticate the deploy');
  console.error('  account (gcloud auth login). NOTHING WAS COMPARED — this is not a pass.');
  process.exit(3);
}

const pinned = new Map();
for (const entry of rawPins.split(',')) {
  const t = entry.trim();
  const at = t.lastIndexOf('@');
  if (at > 0) pinned.set(t.slice(0, at), t.slice(at + 1));
}

if (pinned.size === 0) {
  // PKGATE-5, again. `--pins "garbage"` parsed to an empty map and the summary below
  // printed `✓ … 0 pinned, none unshipped` — a green tick over an empty comparison.
  // A pin list that yields no `name@version` pairs is malformed, not "clean".
  console.error('✗ check-pack-pin-drift: the pin list parsed to ZERO name@version pairs.');
  console.error(`    input began: ${rawPins.slice(0, 80)}${rawPins.length > 80 ? '…' : ''}`);
  console.error('  Nothing was compared. Expected a comma-separated `name@version` list.');
  process.exit(1);
}

const vendored = new Map();
// BOTH vendored roots. This scanned only `packs/` — the NODE packs — and was blind
// to `examples/workflow-chain-packs/`, where every CHAIN pack lives. Chain packs are
// the majority of what `OPENWOP_INSTALL_PACKS` pins and the source of every repin
// this tool was written for, so it reported "none unshipped" while 23 retargeted
// chain packs sat unpublished. Third instance of the same false-green shape
// (PKGATE-5, PKGATE-7): a check that answers about a narrower corpus than its
// summary line claims.
const VENDOR_ROOTS = ['packs', 'examples/workflow-chain-packs'];
for (const root of VENDOR_ROOTS) {
  const dirPath = join(ROOT, root);
  if (!existsSync(dirPath)) continue;
  for (const dir of readdirSync(dirPath)) {
    const manifest = join(dirPath, dir, 'pack.json');
    if (!existsSync(manifest)) continue;
    try {
      const { name, version } = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof name === 'string' && typeof version === 'string' && MANAGED.test(name)) {
        vendored.set(name, version);
      }
    } catch { /* a malformed manifest is the other gate's problem */ }
  }
}

/** The known-drift list. The env override exists for the gate harness ONLY (it has to
 *  prove the list fails CLOSED when absent); nothing in the deploy path sets it. */
const KNOWN_FILE = process.env.OPENWOP_PIN_DRIFT_KNOWN_FILE ?? join(ROOT, 'scripts', 'pin-drift-known.json');

/** Rows in the known-drift list, read early for the "nothing drifts any more" arm. */
function knownRowCount() {
  try {
    const parsed = JSON.parse(readFileSync(KNOWN_FILE, 'utf8'));
    return Array.isArray(parsed?.unshipped) ? parsed.unshipped.length : 0;
  } catch { return 0; }
}

const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

const unshipped = []; // repo NEWER than prod — merged work not running
const stale = [];     // prod NEWER than repo — repo behind
for (const [name, ver] of [...vendored].sort()) {
  const pin = pinned.get(name);
  if (!pin || pin === ver) continue;
  (cmp(ver, pin) > 0 ? unshipped : stale).push({ name, ver, pin });
}

// Deliberately does NOT say "run sync-packs.sh". That advice was here, and it is
// how a per-pack staleness report licenses a repo-wide destructive sweep: the
// script is family-granular and deletes whatever canon lacks. Point at the
// non-destructive check instead and let it decide.
for (const { name, ver, pin } of stale) {
  console.warn(`  stale (prod ahead): ${name} — repo ${ver}, prod ${pin}.`);
}
if (stale.length > 0) {
  console.warn('  To refresh the vendored copies, FIRST run `bash scripts/sync-packs.sh --check`:');
  console.warn('  a plain sync also reverts any family vendored ahead of canon and deletes any');
  console.warn('  family canon has never seen. The check names both without changing anything.');
}

if (unshipped.length === 0 && knownRowCount() > 0) {
  console.error('✗ check-pack-pin-drift: nothing is unshipped, but scripts/pin-drift-known.json still lists waived drift.');
  console.error('  STALE WAIVER — the drift was fixed; empty the `unshipped` list so the waiver cannot outlive its reason.');
  process.exit(1);
}
if (unshipped.length === 0) {
  const note = stale.length ? ` (${stale.length} stale)` : '';
  console.log(`✓ check-pack-pin-drift: ${vendored.size} vendored packs, ${pinned.size} pinned, none unshipped${note}`);
  process.exit(0);
}

// ── THE WAIVER IS SELF-LIMITING (issue #3940) ───────────────────────────────
// `--allow-pin-drift` was used on at least five consecutive deploys, and a waiver
// that covers "whatever drifted" hides NEW drift behind the old. So the known
// drift is a checked-in list, and the exit code says which kind this is:
//
//   exit 4  every unshipped pack matches a row in `pin-drift-known.json` EXACTLY
//           (name + vendored + pinned) — the only drift preflight may waive
//   exit 1  anything else: a NEW drifting pack, a known pack whose versions moved,
//           or a STALE row that no longer drifts. NOT waivable.
//
// A missing or unparseable list means NOTHING is known, so every drift is new —
// the fail-closed direction.
let known = [];
try {
  const parsed = JSON.parse(readFileSync(KNOWN_FILE, 'utf8'));
  if (Array.isArray(parsed?.unshipped)) known = parsed.unshipped;
} catch { /* fail closed: nothing is known */ }
const isKnown = ({ name, ver, pin }) => known.some((k) => k.name === name && k.vendored === ver && k.pinned === pin);
const newDrift = unshipped.filter((u) => !isKnown(u));
const staleWaivers = known.filter((k) => !unshipped.some((u) => u.name === k.name && u.ver === k.vendored && u.pin === k.pinned));

console.error('\n✗ check-pack-pin-drift: production pins these packs BELOW the version this repo vendors.\n');
for (const u of unshipped) {
  console.error(`    ${isKnown(u) ? 'known' : 'NEW  '}  ${u.name} — vendored ${u.ver}, production pinned ${u.pin}`);
}
if (staleWaivers.length > 0) {
  console.error('\n  STALE WAIVER — listed in scripts/pin-drift-known.json but no longer drifting as recorded; delete the row:');
  for (const k of staleWaivers) console.error(`    ${k.name} — recorded vendored ${k.vendored}, pinned ${k.pinned}`);
}
console.error(
  '\n  The installer refuses to downgrade a vendored pack (ADR 0655 D5), so production'
  + '\n  SERVES the vendored copy here — not registry-verified, outside what STRICT_REGISTRY'
  + '\n  promises — and the pin is inert (ADR 0713). For each: publish the version'
  + '\n  to packs.openwop.dev, then advance the pin with an incremental'
  + '\n  `gcloud run services update --update-env-vars` (never --set-env-vars).',
);
if (newDrift.length === 0 && staleWaivers.length === 0) {
  console.error(`\n  KNOWN drift only (${unshipped.length} row(s) in scripts/pin-drift-known.json) — waivable with --allow-pin-drift.`);
  process.exit(4);
}
console.error('\n  This is NOT covered by --allow-pin-drift: the waiver states a KNOWN drift, and this is not on the list.');
process.exit(1);
