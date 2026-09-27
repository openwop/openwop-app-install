#!/usr/bin/env node
/**
 * check-pack-version-bump — a chain pack whose CONTENT changed must also change
 * its `version`.
 *
 * THE INCIDENT. `examples/workflow-chain-packs/` is vendored into the backend
 * image, but the SAME packs are also published to packs.openwop.dev and pinned by
 * `OPENWOP_INSTALL_PACKS`, where the registry copy takes precedence (ADR 0370).
 * Edit a pack in place and the two copies disagree AT THE SAME VERSION — a state
 * no version comparison can detect, and which the loader can only report after
 * the fact (`workflow_chain_pack_duplicate_content_drift`,
 * `host/workflowChainPackLoader.ts:401`).
 *
 * This happened twice in one week, both times from a PR branched off an older
 * `origin/main` whose stale copy of a description won the merge while the version
 * bump survived. A repo-vs-registry diff then found **15 packs** drifting.
 *
 * Nothing breaks in production — precedence still keeps one copy — but the two
 * sources of truth silently disagree, and the next publish ships whichever the
 * author happened to be looking at.
 *
 * THE RULE. If a pack's chain-bearing content changed against the merge-base,
 * `version` must differ too. That is checkable offline, at PR time, with no
 * network call — unlike the drift warning, which needs both copies loaded at boot.
 *
 * Not covered on purpose: whether the bump is SemVer-correct, and whether the new
 * version was actually published. The first needs judgment; the second needs the
 * network. This catches the mechanical mistake that actually recurs.
 */
import { execSync } from 'node:child_process';

const PACK_GLOB = /^(examples\/workflow-chain-packs|packs)\/[^/]+\/pack\.json$/;

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The commit to diff against: the merge-base with origin/main, or main if the
 *  remote ref is absent (a fresh clone / detached CI checkout). */
function baseRef() {
  for (const ref of ['origin/main', 'main']) {
    try {
      sh(`git rev-parse --verify --quiet ${ref}`);
      return sh(`git merge-base HEAD ${ref}`);
    } catch { /* try the next */ }
  }
  return null;
}

/** Numeric-segment SemVer compare; a prerelease tag falls back to a lexical
 *  tiebreak, which suffices for the numeric versions these packs actually use. */
function compareSemver(x, y) {
  const parts = (v) => String(v).split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [a1, a2, a3] = parts(x);
  const [b1, b2, b3] = parts(y);
  if (a1 !== b1) return a1 - b1;
  if (a2 !== b2) return a2 - b2;
  if (a3 !== b3) return a3 - b3;
  return String(x).localeCompare(String(y));
}

const base = baseRef();
if (!base) {
  // FAIL-OPEN, deliberately and LOUDLY. Without a base ref there is nothing to diff,
  // so the check cannot run — but a `✓` here would read as "verified" when nothing was
  // verified, which is the exact dishonesty this file exists to prevent elsewhere.
  // A shallow or detached CI checkout hits this; `npm run ci` locally does not.
  console.warn('! check-pack-version-bump: SKIPPED — no origin/main or main to diff against.');
  console.warn('  Nothing was verified. A shallow/detached checkout needs `git fetch origin main`.');
  process.exit(0);
}

let changed = [];
try {
  changed = sh(`git diff --name-only ${base} -- examples/workflow-chain-packs packs`)
    .split('\n')
    .filter((f) => PACK_GLOB.test(f));
} catch (err) {
  console.error(`check-pack-version-bump: git diff failed — ${err.message}`);
  process.exit(1);
}

if (changed.length === 0) {
  console.log('✓ check-pack-version-bump: no pack.json changed');
  process.exit(0);
}

/** The content that MATTERS for drift: everything a consumer resolves from the
 *  manifest. `version` is excluded (it is the thing under test) and so is the pack
 *  `description`, which is catalog copy no loader compares.
 *
 *  This used to hard-code `{name, chains}`. That made the check VACUOUS for every
 *  NODE pack — they carry `nodes`, not `chains`, so both sides serialised to the
 *  same `chains: null` and the function reported "no content change" no matter what
 *  had been rewritten. The glob has always matched `packs/`; the coverage was the
 *  lie. Probed by replacing `packs/core.openwop.ai` wholesale and watching it pass.
 *
 *  Shape-agnostic now: compare everything except the two fields that are
 *  deliberately allowed to move on their own. */
const NOT_CONTENT = new Set(['version', 'description']);
function contentOf(text) {
  const parsed = JSON.parse(text);
  const stable = {};
  for (const key of Object.keys(parsed).sort()) {
    if (!NOT_CONTENT.has(key)) stable[key] = parsed[key];
  }
  return JSON.stringify(stable);
}

/**
 * ADR 0597 §6 (SPWF-3 / SPWF-12) — THE PER-CHAIN VERSION, which is the field
 * workflow IDENTITY is actually built from.
 *
 * `host/workflowChainPackLoader.deterministicExpansionId` hashes
 * `${chain.chainId}@${chain.version}:${params}` — the PACK manifest `version`
 * the check above compares never enters it. So the check was policing a
 * spelling, not the invariant: `vendor.openwop-app.workflows.strategy` moved
 * 1.0.0 → 1.0.1 → 1.0.2 → 1.0.3 across four commits — one of which changed
 * every `deliver` node's `typeId` — while all three chains sat at
 * `"version": "1.0.0"` throughout. Same `(chainId, version, params)` ⇒
 * byte-identical expansionId ⇒ the same workflowId and the same node ids
 * resolving to a DIFFERENT graph, with no version signal anywhere. A `:fork` of
 * an older run, or a re-instantiate, silently crosses that boundary.
 *
 * Same two rules as the pack-level check, per chain: content changed ⇒ version
 * must change, and it must move FORWARD. `description` is catalog copy (no
 * loader compares it); `label` is NOT excluded — it is what the builder gallery
 * and the `/` picker show, so it is content.
 */
