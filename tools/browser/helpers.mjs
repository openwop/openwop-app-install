/**
 * Pure helpers used by server.mjs — extracted so the logic can be
 * unit-tested without spinning up Playwright / Chromium.
 *
 * Keep these functions synchronous, side-effect-free, and free of
 * dependencies on `page`, `fs`, or any Playwright state so tests stay
 * fast and deterministic. HTTP/browser plumbing stays in server.mjs.
 *
 * @module tools/browser/helpers
 */

import path from 'node:path';

/**
 * Parse a `waitUrl` pattern into either a substring or a compiled
 * regex. Treats `/foo/` as a regex only when the inner content
 * contains regex metacharacters — a plain URL path wrapped in slashes
 * (`/dashboard/app-builder/`) is indistinguishable from a regex
 * literal otherwise, and users virtually always mean the substring.
 *
 * Throws a descriptive error on invalid regex so callers don't see
 * raw `SyntaxError`s.
 *
 * @param {string} pattern raw user-supplied pattern
 * @returns {{ kind: 'substring', value: string } | { kind: 'regex', value: RegExp }}
 */
const REGEX_METACHAR = /[\\^$()|[\]*+?{}]/;
export function parseWaitUrlPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new Error('waitUrl: pattern must be a non-empty string');
  }
  const slashWrapped =
    pattern.length >= 3 && pattern.startsWith('/') && pattern.endsWith('/');
  if (!slashWrapped) {
    return { kind: 'substring', value: pattern };
  }
  const inner = pattern.slice(1, -1);
  // Plain URL paths like `/dashboard/app-builder/` wrap in slashes too
  // but carry no regex metacharacters. Treat them as substrings so the
  // common case doesn't silently turn into a slower regex match.
  if (!REGEX_METACHAR.test(inner)) {
    return { kind: 'substring', value: pattern };
  }
  try {
    return { kind: 'regex', value: new RegExp(inner) };
  } catch (err) {
    throw new Error(
      `Invalid regex in waitUrl "${pattern}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Test whether a URL matches the parsed pattern. Extracted so tests
 * can exercise both branches without a live browser.
 *
 * @param {string} url
 * @param {{ kind: 'substring', value: string } | { kind: 'regex', value: RegExp }} parsed
 * @returns {boolean}
 */
export function urlMatchesPattern(url, parsed) {
  if (parsed.kind === 'regex') return parsed.value.test(url);
  return url.includes(parsed.value);
}

/**
 * Resolve and validate an `evalFile` path. Accepts paths relative to
 * `projectRoot` OR absolute paths that resolve under `projectRoot` or
 * `/tmp` (macOS `/private/tmp` included). Throws on escape attempts.
 *
 * @param {string} raw user-supplied path
 * @param {string} projectRoot absolute path to the repo root
 * @returns {string} resolved absolute path
 */
export function resolveEvalFilePath(raw, projectRoot) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('evalFile: path must be a non-empty string');
  }
  const candidate = path.isAbsolute(raw) ? raw : path.join(projectRoot, raw);
  const resolved = path.resolve(candidate);
  const allowedPrefixes = [
    path.resolve(projectRoot) + path.sep,
    '/tmp' + path.sep,
    '/private/tmp' + path.sep,
  ];
  const isAllowed = allowedPrefixes.some((prefix) => resolved.startsWith(prefix));
  if (!isAllowed) {
    throw new Error(
      `evalFile path must be under PROJECT_ROOT or /tmp (got: ${resolved})`,
    );
  }
  return resolved;
}
