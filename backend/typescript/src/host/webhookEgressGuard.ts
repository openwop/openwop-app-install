/**
 * Webhook egress guard — the single denied-range predicate shared by the
 * registration-time SSRF check (`routes/webhooks.ts assertReachableUrl`) and
 * the delivery-time pinned-resolution re-validation (`webhookDeliveryWorker`).
 * One predicate, two call sites, so the two checks can't drift (RFC 0093 §A.1).
 *
 * Delivery-time enforcement (RFC 0093 §A.1-A.2 + `spec/v1/webhooks.md`
 * §"Delivery-time egress validation"): registration-time validation alone
 * leaves a DNS-rebinding TOCTOU window — an attacker registers a public
 * hostname, then flips its A record to `169.254.169.254`. The dispatcher MUST
 * re-resolve at delivery time, validate EVERY resolved address against the
 * same denied ranges, and connect to the validated address (pinned
 * resolution). We implement this with an undici `Agent` whose
 * `connect.lookup` callback validates inside the actual connection's
 * resolution — the addresses the guard approves are exactly the addresses
 * `net.connect` dials, so there is no second resolution to race (no TOCTOU).
 *
 * `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true` (local dev / tests only) disables the
 * denied-range check at BOTH layers, consistently. The no-redirect policy
 * (RFC 0093 §A.2) is NOT env-bypassable — it lives in the worker's
 * `redirect: 'error'` fetch policy.
 *
 * `OPENWOP_WEBHOOK_ALLOW_ORIGINS` (WHD-19) is the NARROW form of the same
 * relaxation: a comma-separated list of exact `scheme://host:port` origins that
 * are admitted while every other destination — including the same host on
 * another port or scheme — stays refused. See `webhookAllowOrigins()` below.
 */

import { lookup as dnsLookup } from 'node:dns';
import { isIPv4, isIPv6, type LookupFunction } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';
import { createLogger } from '../observability/logger.js';
import { assertEffectAllowed } from './runEffectContext.js';

const log = createLogger('host.webhookEgressGuard');

/** True when the operator explicitly allows private/loopback egress FOR THE
 *  WEBHOOK DELIVERY WORKER (local development / tests only, so a loopback
 *  subscriber mock is reachable). Read per-call so tests can flip it. */
export function webhookPrivateEgressAllowed(): boolean {
  return process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE === 'true';
}

/** True when private/loopback egress is allowed FOR THE PACK-FACING
 *  `ctx.http.safeFetch` (host/connectionInjection.ts). DELIBERATELY a distinct
 *  flag from the webhook one: RFC 0076 §host.http makes safeFetch's SSRF guard
 *  a security MUST with no dev-relaxation clause, so a boot that relaxes the
 *  webhook worker (e.g. to reach a loopback subscriber) MUST NOT thereby weaken
 *  safeFetch — otherwise advertising `httpClient.safeFetch.supported` becomes a
 *  dishonest wire claim in that posture. Default OFF ⇒ the advertised guard is
 *  witnessable. Only the connection-injection unit test (which round-trips an
 *  Authorization header against a loopback echo) opts in. */
export function safeFetchPrivateEgressAllowed(): boolean {
  return process.env.OPENWOP_SAFEFETCH_ALLOW_PRIVATE === 'true';
}

