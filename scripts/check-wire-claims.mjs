#!/usr/bin/env node
/**
 * Does the DEPLOYED capability document still say what the source says?
 *
 * WHY THIS EXISTS. On 2026-08-15 this host served
 * `replay.sideEffectSuppression: "recorded-outcome"` for four days after the
 * withdrawal merged — a capability claim `main` had explicitly retracted,
 * because the retraction was CODE and the only thing deployed since had been an
 * ENV change (which needs no image). `scripts/verify-deploy.sh` passed
 * throughout, correctly: it asserts the deployed COMMIT, and the commit was
 * never the thing in question. The spec steward found it by reading the
 * document while checking something else.
 *
 * A commit stamp proves WHICH SOURCE is running. It does not prove WHAT THAT
 * SOURCE CLAIMS — and a wire claim is the thing peers actually rely on.
 *
 * THE PRINCIPLE, one layer out from the §A adverts: the wire and the source
 * must not be able to disagree about what this host claims. The §A fields are
 * DERIVED from `host/a2aProfile.ts` / `host/mcpProfile.ts` so the advert and the
 * refusal path cannot drift; this asserts the same for the advert and the
 * DEPLOYED document.
 *
 * WHAT IT DOES NOT DO. It does not diff the whole document. Most of that
 * document is runtime-dependent (env flags, BYOK posture, storage backend), so a
 * full diff would be noise and would get silenced — the failure mode the
 * steward named for a check whose diagnosis is wrong. It binds the claims whose
 * value is decided by SOURCE ALONE, read from the source's own SSoT rather than
 * re-typed here. Re-typing them would make this a second place to update, i.e.
 * exactly the drift it exists to catch.
 *
 *   node scripts/check-wire-claims.mjs <base-url>
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'backend/typescript/src');
const base = (process.argv[2] ?? process.env.BASE ?? '').replace(/\/+$/, '');
if (!base) {
  console.error('usage: check-wire-claims.mjs <base-url>   (or BASE=…)');
  process.exit(2);
}

/**
 * Pull an array out of a `const X = [...]` declaration, resolving both quoted
 * literals and NAMED CONSTANTS declared in the same file.
 *
 * The named-constant arm was added for ADR 0553 P2. `MCP_SUPPORTED_VERSIONS`
 * stopped being `['2025-06-18']` and became `[MCP_CURRENT_VERSION,
 * MCP_LEGACY_VERSION]`, because the codec-selection and `server/discover` paths
 * need to name the two revisions individually and a second spelling of the same
 * date is exactly the drift `host/mcpProfile.ts` exists to prevent.
 *
 * The literal-only parser then matched the declaration and extracted NOTHING —
 * and, to its considerable credit, threw instead of comparing the advert
 * against an empty list and passing. That refusal is the only reason this was a
 * red build rather than a wire check that had quietly stopped checking. Fixing
 * the parser is what the error message asks for; inlining the dates back into
 * the array to appease it would have re-created the duplicate.
 */
function constArray(file, name) {
  const src = readFileSync(join(SRC, file), 'utf8');
  const m = new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(src);
  if (!m) throw new Error(`could not read ${name} from ${file} — the SSoT moved; fix this script rather than deleting the check`);
  const out = [];
  for (const raw of m[1].split(',')) {
    const token = raw.trim();
    if (token === '') continue;
    const literal = /^'([^']+)'$/.exec(token);
    if (literal) { out.push(literal[1]); continue; }
    if (/^[A-Za-z_$][\w$]*$/.test(token)) {
      // A named constant in the SAME file. Fail closed if it does not resolve:
      // an unresolvable name must never silently shrink the list.
      const ref = new RegExp(`\\b${token}\\b[^=\\n]*=\\s*'([^']+)'`).exec(src);
      if (!ref) throw new Error(`${name} in ${file} references ${token}, which does not resolve to a string constant in the same file`);
      out.push(ref[1]);
      continue;
    }
    throw new Error(`${name} in ${file} has an element this script cannot read (${token}) — fix this script rather than deleting the check`);
  }
  if (out.length === 0) throw new Error(`${name} in ${file} parsed EMPTY — refusing to compare against nothing`);
  return out;
}

