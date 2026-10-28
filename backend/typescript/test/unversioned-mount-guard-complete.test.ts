import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_OWN_UNVERSIONED_MOUNTS, v2MountedRootPrefixes } from '../src/middleware/protocolVersion.js';

/**
 * The boot collision guard in `protocolVersion.ts` refuses to mount a v2 path
 * space over a root this host already occupies unversioned. It reads a
 * CONSTANT, because the derivation runs at module import — before a single
 * route or middleware has registered — so it cannot ask Express what is
 * mounted.
 *
 * A hand-kept constant drifts, and this one had drifted twice over. It named
 * four roots; the host occupies eleven. Two of the misses were ordinary
 * registrations nobody added. The rest were not registrations at all.
 *
 * THE THREE MECHANISMS. A name can be taken here by:
 *
 *   1. a path-literal registration — `app.get('/health', …)`
 *   2. an anchored-regex REWRITE — `routes/conformanceSeams.ts` aliases the v2
 *      seam space onto its v1 address; `middleware/customDomain.ts` maps
 *      `/blog/:slug` and `/pod/:show` onto prerender paths
 *   3. an exact-string COMPARISON — `index.ts` strips `/api` before the
 *      negotiator runs, and would swallow a colliding manifest operation
 *      outright
 *
 * A rewrite holds a name exactly as firmly as a registration, and answers no
 * grep for `app.get('/…')`. Scanning only mechanism 1 is how this constant
 * looked complete at four names while missing five more.
 *
 * WHAT THIS TEST DOES NOT CLAIM. It pins the constant against these three
 * mechanisms. A fourth way of taking a name — a path built at runtime, a
 * table loaded from disk — escapes it, and no scan of this kind can promise
 * otherwise. The claim is "pinned against the three known mechanisms", not
 * "proven complete". Each mechanism carries its own floor below so that a
 * sub-scan going inert fails loudly instead of hiding behind the other two.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** 1. `app.get('/foo/:bar', …)` and friends. There are no `express.Router()`
 *  instances in this codebase, so every path literal is absolute; a relative
 *  sub-router path cannot be mistaken for a top-level mount. If that changes,
 *  this scan must change with it. */
const REGISTRATION = /\.(?:get|post|put|patch|delete|all|use|options|head)\(\s*'(\/[^']*)'/g;

/** 2. `/^\/conformance\/seams\/sample\//` — a regex anchored at a path root,
 *  which is the shape every URL-rewriting table here uses. */
const ANCHORED_REGEX = /\/\^\\?\/([a-zA-Z0-9_.-]+)/g;

/** 3. `req.url === '/api'`, `path === '/pricing'`. */
const EXACT_COMPARE = /(?:path|req\.url|url|pathname) === '(\/[a-zA-Z0-9_.-]*)'/g;

/** `/v1` is the versioned space the negotiator owns, and `/runs` appears as an
 *  anchored regex INSIDE the negotiator for bound run ids — both are protocol
 *  path space, not a host-own name. `/` cannot collide: the derivation drops
 *  segments of length <= 1. `/.well-known` is filtered out of the manifest
 *  segments by name, for the same reason. */
// ADR 0812 P3a: `/content` and `/host` are the same case as `/runs`. The
// spelling-independent matchers (`isCredentialOptionalRead`, the SSE exemption,
// the MFA exemptions) anchor on the UNVERSIONED protocol (`/content`) and vendor
// (`/host/openwop-app`) path spaces. Both are v2 manifest roots, so naming them
// host-own would make the boot collision guard throw.
// ADR 0812 P3b final batch 2: `/packs` is the v1 Registry HTTP API's path space. The
// served-v1 shim maps a stripped `/v1/packs…` onto the vendor home; nothing is
// served at a bare `/packs`, so it is not a root this host occupies unversioned.
const NOT_A_HOST_NAME = new Set(['/v1', '/runs', '/', '/.well-known', '/content', '/host', '/packs']);
// ADR 0812 P3c: protocol routes used to register through `v1('/prompts')`, which
// this literal scan could not see. With `v1()` deleted they are plain literals, so
// a v2 manifest root is excluded BY NAME, read from the manifest itself: it is the
// protocol's path space, mounted under major 2, never a host-own name. A
// `:action` suffix is a key of the same resource, as in `isV2MountedPath`.
const PROTOCOL_ROOTS = new Set(v2MountedRootPrefixes());