// ── WHD-19 — the exact-origin relaxation ─────────────────────────────────────
//
// WHY THIS EXISTS. The in-process conformance lane needs the host to reach a
// handful of the suite's OWN loopback listeners (the webhook receiver, the A2A
// fake peer, the MCP fake server, the compat-provider mock). The only knob it
// had was `OPENWOP_WEBHOOK_ALLOW_PRIVATE=true`, which switches the WHOLE guard
// off — so from suite 2.33.0 `v2-webhook-egress-refusal` (eight destinations
// `webhooks.md` §SSRF says a host MUST refuse) was accepted 8 of 8, and, worse,
// the gate `deploy.sh` runs could never catch a guard regression, because the
// guard it measured was never on. A relaxation you cannot scope is a relaxation
// that hides everything it touches.
//
// THE SHAPE. A list of exact origins — scheme, host AND port — matched EXACTLY:
// never a prefix, never a CIDR, never a wildcard, never "this host on any port".
// `http://127.0.0.1:41234` admits exactly that socket; `http://127.0.0.1:41235`,
// `https://127.0.0.1:41234`, `http://localhost:41234` and every egress-refusal
// probe (all of which are port 443 or 80) are still refused. That is the whole
// point: the lane can reach what it owns while the guard stays ON for the row
// that tests it.
//
// FAIL CLOSED, WHOLE LIST. One malformed entry discards the ENTIRE list (the
// guard stays fully strict) and logs `webhook_egress_allowlist_rejected` at
// error level. Considered and rejected: (a) dropping only the bad entry — a
// typo'd relaxation silently becoming a DIFFERENT relaxation is exactly the
// kind of partial application a security knob must not have; (b) refusing to
// boot — every reader here resolves the env PER CALL (so tests can flip it),
// there is no single boot point that owns it, and a dev-only knob that can
// take a host down is a worse failure than one that leaves it strict. Strict
// is the production posture; falling back to it can open nothing.
//
// DEFAULT OFF. Unset (production) ⇒ empty set ⇒ every reader below behaves
// byte-for-byte as before this knob existed.
//
// WHO HONOURS IT. Only the webhook-family sites that already honoured
// `OPENWOP_WEBHOOK_ALLOW_PRIVATE` AND can see a full URL: `assertEgressUrlAllowed`
// / `assertEgressSchemeAllowed` with `honorDevFlag` (webhook registration +
// delivery, priority-matrix federation), `guardedEgressFetch` (A2A peer
// dispatch), the webhook-family connect-time connector, and the MCP client's
// https-only arm. Sites that only ever see a HOSTNAME (`isDeniedWebhookHost(
// url.hostname)` prechecks in brokered egress, trigger ingestion, sandbox,
// image, knowledge-source, web-research, SMTP, the compat-endpoint route) do
// NOT honour it — they cannot match a port, and an origin allowlist applied
// without the port would be exactly the "same host, any port" widening this
// knob exists to avoid. They stay strict, which is narrower, never wider.
// `ctx.http.safeFetch` never honours it either (its own flag, RFC 0076).

export const WEBHOOK_ALLOW_ORIGINS_ENV = 'OPENWOP_WEBHOOK_ALLOW_ORIGINS';

/** The parsed allowlist. `rejected` set ⇔ the whole list was discarded. */
export interface WebhookAllowOrigins {
  readonly origins: ReadonlySet<string>;
  readonly rejected?: { readonly entry: string; readonly reason: string };
}

/** `scheme://host:port`, explicit port REQUIRED, nothing after the port but an
 *  optional single `/`. Host is an IPv6 literal in brackets or a DNS-ish name /
 *  IPv4 literal of `[A-Za-z0-9.-]` only — so `*`, `_`, `@`, `/8` (a CIDR), a
 *  path, a query, a fragment and userinfo are all malformed by construction. */
const ORIGIN_ENTRY = /^(https?):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})\/?$/;

/**
 * The canonical key both sides of the match are reduced to. Takes the pieces
 * separately because the connect-time caller (undici's connector) has them
 * separately and no URL. `port` may be `''` (the scheme default, which is what
 * `URL.port` and undici both report for 80/443). Returns null for a non-http(s)
 * scheme — such a request is refused elsewhere and never matches.
 */
export function webhookOriginKey(protocol: string, hostname: string, port: string | number): string | null {
  const scheme = protocol.toLowerCase().replace(/:$/, '');
  if (scheme !== 'http' && scheme !== 'https') return null;
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const portNum = port === '' ? (scheme === 'https' ? 443 : 80) : Number(port);
  if (!Number.isInteger(portNum)) return null;
  return `${scheme}://${host.includes(':') ? `[${host}]` : host}:${portNum}`;
}

/** Pure parser — exported for the tests; production reads go through
 *  `webhookAllowOrigins()`, which caches and logs. */
