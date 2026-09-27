#!/usr/bin/env node
// check-vendored-schemas — drift guard for the LOAD-BEARING vendored schemas.
//
// The repo-root `schemas/` dir holds vendored copies of openwop/openwop canonical
// schemas. Most are reference-only (the backend hand-writes the matching TS types
// and merely `@see`s them) — those are refreshed best-effort via
// `scripts/sync-schemas.sh` and are NOT guarded here (guarding all ~57 would force
// a re-vendor PR on every unrelated upstream schema edit, pure churn for docs the
// app never executes).
//
// THIS guard covers only the schemas the backend actually compiles + validates
// data against at runtime (so a stale copy would mean the app mis-accepts or
// mis-rejects live data — a real bug, not cosmetic):
//
//   - schemas/ai-envelope.schema.json            (host/envelopeAcceptor.ts)
//   - schemas/envelopes/*.schema.json            (host/envelopeAcceptor.ts, per-kind)
//   - schemas/prompt-pack-manifest.schema.json   (host/promptPackLoader.ts)
//   - schemas/prompt-kind.schema.json            (   "  — manifest $ref)
//   - schemas/prompt-template.schema.json        (   "  — manifest $ref)
//   - schemas/prompt-ref.schema.json             (   "  — manifest $ref)
//   - schemas/connection-pack-manifest.schema.json (features/connections/connectionPackLoader.ts)
//   - schemas/workflow-chain-pack-manifest.schema.json (host/workflowChainPackLoader.ts —
//     compiled with ajv at boot; `additionalProperties:false` on FragmentNode, so a
//     stale copy REJECTS every pack carrying a newer field. H34, 2026-08-16: it
//     had drifted silently — RFC 0157's `compensation`/`irreversibleEffect` made
//     every conforming pack `invalid_manifest` at load until H13 re-vendored it by
//     hand. Exactly the harm class this file's header describes, in a file the
//     list did not name.)
//
// Canonical source: the local openwop corpus (OPENWOP_CORPUS_DIR or ../openwop,
// same as sync-schemas.sh) when present; otherwise the GitHub raw `main` branch
// (OPENWOP_SPEC_RAW_BASE override) so the guard also runs in a corpus-less CI.
//
// Pure Node 20 stdlib (+ fetch). Run from repo root: `node scripts/check-vendored-schemas.mjs`.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { classifyDrift, suiteCertifiesCorpusTag, AHEAD, UNKNOWN } from './schemaDrift.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED = join(ROOT, 'schemas');

