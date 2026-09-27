import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_OWN_UNVERSIONED_MOUNTS } from '../src/middleware/protocolVersion.js';

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
const NOT_A_HOST_NAME = new Set(['/v1', '/runs', '/', '/.well-known']);

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
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote !== null) {
      if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i += 1; continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2; continue;
    }
    out += c; i += 1;
  }
  return out;
}

function scan(pattern: RegExp): string[] {
  const roots = new Set<string>();
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const text = stripComments(readFileSync(join(entry.parentPath ?? entry.path, entry.name), 'utf8'));
    for (const m of text.matchAll(new RegExp(pattern.source, 'g'))) {
      const root = `/${m[1].replace(/^\//, '').split('/')[0]}`;
      if (!NOT_A_HOST_NAME.has(root)) roots.add(root);
    }
  }
  return [...roots].sort();
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
    // the root to HOST_OWN_UNVERSIONED_MOUNTS, or move the surface under /v1.
    const union = [...new Set(MECHANISMS.flatMap((m) => scan(m.pattern)))].sort();
    expect(union).toEqual([...HOST_OWN_UNVERSIONED_MOUNTS].sort());
  });
});
