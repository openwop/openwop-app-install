#!/usr/bin/env node
/**
 * ADR 0614 — the OpenWOP wire MUST be reachable at the ORIGIN ROOT.
 *
 * `spec/v1/capabilities.md:32`: a server MAY expose discovery at additional
 * paths but MUST treat `/.well-known/openwop` as CANONICAL; `:30` requires
 * `application/json` there. `app.openwop.dev` violated both for months: hosting
 * rewrote only `/api/**` to Cloud Run, so `/.well-known/openwop` fell through to
 * the SPA catch-all and answered an external OpenWOP client with `text/html`.
 * The host also publishes ROOT-RELATIVE wire URLs (`conformanceClaims.ts` builds
 * `{requestOrigin}{path}`), so an advertised `certificationBundleUrl` resolved
 * to the same web page.
 *
 * This is the gate for that, and it exists because THE ONLY OTHER RECORD WOULD
 * HAVE BEEN A COMMENT. `firebase.json` is JSON: it cannot hold one. The first
 * attempt added a `"_comment"` key to each rewrite, which is worse than
 * useless — every branch of firebase-tools' own `HostingRewrites` schema is
 * `additionalProperties: false`, so the file became schema-INVALID, and the CLI
 * only `logger.debug`s that (`lib/config.js:227`). A silent invalidity, in the
 * file whose correctness the deploy depends on, defended by prose. Hence a
 * check that fails instead.
 *
 * THREE assertions, each for a distinct way this regresses:
 *
 *  1. ORDER. Firebase Hosting takes the FIRST matching rewrite. The wire rules
 *     must precede the SPA catch-all; moving the catch-all up silently restores
 *     the exact bug, with every rule still present and correct-looking.
 *  2. UNKNOWN KEYS. What `_comment` violated. Nothing else catches it: the CLI
 *     logs at debug and deploys anyway.
 *  3. PLAIN JSON. The CLI loads this file with `cjson`, so `//` comments parse
 *     for IT — but `scripts/check-csp-runtime.mjs:29` does a bare `JSON.parse`,
 *     so a comment would break a sibling gate. The tempting fix for (2) is the
 *     one that breaks (3); pin it.
 *
 * Run: node scripts/check-hosting-wire-rewrites.mjs (in `npm run build`).
 */
// COMMONJS ON PURPOSE, and the extension is load-bearing. This runs as a
// `firebase deploy` PREDEPLOY hook, and the Firebase CLI ships as a pkg-bundled
// Node that `require()`s the command it is given: an `.mjs` file there dies with
// `ERR_REQUIRE_ESM` before a single assertion runs. MEASURED 2026-09-08 — it
// failed the frontend half of a real deploy while `prepare-hosting-shell.cjs`,
// the sibling hook two lines below it in firebase.json, ran fine for months.
//
// So the sibling was the existing proof of the right shape and this file did not
// follow it. Do NOT rename this back to `.mjs`: the check would still pass every
// local run (`node file.mjs` is fine) and fail only at deploy time, which is the
// worst place to learn it.
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { dirname, join, relative, resolve } = require('node:path');

// Usage: node check-hosting-wire-rewrites.mjs [path/to/firebase.json]
//
// The path is resolved from THIS FILE, not from the cwd, so the same check runs
// from `npm run build` (cwd frontend/react), from the hosting `predeploy` hook
// (cwd repo root — Firebase runs it on EVERY `firebase deploy`, by hand or
// scripted, which is the one step an operator cannot skip) and from
// `scripts/preflight-deploy.sh`. MEASURED 2026-09-06 on a white-label deploy:
// the adopter edited firebase.json for their service id, deployed by hand
// without rebuilding, and shipped 7 rewrites where v2 needs 34 — every wire
// route fell through to the SPA catch-all. This gate lived only in the build.
const FB = process.argv[2] ? resolve(process.argv[2]) : resolve(__dirname, '../../../firebase.json');
const REPO_ROOT = dirname(FB);
const RAW = readFileSync(FB, 'utf8');

// (3) must stay parseable as PLAIN JSON, not merely as cjson.
let fb;
try {
  fb = JSON.parse(RAW);
} catch (e) {
  console.error(
    `✗ check-hosting-wire-rewrites: firebase.json is not plain JSON (${e.message}).\n` +
    `  The firebase CLI tolerates comments via cjson, but check-csp-runtime.mjs\n` +
    `  does a bare JSON.parse of this file. Remove the comment.`,
  );
  process.exit(1);
}