// The fixed load-bearing set + the per-kind envelopes/ directory (globbed so a
// newly-added envelope kind is covered automatically).
const FIXED = [
  'ai-envelope.schema.json',
  'prompt-pack-manifest.schema.json',
  'prompt-kind.schema.json',
  'prompt-template.schema.json',
  'prompt-ref.schema.json',
  'connection-pack-manifest.schema.json',
  'workflow-chain-pack-manifest.schema.json',
  // ── a THIRD harm class: the reference copy for a HAND-WRITTEN mirror ──────
  //
  // Added 2026-08-17 (ADR 0554 / S36). Stated honestly, because this entry does
  // NOT satisfy the runtime-loader criterion the rest of this list uses, and a
  // reader who assumed it did would draw the wrong conclusion. MEASURED: nothing
  // compiles or reads `workflow-definition.schema.json` at runtime — only
  // comments reference it, and `host/workflowDefinitionValidation.ts` is a
  // hand-written validator that MIRRORS it field-for-field.
  //
  // The mirror IS the harm, and it points the dangerous way. A hand-written
  // validator and a stale reference copy drift silently: a field added upstream
  // is absent from the validator's allowlist, so an author's document is
  // ACCEPTED and the field silently DISCARDED. Not hypothetical — that is #3274
  // (`compensation` dropped by this very validator's allowlist, every test
  // green) and #3292 (the same class at chain expansion). The vendored copy is
  // the only artifact a maintainer diffs the mirror against, so keeping it fresh
  // is what makes that class findable at all.
  'workflow-definition.schema.json',
  // Same third class, added 2026-08-18 (H54, ADR 0554 / RFC 0151 §B). MEASURED:
  // nothing compiles or reads `compensation-policy.schema.json` at runtime and no
  // test compiles it either (`corpusSchema()` is never called with it). The
  // `settings.compensation` key is validated by a HAND-WRITTEN mirror —
  // `checkCompensationPolicy` in `host/workflowDefinitionValidation.ts` (the
  // closed `triggers` enum, `orderingModel`, `profileVersion`, the
  // manual-intervention dispositions) plus the `CompensationPolicy` type in
  // `host/compensationUnwind.ts` and the chain-level `compensation` field in
  // `host/workflowChainPackLoader.ts`. Three mirrors of one closed schema, in the
  // very validator that already dropped `compensation` once (#3274). The vendored
  // copy is what a maintainer diffs those three against; it must be current.
  'compensation-policy.schema.json',
  // Same third class, added 2026-08-18 (H54, ADR 0555 / RFC 0154 §A/§B). MEASURED:
  // nothing compiles or reads `workload-identity.schema.json` at runtime and no
  // test compiles it. `isWellFormedIdentity` / `isWellFormedDelegation` in
  // `host/workloadIdentity.ts` are hand-written CLOSED-WORLD allowlists that
  // mirror it key-for-key (schemes, `keyBinding.method`, the `sha256:` digest
  // patterns, hop keys). Here the drift points the OTHER way from #3274 — a
  // field added upstream is REFUSED, not silently discarded, because the mirror
  // is closed on purpose (raw tokens must never ride along) — but it is the same
  // harm: a conforming peer's identity object rejected by a host reading a stale
  // reference. Guarding the copy is what makes that findable.
  'workload-identity.schema.json',
  // ADR 0550 P4 / RFC 0148 §C. `conformance/certify.ts` COMPILES this copy with
  // ajv and refuses to write a bundle that fails it, so the vendored file is the
  // gate on every public claim this host makes. A stale copy here would let the
  // emitter accept a bundle no consumer's verifier would — the drift class this
  // file's header describes, applied to evidence rather than to live data.
  //
  // Guarded even though it is not compiled by a RUNTIME loader (the route serves
  // the already-validated stamp): the harm is the same shape, and it lands on
  // the one artifact whose whole purpose is to be checked by someone else.
  'certification-bundle-v2.schema.json',
  // ── the second harm class, and why it is no longer guarded here ────────
  // On 2026-08-10 `run-event-payloads` and `capabilities` were added to this set
  // because the TEST SUITE compiled the vendored copies with ajv — so a stale
  // copy meant the suite certified conformance against a contract that no longer
  // existed, and stayed green doing it (measured: `capabilities` sat 7 properties
  // behind upstream).
  //
  // REMOVED the same day, because the tests now import those two schemas from
  // `@openwop/openwop-conformance` (`test/support/corpusSchema.ts`). There is no
  // second copy to drift, so the drift is impossible rather than detected —
  // strictly stronger than this guard. Keeping the entries would have left this
  // file asserting a justification that had stopped being true, which is the
  // defect the guard exists to catch.
  //
  // If a RUNTIME loader ever reads either vendored copy, add it back — the
  // original harm class (the app mis-handling live data) would then apply.
];
const paths = FIXED.map((f) => `schemas/${f}`);
const envelopesDir = join(VENDORED, 'envelopes');
if (existsSync(envelopesDir)) {
  for (const f of readdirSync(envelopesDir)) {
    if (f.endsWith('.schema.json')) paths.push(`schemas/envelopes/${f}`);
  }
}

// Resolve the canonical source: local corpus dir wins (offline-friendly, same as
// sync-schemas.sh), else GitHub raw.
const corpusDir = process.env.OPENWOP_CORPUS_DIR ?? join(ROOT, '..', 'openwop');
const useLocal = existsSync(join(corpusDir, 'schemas'));
const rawBase = process.env.OPENWOP_SPEC_RAW_BASE ?? 'https://raw.githubusercontent.com/openwop/openwop/main';
let _pinned;
const sourceLabel = useLocal ? `local corpus ${corpusDir}${pinnedTag() === null ? ' (working tree — CORPUS_TAG not in this clone)' : ` at ${pinnedTag()}`}` : rawBase;

