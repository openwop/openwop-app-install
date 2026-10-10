/**
 * ADR 0783 phase 2 — the URL rules for a data source (D1, D4, D6). One module,
 * because the same confinement must hold for the stored base, for every request
 * path built on it, and for every pagination `next` link a provider hands back.
 *
 * The broker (`brokeredFetch`) still applies the provider's `apiHosts` pin, the
 * SSRF guard and the tenant egress firewall on every call. These rules run FIRST,
 * so the broker is defence in depth, never the only check.
 */
import { hostMatchesApi } from './connectionInjection.js';
import { isDeniedWebhookHost, webhookPrivateEgressAllowed } from './webhookEgressGuard.js';

/** A typed refusal (`{ code }` is the pack convention for node failures). */
export function sourceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** A raw `.` or `..` segment, or one spelled with `%2e`. */
function isDotSegment(seg: string): boolean {
  let s = seg;
  try { s = decodeURIComponent(seg); } catch { return true; } // malformed escape: refuse
  return s === '.' || s === '..';
}

/**
 * D1 — validate a base URL for a Connection whose provider pins `apiHosts`.
 * Returns the normalised base (no trailing slash). Runs at WRITE time and again
 * at CALL time, because the provider's pins or the deny list can change after
 * the write.
 */
export function validateDataSourceBaseUrl(raw: unknown, apiHosts: readonly string[] | undefined): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw sourceError('validation_error', 'baseUrl must be a non-empty string');
  const text = raw.trim();
  // Checked on the RAW text: the URL parser silently resolves `..`, which would
  // hide exactly the segment this rule exists to refuse.
  if (/[\x00-\x1f\x7f\\]/.test(text)) throw sourceError('validation_error', 'baseUrl contains a control character or a backslash');
  let u: URL;
  try { u = new URL(text); } catch { throw sourceError('validation_error', 'baseUrl is not a URL'); }
  // The SAME switch, read the same way, that relaxes the broker's own https and
  // private-host checks (`brokeredEgress.ts`) for local development and tests.
  // Never wider than the broker: a base this refuses, the broker would too.
  const privateOk = webhookPrivateEgressAllowed();
  if (u.protocol !== 'https:' && !(privateOk && u.protocol === 'http:')) throw sourceError('validation_error', 'baseUrl must be https');
  if (u.username || u.password) throw sourceError('validation_error', 'baseUrl must not carry credentials');
  if (u.search || u.hash || text.includes('?') || text.includes('#')) throw sourceError('validation_error', 'baseUrl must not carry a query or a fragment');
  const rawPath = text.slice(text.indexOf('//') + 2).replace(/^[^/]*/, '');
  if (rawPath.split('/').some(isDotSegment)) throw sourceError('validation_error', 'baseUrl must not contain . or .. segments');
  if (!privateOk && isDeniedWebhookHost(u.hostname)) throw sourceError('validation_error', 'baseUrl names a private or internal host');
  const pins = apiHosts ?? [];
  if (pins.length === 0 || !pins.some((ah) => hostMatchesApi(u.hostname, ah))) {
    throw sourceError('validation_error', "baseUrl's host is outside the provider's allowed API hosts");
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Is `candidate` inside `base`: the same origin, and at or under its path? */
export function isWithinBase(candidate: URL, base: string): boolean {
  const b = new URL(base);
  if (candidate.origin !== b.origin) return false;
  const prefix = b.pathname.replace(/\/+$/, '');
  return candidate.pathname === prefix || candidate.pathname === `${prefix}/` || candidate.pathname.startsWith(`${prefix}/`);
}

type Scalar = string | number | boolean;
const isScalar = (v: unknown): v is Scalar => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * D4 — build the request URL from the base, the pack's `path` (with `{{var}}`
 * placeholders) and `params`. Each placeholder value is `encodeURIComponent`'d,
 * so a value can never add a `/`, a `..` or a scheme. Unconsumed scalar params
 * (or arrays of scalars) become the query string. The result must stay inside the
 * base, or the call is refused before it reaches the broker.
 */