const rewrites = fb?.hosting?.rewrites;
if (!Array.isArray(rewrites)) {
  console.error('✗ check-hosting-wire-rewrites: hosting.rewrites is missing or not an array.');
  process.exit(1);
}

const fail = (msg) => { console.error(`✗ check-hosting-wire-rewrites: ${msg}`); process.exit(1); };

// (2) Keys firebase-tools' HostingRewrites schema permits alongside a matcher.
const LEGAL = new Set(['source', 'glob', 'regex', 'destination', 'function', 'region', 'run', 'dynamicLinks']);
for (const [i, rw] of rewrites.entries()) {
  const unknown = Object.keys(rw).filter((k) => !LEGAL.has(k));
  if (unknown.length) {
    fail(
      `hosting.rewrites[${i}] has key(s) firebase's schema forbids: ${unknown.join(', ')}.\n` +
      `  Every HostingRewrites branch is additionalProperties:false, and the CLI only\n` +
      `  logs the violation at debug level — it will deploy an invalid config silently.\n` +
      `  Rationale belongs in an ADR or this check, not in the JSON.`,
    );
  }
}

// (1) The wire paths must route to Cloud Run, ahead of the SPA catch-all.
const idxOf = (src) => rewrites.findIndex((rw) => rw.source === src);
const catchAll = rewrites.findIndex((rw) => rw.source === '**');
if (catchAll === -1) fail('no SPA catch-all rewrite ("**") found — this check can no longer prove ordering.');

// (2) ADR 0631 — the MAJOR-2 PATH SPACE is rooted at the discovery host
// (`spec/v2/path-manifest.json`: `serverUrl: https://{host}`), so every
// top-level manifest root MUST reach Cloud Run ahead of the catch-all too.
// MEASURED 2026-09-05 on production: 14 of 15 roots answered `200 text/html`
// (the SPA shell) with no `OpenWOP-Version` — P4-SPEC-15 unmet at the front
// door while met one hop behind it. The roots are DERIVED from the vendored
// manifest (the same file the backend negotiator derives its mounts from), never
// hand-listed: a corpus revision that adds a root must fail this check until
// hosting routes it. Both the bare root (`/runs`) and its subtree (`/runs/**`)
// are required — Firebase's `/x/**` does not match `/x` — and a `:`-suffixed
// operation (`/runs:bulk-cancel`, `/prompts:render`) is its own source.
const MANIFEST = join(REPO_ROOT, 'schemas', 'v2', 'path-manifest.json');
let manifestOps;
try {
  const m = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  manifestOps = Array.isArray(m) ? m : (m.operations ?? m.paths);
} catch (e) {
  fail(`cannot read the vendored v2 path manifest at ${MANIFEST} (${e.message}) — the v2 origin sources cannot be derived, and an underivable list must not pass.`);
}
const opPaths = (Array.isArray(manifestOps) ? manifestOps : Object.keys(manifestOps ?? {}))
  .map((o) => (typeof o === 'string' ? o : String(o?.path ?? '')))
  .filter((p) => p.startsWith('/'));
if (opPaths.length === 0) fail('the v2 path manifest lists no operation paths — refusing to treat an empty list as "nothing to route".');
const v2Sources = new Set();
for (const p of opPaths) {
  const first = p.split('/').filter(Boolean)[0] ?? '';
  if (!first || first === '.well-known') continue;            // discovery is pinned in (1)
  if (first.includes(':')) { v2Sources.add(`/${first}`); continue; } // `/runs:bulk-cancel`
  v2Sources.add(`/${first}`);
  v2Sources.add(`/${first}/**`);
}
const V2_SOURCES = [...v2Sources].sort();
if (V2_SOURCES.length < 10) fail(`derived only ${V2_SOURCES.length} v2 sources from the manifest — below any plausible floor; the derivation is broken, not the manifest.`);

// The RFC 0168 §C.1 conformance-seam space is pinned as a LITERAL, not derived,
// and the manifest says why in its own `$comment`: it is generated with "no seam
// or test-mode operation". So the seam addresses are outside the path space every
// other source on this line comes from — deriving them here is not possible from
// any file this script can read (the host vendors no `api/seams-v2.yaml`).
//
// One literal covers all thirteen because the derivation lives where the data is:
// `v2-conformance-seams-mount.test.ts` asserts every `SEAM_OPERATIONS[].v2Path`
// sits under `SEAMS_PREFIX`. Add a seam outside that prefix and that test goes
// red rather than this guard passing while the new address answers text/html.
const SEAMS_SOURCE = '/conformance/**';

