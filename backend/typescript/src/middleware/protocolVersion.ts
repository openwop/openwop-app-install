/**
 * The v2 front door — major negotiation, the unversioned path space, and the
 * v2 response hygiene (`spec/v2/core/versioning.md` §1.3–§1.5, §5;
 * `spec/v2/core/headers.md` §"Removed in v2"; `spec/v2/core/errors.md`).
 *
 * OpenWOP v2 keeps ONE host serving TWO majors through the overlap:
 *
 *   - major 1 (`1.1`) is the `/v1/…` path space — byte-for-byte what this host
 *     served before this module existed, plus the one additive response header
 *     §1.4 makes REQUIRED of every response on any path.
 *   - major 2 (`2.0`) is the SAME operations at the SAME path keys with the
 *     `/v1` prefix removed. A request that names `OpenWOP-Version: 2` on an
 *     unversioned key is rewritten onto the v1 handler, so there is exactly one
 *     implementation of each operation and the two majors cannot drift.
 *
 * What decides the contract (§1.3):
 *
 *   | request                                   | contract |
 *   |-------------------------------------------|----------|
 *   | any `/v1/…` path                          | 1        |
 *   | `OpenWOP-Version: 1` on any path          | 1        |
 *   | `OpenWOP-Version: 2` on an unversioned key| 2        |
 *   | no header                                 | `preferredVersion`'s major |
 *
 * `preferredVersion` is `1.1` through the overlap (§1.1: "Through the overlap
 * `preferredVersion` MUST name a 1.x member"), so a header-less request keeps
 * getting exactly the v1 answer it got yesterday. That is why the unversioned
 * mount below fires ONLY under major 2: a header-less `GET /runs` stays a 404,
 * as it was, rather than quietly becoming a second spelling of `/v1/runs`.
 *
 * The three refusals (§1.3, codes from `spec/v2/errors.json`):
 *
 *   - a major not in `protocolVersions[]`  → `406 protocol_version_unsupported`
 *     with `details.protocolVersions[]` echoing the advertised list
 *   - `OpenWOP-Version` ≠ 1 on a `/v1/…` key → `400 protocol_version_mismatch`
 *   - `OpenWOP-Client-Version` below `minClientVersion` → `426
 *     client_version_unsupported`
 *
 * Scope note (v2 charter Phase 4, P4-B′): the unversioned mount covers the run
 * and interrupt surfaces the v2 conformance scenarios drive. It is an explicit
 * allowlist rather than a blanket "strip `/v1` from anything" because this host
 * serves a large non-`/v1` surface of its own (`/health`, `/public/…`, the
 * frontend) that has nothing to do with the protocol's unversioned path space,
 * and a blanket rewrite would silently shadow it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { locateRepoSchemasDir } from '../host/_repoPath.js';
import { runUnderContract } from '../storage/eventEraAdapter.js';
import { projectV2RunIds } from '../host/v2Ids.js';

/** The 1.x contract this host serves (`spec/v1/…` at `/v1/…`). */
export const PROTOCOL_VERSION_V1 = '1.1';
/** The 2.x contract this host serves (`spec/v2/…` at the unversioned keys). */
export const PROTOCOL_VERSION_V2 = '2.0';
/**
 * RFC 0172 §A.1 — every `<major>.<minor>` this host serves. Derived from the two
 * constants above so the advertisement and the negotiator cannot disagree.
 */
/**
 * ADR 0669 — the RETIREMENT cut-switch, and the reason it is ONE flag.
 *
 * `versioning.md` §5 makes retirement ATOMIC: dropping `1.x` from
 * `protocolVersions[]`, moving `preferredVersion` to `2.0`, and withdrawing the
 * `/v1` path space are one act. Any two of the three without the third is a
 * self-contradictory advertisement — a host that still lists `1.1` while
 * preferring `2.0` violates §1.1, and one that withdraws `/v1` while listing
 * `1.1` advertises a contract it refuses to serve.
 *
 * So they are DERIVED from one predicate rather than set independently. There
 * is no way to flip half of this, because there is no half to flip.
 *
 * Read at CALL time, never captured at import: the rehearsal
 * (`test/adr0669-v1-retirement-rehearsal.test.ts`) has to be able to boot an
 * app under each setting inside one process, and a module-level capture would
 * make the second boot silently inherit the first. That is the same
 * stale-snapshot shape this repo has been bitten by elsewhere.
 *
 * THIS FLAG IS NOT A TUNING KNOB. `versioning.md` §5 and the corpus EOS clock
 * (leg (a) `notBefore` 2026-12-04) decide when it may be set in production;
 * turning it on before then is a conformance violation, not a configuration
 * choice. It exists so that retirement DAY is a flag flip that has already been
 * rehearsed, rather than a migration performed under time pressure.
 */
export function v1Retired(): boolean {
  return (process.env.OPENWOP_V1_RETIRED ?? '').trim().toLowerCase() === 'true';
}