export function buildSourceUrl(base: string, path: unknown, params: unknown): string {
  if (path !== undefined && typeof path !== 'string') throw sourceError('validation_error', 'path must be a string');
  if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
    throw sourceError('validation_error', 'params must be an object');
  }
  const p = (params ?? {}) as Record<string, unknown>;
  const used = new Set<string>();
  let rel = (path ?? '').replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(p, name)) throw sourceError('validation_error', `path placeholder {{${name}}} has no value in params`);
    const v = p[name];
    if (!isScalar(v)) throw sourceError('validation_error', `path placeholder {{${name}}} must be a string, number or boolean`);
    used.add(name);
    return encodeURIComponent(String(v));
  });
  if (rel !== '' && !rel.startsWith('/')) rel = `/${rel}`;
  if (rel.includes('://') || rel.startsWith('//')) throw sourceError('validation_error', 'path must be relative to the source');
  if (/[\x00-\x1f\x7f\\?#]/.test(rel)) throw sourceError('validation_error', 'path must not contain a control character, a backslash, a query or a fragment (use params)');
  if (rel.split('/').some(isDotSegment)) throw sourceError('validation_error', 'path must not contain . or .. segments');

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (used.has(k) || v === undefined || v === null) continue;
    if (isScalar(v)) qs.append(k, String(v));
    else if (Array.isArray(v) && v.every(isScalar)) for (const item of v) qs.append(k, String(item));
    else throw sourceError('validation_error', `param '${k}' must be a scalar or an array of scalars`);
  }
  const query = qs.toString();
  const url = new URL(`${base}${rel}${query ? `?${query}` : ''}`);
  if (!isWithinBase(url, base)) throw sourceError('validation_error', 'the request would leave the source base URL');
  return url.toString();
}

/**
 * D6 — the `rel="next"` target of an RFC 8288 `Link` header, resolved against the
 * page that carried it. Returns null when there is none. Confinement is the
 * caller's (`isWithinBase`), applied to every hop.
 */
export function nextLink(linkHeader: string | undefined, current: string): string | null {
  if (!linkHeader || !linkHeader.trim()) return null;
  const invalid = (): never => { throw sourceError('source_invalid_response', 'the source returned a malformed pagination Link header'); };
  // Split link-values only outside URI references and quoted parameter values.
  // A bad nonempty header must never mean "this is the complete list".
  const parts: string[] = [];
  let start = 0;
  let inTarget = false;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < linkHeader.length; i++) {
    const c = linkHeader[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (inTarget) {
      if (c === '>') inTarget = false;
    } else if (c === '<') inTarget = true;
    else if (c === '"') quoted = true;
    else if (c === ',') { parts.push(linkHeader.slice(start, i)); start = i + 1; }
  }
  if (quoted || inTarget || escaped) invalid();
  parts.push(linkHeader.slice(start));
  let next: string | null = null;
  for (const part of parts) {
    // RFC 8288 target + token-named parameters; quoted values may carry commas.
    const m = /^\s*<([^<>\s]*)>\s*((?:;\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+(?:\s*=\s*(?:"(?:[^"\\\r\n]|\\.)*"|[!#$%&'*+\-.^_`|~0-9A-Za-z]+))?\s*)*)$/.exec(part);
    if (!m) return invalid();
    let target: string;
    try { target = new URL(m[1]!, current).toString(); } catch { return invalid(); }
    // Read actual parameters in sequence: text inside a quoted title is not
    // a parameter, and RFC 8288 ignores all but the first rel occurrence.
    const parameter = /;\s*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)(?:\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+\-.^_`|~0-9A-Za-z]+)))?\s*/gy;
    let relation: string | undefined;
    while (parameter.lastIndex < m[2]!.length) {
      const p = parameter.exec(m[2]!);
      if (!p) return invalid();
      if (p[1]!.toLowerCase() === 'rel' && relation === undefined) {
        relation = (p[2] ?? p[3] ?? '').replace(/\\(.)/g, '$1');
      }
    }
    if (!relation?.trim()) return invalid();
    const rels = relation.toLowerCase().trim().split(/\s+/);
    if (next === null && rels.includes('next')) next = target;
  }
  return next;
}