/** The literal a source file states for a single-valued claim. */
function constString(file, key) {
  const src = readFileSync(join(SRC, file), 'utf8');
  const m = new RegExp(`^\\s*${key}:\\s*'([^']+)',`, 'm').exec(src);
  if (!m) throw new Error(`could not read ${key} from ${file} — the advert moved; fix this script rather than deleting the check`);
  return m[1];
}

const A2A = constArray('host/a2aProfile.ts', 'A2A_SUPPORTED_VERSIONS');
const MCP = constArray('host/mcpProfile.ts', 'MCP_SUPPORTED_VERSIONS');
// ADR 0812 P4 deleted the v1 discovery document, the only place this host ever
// stated `replay.sideEffectSuppression`; v2 deleted the field outright
// (capabilities.md §Deleted fields; v2 `replay` is a family record). So the
// source carries no literal any more, and `null` means "this host claims
// nothing". The v1-only row below still reads N/A on a v2-only host; against a
// document that is not v2-only, absence on both sides is consistent and a served
// value the source no longer states is STALE.
const SUPPRESSION = (() => {
  const src = readFileSync(join(SRC, 'routes/discovery.ts'), 'utf8');
  const m = /^\s*sideEffectSuppression:\s*'([^']+)',/m.exec(src);
  return m ? m[1] : null;
})();

/**
 * RFC 0146 `contractProvenance.suiteVersion` — the one claim whose ABSENCE the
 * wire can never diagnose, and therefore the one that has to be checked here.
 *
 * Requirement 1 makes absence LEGITIMATE (absent ⇒ unspecified). So an honest
 * omission and a derivation that threw are the SAME BYTES, and no reader of the
 * document can tell them apart. That is not a defect in the RFC; it is a
 * property of an optional field, and it is why this host shipped the field
 * DEPLOYED AND SILENTLY INERT for four days (`@openwop/openwop-conformance` is
 * a devDependency; `Dockerfile:85` runs `npm ci --omit=dev`, so the runtime
 * `require.resolve` threw and the field vanished). Nothing was wrong on the
 * wire. That is exactly why nobody looked.
 *
 * The deployer is the only vantage point from which the two are distinguishable,
 * because the deployer knows which suite it built against. Hence: if this
 * checkout produced a stamp, the document MUST carry it.
 */
function expectedSuiteVersion() {
  // The shipped artifact first — `build-meta/corpus-suite.txt` is what was
  // COPYed into the image, so it is the value the running host could have read.
  try {
    const v = readFileSync(join(ROOT, 'build-meta/corpus-suite.txt'), 'utf8').trim();
    if (/^\d+\.\d+\.\d+/.test(v)) return { version: v, from: 'image stamp' };
  } catch { /* not stamped in this checkout — fall through */ }
  // Dev fallback: the installed package the stamp would have been derived FROM.
  // Without this the check would silently skip in every non-deploy run, which is
  // the "green that never ran" failure this whole program exists to remove.
  try {
    // Resolve from the workspace that DECLARES the dependency — the same
    // createRequire base `scripts/write-build-commit.mjs` uses, so the checker
    // and the stamp writer read one package rather than two lookups that can
    // disagree.
    const req = createRequire(join(ROOT, 'backend', 'typescript', 'package.json'));
    const v = req('@openwop/openwop-conformance/package.json').version;
    if (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) return { version: v, from: 'installed package' };
  } catch { /* neither available */ }
  return null;
}
const SUITE = expectedSuiteVersion();