/**
 * RFC 0172 §A.1 — every `<major>.<minor>` this host serves. Derived from the
 * two constants above so the advertisement and the negotiator cannot disagree,
 * and from `v1Retired()` so they cannot disagree across the cut either.
 */
export function protocolVersions(): readonly string[] {
  return v1Retired() ? [PROTOCOL_VERSION_V2] : [PROTOCOL_VERSION_V1, PROTOCOL_VERSION_V2];
}
/**
 * `versioning.md` §1.1 — the header-less default. MUST name the 1.x member for
 * as long as `protocolVersions[]` carries one: `capabilities.md` §1 makes the
 * header-less representation of `/.well-known/openwop` the v1 document, and
 * §1.3 makes the header-less default `preferredVersion`'s major, so the two
 * rules agree only while this names `1.1`. Moving it to `2.0` is the END of the
 * overlap, not a tuning knob.
 */
export function preferredVersion(): string {
  return v1Retired() ? PROTOCOL_VERSION_V2 : PROTOCOL_VERSION_V1;
}
/**
 * `versioning.md` §1.5 — the client floor. `1.0` is honest: this host has
 * served the 1.x wire since 1.0 and refuses nothing below it today; the value
 * exists so the `426` is reachable and the advertisement is not a blank.
 */
export function minClientVersion(): string {
  // Post-cut the floor is the 2.x contract: a 1.x client is not "below the
  // floor", it is asking for a contract that no longer exists, and §1.5's
  // `426` is the honest refusal for both.
  return v1Retired() ? PROTOCOL_VERSION_V2 : '1.0';
}

/** The request header that selects the contract (§1.3). */
const VERSION_HEADER = 'openwop-version';
/** The request header a client announces itself with (§1.5). */
const CLIENT_VERSION_HEADER = 'openwop-client-version';
/** The response header naming the contract that produced the response (§1.4). */
export const VERSION_RESPONSE_HEADER = 'OpenWOP-Version';

/**
 * The unversioned keys this host serves under major 2, DERIVED from the corpus
 * path manifest rather than hand-listed. The v2 key of an operation is its v1
 * key without the `/v1` prefix (`api/v2/openapi.yaml`), so a match here is
 * rewritten onto the existing v1 handler.
 *
 * CORRECTED 2026-09-04. This was `['/runs', '/interrupts']` — a private
 * allowlist naming the two surfaces the v2 scenarios happened to drive. The
 * manifest declares THIRTEEN top-level segments, so this host advertised
 * `protocolVersions: ["1.1","2.0"]` while routing a seventh of major 2's path
 * space. MEASURED on the live host: five of five pairable surfaces answered
 * `404` under major 2 and `200` under `/v1` — `/agents`, `/agents/org-chart`,
 * `/openapi.json`, `/prompts`, `/tools`.
 *
 * WHY NOTHING CAUGHT IT, which is the part worth keeping. Every probe used to
 * call the dual stack live — `protocolVersions`, `preferredVersion`, the
 * response header, the two differing representations, and the corpus's own
 * `v2-version-header-honored` — targets `/.well-known/openwop`. That is the one
 * resource whose REPRESENTATION the header selects, so all of them pass for a
 * host that negotiates perfectly there and has mounted almost nothing else. It
 * took a scenario probing a PAIR (`/v1<path>` and `<path>` under major 2) to
 * separate "does not implement this surface" from "implements it and did not
 * mount it under major 2" — facts a lone 404 cannot distinguish.
 *
 * The allowlist STRATEGY was right and is kept: a blanket "strip `/v1` from
 * anything" would shadow the large non-`/v1` surface this host serves
 * (`/health`, `/readiness`, `/schemas`, `/scim`, the SPA). What was wrong was
 * maintaining the list by hand, which cannot notice the corpus adding an
 * operation. Deriving it cannot fail to.
 *
 * `/.well-known` is excluded deliberately: discovery is ONE resource with two
 * representations (`capabilities.md` §1), chosen by the header inside the
 * route, never a path rewritten onto a `/v1` twin.
 *
 * Collision-checked against this host's own non-`/v1` mounts at the time of
 * writing — `/health`, `/readiness`, `/schemas`, `/scim` — and the manifest
 * intersects none of them. A future corpus segment that DID collide would
 * shadow a host route silently, so `v2MountedPrefixes()` throws on that overlap
 * rather than letting the rewrite win.
 */
