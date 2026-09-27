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
const SUPPRESSION = constString('routes/discovery.ts', 'sideEffectSuppression');

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
 * ADR 0550 P4 — the shipped conformance CLAIMS, if this checkout produced any.
 *
 * The other arms of this script compare a wire value against SOURCE. This one
 * cannot: a profile claim is not decidable from source, only from the RFC 0148
 * ledger of a run. So the SSoT here is the stamped artifact
 * (`build-meta/conformance-claims.json`), which is the same file
 * `COPY build-meta ./build-meta` puts in the image — i.e. the exact bytes the
 * running host reads.
 *
 * WHY IT NEEDS AN ARM AT ALL. A stale claims document is invisible on the wire
 * in both directions. A host that stopped certifying still serves yesterday's
 * profile list (the `sideEffectSuppression` failure this file was born from,
 * applied to evidence), and a host whose claims never reached the image is
 * indistinguishable — per RFC 0089 §D — from one that legitimately publishes
 * none. From the deployer's vantage the two are distinguishable, because the
 * deployer knows what it certified. Same argument as the `contractProvenance`
 * arm below, one layer up: there the wire cannot diagnose ABSENCE, here it
 * cannot diagnose STALENESS.
 */
function shippedClaims() {
  try {
    // `OPENWOP_BUILD_META_DIR` is the SAME seam `src/host/buildInfo.ts` and
    // `src/host/conformanceClaims.ts` read. One name across the writer, the
    // server and this checker means a test can stage all three consistently;
    // inventing a second variable here would be a second place to get it wrong.
    const dir = process.env.OPENWOP_BUILD_META_DIR?.trim() || join(ROOT, 'build-meta');
    const raw = readFileSync(join(dir, 'conformance-claims.json'), 'utf8');
    const doc = JSON.parse(raw);
    if (typeof doc?.claimsVersion !== 'string' || !Array.isArray(doc?.claimedProfiles)) {
      throw new Error('build-meta/conformance-claims.json is not a claims document (no claimsVersion / claimedProfiles)');
    }
    return doc;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('build-meta/')) throw err;
    return null; // not certified in this checkout — the SKIP arm below says so out loud
  }
}
const CLAIMS = shippedClaims();

