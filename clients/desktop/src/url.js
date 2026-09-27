// ADR 0181 — pure host-origin URL helpers for the desktop shell.
//
// Extracted from the Electron main process so the parsing/validation logic is
// unit-testable with `node --test` (no Electron runtime needed). Never throws.
// CommonJS to match the Electron main/preload module system.

'use strict';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Strip a trailing slash so comparisons survive user-typed vs stored forms. */
function normalizeOrigin(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\/+$/, '');
}

/**
 * Validate + normalize a host origin the user typed on the setup page.
 * Returns the normalized `http(s)://host[:port]` origin, or `null` when the
 * input is not a usable absolute http/https URL. A bare `host:port` (no scheme)
 * is coerced to `http://` for loopback convenience.
 */
function parseHostOrigin(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return null;
  // Coerce ONLY a schemeless `host:port` to http. An input that already carries
  // a scheme (file://, ftp://, …) is validated as-is and rejected below if it is
  // not http/https — never silently rewritten to http.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  const withScheme = hasScheme ? raw : `http://${raw}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return normalizeOrigin(u.origin);
}

/** True when an origin points at the local machine (loopback). */
function isLoopbackOrigin(origin) {
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** True when two origins refer to the same host (post-normalization). */
function sameOrigin(a, b) {
  return normalizeOrigin(a) !== '' && normalizeOrigin(a) === normalizeOrigin(b);
}

module.exports = { normalizeOrigin, parseHostOrigin, isLoopbackOrigin, sameOrigin };