// Every unversioned first segment this host OCCUPIES. The manifest derivation
// below refuses to mount a v2 path space over any of them, because the rewrite
// would shadow whatever serves that name silently.
//
// CORRECTED 2026-09-12: this list was hand-written and named FOUR of the
// eleven. Two corrections, and the second is the instructive one.
//
// First, two registered roots had simply never been added — `/p`
// (`features/publishing/routes.ts`) and `/llms.txt` (`features/docs/routes.ts`),
// both added after this constant was written.
//
// Second, and worse: "registered" is only one of the three ways this host takes
// a name. The others answer no `app.get('/x')` grep at all.
//   - a path-literal registration  — `/health`, `/llms.txt`, `/p`, `/readiness`,
//                                    `/schemas`, `/scim`
//   - an anchored-regex REWRITE    — `/conformance` (`routes/conformanceSeams.ts`
//                                    aliases the v2 seam space onto its v1
//                                    address), `/blog` and `/pod`
//                                    (`middleware/customDomain.ts`)
//   - an exact-string COMPARISON   — `/api` (`index.ts`, the Firebase→Cloud Run
//                                    prefix strip, which runs BEFORE the
//                                    negotiator and would eat a colliding
//                                    manifest op outright) and `/pricing`
//
// A rewrite occupies a name exactly as firmly as a registration does, and is
// invisible to the scan that finds registrations. Found by applying
// myndhyve-1's finding (crosstalk `07ed`) that a check keyed on `/v1` looks at
// the wrong set — what is at risk is what is served WITHOUT a version — and
// then by not stopping at the first mechanism that answered.
//
// `test/unversioned-mount-guard-complete.test.ts` derives all three from source
// and fails when this constant disagrees, so the list stays a constant (the
// derivation runs at import, before any route or middleware registers) while
// completeness stops being a matter of memory. That test states plainly which
// mechanisms it covers: a FOURTH way of taking a name would escape it, and the
// honest position is that this constant is pinned against three known
// mechanisms rather than proven complete.
//
// `/.well-known` is deliberately absent: the derivation filters it out of the
// manifest segments explicitly, so it cannot collide. `/` likewise — a
// one-character segment never matches.
export const HOST_OWN_UNVERSIONED_MOUNTS: readonly string[] = [
  '/api', '/blog', '/conformance', '/health', '/llms.txt', '/p',
  '/pod', '/pricing', '/readiness', '/schemas', '/scim',
];

function v2MountedPrefixes(): readonly string[] {
  const manifestPath = join(
    locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json'),
    'v2', 'path-manifest.json',
  );
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  const ops: unknown = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown>)['operations'] ?? (raw as Record<string, unknown>)['paths']);
  const list: string[] = Array.isArray(ops)
    ? ops.map((o) => (typeof o === 'string' ? o : String((o as Record<string, unknown>)['path'] ?? '')))
    : Object.keys((ops ?? {}) as Record<string, unknown>);
  const segments = [...new Set(
    list
      .filter((p) => p.startsWith('/'))
      // First segment only, with any `:action` suffix stripped — `/runs:bulk-cancel`
      // is a key of the `/runs` resource, and `isV2MountedPath` already treats `:`
      // as a boundary.
      .map((p) => `/${p.split('/').filter(Boolean)[0]?.split(':')[0] ?? ''}`)
      .filter((p) => p.length > 1 && p !== '/.well-known'),
  )].sort();
  const collisions = segments.filter((s) => HOST_OWN_UNVERSIONED_MOUNTS.includes(s));
  if (collisions.length > 0) {
    throw new Error(
      `protocolVersion: the v2 path manifest declares ${collisions.join(', ')}, which this host already serves `
      + 'as its OWN unversioned route. Mounting it would shadow that route silently. Resolve deliberately '
      + '(rename the host route, or special-case the segment) rather than letting the rewrite win.',
    );
  }
  return segments;
}

const V2_MOUNTED_PREFIXES: readonly string[] = v2MountedPrefixes();

/** The org this host's non-protocol codes AND paths travel under (`errors.md` vendor pattern; RFC 0181). */
export const VENDOR_ORG = 'openwop-app';

/**
 * RFC 0181 (ADR 0652) — this host's PROPRIETARY path namespace: `/host/<org>/…`
 * where `<org>` is the org registered in `spec/v2/declaration.json`
 * `extensions` (`openwop-app`, registered 2026-09-11, in effect at the 2.0.12
 * pin). No major in the path; the `OpenWOP-Version` header selects NOTHING
 * here because nothing here is a protocol operation (§1.2 binds manifest-named
 * operations only), so a vendor path is served the same way with the header,
 * without it, or with a malformed one, carries NO `OpenWOP-Version` response
 * header, and runs under the host's own (v1) dialect. `/v1/host/<org>/…` is
 * the twin through the overlap and retires atomically with `/v1`
 * (`versioning.md` §5); the December flip inverts this rewrite.
 *
 * Before ADR 0652 this address was reachable by ACCIDENT: `/host` is a derived
 * manifest prefix (from `/host/effect-seams` + `/host/events`), so ADR 0646's
 * content negotiation rewrote every JSON client's `/host/openwop-app/…` onto
 * the twin and stamped a version header on a non-protocol response. Found by
 * the 2026-09-10 readiness measurement (crosstalk 8f27 §7c); ruled d4d0.
 */
export const VENDOR_ROOT = `/host/${VENDOR_ORG}`;
export function isVendorPath(path: string): boolean {
  return path === VENDOR_ROOT || path.startsWith(`${VENDOR_ROOT}/`);
}
/**
 * RFC 0181 §reserved segments: an org MAY NOT be named after a first segment the
 * manifest uses under `/host/` (`effect-seams`, `events`, …). Enforced here
 * against the vendored manifest, so a future manifest that adds
 * `/host/openwop-app` as a PROTOCOL path fails the boot, not the wire.
 */