/**
 * WHD-18 / ADR 0735 — ORIGIN MODE. When the deployed service serves its
 * certification evidence from an out-of-image origin (`OPENWOP_CERT_BUNDLE_ORIGIN`,
 * the SAME variable the service reads — `deploy.sh` exports every
 * `scripts/deploy.env` key, so a deploy-driven verify sees it; a hand-run
 * verify must export it), the build-meta arm below is the WRONG oracle: the
 * image's pre-deploy claims are deliberately not served, so comparing the wire
 * against them would red every healthy origin-mode deploy.
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

/**
 * Canonical JSON — sorted keys, no incidental whitespace.
 *
 * A SECOND implementation of `conformance/certify.ts`'s `canonicalJson`, and
 * the duplication is deliberate rather than sloppy: this file is plain ESM run
 * by a deploy script, and the original lives in a module that imports a
 * devDependency the runtime stage strips. Importing it here would make the
 * deploy verifier depend on the dev graph.
 *
 * The duplication is SAFE because it fails closed. The two are compared through
 * `evidence.bundleSha256` on every run: if they ever disagree about byte order,
 * the digest check below goes RED rather than quietly passing. A drifting copy
 * announces itself here instead of hiding.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
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
      // ADR 0550 P4. Present only when this checkout stamped a bundle, mirroring
      // the runtime gate: `host/conformanceClaims.ts` omits the pointer when the
      // image carries none, so a fixture that always emitted it would assert a
      // shape the honest posture does not produce. The value is a placeholder —
      // the check asserts the pointer EXISTS (the URL's origin is the deployed
      // host's, which a fixture cannot know) and compares the CLAIMS document
      // for equality.
      ...(CLAIMS && !ORIGIN_MODE ? { conformance: { certificationBundleUrl: 'https://example.invalid/v1/host/openwop-app/conformance/certification-bundle' } } : {}),
      replay: { sideEffectSuppression: SUPPRESSION },
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

const checks = [
  ['replay.sideEffectSuppression', caps.replay?.sideEffectSuppression, SUPPRESSION],
  ['a2a.protocolVersions', JSON.stringify(caps.a2a?.protocolVersions), JSON.stringify(A2A)],
  ['a2a.preferredVersion', caps.a2a?.preferredVersion, A2A[0]],
  ['mcp.protocolVersions', JSON.stringify(caps.mcp?.protocolVersions), JSON.stringify(MCP)],
];

// RFC 0146 gets its own arm rather than a row above, because its ABSENCE is the
// failure — the generic comparison would read `undefined` vs a version as an
// ordinary mismatch and print a diagnosis that misses the point entirely.
let failed = 0;
if (SUITE) {
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

// ── ADR 0550 P4 — the deployed CLAIMS must equal the shipped artifact ───────
//
// Two assertions, and the order matters: the pointer must be advertised, and the
// document it points past must be the one we built. Checking only the pointer
// would pass against a host serving a different host's evidence; checking only
// the document would pass against a host that publishes evidence nobody can
// discover.
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
    const cRes = await fetch(`${base}/v1/host/openwop-app/conformance/claims?cb=${Date.now()}`, { redirect: 'follow' }).catch(() => null);
    if (cRes && cRes.status === 404) {
      console.log(`  ${'conformance claims document'.padEnd(30)} OK       withheld in origin mode (404)`);
    } else {
      console.log(`  ${'conformance claims document'.padEnd(30)} STALE    ${cRes ? cRes.status : 'fetch failed'} — origin mode must not serve the in-image claims`);
      failed++;
    }
  }
} else if (CLAIMS) {
  const liveUrl = caps.conformance?.certificationBundleUrl;
  if (typeof liveUrl !== 'string' || liveUrl === '') {
    console.log(`  ${'conformance.certificationBundleUrl'.padEnd(30)} MISSING  this build stamped claims but the wire advertises no pointer`);
    console.error('\n  `build-meta/conformance-claims.json` exists in this checkout, so the image');
    console.error('  carries a bundle and RFC 0089 §D\'s pointer MUST be advertised. Absence here is');
    console.error('  the same shape as the contractProvenance failure: legitimate for a host that');
    console.error('  never certified, and a silent regression for one that did.');
    failed++;
  } else {
    console.log(`  ${'conformance.certificationBundleUrl'.padEnd(30)} OK       ${liveUrl}`);
  }

  const claimsRes = await fetch(`${base}/v1/host/openwop-app/conformance/claims?cb=${Date.now()}`, { redirect: 'follow' });
  const claimsType = claimsRes.headers.get('content-type') ?? '';
  if (!claimsType.includes('json')) {
    console.log(`  ${'conformance claims document'.padEnd(30)} STALE    ${claimsRes.status} ${claimsType} — not a claims document`);
    failed++;
  } else {
    const live = await claimsRes.json();
    // Compare the CLAIM, not the whole document: `generatedAt` and the digests
    // are the evidence's identity, and the profile list is the assertion a peer
    // relies on. A mismatch in either direction is a deployed claim that the
    // artifact we built does not substantiate.
    const liveProfiles = JSON.stringify(live?.claimedProfiles ?? null);
    const wantProfiles = JSON.stringify(CLAIMS.claimedProfiles);
    const liveBundle = live?.evidence?.bundleSha256 ?? null;
    const wantBundle = CLAIMS.evidence?.bundleSha256 ?? null;
    if (liveProfiles === wantProfiles && liveBundle === wantBundle) {
      console.log(`  ${'conformance claims document'.padEnd(30)} OK       ${CLAIMS.claimedProfiles.length} profile(s), evidence ${String(wantBundle).slice(0, 12)}`);
    } else {
      console.log(`  ${'conformance claims document'.padEnd(30)} STALE    live=${liveProfiles} @${String(liveBundle).slice(0, 12)}`);
      console.log(`  ${''.padEnd(30)}          built=${wantProfiles} @${String(wantBundle).slice(0, 12)}`);
      failed++;
    }

    // ── The pointer must RESOLVE, and what it resolves to must be the evidence
    //    the claims document names.
    //
    // Everything above compares documents. This follows the link a third party
    // would follow. A pointer that 404s, or that resolves to a bundle whose
    // digest is not the one the claims bind, is a claim nobody can check — which
    // is the same as no claim, except that it looks like one. RFC 0089 §B says a
    // consumer MUST re-evaluate rather than trust `claimedProfiles` verbatim, so
    // the deployer had better make sure there is something to re-evaluate.
    if (typeof liveUrl === 'string' && liveUrl !== '') {
      // Follow the PATH the host advertised, against the origin we are checking:
      // the advertised HOST may legitimately differ (a custom domain in front of
      // the same service), and dialling it instead would test DNS rather than
      // this deploy.
      //
      // ADR 0614 — this comment used to say "(custom domain, rewrite prefix)",
      // treating those as one benign category. They are not, and the difference
      // is a live defect this check could not see:
      //
      //   - a different HOST is a deployment detail the origin-relative dial
      //     correctly ignores;
      //   - a different PATH PREFIX means the advertised URL is unfollowable by
      //     the only party it exists for.
      //
      // MEASURED 2026-09-01 on app.openwop.dev: the advertised bundle URL
      // returned `200 text/html` (the SPA catch-all) while `${base}${path}` —
      // with `/api` in `base` — returned JSON. This check passed on every deploy
      // while the published pointer resolved to a web page. That is exactly the
      // state the docblock above warns about: "a host that publishes evidence
      // nobody can discover".
      //
      // So: keep the origin-relative dial as the primary assertion, and ALSO
      // dial the absolute URL when its host matches the origin under test. Same
      // host + wrong path is a defect; different host is skipped with a reason,
      // never silently.
      const path = liveUrl.replace(/^https?:\/\/[^/]+/, '');
      const advertisedHost = (liveUrl.match(/^https?:\/\/([^/]+)/) ?? [])[1] ?? '';
      const baseHost = (base.match(/^https?:\/\/([^/]+)/) ?? [])[1] ?? '';
      if (advertisedHost && advertisedHost === baseHost) {
        const aRes = await fetch(`${liveUrl}?cb=${Date.now()}`, { redirect: 'follow' }).catch(() => null);
        const aType = aRes?.headers.get('content-type') ?? '';
        if (!aRes || !aType.includes('json')) {
          console.log(`  ${'advertised url is followable'.padEnd(30)} BROKEN   ${aRes ? `${aRes.status} ${aType}` : 'fetch failed'} — a consumer following the ADVERTISED url does not get the bundle`);
          console.error('\n  The pointer resolves origin-relatively but not as published. That is a');
          console.error('  mount-prefix divergence: the host advertises root-relative wire URLs while');
          console.error('  being served under a prefix. Fix the ROUTING (serve the wire at the origin');
          console.error('  root) rather than the advert — see ADR 0614.');
          failed++;
        } else {
          console.log(`  ${'advertised url is followable'.padEnd(30)} OK       ${liveUrl}`);
        }
      } else {
        console.log(`  ${'advertised url is followable'.padEnd(30)} SKIPPED  advertised host ${advertisedHost || '(none)'} != ${baseHost} — dialling it would test DNS, not this deploy`);
      }
      const bRes = await fetch(`${base}${path}?cb=${Date.now()}`, { redirect: 'follow' });
      const bType = bRes.headers.get('content-type') ?? '';
      if (!bType.includes('json')) {
        console.log(`  ${'certification bundle resolves'.padEnd(30)} BROKEN   ${bRes.status} ${bType} — the advertised pointer does not serve a bundle`);
        failed++;
      } else {
        const bundle = await bRes.json();
        const problems = [];
        // RFC 0148 §C's discriminator. A v1 bundle cannot express dispositions,
        // so serving one through a pointer that promises v2 evidence overstates
        // what a consumer can verify.
        if (bundle?.bundleVersion !== '2') problems.push(`bundleVersion=${JSON.stringify(bundle?.bundleVersion)}, expected "2"`);
        // The binding: the claims document's digest must be OF this bundle.
        const digest = sha256(canonicalJson(bundle));
        if (digest !== CLAIMS.evidence?.bundleSha256) {
          problems.push(`bundle digest ${digest.slice(0, 12)} != claims evidence.bundleSha256 ${String(CLAIMS.evidence?.bundleSha256).slice(0, 12)}`);
        }
        // And the two documents must name the same profiles. The digest already
        // implies this, but reporting it separately turns "some byte differs"
        // into the diagnosis a reader can act on.
        const bundleProfiles = JSON.stringify(bundle?.claimedProfiles ?? null);
        if (bundleProfiles !== wantProfiles) problems.push(`bundle claims ${bundleProfiles}, claims document claims ${wantProfiles}`);
        if (problems.length === 0) {
          console.log(`  ${'certification bundle resolves'.padEnd(30)} OK       v2, ${(bundle.results?.requirements ?? []).length} requirement row(s), digest matches`);
        } else {
          console.log(`  ${'certification bundle resolves'.padEnd(30)} BROKEN`);
          for (const p of problems) console.log(`  ${''.padEnd(30)}          ${p}`);
          failed++;
        }
      }
    }
  }
} else {
  // Loud, never silent — a skip is the check not running.
  console.log(`  ${'conformance claims document'.padEnd(30)} SKIP     (this checkout has no build-meta/conformance-claims.json)`);
  if (caps.conformance?.certificationBundleUrl !== undefined) {
    console.log(`  ${''.padEnd(30)}          live advertises ${caps.conformance.certificationBundleUrl} — cannot verify from this checkout`);
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

for (const [name, live, expected] of checks) {
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