export function parseWebhookAllowOrigins(raw: string | undefined): WebhookAllowOrigins {
  if (raw === undefined || raw.trim() === '') return { origins: new Set() };
  const origins = new Set<string>();
  for (const piece of raw.split(',')) {
    const entry = piece.trim();
    const reject = (reason: string): WebhookAllowOrigins => ({ origins: new Set(), rejected: { entry, reason } });
    if (entry === '') return reject('empty entry (a stray comma)');
    const m = ORIGIN_ENTRY.exec(entry);
    if (!m) return reject('not an exact scheme://host:port origin (explicit port required; no path, query, userinfo, wildcard or CIDR)');
    const port = Number(m[3]);
    if (port < 1 || port > 65535) return reject('port out of range');
    // Normalise the host through the SAME parser the request side uses, so an
    // entry and a request URL for one socket always reduce to one key (IPv6
    // compression, case). The regex has already fixed what the entry may say.
    let parsed: URL;
    try {
      parsed = new URL(`${m[1]}://${m[2]}:${port}/`);
    } catch {
      return reject('host does not parse');
    }
    const key = webhookOriginKey(parsed.protocol, parsed.hostname, String(port));
    if (key === null) return reject('unsupported scheme');
    origins.add(key);
  }
  return { origins };
}

let allowOriginsCache: { raw: string | undefined; parsed: WebhookAllowOrigins } | null = null;

/** The live allowlist. Re-parsed only when the env value changes, and LOGGED
 *  once per distinct value — so the relaxation is visible at boot (see
 *  `logWebhookEgressPosture`) and again if anything changes it afterwards. */
export function webhookAllowOrigins(): WebhookAllowOrigins {
  const raw = process.env[WEBHOOK_ALLOW_ORIGINS_ENV];
  if (allowOriginsCache && allowOriginsCache.raw === raw) return allowOriginsCache.parsed;
  const parsed = parseWebhookAllowOrigins(raw);
  allowOriginsCache = { raw, parsed };
  if (parsed.rejected) {
    log.error('webhook_egress_allowlist_rejected', {
      env: WEBHOOK_ALLOW_ORIGINS_ENV,
      entry: parsed.rejected.entry,
      reason: parsed.rejected.reason,
      effect: 'the WHOLE list is ignored — the egress guard stays fully strict',
    });
  } else if (parsed.origins.size > 0) {
    log.warn('webhook_egress_relaxation', {
      env: WEBHOOK_ALLOW_ORIGINS_ENV,
      origins: [...parsed.origins],
      effect: 'exactly these origins bypass the webhook-family egress guard; every other destination is refused',
    });
  }
  return parsed;
}

/** Socket-level match — the connect-time connector's entry point. */
export function isAllowlistedWebhookSocket(protocol: string, hostname: string, port: string | number): boolean {
  const { origins } = webhookAllowOrigins();
  if (origins.size === 0) return false;
  const key = webhookOriginKey(protocol, hostname, port);
  return key !== null && origins.has(key);
}

/** URL-level match. */
export function isAllowlistedWebhookOrigin(url: URL): boolean {
  return isAllowlistedWebhookSocket(url.protocol, url.hostname, url.port);
}

/** The URL-aware form of `webhookPrivateEgressAllowed()`: the blanket flag, OR
 *  this exact origin is allowlisted. Every site that can see a whole URL and
 *  honours the webhook relaxation asks THIS, never the flag alone. */
export function webhookPrivateEgressAllowedFor(url: URL): boolean {
  return webhookPrivateEgressAllowed() || isAllowlistedWebhookOrigin(url);
}

/** Boot-time statement of the webhook egress posture (called from `createApp`
 *  so an embedder — the conformance lane — logs it too, not only `main()`).
 *  Silent in the default posture: production has nothing to announce. */
export function logWebhookEgressPosture(): void {
  if (webhookPrivateEgressAllowed()) {
    log.warn('webhook_egress_relaxation', {
      env: 'OPENWOP_WEBHOOK_ALLOW_PRIVATE',
      effect: 'the webhook-family egress guard is OFF for every private/loopback destination',
    });
  }
  // Parsing logs the allowlist (or its rejection) the first time it is read.
  webhookAllowOrigins();
}