function assertVendorOrgNotReserved(): void {
  const manifestPath = join(
    locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json'),
    'v2', 'path-manifest.json',
  );
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  const ops: unknown = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown>)['operations'] ?? (raw as Record<string, unknown>)['paths']);
  const list: string[] = Array.isArray(ops)
    ? ops.map((o) => (typeof o === 'string' ? o : String((o as Record<string, unknown>)['path'] ?? '')))
    : Object.keys((ops ?? {}) as Record<string, unknown>);
  const hostSegments = new Set(
    list.filter((p) => p.startsWith('/host/')).map((p) => p.split('/').filter(Boolean)[1]?.split(':')[0] ?? ''),
  );
  if (hostSegments.has(VENDOR_ORG)) {
    throw new Error(
      `protocolVersion: the v2 path manifest uses /host/${VENDOR_ORG} as a PROTOCOL segment; RFC 0181 reserves it — `
      + 'the vendor namespace cannot share a first segment with a manifest operation.',
    );
  }
}
assertVendorOrgNotReserved();

/**
 * ADR 0631 — the manifest roots, for the ONE other consumer that must agree
 * with the negotiator about what an unversioned root is: the publishing
 * feature's SPA-shell fallthrough. Same derivation, same file, no second list.
 */
export function v2MountedRootPrefixes(): readonly string[] { return V2_MOUNTED_PREFIXES; }

/**
 * `headers.md` §"Removed in v2" — header families that MUST NOT appear on a
 * major-2 response. `Capabilities-Etag` is superseded by the standard `ETag`;
 * the rest are v1 spellings renamed under the one `OpenWOP-<Name>` scheme. They
 * keep being emitted on major-1 responses through the overlap.
 */
function isRemovedInV2(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.startsWith('x-openwop-') ||
    n.startsWith('x-pack-') ||
    n === 'capabilities-etag' ||
    n === 'x-dedup' ||
    n === 'x-force-engine-version'
  );
}

/**
 * `errors.md` §"Retry timing" — retry timing lives in `Retry-After` and nowhere
 * else. These three spellings are v1 carriers this host still emits under major
 * 1 (`middleware/rateLimit.ts`, `routes/runs.ts` in-flight 409); under major 2 a
 * host MUST NOT emit them, so they are dropped on the way out rather than
 * removed from the v1 wire.
 */
const REMOVED_RETRY_KEYS: readonly string[] = ['retryAfter', 'retryAfterMs', 'retryAfterSeconds'];

/**
 * `errors.md` — under major 2 the `error` field is a code from the v2 registry
 * (`spec/v2/errors.json`, 94 rows) or a vendor code `<org>.<name>`. A producer
 * MUST NOT emit an unregistered member.
 *
 * READ from the vendored artifact, never re-typed: `schemas/v2/error-envelope.
 * schema.json` is generated from the registry, so a corpus bump moves this set
 * with it. A literal copy would satisfy the schema on the day it was written
 * and drift on the first bump — the exact defect `check:schemas` exists to catch
 * for the other load-bearing schemas.
 */
const V2_REGISTERED_CODES: ReadonlySet<string> = (() => {
  try {
    const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json');
    const doc = JSON.parse(readFileSync(join(dir, 'v2', 'error-envelope.schema.json'), 'utf8')) as {
      properties?: { error?: { oneOf?: Array<{ enum?: string[] }> } };
    };
    return new Set(doc.properties?.error?.oneOf?.flatMap((b) => b.enum ?? []) ?? []);
  } catch {
    // A deploy without the vendored corpus still serves major 1 correctly; the
    // v2 codes then fall through to the vendor namespace below, which is honest
    // (a vendor code says "mine", never "the protocol's").
    return new Set<string>();
  }
})();

/**
 * v1 codes this host emits on the surfaces mounted under major 2, mapped to the
 * v2 registry row that means the same thing at the same HTTP status. Only
 * spellings — every entry is the SAME refusal, so no behaviour moves with it.
 */
const V2_CODE_ALIASES: Readonly<Record<string, string>> = {
  run_not_found: 'not_found',
  workflow_not_found: 'not_found',
  interrupt_token_not_found: 'interrupt_not_found',
  // `interrupt.md` §"Resolve surfaces": the token surfaces answer `404
  // not_found` for a token that names no interrupt. This host's v1 spelling is
  // `invalid_interrupt_token`; the refusal is the same one.
  invalid_interrupt_token: 'not_found',
  unauthorized: 'unauthenticated',
  idempotency_key_conflict: 'idempotency_key_mismatch',
  // RFC 0170 / `identity.md` §2.2 — a session revoked since it was minted (the
  // ADR 0621 epoch bump: sign-out-everywhere, disable, factor reset) is a
  // revoked credential on a `next-request` lane. Same 401, same refusal; v1
  // keeps the spelling its clients already handle.
  session_revoked: 'credential_revoked',
};