for (const src of ['/.well-known/**', '/v1/**', SEAMS_SOURCE, ...V2_SOURCES]) {
  const i = idxOf(src);
  if (i === -1) {
    fail(
      `no rewrite for "${src}". Without it the SPA catch-all answers the OpenWOP wire\n` +
      (V2_SOURCES.includes(src) ? `  (a v2 manifest root — ADR 0631: advertising major 2 is a claim about the path space)\n` : '') +
      `  with text/html — violating capabilities.md:30 (application/json) and, for\n` +
      `  /.well-known, :32 (canonical discovery). See ADR 0614.`,
    );
  }
  if (!rewrites[i].run?.serviceId) fail(`rewrite for "${src}" does not target a Cloud Run service.`);
  if (i > catchAll) {
    fail(
      `rewrite for "${src}" (index ${i}) comes AFTER the SPA catch-all (index ${catchAll}).\n` +
      `  Firebase Hosting takes the first match, so this rule is dead and the wire\n` +
      `  serves the SPA shell again. Order is the behaviour here, not style.`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// (3) ADR 0641 phase 2 — a `site` route MUST NOT collide with a Cloud Run source.
//
// The `site` tier serves product surfaces at CLEAN ROOT URLs (`/today`). Firebase
// Hosting takes the first matching rewrite, and every source checked above routes
// to Cloud Run AHEAD of the SPA catch-all. So a site route whose path equals or
// sits under one of them never reaches the SPA at all — the request is answered
// by the backend, one layer ABOVE both Express's router and React Router.
//
// Nothing downstream can see this. It is not a 404 the SPA can log, not a route
// the backend recognises, and not a collision any in-app check could detect:
// both halves of the comparison live in files the app never reads at runtime.
// This script already holds both, which is why the gate belongs here.
//
// It is not hypothetical and it is not static. The v2 source list is DERIVED from
// the vendored path manifest, so a corpus sync can add a reserved root — `/plan`,
// `/today`, `/progress` are all plausible future operation roots — with no change
// to this repo. A site route that was legal yesterday silently stops reaching the
// SPA. The gate runs in all three call sites (`npm run build`, the hosting
// `predeploy` hook, and `preflight-deploy.sh`), including the hand-deploy path.
//
// FAIL-CLOSED ON AN UNDERIVABLE LIST, mirroring the manifest floor above. The
// hazard is specific: "found none" was the expected answer for a long time, so an
// ordinary count floor would have been meaningless.
//
// CORRECTED 2026-09-11 — the floor this comment used to describe was measured on
// the WRONG POPULATION, and it let exactly the defect it was written to prevent
// through. It said: "if the scanner can see 100+ `tier:` declarations it is
// working, and a zero for `site` is a real zero rather than a broken regex
// reporting silence." That inference does not hold. The scanner matched route
// objects with `/\{[^{}]*?\}/g` — INNERMOST brace pairs only — so any route
// carrying a nested `nav: { … }` never matched and was invisible, while its
// `tier:` declaration still counted toward the floor. Declarations were plentiful
// (135 parsed) precisely while routes were being dropped.
//
// MEASURED against a downstream consumer: nine `tier: 'site'` routes declared
// across three modules, of which the gate saw TWO — the seven carrying a `nav`
// block passed through unchecked, including routes whose whole reason for being
// gated is that a Cloud Run rewrite could shadow them. A floor cannot detect a
// parser that drops members of the set it is counting from a set it is not.
//
// The floor is now a SELF-CONSISTENCY check between the two populations: every
// `tier:` declaration in code MUST resolve to an enclosing route object with a
// top-level `path:`. If even one does not, the parser has a blind spot and the
// gate refuses rather than reporting a count it cannot stand behind.
const FEATURES_DIR = join(REPO_ROOT, 'frontend', 'react', 'src', 'features');
let routeFiles = [];
try {
  for (const d of readdirSync(FEATURES_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = join(FEATURES_DIR, d.name, 'routes.tsx');
    if (existsSync(f)) routeFiles.push(f);
  }
} catch (e) {
  fail(`cannot enumerate feature route modules under ${FEATURES_DIR} (${e.message}) — the site-route list is underivable and must not pass as "no collisions".`);
}
if (routeFiles.length < 20) {
  fail(`found only ${routeFiles.length} feature route module(s) — below any plausible floor. The scan is broken, not the tree; refusing to report "no site-route collisions" from a list that was never built.`);
}

// Deliberately scoped to `src/features/*/routes.tsx` — the real route modules.
// Test files declare `tier: 'site'` fixtures (siteRouteContract.test.ts alone has
// nine), and a scanner that swept `src/**` would treat those as shipped routes.
// Blank out comments (preserving offsets and line count) so a `tier: 'admin'`
// MENTIONED in a doc block is not counted as a declaration — two were, and they
// inflated the old floor with prose.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}
// The enclosing object literal for a declaration at `idx`, by BALANCED braces.
// The predecessor matched innermost pairs only, which silently skipped every
// route carrying a nested `nav: { … }` — see the correction note above.
function enclosingObject(src, idx) {
  let depth = 0;
  let start = -1;
  for (let i = idx; i >= 0; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}
// `path:` at the object's OWN level — never one belonging to a nested literal.
function topLevelPath(obj) {
  let depth = 0;
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i];
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; continue; }
    if (depth === 1 && obj.startsWith('path:', i)) {
      const m = /^path:\s*'([^']+)'/.exec(obj.slice(i));
      if (m) return m[1];
    }
  }
  return null;
}