/** The tag `schemas/CORPUS_TAG` names, when that tag exists in the corpus clone. */
function pinnedTag() {
  if (_pinned !== undefined) return _pinned;
  _pinned = null;
  try {
    const tag = readFileSync(join(ROOT, 'schemas', 'CORPUS_TAG'), 'utf8').trim();
    execFileSync('git', ['-C', corpusDir, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    _pinned = tag;
  } catch { /* no tag file, tag absent from this clone, or not a git repo */ }
  return _pinned;
}

async function canonical(rel) {
  if (useLocal) {
    // Read the file AT THE PINNED TAG, not from whatever the sibling checkout
    // happens to be on. `schemas/CORPUS_TAG` names the release these copies came
    // from; comparing against a sibling HEAD that has moved on (or, worse, is
    // behind) reports drift that is not drift and — the dangerous direction —
    // reports agreement with a corpus nobody released. `sync-schemas.sh` already
    // refuses to copy from anything but the tag; this is the same rule on the
    // verifying side. Falls back to the working tree only when the tag is not in
    // that clone, and says so.
    const pinned = pinnedTag();
    if (pinned !== null) {
      try {
        return execFileSync('git', ['-C', corpusDir, 'show', `${pinned}:${rel}`], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return null; // absent at the tag is a real "missing", not a fallback
      }
    }
    const p = join(corpusDir, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
  const res = await fetch(`${rawBase}/${rel}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch ${rel} → HTTP ${res.status}`);
  return await res.text();
}

/** Which side is ahead for a drifting schema (pure logic in ./schemaDrift.mjs,
 *  unit-tested — it decides whether we recommend a DESTRUCTIVE sync). */
function driftDirection(rel) {
  try {
    const theirs = driftCanonicalText.get(rel);
    if (theirs == null) return UNKNOWN;
    return classifyDrift(readFileSync(join(ROOT, rel), 'utf8'), theirs);
  } catch {
    return UNKNOWN;
  }
}

/** How many commits the local corpus checkout is behind its upstream (0 when
 *  current, unknown/absent, or not a git repo). A stale corpus is the most common
 *  cause of a false-positive drift report. */
function corpusBehindCount() {
  if (!useLocal) return 0;
  try {
    const out = execFileSync('git', ['-C', corpusDir, 'rev-list', '--count', 'HEAD..@{u}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Number.parseInt(out.trim(), 10) || 0;
  } catch {
    return 0; // no upstream / not a repo / git unavailable — say nothing rather than guess
  }
}

const drift = [];
const missing = [];
/** rel → canonical text, retained for the drift-direction diagnosis. */
const driftCanonicalText = new Map();
let checked = 0;

try {
  for (const rel of paths) {
    const localPath = join(ROOT, rel);
    if (!existsSync(localPath)) {
      missing.push(`${rel} (absent in app — a load-bearing schema MUST be vendored)`);
      continue;
    }
    const canon = await canonical(rel);
    if (canon === null) {
      missing.push(`${rel} (not found in canonical ${sourceLabel})`);
      continue;
    }
    // Trailing-whitespace-insensitive; any real content delta is drift.
    if (readFileSync(localPath, 'utf8').replace(/\s+$/, '') !== canon.replace(/\s+$/, '')) {
      drift.push(rel);
      driftCanonicalText.set(rel, canon);
    }
    checked++;
  }
} catch (err) {
  // Network failure with no local corpus → can't verify. SKIP (don't block the
  // local CI gate on an infra blip); the check enforces whenever canonical is
  // reachable (a checked-out ../openwop or a working GitHub fetch).
  if (!useLocal) {
    console.warn(`check-vendored-schemas: SKIPPED — canonical unreachable (${err.message}). ` +
      `Set OPENWOP_CORPUS_DIR to a local openwop checkout to verify offline.`);
    process.exit(0);
  }
  throw err;
}

// Pin coherence (2026-09-02, v2 charter Phase 0): `schemas/CORPUS_TAG` records the
// openwop tag `sync-schemas.sh` copied from. It MUST equal the corpusTag carried
// by the installed suite's signed artifact stamp, so the schemas the backend
// validates against and the suite that certifies it come from the same corpus
// release. The npm package version is an independent harness release axis: a
// test-runner-only patch may continue to certify the same corpus.
{
  const tagPath = join(ROOT, 'schemas', 'CORPUS_TAG');
  if (!existsSync(tagPath)) {
    console.error('check-vendored-schemas: schemas/CORPUS_TAG is missing — vendored schemas are unpinned.');
    console.error('  Re-vendor from a tagged corpus: bash scripts/sync-schemas.sh --tag openwop-conformance/vX.Y.Z');
    process.exit(1);
  }
  const tag = readFileSync(tagPath, 'utf8').trim();
  // Two tag namespaces, because the corpus has two release lines (PUBLISHING.md
  // §"Release lines from suite 2.0.0"): the 1.x suite publishes from
  // `openwop-conformance/vX.Y.Z`, and the v2 coordinated release publishes the
  // suite AND `@openwop/spec-artifacts` from a bare `vX.Y.Z[-rc.N]`. A v2 pin
  // written in the 1.x namespace would name a tag that does not exist.
  const m = /^(?:openwop-conformance\/)?v(\d+\.\d+\.\d+(?:-rc\.\d+)?)$/.exec(tag);
  if (!m) {
    console.error(`check-vendored-schemas: schemas/CORPUS_TAG is ${JSON.stringify(tag)}; expected openwop-conformance/vX.Y.Z (1.x line) or vX.Y.Z[-rc.N] (v2 coordinated release)`);
    process.exit(1);
  }
  let installed = null;
  let certifiedCorpusTag = null;
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(join(ROOT, 'backend', 'typescript', 'package.json'));
    const packagePath = req.resolve('@openwop/openwop-conformance/package.json');
    installed = JSON.parse(readFileSync(packagePath, 'utf8')).version;
    const stampPath = join(dirname(packagePath), 'schemas', 'CORPUS-STAMP.json');
    if (existsSync(stampPath)) {
      certifiedCorpusTag = JSON.parse(readFileSync(stampPath, 'utf8')).corpusTag ?? null;
    }
  } catch {
    installed = null;
    certifiedCorpusTag = null;
  }
  if (installed === null) {
    console.warn('check-vendored-schemas: @openwop/openwop-conformance not installed in backend/typescript; pin coherence not checked (run npm ci there first).');
  } else if (!suiteCertifiesCorpusTag(tag, installed, certifiedCorpusTag)) {
    const certified = certifiedCorpusTag ?? `legacy version-derived tag v${installed}`;
    console.error(`check-vendored-schemas: schemas/CORPUS_TAG says ${tag} but @openwop/openwop-conformance@${installed} certifies ${certified}.`);
    console.error('  Vendored schemas and the suite artifact stamp must name the same corpus release.');
    // The tag FORM depends on the major, and hardcoding the 1.x form sent a
    // reader to a tag that does not exist. MEASURED 2026-09-12 while pinning
    // 2.1.4: the corpus `openwop-conformance/vN` namespace stops at
    // `v2.0.0-rc.67`; every 2.x release since is tagged BARE (`v2.1.4`). So the
    // old remedy failed with "tag does not exist" — and so would the form for
    // the tag already recorded in CORPUS_TAG, meaning the message was wrong
    // about both halves of its own comparison. `sync-schemas.sh:45` documents
    // both forms correctly; only this message did not. A remedy that cannot be
    // pasted is worse than none: it spends the reader's trust before their time.
    const major = Number(installed.split('.')[0]);
    const tagForm = certifiedCorpusTag ?? (major >= 2 ? `v${installed}` : `openwop-conformance/v${installed}`);
    console.error(`  Either install a suite that certifies ${tag} or re-vendor: bash scripts/sync-schemas.sh --tag ${tagForm}`);
    // The clone does NOT need to be at that tag (2026-09-23): `sync-schemas.sh`
    // reads the release out of the tag with `git archive` and leaves the shared
    // checkout alone. This line used to say `git worktree add --detach …` +
    // OPENWOP_CORPUS_DIR, because the script then demanded a checkout at the tag
    // and `git checkout` on the SHARED clone is what CLAUDE.md forbids. The
    // throwaway worktree is no longer part of the path; only the tag must exist
    // locally.
    console.error(`  The clone can sit on any branch — the sync reads ${tagForm} itself. If it is missing:`);
    console.error(`  git -C ../openwop fetch --tags`);
    process.exit(1);
  }
}

if (drift.length || missing.length) {
  console.error(`check-vendored-schemas: load-bearing vendored schemas are out of sync with canonical (${sourceLabel}).`);
  for (const d of drift) console.error(`  DRIFT:   ${d} [${driftDirection(d)}]`);
  for (const m of missing) console.error(`  MISSING: ${m}`);
  console.error(`\n  These schemas are compiled + validated at runtime — a stale copy is a real`);
  console.error(`  validation bug.`);

  // Remedy depends on WHICH SIDE is ahead. `sync-schemas.sh` overwrites vendored
  // WITH canonical, so recommending it unconditionally is destructive when the app's
  // copy is the newer one: it silently DELETES fields the app validates against.
  // (This bit us once — the app had RFC 0123's `vendor` field while the local corpus
  // clone was 32 commits stale and lacked the RFC entirely.)
  const anyAhead = drift.some((d) => driftDirection(d) === AHEAD);
  const behind = corpusBehindCount();
  if (behind > 0) {
    console.error(`\n  ⚠ Your corpus checkout is ${behind} commit(s) BEHIND its upstream.`);
    console.error(`    Update it FIRST, then re-run this check — the drift may not be real:`);
    console.error(`      git -C ${corpusDir} pull --ff-only`);
  }
  if (anyAhead) {
    console.error(`\n  ⚠ At least one vendored schema is a SUPERSET of canonical (app is ahead).`);
    console.error(`    Do NOT run sync-schemas.sh yet — it would DELETE the newer field(s).`);
    console.error(`    Either the corpus is stale (see above), or the app vendored a schema`);
    console.error(`    whose RFC has not landed upstream — in which case land the RFC first.`);
  } else {
    console.error(`\n  Refresh with: bash scripts/sync-schemas.sh --tag openwop-conformance/v<installed suite version>`);
  }
  process.exit(1);
}

console.log(`check-vendored-schemas: ok — all ${checked} load-bearing vendored schema(s) match canonical (${sourceLabel}).`);