/**
 * Denied-range predicate per `spec/v1/webhooks.md` §"SSRF protection":
 * loopback, RFC 1918 private, link-local (incl. cloud metadata), IPv6
 * ULA/link-local, and the well-known metadata hostnames. Accepts either a
 * hostname (registration-time check) or a resolved IP literal
 * (delivery-time check). An IPv6 literal is parsed to its 16 bytes, and an
 * IPv4 address EMBEDDED in it — IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible
 * (`::/96`), NAT64 (`64:ff9b::/96`) — is checked against the IPv4 ranges.
 *
 * CORRECTED 2026-09-21 (WHD-27, reported by the corpus session + MyndHyve):
 * this used to strip a literal `::ffff:` prefix and then match DOTTED quads
 * only. The WHATWG URL parser normalises `https://[::ffff:127.0.0.1]/` to the
 * hostname `::ffff:7f00:1` — a HEX tail — so loopback, metadata
 * (`[::ffff:a9fe:a9fe]`) and RFC 1918 all passed, at registration and at every
 * pre-dial check that shares this predicate. And because undici never calls
 * `connect.lookup` for an IP-literal host, the connect-time guard never saw them
 * either: this predicate is the ONLY check a literal meets.
 */
export function isDeniedWebhookHost(hostRaw: string): boolean {
  let host = hostRaw.toLowerCase();
  // Strip brackets from IPv6 literals (URL.hostname keeps them).
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (['localhost', 'metadata', 'metadata.google.internal'].includes(host)) return true;
  if (host === 'localhost.' || host.endsWith('.localhost')) return true;
  if (isIPv4(host)) return isDeniedIPv4(host.split('.').map(Number));
  if (isIPv6(host)) return isDeniedIPv6(ipv6Bytes(host));
  return false;
}

function isDeniedIPv4([a, b]: number[]): boolean {
  if (a === 127) return true;            // 127.0.0.0/8 loopback
  if (a === 10) return true;             // 10.0.0.0/8 RFC 1918
  if (a === 172 && b! >= 16 && b! <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 169 && b === 254) return true;          // 169.254.0.0/16 link-local + GCP/AWS metadata
  if (a === 100 && b! >= 64 && b! <= 127) return true; // 100.64.0.0/10 RFC 6598 CGNAT (cloud internal LBs / PSC)
  if (a === 0) return true;                          // 0.0.0.0/8
  return false;
}