let tierDecls = 0;
const siteRoutes = [];
const unresolved = [];
for (const f of routeFiles) {
  const src = stripComments(readFileSync(f, 'utf8'));
  for (const m of src.matchAll(/tier:\s*'(workspace|admin|public|site)'/g)) {
    tierDecls += 1;
    const obj = enclosingObject(src, m.index);
    const path = obj ? topLevelPath(obj) : null;
    if (!path) {
      unresolved.push(`${relative(REPO_ROOT, f)}:${src.slice(0, m.index).split('\n').length}  (${m[0]})`);
      continue;
    }
    if (m[1] === 'site') siteRoutes.push(path);
  }
}
if (tierDecls < 100) {
  fail(`parsed only ${tierDecls} tier declaration(s) across ${routeFiles.length} route modules — below the floor. The tier regex no longer matches how routes are declared, so a zero site-route result would be an artefact of the scanner, not a fact about the tree.`);
}
// The guard the old floor could not be: the two populations must AGREE. A
// declaration the parser cannot resolve to a route object is a route the
// collision check never saw, and a silent under-count here is indistinguishable
// from "no collisions".
if (unresolved.length > 0) {
  fail(
    `${unresolved.length} tier declaration(s) could not be resolved to a route object with a top-level \`path:\`:\n` +
      unresolved.map((u) => `  ${u}`).join('\n') +
      `\n  The scanner cannot see these routes, so it cannot report a collision for them.\n` +
      `  A count is only trustworthy when every member of the population it counts from\n` +
      `  resolves — this is the check whose absence let seven \`site\` routes through\n` +
      `  unexamined (ADR 0641 phase 2, correction 2026-09-11).`,
  );
}

// Cloud Run owns every source checked above. A site path collides when its FIRST
// SEGMENT is reserved — same granularity the v2 derivation uses, because that is
// the granularity Firebase routes at (`/runs/**` swallows `/runs/anything`).
const cloudRunSources = new Set(['/.well-known/**', '/v1/**', SEAMS_SOURCE, ...V2_SOURCES]);
const collisions = [];
for (const rp of siteRoutes) {
  const first = rp.split('/').filter(Boolean)[0] ?? '';
  if (!first) continue;
  if (cloudRunSources.has(`/${first}`) || cloudRunSources.has(`/${first}/**`)) {
    collisions.push({ route: rp, reserved: `/${first}` });
  }
}
if (collisions.length > 0) {
  fail(
    `${collisions.length} \`site\` route(s) collide with a Cloud Run rewrite source:\n` +
      collisions.map((c) => `  ${c.route}  →  reserved by "${c.reserved}"`).join('\n') +
      `\n  Firebase Hosting answers these from the backend BEFORE the SPA sees them, so the\n` +
      `  surface never renders. No Express or React Router check can detect this — it happens\n` +
      `  one layer above both. Rename the route, or remove the rewrite if the root is genuinely\n` +
      `  the SPA's (it is not, if it came from the v2 path manifest). ADR 0641 phase 2.`,
  );
}

console.log(
  `✓ check-hosting-wire-rewrites: /.well-known/**, /v1/** and the ${V2_SOURCES.length} v2 manifest ` +
  `sources route to Cloud Run ahead of the SPA catch-all (${rewrites.length} rewrites, plain JSON, no unknown keys); ` +
  `${siteRoutes.length} site route(s) checked against ${cloudRunSources.size} reserved source(s) from ${routeFiles.length} route modules (${tierDecls} tier declarations parsed).`,
);