/**
 * Strip comments before scanning. A scan that reads comments counts prose as
 * code, and this one proved it immediately: the very comment written above to
 * EXPLAIN mechanism 1 says `app.get('/x')`, and the first run of this test
 * dutifully reported `/x` as a twelfth root the host occupies. Documentation
 * about a check must not be an input to it.
 *
 * Quote state is tracked so a `//` inside a string (every `https://` in the
 * tree) is not mistaken for a line comment.
 */
function stripComments(src: string): string {
  // Same semantics as the original char-by-char builder, but it copies whole
  // non-comment RUNS with slice() instead of concatenating one char at a time
  // (that concatenation was most of the 1.7 s this file cost; 8f W4).
  const parts: string[] = [];
  const n = src.length;
  let i = 0;
  let start = 0;
  let quote: number | null = null;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (quote !== null) {
      if (c === 92 /* \\ */) { i += 2; continue; }
      if (c === quote) quote = null;
      i += 1; continue;
    }
    if (c === 39 || c === 34 || c === 96) { quote = c; i += 1; continue; }
    if (c === 47 /* / */) {
      const next = src.charCodeAt(i + 1);
      if (next === 47) {
        parts.push(src.slice(start, i));
        while (i < n && src.charCodeAt(i) !== 10) i += 1;
        start = i; continue;
      }
      if (next === 42) {
        parts.push(src.slice(start, i));
        i += 2;
        while (i < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i += 1;
        i += 2; start = i; continue;
      }
    }
    i += 1;
  }
  if (start < n) parts.push(src.slice(start));
  return parts.join('');
}

/**
 * The comment-stripped text of every `src/**\/*.ts` file, read ONCE per file run.
 * Wave-3 lesson: a case that re-walks `src/` (2,074 files, 30 MB, char-wise
 * stripping) per mechanism and again for the union measured 1.7 s alone (8f W4
 * baseline); under gate load that kind of rewalk went past the timeout. Reading
 * once and memoizing each pattern's scan changes nothing the cases claim.
 */
let SOURCES: readonly string[] | undefined;
function sources(): readonly string[] {
  if (SOURCES) return SOURCES;
  const out: string[] = [];
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    out.push(stripComments(readFileSync(join(entry.parentPath ?? entry.path, entry.name), 'utf8')));
  }
  SOURCES = out;
  return out;
}

const SCANS = new Map<string, string[]>();
function scan(pattern: RegExp): string[] {
  const cached = SCANS.get(pattern.source);
  if (cached) return cached;
  const roots = new Set<string>();
  for (const text of sources()) {
    for (const m of text.matchAll(new RegExp(pattern.source, 'g'))) {
      const root = `/${m[1].replace(/^\//, '').split('/')[0]}`;
      if (!NOT_A_HOST_NAME.has(root) && !PROTOCOL_ROOTS.has(root.split(':')[0]!)) roots.add(root);
    }
  }
  const result = [...roots].sort();
  SCANS.set(pattern.source, result);
  return result;
}

const MECHANISMS = [
  { name: 'path-literal registration', pattern: REGISTRATION, floor: 4, witness: '/health' },
  { name: 'anchored-regex rewrite', pattern: ANCHORED_REGEX, floor: 2, witness: '/conformance' },
  { name: 'exact-string comparison', pattern: EXACT_COMPARE, floor: 2, witness: '/api' },
] as const;

describe('HOST_OWN_UNVERSIONED_MOUNTS is complete', () => {
  // Without a per-mechanism floor, a scan that stops matching reports a
  // perfectly empty, perfectly passing result — and its roots are still
  // covered by the other two scans, so the union assertion stays green while
  // a third of the check has gone dark. Empty-plus-green is the most reliable
  // tell we have that a check has gone inert, and it is invisible in the
  // check's own output.
  for (const m of MECHANISMS) {
    it(`still sees ${m.name}s — an empty scan is a broken query, not a clean host`, () => {
      const roots = scan(m.pattern);
      expect(roots.length).toBeGreaterThanOrEqual(m.floor);
      expect(roots).toContain(m.witness);
    });
  }

  it('names every root this host occupies unversioned, by any of the three mechanisms', () => {
    // If this fails, do not delete the assertion and do not narrow the scans.
    // Something new took an unversioned name and the guard cannot see it: add
    // the root to HOST_OWN_UNVERSIONED_MOUNTS, or serve it as a protocol route.
    const union = [...new Set(MECHANISMS.flatMap((m) => scan(m.pattern)))].sort();
    expect(union).toEqual([...HOST_OWN_UNVERSIONED_MOUNTS].sort());
  });
});