/**
 * WHD-18 / ADR 0735 — ORIGIN MODE. When the deployed service serves its
 * certification evidence from an out-of-image origin (`OPENWOP_CERT_BUNDLE_ORIGIN`,
 * the SAME variable the service reads — `deploy.sh` exports every
 * `scripts/deploy.env` key, so a deploy-driven verify sees it; a hand-run
 * verify must export it). This used to sit beside a build-meta (image-mode)
 * arm; that arm was deleted with the image half (ADR 0812 P4 slice 5), so
 * origin mode is the only evidence check.
 *
 * The oracle instead is the bundle's OWN binding: it must be v3, attribute to
 * the commit we expected (`EXPECTED_COMMIT`, passed by `verify-deploy.sh`), be
 * for the major whose root advertised it, and verify under a key the LIVE host
 * publishes. The same checks the host ran before serving it
 * (`lib/bundle-v3-verify.mjs`, parity-tested against the TS verifier).
 *
 * A pointer that is ABSENT is `PENDING`, never OK and never a failure: evidence
 * is cut AFTER the deploy (`scripts/publish-evidence.sh`), so every fresh
 * revision starts without it, correctly. Failing the deploy for that would make
 * the verify red by construction; calling it OK would claim a check ran.
 */
const ORIGIN_MODE = Boolean(process.env.OPENWOP_CERT_BUNDLE_ORIGIN?.trim());
const EXPECTED_COMMIT = process.env.EXPECTED_COMMIT?.trim() ?? '';

const sha256 = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

// `--emit-expected` prints the minimal document this check would ACCEPT. The
// deploy-gate fixture serves that as its stub capability document, so the
// fixture and the checker cannot disagree about the expected values — they come
// from the same SSoT read, not from a second copy typed into the test.
if (process.argv.includes('--emit-expected')) {
  process.stdout.write(JSON.stringify({
    // `contractProvenance` sits at the ROOT, where `capabilities.schema.json`
    // defines it — NOT inside the nested object. Emitting it nested is how the
    // fixture stopped being able to catch the placement bug: the stub and the
    // checker were built from this one function, so they agreed with each other
    // about the wrong shape and the gate passed 21/21 while the real check could
    // never go green. Sharing a source removes drift in the VALUES; it cannot
    // validate the STRUCTURE, because the structure is what both sides inherited.
    // The schema is the only authority for placement, so this mirrors the schema.
    ...(SUITE ? { contractProvenance: { suiteVersion: SUITE.version } } : {}),
    capabilities: {
      ...(SUPPRESSION ? { replay: { sideEffectSuppression: SUPPRESSION } } : {}),
      a2a: { protocolVersions: A2A, preferredVersion: A2A[0] },
      mcp: { supported: true, protocolVersions: MCP },
    },
  }, null, 2));
  process.exit(0);
}

const res = await fetch(`${base}/.well-known/openwop?cb=${Date.now()}`, { redirect: 'follow' });
const ctype = res.headers.get('content-type') ?? '';
if (!ctype.includes('json')) {
  // The CDN answers `200 text/html` for unmatched paths. Treating that as a
  // capability document would compare against an app shell and "pass".
  console.error(`✗ ${base}/.well-known/openwop returned ${res.status} ${ctype} — not a capability document.`);
  console.error('  If this is the hosting origin, point BASE at the backend origin; no claim was witnessed here.');
  process.exit(1);
}
const doc = await res.json();
const caps = doc.capabilities ?? doc;

// A host that has RETIRED v1 (ADR 0669; every host since ADR 0812) serves only the
// major-2 representation, so the header-less read above returns the v2 document.
// Two of this file's claims are v1-ROOT fields that the v2 capabilities schema
// does not define at all: `contractProvenance` and `replay.sideEffectSuppression`
// (v2 `replay` is a family record). Found on the 2026-10-04 cut of
// app.openwop.dev: both read as MISSING/STALE on a healthy deploy. (The claims
// arms need no change: the claims route is served unversioned after the cut,
// and the v2 schema keeps `conformance.certificationBundleUrl`, at the root,
// where `caps` already lands on a document with no nested `capabilities`.) The
// prescribed remedy ("deploy the backend") could never clear them, which is the
// same false diagnosis the a2a arm below was fixed for.
// The predicate is the advertised version list, never an assumption: a document
// without `protocolVersions` keeps the v1 behaviour.
const V2_ONLY = Array.isArray(doc.protocolVersions)
  && doc.protocolVersions.length > 0
  && !doc.protocolVersions.some((v) => String(v).startsWith('1.'));