function isDeniedIPv6(x: number[]): boolean {
  const zero = (from: number, to: number) => x.slice(from, to).every((v) => v === 0);
  // An IPv4 address carried in the low 32 bits — every form that can reach a v4 host.
  const embedded =
    (zero(0, 10) && x[10] === 0xff && x[11] === 0xff) ||                        // ::ffff:0:0/96 mapped
    zero(0, 12) ||                                                              // ::/96 compatible (incl. :: and ::1)
    (x[0] === 0x00 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b && zero(4, 12)); // 64:ff9b::/96 NAT64
  if (embedded) {
    if (zero(0, 15) && (x[15] === 0 || x[15] === 1)) return true; // :: unspecified, ::1 loopback
    return isDeniedIPv4(x.slice(12, 16));
  }
  if (x[0] === 0xfe && (x[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (x[0] === 0xfe && (x[1]! & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if ((x[0]! & 0xfe) === 0xfc) return true;                  // fc00::/7 ULA
  return false;
}

/** 16 bytes of a syntactically valid IPv6 literal (callers gate on `isIPv6`). */
function ipv6Bytes(s: string): number[] {
  let text = s.split('%')[0]!; // drop a zone id
  let tail: number[] = [];
  const v4 = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    tail = v4[1]!.split('.').map(Number);
    text = text.slice(0, -v4[1]!.length) + '0:0';
  }
  const [head, rest] = text.split('::') as [string, string | undefined];
  const parse = (part: string | undefined) => (part ? part.split(':').filter(Boolean).map((h) => parseInt(h, 16)) : []);
  const hi = parse(head);
  const lo = parse(rest);
  const groups = rest === undefined ? hi : [...hi, ...new Array(8 - hi.length - lo.length).fill(0), ...lo];
  const bytes = groups.flatMap((g) => [(g >> 8) & 0xff, g & 0xff]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** Error raised when a delivery-time resolution lands in a denied range.
 *  Carries a stable `code` so the worker's failure detail (and tests) can
 *  distinguish an egress refusal from an ordinary network error. */
/** Why a caller-supplied egress URL was refused. Callers map these onto their
 *  own error shapes (an `OpenwopError` at an HTTP boundary, a delivery-failure
 *  detail string in a worker) — the reason code is the stable part. */
export type EgressUrlRejection = 'invalid_url' | 'unsupported_protocol' | 'insecure_scheme' | 'denied_host';

export class EgressUrlRejectedError extends Error {
  readonly code = 'OPENWOP_EGRESS_URL_REJECTED';
  constructor(
    readonly reason: EgressUrlRejection,
    readonly url: string,
    /** Set for `denied_host` — the hostname that matched the denied ranges. */
    readonly hostname?: string,
    /** Set for `unsupported_protocol` / `insecure_scheme`. */
    readonly protocol?: string,
  ) {
    super(`egress url rejected (${reason}): ${url}`);
    this.name = 'EgressUrlRejectedError';
  }
}

/**
 * ADR 0607 — the ONE ordered predicate for "may the host be asked to fetch this
 * CALLER-SUPPLIED url", replacing four hand-rolled near-copies that had drifted
 * apart in exactly the way `isDeniedWebhookHost` was extracted to prevent.
 *
 * The order is load-bearing and is ADR 0606's:
 *
 *  1. unparseable            → `invalid_url`
 *  2. not http(s)            → `unsupported_protocol`. **Outside** the dev-flag
 *     escape: a local-development switch must never turn an endpoint into a
 *     `file:` reader.
 *  3. dev-flag early return  → only when `honorDevFlag`, see below.
 *  4. not https              → `insecure_scheme`. Before the host arm, so a
 *     caller retrying `http://` to a private host is told the reason that is
 *     true of EVERY retry they could make with that url, rather than one that
 *     changes if they switch hosts.
 *  5. denied host literal    → `denied_host`.
 *
 * `honorDevFlag` is NOT a style choice — the two postures are both required:
 *
 *  - **`true`** (webhook registration, priority-matrix federation): the
 *    conformance operator contract puts a MUST on it. `webhook-signed-delivery`
 *    registers a `127.0.0.1` receiver, and a host whose opt-in does not reach
 *    registration cannot run the scenario at all — it soft-skips and reports
 *    `pass` having witnessed nothing.
 *  - **`false`** (A2A push config): `SECURITY/invariants.yaml`
 *    `a2a-push-egress-ssrf` has a conformance leg asserting a private push url
 *    is REFUSED, and that leg runs in the same process as the webhook scenario
 *    that requires the flag ON. Honouring the flag here would make the two
 *    mutually unsatisfiable. A2A push is unconditionally strict, and must stay
 *    so — this is why the parameter exists rather than a single global posture.
 *
 * Returns the parsed `URL` so callers don't parse twice.
 */
export function assertEgressUrlAllowed(url: string, opts: { honorDevFlag: boolean }): URL {
  const parsed = parseOrThrow(url);
  assertProtocolFamily(parsed, url);
  if (opts.honorDevFlag && webhookPrivateEgressAllowedFor(parsed)) return parsed;
  assertHttps(parsed, url);
  if (isDeniedWebhookHost(parsed.hostname.toLowerCase())) {
    throw new EgressUrlRejectedError('denied_host', url, parsed.hostname.toLowerCase());
  }
  return parsed;
}

/**
 * ADR 0607 — the SCHEME arms only, for a DELIVERY-time re-check.
 *
 * Deliberately omits the denied-host string precheck, and that omission is the
 * point rather than an oversight: at delivery the address is validated at
 * CONNECT time by the dispatcher's pinned-resolution `lookup`, which is
 * strictly stronger than a string match — it catches the DNS rebind a
 * registration-time literal check cannot see (RFC 0093 §A.1).
 *
 * Adding the string precheck here would also SHADOW the rebind guard for every
 * literal hostname, silently converting `rfc0093-webhook-egress.test.ts`'s
 * pinned-resolution assertion into a string-match assertion. A scheme check has
 * no such stronger counterpart at connect time — `lookup` never sees a
 * protocol — which is precisely why this arm has to run here and the host arm
 * does not.
 */
export function assertEgressSchemeAllowed(url: string, opts: { honorDevFlag: boolean }): URL {
  const parsed = parseOrThrow(url);
  assertProtocolFamily(parsed, url);
  if (opts.honorDevFlag && webhookPrivateEgressAllowedFor(parsed)) return parsed;
  assertHttps(parsed, url);
  return parsed;
}

function parseOrThrow(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new EgressUrlRejectedError('invalid_url', url);
  }
}

function assertProtocolFamily(parsed: URL, url: string): void {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EgressUrlRejectedError('unsupported_protocol', url, undefined, parsed.protocol);
  }
}

function assertHttps(parsed: URL, url: string): void {
  if (parsed.protocol !== 'https:') {
    throw new EgressUrlRejectedError('insecure_scheme', url, undefined, parsed.protocol);
  }
}

export class WebhookEgressDeniedError extends Error {
  readonly code = 'OPENWOP_WEBHOOK_EGRESS_DENIED';
  constructor(hostname: string, address: string) {
    super(
      `webhook egress denied: ${hostname} resolved to ${address} (loopback / link-local / private range; RFC 0093 §A.1)`,
    );
    this.name = 'WebhookEgressDeniedError';
  }
}

/**
 * `lookup` implementation passed to undici's connector: runs the system
 * resolver, then rejects the connection when ANY resolved address falls in
 * a denied range. Because the addresses returned here are exactly what the
 * socket dials, validation and connect share one resolution (pinned).
 */
function makeGuardedLookup(allowPrivate: () => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, options, (err, address, family) => {
      if (err) {
        callback(err, address, family);
        return;
      }
      if (!allowPrivate()) {
        // `address` is a string for single-answer lookups and a
        // LookupAddress[] when the connector asked for `all` answers
        // (e.g. Happy Eyeballs). Validate every address either way.
        const resolved = Array.isArray(address) ? address.map((a) => a.address) : [address];
        const denied = resolved.find((a) => typeof a === 'string' && isDeniedWebhookHost(a));
        if (denied) {
          // INT-2: surface SSRF-guard denials as a structured signal (not just a
          // thrown error the caller may swallow) so ops can see blocked egress —
          // a denial at delivery time can indicate DNS-rebind or a misconfig.
          log.warn('egress_denied', { hostname, resolvedAddress: denied });
          callback(new WebhookEgressDeniedError(hostname, denied), address, family);
          return;
        }
      }
      callback(null, address, family);
    });
  };
}

/** Connect-time pinned-resolution guard for the WEBHOOK worker (gated on its
 *  own ALLOW_PRIVATE flag). */
const guardedLookup: LookupFunction = makeGuardedLookup(webhookPrivateEgressAllowed);

/**
 * WHD-19 — the webhook-family CONNECTOR: the guarded lookup above, except for a
 * socket that is exactly an allowlisted origin (`OPENWOP_WEBHOOK_ALLOW_ORIGINS`),
 * which connects without the denied-range check.
 *
 * Why a connector and not the lookup: a `lookup` callback is handed a HOSTNAME
 * and never a port or scheme, so it could only implement "this host on any
 * port" — the widening the allowlist exists to refuse. The connector is handed
 * `{ protocol, hostname, port }`, i.e. the whole origin.
 *
 * With the allowlist empty (production) every connection takes the `guarded`
 * branch, and `buildConnector({ lookup })` is what undici's Client builds from
 * `connect: { lookup }` when no other connect options are set — the path this
 * replaces — so the default posture is unchanged.
 *
 * HONEST LIMIT, MEASURED 2026-09-21 (NOT introduced here): Node's `net.connect`
 * never calls `lookup` for an IP-LITERAL host, so neither this connector's
 * guarded branch nor the lookup it wraps sees `http://127.0.0.1:…` at all — a
 * literal is judged only by the string prechecks at registration / call sites.
 * Probe: an Agent whose lookup refuses everything fetched `http://127.0.0.1:<p>/`
 * with 200 and ZERO lookup calls, and refused `http://localhost:<p>/`. So for
 * the in-process lane's literal origins the allowlist's load-bearing arm is the
 * STRING one; this arm is what makes a hostname origin (`host.docker.internal`,
 * `localhost`) exact rather than host-wide. Closing the literal gap would change
 * production behaviour and is tracked separately.
 */
function makeWebhookConnector(lookup: LookupFunction): buildConnector.connector {
  return makeGuardedConnector(lookup, webhookPrivateEgressAllowed, true);
}

/**
 * The connector every guarded Agent dials through. The `lookup` guard alone is
 * NOT enough: undici never calls `lookup` for an IP-LITERAL host (MEASURED
 * during WHD-19: a lookup refusing everything, a literal fetched 200 with 0
 * lookup calls), so a literal would reach the socket having met no check at
 * connect time. This refuses a denied literal here, before dialling, so the
 * guard no longer rests on every call site remembering its string precheck
 * (WHD-27).
 */
function makeGuardedConnector(
  lookup: LookupFunction,
  allowPrivate: () => boolean,
  honourAllowlist: boolean,
): buildConnector.connector {
  const guarded = buildConnector({ lookup });
  const open = buildConnector({});
  return (opts, callback) => {
    if (honourAllowlist && isAllowlistedWebhookSocket(opts.protocol, opts.hostname, opts.port)) {
      open(opts, callback);
      return;
    }
    const literal = opts.hostname.replace(/^\[|\]$/g, '');
    if ((isIPv4(literal) || isIPv6(literal)) && !allowPrivate() && isDeniedWebhookHost(literal)) {
      log.warn('egress_denied', { hostname: opts.hostname, resolvedAddress: literal, literal: true });
      callback(new WebhookEgressDeniedError(opts.hostname, literal), null);
      return;
    }
    guarded(opts, callback);
  };
}

let dispatcher: Agent | null = null;

/**
 * The undici dispatcher every webhook delivery MUST go through. Lazy
 * singleton: one Agent for the worker's lifetime (connection reuse of an
 * already-validated address is fine — the pinned resolution was checked at
 * connect time, which is the property RFC 0093 §A.1 demands).
 */
export function webhookEgressDispatcher(): Agent {
  // ADR 0533 — THE replay effect seam for outbound HTTP, and the reason this
  // getter (rather than `guardedEgressFetch`) carries the guard.
  //
  // `guardedEgressFetch` below is the documented chokepoint, but it is not the
  // only one: `mcpClient.ts`, `webResearchSurface.ts`, `sandboxAdapter.ts`,
  // `e2bAdapter.ts` and `imageProviderAdapter.ts` all call `undiciFetch`
  // DIRECTLY and reach the same SSRF posture by passing this dispatcher. Every
  // one of them — and `guardedEgressFetch` itself — calls this function INLINE
  // in the fetch init, exactly once per outbound request. So putting the guard
  // on `guardedEgressFetch` alone would leave MCP tool invocation unguarded
  // during a replay: a fail-open hole in a path a pack node can reach.
  //
  // CORRECTED — this comment used to list `connectionInjection.ts`
  // (`ctx.http.safeFetch`) among the sites passing THIS dispatcher, and named
  // an unguarded safeFetch as the hole it existed to close. That was false in
  // both halves: safeFetch builds its own Agent via `makeGuardedAgent` below,
  // which shares the SSRF posture and NOT this replay guard, and it hoists it
  // into a module-level cache. So the described hole was open — ten
  // `core.openwop.http.*` nodes declaring `role: "side-effect"` re-executed on
  // a replay fork with neither the fast path nor this backstop in the way (of
  // the ten, `openapi-call` is the one shipping in chains). The guard now lives
  // in that file's own `safeFetchDispatcher()`; this dispatcher never covered it.
  //
  // THE INVARIANT THIS RESTS ON: no call site may hoist a guarded `Agent`
  // into a module-level constant WITHOUT its getter re-asserting, or its
  // requests stop passing the guard while still looking guarded.
  // `test/run-effect-context.test.ts` pins it by requiring every function used
  // as a `dispatcher:` to reach `assertEffectAllowed` — the property itself,
  // rather than the one syntactic shape that used to stand in for it.
  //
  // `assertEffectAllowed` is a no-op outside a run, so the webhook delivery
  // worker and the OAuth/SAML route fetches are unaffected.
  assertEffectAllowed('network-egress', 'undici egress dispatcher');
  if (!dispatcher) {
    dispatcher = new Agent({ connect: makeWebhookConnector(guardedLookup) });
  }
  return dispatcher;
}

/**
 * Build an Agent that shares the SAME pinned-resolution SSRF guard as the
 * webhook dispatcher but carries additional per-surface clamps (response-body
 * ceiling, header/body timeouts). Used by `ctx.http.safeFetch`
 * (host/connectionInjection.ts), whose advertised `httpClient` caps MUST equal
 * the values enforced here — the guard predicate itself is never duplicated.
 */
export function makeGuardedAgent(opts: {
  maxResponseSize?: number;
  headersTimeout?: number;
  bodyTimeout?: number;
  /** Which ALLOW_PRIVATE gate the connect-time guard honors. Defaults to the
   *  WEBHOOK flag (back-compat); the safeFetch dispatcher passes
   *  `safeFetchPrivateEgressAllowed` so it is NOT relaxed by the webhook flag. */
  allowPrivate?: () => boolean;
} = {}): Agent {
  const { allowPrivate, ...agentOpts } = opts;
  // A caller that brings its OWN gate (safeFetch) gets exactly that gate and
  // NOT the webhook origin allowlist — the same separation as the flags above.
  // Only the default (webhook-family) posture honours the allowlist.
  if (allowPrivate) return new Agent({ connect: makeGuardedConnector(makeGuardedLookup(allowPrivate), allowPrivate, false), ...agentOpts });
  return new Agent({ connect: makeWebhookConnector(guardedLookup), ...agentOpts });
}

/**
 * The single SSRF-guarded fetch for host outbound requests to a caller/config-supplied
 * URL. Bundles the whole egress posture so a new call site can't adopt a weaker subset:
 *
 *   1. STRING precheck — reject a denied host literal up front (cheap, clear error
 *      before any socket), unless `OPENWOP_WEBHOOK_ALLOW_PRIVATE` (dev/self-host).
 *   2. https-only (same env bypass).
 *   3. `webhookEgressDispatcher()` — connect-time PINNED-resolution re-validation, so a
 *      DNS-rebind to a private address is refused at dial time (no TOCTOU).
 *   4. `redirect: 'error'` by default — a 3xx to an internal host is an SSRF bypass; a
 *      caller that genuinely needs redirect-following can pass `init.redirect`.
 *
 * Throws {@link WebhookEgressDeniedError} (denied host) or a plain Error (insecure
 * scheme / bad URL) BEFORE fetching; callers map these to their own typed error shape.
 * Returns the undici `Response` (its `.body` stream is preserved for SSE consumers).
 */
export async function guardedEgressFetch(
  url: string,
  init: Parameters<typeof undiciFetch>[1] = {},
): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`guardedEgressFetch: invalid URL`);
  }
  if (!webhookPrivateEgressAllowedFor(parsed)) {
    if (isDeniedWebhookHost(parsed.hostname)) {
      throw new WebhookEgressDeniedError(parsed.hostname, parsed.hostname);
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('guardedEgressFetch: endpoint must be https');
    }
  }
  return undiciFetch(url, {
    redirect: 'error',
    ...init,
    dispatcher: webhookEgressDispatcher(),
  });
}