const VENDOR_CODE = /^(?!openwop\.)[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9_]*$/;

/**
 * The v2 spelling of an error code: a registered row passes through, a known v1
 * spelling is aliased onto its registered twin, and anything else travels as a
 * vendor code. Namespacing rather than silently promoting an unknown code to the
 * registry is the honest move — `openwop-app.sandbox_pack_not_found` says "this
 * is our code" where bare `sandbox_pack_not_found` would claim to be protocol.
 */
export function v2ErrorCode(code: string): string {
  if (V2_REGISTERED_CODES.has(code) || VENDOR_CODE.test(code)) return code;
  const aliased = V2_CODE_ALIASES[code];
  if (aliased !== undefined) return aliased;
  return `${VENDOR_ORG}.${code}`;
}


/**
 * ADR 0654 — v1 is DEPRECATED on this host (operator directive 2026-09-11;
 * steward ruling crosstalk 4ad9). Every `/v1/…` response (protocol
 * operations and the vendor twin alike) and the v1 discovery document carry
 * RFC 9745 `Deprecation: @<epoch>` (the date this host deprecated v1).
 * RFC 8594 `Sunset` is emitted ONLY when the host actually holds a date
 * (`OPENWOP_V1_SUNSET=<YYYY-MM-DD>`): the end-of-support clock's `notBefore`
 * (2026-12-04) is a floor computed by the corpus from the matrix, not a date
 * this host holds, and a Sunset that names a floor would be a claim. Both are
 * IETF standard headers — not protocol headers (`headers.md`, RFC 0171 §C.1)
 * — so nothing in §1.4 constrains them. Retirement itself stays atomic and
 * clock-bound (`versioning.md` §5); this is the signal, not the drop.
 * `OPENWOP_V1_DEPRECATION=off` silences the whole signal.
 */
const V1_DEPRECATED_ON = '2026-09-11';
const V1_SUNSET_LINK = 'https://github.com/openwop/openwop/blob/main/spec/v2/core/overview.md#v1-end-of-support-rfc-0174-b4';
export function v1DeprecationHeaders(): Readonly<Record<string, string>> | null {
  // ADR 0669 — post-cut there is nothing left to deprecate. A `Deprecation`
  // header on a host that no longer serves major 1 is a claim about a contract
  // it does not have, and RFC 9745 has no reading under which it is true.
  if (v1Retired()) return null;
  if ((process.env.OPENWOP_V1_DEPRECATION ?? '').trim().toLowerCase() === 'off') return null;
  const out: Record<string, string> = {
    Deprecation: `@${Math.floor(new Date(`${V1_DEPRECATED_ON}T00:00:00Z`).getTime() / 1000)}`,
    Link: `<${V1_SUNSET_LINK}>; rel="deprecation"`,
  };
  const raw = (process.env.OPENWOP_V1_SUNSET ?? '').trim();
  if (raw.length > 0) {
    const sunset = new Date(`${raw}T00:00:00Z`);
    if (!Number.isNaN(sunset.getTime())) {
      out['Sunset'] = sunset.toUTCString();
      out['Link'] = `<${V1_SUNSET_LINK}>; rel="sunset"`;
    }
  }
  return out;
}

/** Where the negotiated contract is parked for the rest of the request. */
const MAJOR = Symbol.for('openwop.protocol.major');

interface Negotiated extends Request {
  [MAJOR]?: 1 | 2;
}

/** The major this request is being served under. Defaults to 1 (the overlap). */
export function negotiatedMajor(req: Request): 1 | 2 {
  return (req as Negotiated)[MAJOR] ?? 1;
}

/** The `<major>.<minor>` contract this request is being served under. */
export function negotiatedVersion(req: Request): string {
  return negotiatedMajor(req) === 2 ? PROTOCOL_VERSION_V2 : PROTOCOL_VERSION_V1;
}

/**
 * `<major>` or `<major>.<minor>`. The spec's §1.3 prose says the request header
 * "carries an integer major only", but every v2 conformance scenario and the
 * suite's own driver send `OpenWOP-Version: 2.0`, so both are accepted; a value
 * outside the grammar is `malformed`.
 */