// Both fields were DELETED at v2 (RFC 0169 §A.5; spec/v2/core/capabilities.md
// §Deleted fields). Provenance now rides the signed v3 bundle's `host.build` and
// `suite.version`, which the origin-mode arm below verifies.
const NOT_IN_V2 = `N/A      (v2-only host: protocolVersions ${JSON.stringify(doc.protocolVersions)}; deleted at v2, capabilities.md §Deleted fields)`;

const checks = [
  ['replay.sideEffectSuppression', caps.replay?.sideEffectSuppression, SUPPRESSION, { v1Only: true }],
  ['a2a.protocolVersions', JSON.stringify(caps.a2a?.protocolVersions), JSON.stringify(A2A)],
  ['a2a.preferredVersion', caps.a2a?.preferredVersion, A2A[0]],
  ['mcp.protocolVersions', JSON.stringify(caps.mcp?.protocolVersions), JSON.stringify(MCP)],
];

// RFC 0146 gets its own arm rather than a row above, because its ABSENCE is the
// failure — the generic comparison would read `undefined` vs a version as an
// ordinary mismatch and print a diagnosis that misses the point entirely.
let failed = 0;
if (V2_ONLY) {
  console.log(`  ${'contractProvenance.suiteVersion'.padEnd(30)} ${NOT_IN_V2}`);
} else if (SUITE) {
  // ROOT, not `caps`. `capabilities.schema.json` puts `contractProvenance` at the
  // document root beside `protocolVersion` — the schema has no nested
  // `capabilities` object at all — while this host nests `replay`/`a2a`/`mcp`
  // under one. Reading it through the same `doc.capabilities ?? doc` heuristic as
  // those looked right and could NEVER have gone green: the field is served
  // correctly and the check reported it MISSING for 30 minutes, blocking a
  // healthy deploy at the verify step.
  //
  // This is the mirror of the flaw this check exists to catch. A check that has
  // only ever gone RED has not been shown to go green, and this one could not
  // have. It was only found because the green half was demanded as evidence
  // rather than assumed to follow — the red half agreed with reality twice, for
  // real reasons, which is exactly what a broken detector looks like from inside.
  const live = (doc.contractProvenance ?? caps.contractProvenance)?.suiteVersion;
  if (live === SUITE.version) {
    console.log(`  ${'contractProvenance.suiteVersion'.padEnd(30)} OK       ${live}`);
  } else if (live === undefined) {
    console.log(`  ${'contractProvenance.suiteVersion'.padEnd(30)} MISSING  expected ${SUITE.version} (${SUITE.from})`);
    console.error('\n  The field is ABSENT but this build has a suite stamp. Absence is legitimate');
    console.error('  under RFC 0146 req 1, which is precisely why it cannot be caught on the wire:');
    console.error('  an honest omission and a derivation that threw are the same bytes. From here');
    console.error('  they are not — we know what we built against. Most likely the value did not');
    console.error('  survive the runtime stage (devDependency + `npm ci --omit=dev`).');
    failed++;
  } else {
    console.log(`  ${'contractProvenance.suiteVersion'.padEnd(30)} STALE    live=${live}  build=${SUITE.version}`);
    failed++;
  }
} else {
  // Loud, not silent: a skip here is the check not running, and this program has
  // already shipped one green that never ran.
  console.log(`  ${'contractProvenance.suiteVersion'.padEnd(30)} SKIP     (no image stamp and no installed conformance package)`);
  if ((doc.contractProvenance ?? caps.contractProvenance) !== undefined) {
    console.log(`  ${''.padEnd(30)}          live advertises ${JSON.stringify(doc.contractProvenance ?? caps.contractProvenance)} — cannot verify from this checkout`);
  }
}