const CHAIN_NOT_CONTENT = new Set(['version', 'description']);
function chainContentOf(chain) {
  const stable = {};
  for (const key of Object.keys(chain).sort()) {
    if (!CHAIN_NOT_CONTENT.has(key)) stable[key] = chain[key];
  }
  return JSON.stringify(stable);
}
function chainsById(parsed) {
  const out = new Map();
  for (const c of Array.isArray(parsed.chains) ? parsed.chains : []) {
    if (c && typeof c.chainId === 'string') out.set(c.chainId, c);
  }
  return out;
}
function chainOffenders(file, a, b) {
  const found = [];
  const before = chainsById(a);
  for (const [chainId, after] of chainsById(b)) {
    const prior = before.get(chainId);
    if (!prior) continue; // a NEW chain has nothing to compare
    if (chainContentOf(prior) === chainContentOf(after)) continue;
    if (prior.version === after.version) {
      found.push(`${file} — chain "${chainId}" changed content but its version stayed "${after.version}" (this is the field deterministicExpansionId hashes)`);
    } else if (compareSemver(after.version, prior.version) < 0) {
      found.push(`${file} — chain "${chainId}" version went BACKWARDS ${prior.version} -> ${after.version}`);
    }
  }
  return found;
}

const offenders = [];
const skipped = [];
const deleted = [];
for (const file of changed) {
  let before;
  try {
    before = sh(`git show ${base}:${file}`);
  } catch {
    skipped.push(`${file} (new pack — nothing to compare)`);
    continue;
  }
  let after;
  try {
    after = sh(`git show HEAD:${file}`);
  } catch {
    // The pack was DELETED in this branch. `git diff --name-only` lists deletions,
    // and `git show HEAD:<gone>` throws — which crashed the whole check with an
    // unhandled exception rather than failing a finding. Removing a pack is not a
    // version-bump concern, so skip it. (Whether a DELETE should be allowed at all
    // is a separate policy question; this check is not the place for it.)
    deleted.push(file);
    continue;
  }
  let a, b;
  try {
    a = JSON.parse(before);
    b = JSON.parse(after);
  } catch (err) {
    offenders.push(`${file} — unparseable JSON (${err.message})`);
    continue;
  }
  // The per-chain check runs INDEPENDENTLY of the pack-level one below: a pack
  // whose manifest version was bumped correctly can still carry a chain whose
  // own version froze, and that is exactly the case this repo shipped three
  // times in a row.
  offenders.push(...chainOffenders(file, a, b));
  if (contentOf(before) === contentOf(after)) continue; // only catalog copy moved
  if (a.version === b.version) {
    offenders.push(`${file} — content changed but version stayed "${b.version}"`);
    continue;
  }
  // FORWARD, not merely different. "The version changed" is satisfied by a
  // DOWNGRADE, and a downgrade is exactly how this repo loses work:
  // `scripts/sync-packs.sh` rm -rf's `packs/core.openwop.*` and re-copies from
  // ../openwop-registry, so syncing while the vendored copy is AHEAD of the
  // registry rewrites it backwards. Probed: that sync
  // (core.openwop.ai 1.3.2 -> 1.1.4, losing the error-path schema checker the
  // app lineage carries) passed the first version of this check.
  if (compareSemver(b.version, a.version) < 0) {
    offenders.push(
      `${file} — version went BACKWARDS ${a.version} -> ${b.version}`
      + ' (syncing over a vendored copy that is ahead of the registry does this)',
    );
  }
}

if (offenders.length > 0) {
  console.error('✗ check-pack-version-bump: a pack changed content without a correct version bump.\n');
  for (const o of offenders) console.error(`    ${o}`);
  console.error(
    '\n  A CHAIN version is what `deterministicExpansionId` hashes into the workflow id'
    + '\n  (host/workflowChainPackLoader.ts) — bump the chain\'s OWN `version` when its DAG,'
    + '\n  parameters, label or outputs change, not just the pack manifest\'s.'
    + '\n'
    + '\n  The registry copy of a pack takes precedence over the vendored one (ADR 0370),'
    + '\n  so shipping different content at the same version leaves the repo and'
    + '\n  packs.openwop.dev silently disagreeing. Bump the patch version, and republish'
    + '\n  if the pack is named in OPENWOP_INSTALL_PACKS.'
    + '\n'
    + '\n  A BACKWARDS version means a sync ran over a vendored copy that was ahead of'
    + '\n  the registry (scripts/sync-packs.sh rm -rf s core.openwop.* and re-copies).'
    + '\n  Publish the newer content to the registry FIRST, then sync.',
  );
  process.exit(1);
}

const parts = [];
if (skipped.length) parts.push(`${skipped.length} new`);
if (deleted.length) parts.push(`${deleted.length} deleted`);
const note = parts.length ? ` (${parts.join(', ')})` : '';
console.log(`✓ check-pack-version-bump: ${changed.length} pack.json changed, all versioned correctly${note}`);