function parseVersionHeader(raw: string | undefined): { major: number | null; malformed: boolean } {
  if (raw === undefined || raw.trim() === '') return { major: null, malformed: false };
  const m = /^(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?$/.exec(raw.trim());
  if (!m) return { major: null, malformed: true };
  return { major: Number(m[1]), malformed: false };
}

/** `a < b` over `<major>.<minor>`; a malformed announcement sorts below everything. */
function versionLessThan(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  return (pa[0] ?? 0) < (pb[0] ?? 0) || ((pa[0] ?? 0) === (pb[0] ?? 0) && (pa[1] ?? 0) < (pb[1] ?? 0));
}

/**
 * ADR 0649 — the ONE place the major-1 path prefix is spelled. Every protocol
 * route registers through `v1()`, the public-path allowlist reads it, and the
 * negotiator's `isV1Path` derives from it. December's retirement (ADR 0642,
 * atomic, EOS 2026-12-04) is then a change to THIS constant plus inverting the
 * rewrite below — not 46 edits across 14 files under a deadline. MEASURED
 * before this ADR: 346 of 347 registrations hard-coded `/v1` individually.
 *
 * Host-extension routes (`/v1/host/openwop-app/*`) and the conformance seams
 * deliberately do NOT use it: they are not retiring with major 1 (their home
 * under major 2 is an open corpus question), so a prefix they share with the
 * protocol would flip them by accident.
 */
export const V1_PATH_PREFIX = '/v1';
/** `v1('/runs')` → `/v1/runs`. Protocol routes only — see above. */
export function v1(path: string): string {
  return `${V1_PATH_PREFIX}${path}`;
}

/**
 * The `/v1` TWIN of a vendor-namespace path (ADR 0654). Through the overlap a
 * host-extension operation is registered on its twin and reached either
 * there or, after ADR 0652, at the canonical `/host/<org>/…`; the twin
 * retires with `/v1` (`versioning.md` §5). Built from the constants so the
 * v1-reliance ratchet, which counts `/v1/host/openwop-app/` LITERALS, sees
 * the destination of a migration, not a new reliance.
 */
export function vendorTwin(path: string): string {
  return `${V1_PATH_PREFIX}${VENDOR_ROOT}${path}`;
}

function isV1Path(path: string): boolean {
  return path === V1_PATH_PREFIX || path.startsWith(`${V1_PATH_PREFIX}/`);
}

/**
 * Whether `path` is an unversioned key this host mounts under major 2.
 * `:`-suffixed operations (`/runs/{id}:fork`, `/runs:bulk-cancel`) are keys of
 * the same resource, so the boundary is `/` OR `:`.
 */
/** `/<kind>/<tenant>/<opaque>` — the decoded spelling of a bound id (see the
 *  rewrite below). `<opaque>` is the 16–128 grammar of `host/v2Ids.ts`; the
 *  lookahead keeps `:fork` / `/events` / `/test` / `?…` suffixes intact.
 *
 *  THE SAME THREE KINDS AS `middleware/v2Identity.ts` `RUN_PATH`, and that is
 *  the point. ADR 0723 taught the path guard to accept bound ids on `webhooks`
 *  and `trigger-subscriptions` as well as `runs`, but this re-encode — the half
 *  that makes a bound id survive a `%2F`-decoding proxy — was only ever written
 *  for `runs`. So at the PUBLIC origin a major-2 client echoing back the
 *  `webhookId` the host itself returned (`DELETE /webhooks/<tenant>%2F<uuid>`,
 *  which Firebase forwards as `/webhooks/<tenant>/<uuid>`) got 404, while the
 *  identical request on the direct `run.app` URL got 204. MEASURED 2026-09-21
 *  against production `27315b41c`; every post-deploy conformance cut therefore
 *  leaked its subscriptions (1 → 3 in one cut). No sub-resource under either
 *  new kind is ≥ 16 characters (`/webhooks/{id}/test` is the only one), so the
 *  second segment is as unambiguous as it is for runs. */
const DECODED_BOUND_ID = /^\/(runs|webhooks|trigger-subscriptions)\/([A-Za-z0-9._~-]{1,128})\/([A-Za-z0-9._~-]{16,128})(?=$|[/:?])/;
/**
 * ADR 0646 — is this request FOR the protocol, on a name the host also serves a
 * page on? The ruling (`versioning.md` §1.3/§1.4, errata 2026-09-10) admits a
 * protocol client by either signal:
 *   - `OpenWOP-Version` present — it named a contract, it wants the operation;
 *   - or an `Accept` that admits `application/json` without PREFERRING
 *     `text/html` — absent, or `*​/*`, or json at a q no lower than html's.
 * `req.accepts()` is that rule already: it orders by q, breaks ties by the
 * order given, returns the first type when `Accept` is absent, and `false`
 * when nothing matches — and a client that accepts neither JSON nor HTML is
 * not a browser, so it gets the operation. Only a client that PREFERS html is
 * the page's.
 */
export function isProtocolClient(req: Request): boolean {
  if (req.header(VERSION_HEADER) !== undefined) return true;
  return req.accepts(['application/json', 'text/html']) !== 'text/html';
}

function isV2MountedPath(path: string): boolean {
  return V2_MOUNTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}:`));
}

/** The flat v2 envelope (`errors.md`): `{ error, message, details? }` and nothing else. */
function refuse(
  res: Response,
  status: number,
  error: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  res.status(status).json(details === undefined ? { error, message } : { error, message, details });
}

/**
 * Strip the removed retry spellings from an outgoing major-2 error body. Only
 * touches a body that is already the error envelope — a successful response that
 * happens to carry a `details` object is not an error and is left alone.
 */
function toV2Envelope(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return body;
  const envelope = body as Record<string, unknown>;
  const code = envelope['error'];
  // Only an error envelope is rewritten — a successful response that happens to
  // carry a `details` object is not an error and is left exactly alone.
  if (typeof code !== 'string') return body;
  const out: Record<string, unknown> = { ...envelope, error: v2ErrorCode(code) };
  const details = out['details'];
  if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
    const kept = Object.fromEntries(
      Object.entries(details as Record<string, unknown>).filter(([k]) => !REMOVED_RETRY_KEYS.includes(k)),
    );
    if (Object.keys(kept).length === 0) delete out['details'];
    else out['details'] = kept;
  }
  return out;
}

/**
 * Under major 2, keep the removed header families off the wire, put every error
 * body in the v2 envelope (registry code, no retry timing in `details`), and
 * project every run id onto its tenant-bound wire form. Installed as wrappers
 * rather than a post-hoc sweep because the offending values are set by ~90 route
 * modules and a sweep would have to run after `writeHead`, which is too late.
 */
function installV2ResponseHygiene(req: Request, res: Response): void {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    if (isRemovedInV2(name)) return res;
    return setHeader(name, value);
  }) as Response['setHeader'];

  const json = res.json.bind(res);
  res.json = ((body?: unknown) => {
    // The tenant is read HERE, not at install time: this wrapper is installed
    // before `authMiddleware()` runs (the negotiator is the front door), and the
    // authenticated tenant is what §5 binds the id to.
    const tenant = (req as { tenantId?: string }).tenantId ?? 'default';
    return json(projectV2RunIds(toV2Envelope(body), tenant));
  }) as Response['json'];
}

/**
 * The negotiator. Mount ONCE, before auth: the unversioned mount rewrites
 * `req.url` onto the `/v1` key, and every downstream gate (the public-path
 * allowlist, the CSRF origin guard, the route table) must see the rewritten
 * path so a v2 request is authorized exactly like its v1 twin.
 */
export function protocolVersionMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = (req.url.split('?')[0] ?? req.url) || '/';
    const versioned = isV1Path(path);

    // ADR 0669 — post-cut, the `/v1` PATH SPACE is withdrawn. This is checked
    // against the INBOUND path and before any rewrite, which matters: the v2
    // routing below still sets `req.url = /v1${req.url}` internally, because
    // the rewrite is an implementation detail of how this host serves major 2
    // and not a claim on the wire. Refusing after the rewrite would refuse
    // every major-2 request; refusing here refuses only what a client actually
    // asked for.
    //
    // `410 Gone` rather than `404`: the resource existed, its removal is
    // permanent and dated, and a client that has cached a `/v1` URL should stop
    // rather than retry. The body names the surviving address so the refusal is
    // actionable instead of merely correct.
    if (versioned && v1Retired()) {
      res.status(410).json({
        error: 'protocol_version_unsupported',
        message:
          'The /v1 path space was withdrawn when this host retired major 1. '
          + 'Use the unversioned paths with `OpenWOP-Version: 2`.',
        details: { protocolVersions: [...protocolVersions()], preferredVersion: preferredVersion() },
      });
      return;
    }
    const { major: requested, malformed } = parseVersionHeader(req.header(VERSION_HEADER));

    // The contract is decided BEFORE anything else so even a refusal names it
    // (§1.4: reporting a version other than the one used is a silent downgrade).
    // §1.3 — the header-less default is `preferredVersion`'s major, so this
    // FOLLOWS the advertisement rather than restating it. Pre-cut that is 1;
    // post-cut it is 2, which is precisely the flip ADR 0646's content
    // negotiation was built to survive (a header-less browser must still get
    // the SPA page on a shared name, not JSON).
    let major: 1 | 2 = preferredVersion() === PROTOCOL_VERSION_V2 ? 2 : 1;
    if (!versioned && requested === 2) major = 2;
    if (!versioned && requested === 1 && !v1Retired()) major = 1;
    // ADR 0646 — a SHARED NAME is an unversioned manifest path this host also
    // serves something else on (`/agents`, `/prompts`, `/runs` are SPA pages).
    // Which consumer a request is for is decided HERE, by content negotiation,
    // never by the v1 default: until this line existed the only thing keeping
    // the SPA page and the protocol operation apart was that a header-less
    // request defaulted to major 1 — and retirement flips that default
    // (`versioning.md` §5), turning three pages into JSON on cutover day.
    // RFC 0181 (ADR 0652): a vendor path is not a protocol operation. The
    // header selects nothing, nothing is stamped, no negotiation, host dialect.
    if (!versioned && isVendorPath(path)) {
      (req as Negotiated)[MAJOR] = 1;
      req.url = `/v1${req.url}`;
      runUnderContract(1, next);
      return;
    }
    const sharedName = !versioned && isV2MountedPath(path);
    const protocolClient = !sharedName || isProtocolClient(req);
    // §1.4 (errata 2026-09-10): every PROTOCOL response carries the version;
    // a non-protocol response on a shared name MUST NOT, so a reader, a cache
    // or the suite can never mistake the shell for the operation.
    if (protocolClient) {
      res.setHeader(VERSION_RESPONSE_HEADER, major === 2 ? PROTOCOL_VERSION_V2 : PROTOCOL_VERSION_V1);
    }
    // ADR 0654: the v1 contract is deprecated — every /v1 response and the v1
    // representation of the discovery document say so.
    if (versioned || (major === 1 && path === '/.well-known/openwop')) {
      const dep = v1DeprecationHeaders();
      if (dep) for (const [k, v] of Object.entries(dep)) res.setHeader(k, v);
    }
    // ADR 0631 — an unversioned path answers DIFFERENT bodies to the same URL
    // depending on the request header (the API under a named major; the SPA
    // shell to a headerless browser), so every such response must say so.
    // MEASURED 2026-09-05: the Firebase CDN in front of the origin strips Vary
    // on some routes, which is why the shell branch is also `no-store`; this
    // header is still the correct statement for every other cache.
    if (!versioned) res.vary('OpenWOP-Version');
    if (sharedName) res.vary('Accept');
    (req as Negotiated)[MAJOR] = major;
    if (major === 2) installV2ResponseHygiene(req, res);

    if (malformed) {
      refuse(res, 400, 'validation_error', 'OpenWOP-Version MUST be <major> or <major>.<minor>.', {
        header: 'OpenWOP-Version',
      });
      return;
    }
    if (versioned && requested !== null && requested !== 1) {
      refuse(
        res,
        400,
        'protocol_version_mismatch',
        'A /v1/ path key serves the 1.x contract; OpenWOP-Version MUST NOT name another major on it.',
        { requested, path: '/v1/' },
      );
      return;
    }
    if (!versioned && requested !== null && requested !== 1 && requested !== 2) {
      refuse(res, 406, 'protocol_version_unsupported', `This host does not serve protocol major ${requested}.`, {
        protocolVersions: [...protocolVersions()],
      });
      return;
    }

    // §1.5 is a 2.x obligation and `minClientVersion` is advertised only in the
    // v2 root, so the floor is enforced only on requests served under major 2.
    // Refusing a v1 caller against a floor the v1 document never published would
    // be a new refusal on an unchanged contract.
    const announced = major === 2 ? req.header(CLIENT_VERSION_HEADER) : undefined;
    if (announced !== undefined && announced.trim() !== '') {
      const m = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)/.exec(announced.trim());
      if (versionLessThan(m ? `${m[1]}.${m[2]}` : '0.0', minClientVersion())) {
        refuse(
          res,
          426,
          'client_version_unsupported',
          `The client announced ${announced.trim()}, below minClientVersion ${minClientVersion()}.`,
          { minClientVersion: minClientVersion() },
        );
        return;
      }
    }

    // The unversioned path space (§5). One implementation, two path keys.
    // §1.3: a protocol client on an unversioned manifest path is served the
    // operation under the negotiated major — `preferredVersion`'s major when the
    // header is absent. Before ADR 0646 this branch ran only for `major === 2`,
    // so a header-less JSON client on `/agents` fell through to a JSON 404:
    // neither the operation §1.3 requires nor the shell. MEASURED live 2026-09-10.
    if (sharedName && protocolClient) {
      // ADR 0631 correction (2026-09-05, corpus steward `1d29`) — A PROXY THAT
      // DECODES `%2F` MUST NOT MAKE A BOUND ID UNREACHABLE. Firebase Hosting
      // forwards `/runs/<tenant>%2F<opaque>` as `/runs/<tenant>/<opaque>`, a
      // path this host correctly had no route for — so every read, poll, cancel
      // and stream of a run created at the origin answered 404 at the origin.
      // The decoded spelling is unambiguous: no sub-resource under `/runs/{id}`
      // is longer than 12 characters (`debug-bundle`), and the opaque grammar
      // is 16–128, so a second segment that matches it can only be the id.
      // Re-encode it here, before routing; the path guard then decodes and
      // runs the tenant check exactly as it does for the encoded form.
      // Major 1 never sees this branch — a `/v1` path is not an unversioned key.
      if (major === 2) {
        req.url = req.url.replace(DECODED_BOUND_ID, (_m, kind: string, tenant: string, opaque: string) => `/${kind}/${tenant}%2F${opaque}`);
      }
      req.url = `/v1${req.url}`;
    }
    // v2 charter Phase 4 (P4-C) — park the negotiated contract for the storage
    // seat (`storage/eventEraAdapter.ts`). `persistence.md` §"The reader rule"
    // binds EVERY reader (poll, SSE, fork, replay, debug bundle); running the
    // rest of the request inside the contract's async context is what makes that
    // true without a per-call-site opt-in a v2 route could forget. Under major 1
    // the store is entered with `1`, which is also the ambient default, so the
    // v1 path behaves exactly as it did before this line existed.
    runUnderContract(major, next);
  };
}