// ── certification evidence (WHD-18 / ADR 0735; image mode removed, ADR 0812 P4) ──
//
// Only origin mode serves evidence now. Its oracle is the signed bundle's own
// binding (see ORIGIN_MODE above), and the in-image claims document must stay
// withheld (404).
if (ORIGIN_MODE) {
  const { verifyServedBundle } = await import('./lib/bundle-v3-verify.mjs');
  const liveKeys = Array.isArray(doc.signingKeys) ? doc.signingKeys : [];
  const commit = /^[0-9a-f]{40}$/.test(EXPECTED_COMMIT) ? EXPECTED_COMMIT : '';
  if (!commit) {
    // Not a pass. Without the full expected commit there is nothing to bind the
    // bundle to, and "v3 and signed" alone would accept a bundle for any build.
    console.log(`  ${'certification evidence'.padEnd(30)} UNCHECKED origin mode needs EXPECTED_COMMIT=<40-hex> (verify-deploy.sh passes it)`);
    failed++;
  } else {
    // The major-2 root is a SEPARATE representation of the same resource.
    let v2doc = null;
    try {
      const r2 = await fetch(`${base}/.well-known/openwop?cb=${Date.now()}`, { redirect: 'follow', headers: { 'OpenWOP-Version': '2' } });
      if ((r2.headers.get('content-type') ?? '').includes('json')) v2doc = await r2.json();
    } catch { /* reported below as an unreadable root */ }
    const UNREADABLE = Symbol('unreadable');
    const roots = [
      [1, caps.conformance?.certificationBundleUrl],
      [2, v2doc === null ? UNREADABLE : v2doc.conformance?.certificationBundleUrl],
    ];
    for (const [major, pointer] of roots) {
      const label = `certification bundle (major ${major})`.padEnd(30);
      if (major === 1 && V2_ONLY) {
        // The header-less read IS the v2 document here; checking it as major 1
        // would verify the major-2 pointer against major-1 expectations.
        console.log(`  ${label} N/A      (v1 retired: the host serves no major-1 root)`);
        continue;
      }
      if (pointer === UNREADABLE) {
        console.log(`  ${label} BROKEN   the major-2 discovery root did not answer JSON`);
        failed++;
        continue;
      }
      if (typeof pointer !== 'string' || pointer === '') {
        console.log(`  ${label} PENDING  (no evidence published for ${commit.slice(0, 12)} yet — run scripts/publish-evidence.sh)`);
        continue;
      }
      const path = pointer.replace(/^https?:\/\/[^/]+/, '');
      const bRes = await fetch(`${base}${path}?cb=${Date.now()}`, { redirect: 'follow' }).catch(() => null);
      const bType = bRes?.headers.get('content-type') ?? '';
      if (!bRes || !bRes.ok || !bType.includes('json')) {
        console.log(`  ${label} BROKEN   ${bRes ? `${bRes.status} ${bType}` : 'fetch failed'} — the advertised pointer does not serve a bundle`);
        failed++;
        continue;
      }
      const text = await bRes.text();
      let bundle;
      try { bundle = JSON.parse(text); } catch { bundle = undefined; }
      const verdict = verifyServedBundle(bundle, { commit, major, signingKeys: liveKeys });
      if (verdict.ok) {
        console.log(`  ${label} OK       v3, build ${commit.slice(0, 12)}, signed by ${verdict.keyId} (live key), sha256 ${sha256(text).slice(0, 12)}`);
      } else {
        console.log(`  ${label} BROKEN   [${verdict.reason}] ${verdict.detail}`);
        failed++;
      }
    }
    // In origin mode the host publishes no separate claims document (ADR 0735,
    // 2026-09-21 record). A 200 here means the image's pre-deploy claims — the
    // artifact origin mode exists to withdraw — are still being served.
    const cRes = await fetch(`${base}/host/openwop-app/conformance/claims?cb=${Date.now()}`, { redirect: 'follow' }).catch(() => null);
    if (cRes && cRes.status === 404) {
      console.log(`  ${'conformance claims document'.padEnd(30)} OK       withheld in origin mode (404)`);
    } else {
      console.log(`  ${'conformance claims document'.padEnd(30)} STALE    ${cRes ? cRes.status : 'fetch failed'} — origin mode must not serve the in-image claims`);
      failed++;
    }
  }
} else {
  // ADR 0812 P4 slice 5: the IMAGE-mode arm is gone. It compared the wire with
  // a `build-meta/conformance-claims.json` stamp, and since #4875 deleted the
  // image half (certify.ts, the in-image claims and bundle routes) nothing
  // writes that stamp; `write-build-commit.mjs` deletes a stale one. Origin mode
  // is the only evidence check, and it needs the origin in this run's env.
  // Loud, never silent: a skip is the check not running.
  console.log(`  ${'certification evidence'.padEnd(30)} N/A      (no OPENWOP_CERT_BUNDLE_ORIGIN in this run, so no origin-mode check; verify-deploy.sh reads it from the live service)`);
  if (caps.conformance?.certificationBundleUrl !== undefined) {
    console.log(`  ${''.padEnd(30)}          live advertises ${caps.conformance.certificationBundleUrl} — only origin mode can verify it`);
  }
}

/* ── the A2A AGENT CARD, at the deployed origin (ADR 0552 / item 52-3's gate) ──
 *
 * ADR 0552's Claim record lists its evidence rung as `test-seam`, and names the
 * gap this closes: nothing fetched the CARD from the deployed origin, so every
 * claim about A2A was evidence about a CHECKOUT. A deploy that shipped a
 * different image would not have disturbed any of it. Until this ran, the record
 * PROHIBITED any statement phrased about the running service.
 *
 * Three assertions, each catching something the others cannot:
 *
 *   1. ADVERT vs REACHABILITY. The card route 404s unless
 *      `OPENWOP_A2A_SERVER_ENABLED=true`. So a deployment that ADVERTISES
 *      `capabilities.a2a` while serving no card is claiming an interface it does
 *      not expose — an ENV-only misconfiguration, invisible to the commit stamp
 *      by construction, which is the same class as the four-day
 *      `sideEffectSuppression` drift this whole script exists for.
 *   2. THE 1.0 SHAPE IS REALLY 1.0. `a2aCard.ts`: 1.0 replaced top-level `url` /
 *      `protocolVersion` / `preferredTransport` with a single
 *      `supportedInterfaces[]`, and §C's witness asserts a 1.0 card has NO
 *      top-level `url` — "a card with both shapes is neither". Asserting the
 *      ABSENCE matters as much as the presence: a host that added the new field
 *      without removing the old ones would pass a presence-only check while
 *      serving a card no conformant client can classify.
 *   3. THE HEADER-LESS RULE, which is the one a reasonable person gets backwards.
 *      While `a2a-0.3-legacy` is advertised, a header-less GET returns the 0.3
 *      shape — the spec owner REVERSED this host's first reading (openwop#1028,
 *      RFC 0152 register S18 Q1). Pinning the reversal on the wire is what stops
 *      a future "simplification" back to the intuitive answer.
 *
 * Skipped honestly, and LOUDLY, when a2a is not advertised: an absent card is
 * correct in that posture, and a check that cannot distinguish the two would be
 * worse than no check.
 */
if (caps.a2a?.supported === true) {
  const cardUrl = `${base}/.well-known/agent-card.json?cb=${Date.now()}`;
  const problems = [];
  let card10;
  try {
    const r10 = await fetch(cardUrl, { redirect: 'follow', headers: { 'A2A-Version': '1.0' } });
    if (r10.status === 404) {
      problems.push('a2a is ADVERTISED but /.well-known/agent-card.json is 404 — OPENWOP_A2A_SERVER_ENABLED is not true on the deployed service');
    } else if (!r10.ok) {
      problems.push(`card GET (A2A-Version: 1.0) returned ${r10.status}`);
    } else {
      card10 = await r10.json();
      if (!Array.isArray(card10?.supportedInterfaces)) {
        problems.push('the 1.0 card has no `supportedInterfaces[]` — that is the field 1.0 replaced the transport trio with');
      }
      if (card10?.url !== undefined) {
        problems.push('the 1.0 card carries a top-level `url` — §C: "a card with both shapes is neither"');
      }
    }
  } catch (err) {
    problems.push(`card GET (A2A-Version: 1.0) failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The header-less rule only applies while the legacy profile is advertised.
  const legacyAdvertised = (caps.a2a?.protocolVersions ?? []).includes('0.3');
  if (legacyAdvertised && problems.length === 0) {
    try {
      const rBare = await fetch(cardUrl, { redirect: 'follow' });
      const bare = rBare.ok ? await rBare.json() : null;
      if (bare && bare.protocolVersion !== '0.3') {
        problems.push(`a header-less card GET returned protocolVersion=${JSON.stringify(bare.protocolVersion)}, expected '0.3' while a2a-0.3-legacy is advertised (openwop#1028 reversed the intuitive answer)`);
      }
    } catch (err) {
      problems.push(`header-less card GET failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (problems.length === 0) {
    const n = card10?.supportedInterfaces?.length ?? 0;
    console.log(`  ${'a2a agent card (deployed)'.padEnd(30)} OK       1.0 shape, ${n} interface(s)${legacyAdvertised ? ', header-less GET is 0.3' : ''}`);
  } else {
    console.log(`  ${'a2a agent card (deployed)'.padEnd(30)} BROKEN`);
    for (const p of problems) console.log(`  ${''.padEnd(30)}          ${p}`);
    failed++;
  }
} else {
  console.log(`  ${'a2a agent card (deployed)'.padEnd(30)} SKIP     (a2a not advertised in this posture)`);
}

for (const [name, live, expected, opts] of checks) {
  if (opts?.v1Only && V2_ONLY) {
    console.log(`  ${name.padEnd(30)} ${NOT_IN_V2}`);
    continue;
  }
  // No source claim (ADR 0812 P4): consistent only if the served document is
  // silent too. A served value the source no longer states is a stale image.
  if (opts?.v1Only && expected === null) {
    if (live === undefined) {
      console.log(`  ${name.padEnd(30)} N/A      (claimed nowhere: ADR 0812 P4 deleted the v1 document that stated it)`);
    } else {
      console.log(`  ${name.padEnd(30)} STALE    live=${JSON.stringify(live)}, but the source no longer states this field (ADR 0812 P4) — the running image predates it`);
      failed++;
    }
    continue;
  }
  // `mcp` is env-gated off in some postures; an absent slot is not a stale claim.
  if (name.startsWith('mcp.') && caps.mcp?.supported !== true) {
    console.log(`  ${name.padEnd(30)} SKIP     (mcp not advertised in this posture)`);
    continue;
  }
  // Same for `a2a`, and this arm was MISSING while the agent-card arm below had
  // it — one file, one capability, two answers. Found 2026-09-09 on a live
  // KickTodo deploy: the card arm printed SKIP ("a2a not advertised in this
  // posture") while these two rows printed STALE `live=undefined` in the same
  // run, and the diagnosis they printed — "the running image predates a change
  // to what this host CLAIMS … deploy the backend" — named a cause that was
  // impossible (both halves stamped the same commit, deployed minutes earlier)
  // and prescribed a remedy that can never clear it, because redeploying does
  // not make an unadvertised capability start being advertised. An operator
  // trusting the message redeploys forever.
  //
  // The predicate is ABSENCE, deliberately not `caps.a2a?.supported !== true`
  // like the card arm's. `--emit-expected` emits an `a2a` object with the
  // version fields and NO `supported` flag, so the stricter predicate would skip
  // these rows against this program's own fixture — silently deleting the only
  // coverage they have, which is this same class of defect one turn over. The
  // live emitter omits the whole slot unless OPENWOP_A2A_SERVER_ENABLED is true
  // (`routes/discovery.ts:1855`), so absence is exactly the off posture.
  if (name.startsWith('a2a.') && caps.a2a === undefined) {
    console.log(`  ${name.padEnd(30)} SKIP     (a2a not advertised in this posture)`);
    continue;
  }
  if (String(live) === String(expected)) {
    console.log(`  ${name.padEnd(30)} OK       ${live}`);
  } else {
    console.log(`  ${name.padEnd(30)} STALE    live=${live}  source=${expected}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n✗ ${failed} deployed capability claim(s) disagree with the source.`);
  console.error('  The running image predates a change to what this host CLAIMS. A matching');
  console.error('  commit stamp does not catch this — the commit was never the claim.');
  console.error('  Deploy the backend, or correct the source if the wire is right.');
  process.exit(1);
}
console.log('wire claims match the source.');
