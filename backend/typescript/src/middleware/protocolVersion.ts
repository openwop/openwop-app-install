/**
 * The v2 front door — major negotiation, the unversioned path space, and the
 * v2 response hygiene (`spec/v2/core/versioning.md` §1.3–§1.5, §5;
 * `spec/v2/core/headers.md` §"Removed in v2"; `spec/v2/core/errors.md`).
 *
 * Major 1 is RETIRED (ADR 0669 cut 2026-10-03; ADR 0812 removed it from the
 * code). This host serves ONE contract, `2.0`, at the unversioned path keys:
 *
 *   | request                                   | answer   |
 *   |-------------------------------------------|----------|
 *   | any `/v1/…` path                          | 410, or the ADR 0806 308 forward for a held vendor read |
 *   | `OpenWOP-Version: 2` or no header         | contract 2 |
 *   | `OpenWOP-Version: 1` (or any other major) | 406      |
 *   | a vendor path (`/host/openwop-app/…`)     | host dialect, no negotiation (RFC 0181) |
 *
 * The refusals (§1.3, codes from `spec/v2/errors.json`):
 *
 *   - a major not in `protocolVersions[]`  → `406 protocol_version_unsupported`
 *     with `details.protocolVersions[]` echoing the advertised list
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
import { projectV2RunIds, toWireRunId } from '../host/v2Ids.js';
import { createLogger } from '../observability/logger.js';
import { apiPathPrefixOf } from './authChallenge.js';

const log = createLogger('middleware.protocolVersion');

/** The retired 1.x contract (ADR 0812). Still the HOST DIALECT label for vendor paths. */
export const PROTOCOL_VERSION_V1 = '1.1';
/** The 2.x contract this host serves (`spec/v2/…` at the unversioned keys). */
export const PROTOCOL_VERSION_V2 = '2.0';
/**
 * ADR 0669 / ADR 0812 P3c — major 1 is RETIRED, and that is no longer a switch.
 *
 * `versioning.md` §5 made retirement ATOMIC: dropping `1.x` from
 * `protocolVersions[]`, moving `preferredVersion` to `2.0`, and withdrawing the
 * `/v1` path space are one act. Through the overlap all three were derived from
 * one predicate (`v1Retired()`, `OPENWOP_V1_RETIRED`) so no half of the cut could
 * be flipped alone. app.openwop.dev retired v1 on 2026-10-03, the code default
 * followed on 2026-10-04 (P1), and P3c removed the opt-back-in with v1 itself.
 * The three facts are now constants, and the `/v1` path space answers only the
 * negotiator's 410 / ADR 0806 308 front.
 */
export function protocolVersions(): readonly string[] {
  return [PROTOCOL_VERSION_V2];
}
/** `versioning.md` §1.1 — the header-less default, the only major served. */
export function preferredVersion(): string {
  return PROTOCOL_VERSION_V2;
}
/**
 * `versioning.md` §1.5 — the client floor. A 1.x client is not "below the
 * floor", it is asking for a contract that no longer exists, and §1.5's `426`
 * is the honest refusal for both.
 */
export function minClientVersion(): string {
  return PROTOCOL_VERSION_V2;
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
  '/pod', '/pricing', '/readiness', '/robots.txt', '/schemas', '/scim', '/sitemap.xml',
  // ADR 0812 P3b final batch 1 — the test seams now register unversioned.
  '/packs-test', '/test',
];

function readV2PathManifestOperations(): unknown {
  const manifestPath = join(
    locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json'),
    'v2', 'path-manifest.json',
  );
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  return Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown>)['operations'] ?? (raw as Record<string, unknown>)['paths']);
}

function v2MountedPrefixes(): readonly string[] {
  const ops = readV2PathManifestOperations();
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

/**
 * ADR 0840 (RFC 0238 §B) — the operations whose response IS a document. A
 * browser asks for one with `Accept: text/html` and no `OpenWOP-Version` (an
 * iframe `src` load), which ADR 0646 would otherwise read as a navigation to
 * the SPA and answer with the shell. The SPA has no page at these paths, so
 * they are never shared names.
 *
 * Named by `operationId` and resolved through the vendored path manifest, never
 * as path literals. `test/adr0840-document-operations.test.ts` checks the ids
 * against the conformance package's OpenAPI: exactly the operations whose `200`
 * is `text/html`. An id the vendored manifest does not carry yet resolves to
 * nothing, so an older corpus pin changes no routing.
 */
export const DOCUMENT_OPERATION_IDS: readonly string[] = ['getUiPluginFrame'];

function documentOperationPatterns(): readonly RegExp[] {
  const ops = readV2PathManifestOperations();
  if (!Array.isArray(ops)) return [];
  return ops
    .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
    .filter((o) => DOCUMENT_OPERATION_IDS.includes(String(o['operationId'] ?? '')))
    .map((o) => String(o['path'] ?? ''))
    .filter((p) => p.startsWith('/'))
    .map((p) => new RegExp(`^${p.split(/\{[^}]+\}/).map((s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&')).join('[^/]+')}$`));
}

const DOCUMENT_OPERATION_PATTERNS: readonly RegExp[] = documentOperationPatterns();

/** ADR 0840 — is `path` one of the {@link DOCUMENT_OPERATION_IDS}? */
export function isDocumentOperationPath(path: string): boolean {
  return DOCUMENT_OPERATION_PATTERNS.some((r) => r.test(path));
}

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
  // `api/v2/openapi.yaml` /prompts:render `400` — "a required variable is
  // missing" is `validation_error`, and `errors.md`: "A vendor code MUST NOT
  // stand for a state a registered code names." This answered
  // `openwop-app.prompt_variable_unresolved` until the corpus steward's suite
  // 2.45.15 witness wave (`prompts.render-unbound-required-refused`).
  prompt_variable_unresolved: 'validation_error',
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
 * openwop#1698 (errors.md §The registry) — the SAME obligation on the codes a
 * RUN carries: `error.code` on `run.failed`, `node.failed` and the snapshot's
 * `error` MUST be registered or a vendor code. Checked by
 * `openwop.requirement.errors.event-code-registered`.
 *
 * Layered on `v2ErrorCode`, never beside it: a code the HTTP lane already
 * spells correctly is spelled the same way here. The extra rows are codes that
 * reach a run's failure but not an HTTP response, each onto the registered row
 * that means the same failure. They are EVENT-LANE ONLY on purpose — an alias
 * in `V2_CODE_ALIASES` must also agree on HTTP status, and a run failure has
 * none, so adding them there would re-status existing HTTP refusals.
 */
const V2_EVENT_CODE_ALIASES: Readonly<Record<string, string>> = {
  // A node needs a host capability this deployment does not provide (the
  // AUTHORING-CANVAS-PACKS `host_capability_missing` discipline). The executor
  // already names the registered code for the reserved-typeId refusal.
  host_capability_missing: 'capability_not_provided',
  host_capability_disabled: 'capability_not_provided',
  // Node config / arguments failed validation.
  //
  // RFC 0226 (suite 2.44.0) registers `node_config_invalid`,
  // `sandbox_invocation_error` and `mcp_error` `since` 2.44. A node's config
  // failing validation now has its own registered row, so `invalid_config`
  // maps there instead of onto the generic `validation_error`. The other two
  // need no row here: they fall to `v2ErrorCode`, which passes them through
  // unprefixed now that the vendored registry lists them (they were
  // `openwop-app.*` vendor codes before this pin).
  invalid_config: 'node_config_invalid',
  invalid_request: 'validation_error',
  invalid_args: 'validation_error',
  // A dispatched agent / workflow the run names does not exist.
  agent_not_found: 'not_found',
  // A structured envelope failed its schema / contract.
  envelope_validation_failed: 'envelope_invalid',
  envelope_contract_violation: 'envelope_invalid',
  // RFC 0228 §Decisions — the per-service names v1 gave `ctx` storage
  // rejections have no v2 row; each is the generic code plus `details`
  // (`V2_HOST_SERVICE_DETAILS` below). The v1 names stay on the major-1 wire:
  // its suite still asserts them (`table-schema-enforcement` by equality), and
  // v1 is served until its end-of-support date.
  path_outside_sandbox: 'forbidden',
  table_schema_violation: 'validation_error',
};

/**
 * RFC 0228 §A / `errors.md` §Host-service refusals — a generic code on a `ctx`
 * service rejection MUST carry `details.service`, the family key, and MAY add
 * `details.reason`. Keyed by the HOST code so a stored failure (written before
 * this existed, or at major 1) reads back correctly under major 2 as well.
 */
const V2_HOST_SERVICE_DETAILS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  path_outside_sandbox: { service: 'fs', reason: 'path-outside-sandbox' },
  table_schema_violation: { service: 'tableStorage' },
};

export function v2EventErrorCode(code: string): string {
  const out = V2_EVENT_CODE_ALIASES[code] ?? v2ErrorCode(code);
  if (V2_REGISTERED_CODES.has(out) || VENDOR_CODE.test(out)) return out;
  // A code outside the vendor grammar's name segment (`[a-z][a-z0-9_]*`) — a
  // provider string such as `Anthropic-429` — would be namespaced into a code
  // that is STILL not a vendor code. Folded to the grammar instead; the
  // original rides `details.hostCode` (see below), so nothing is lost.
  const folded = code.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '');
  return `${VENDOR_ORG}.${folded.length > 0 ? folded : 'error'}`;
}

/**
 * Re-spell `error.code` on one error object for the major-2 wire. When the code
 * is ALIASED (not merely namespaced) the host's own code rides in
 * `details.hostCode` — `details` is open on `_errorObject` — so the aliasing is
 * lossless and a reader that knows this host can still branch on it. Returns
 * the same reference when nothing changes; a stored run is never rewritten
 * (this runs at egress only), so historical rows read back under the same rule.
 */
export function projectV2ErrorObject(error: unknown): unknown {
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return error;
  const e = error as { code?: unknown; details?: unknown };
  if (typeof e.code !== 'string' || e.code.length === 0) return error;
  const code = v2EventErrorCode(e.code);
  if (code === e.code) return error;
  const aliased = code !== `${VENDOR_ORG}.${e.code}`;
  const details = e.details !== null && typeof e.details === 'object' && !Array.isArray(e.details) ? e.details as Record<string, unknown> : undefined;
  return {
    ...(error as Record<string, unknown>),
    code,
    ...(aliased ? { details: { ...(V2_HOST_SERVICE_DETAILS[e.code] ?? {}), ...(details ?? {}), hostCode: e.code } } : {}),
  };
}


/** A coarse caller class for the retired-address forward log — never a principal or token. */
function callerClass(req: Request): string {
  const ua = (req.header('user-agent') ?? '').toLowerCase();
  return ua.includes('openwop-conformance') ? 'conformance-suite'
    : ua.includes('openwop') ? 'openwop-sdk'
    : req.accepts(['application/json', 'text/html']) === 'text/html' ? 'browser'
    : 'other';
}

/** Where the negotiated contract is parked for the rest of the request. */
const MAJOR = Symbol.for('openwop.protocol.major');

interface Negotiated extends Request {
  [MAJOR]?: 1 | 2;
}

/**
 * ADR 0812 P3c — is this a PROTOCOL request (true), or the vendor host dialect
 * (false)? The negotiator decides once: a vendor path (`/host/openwop-app/…`,
 * RFC 0181) is the host dialect, every other path it lets through is served
 * under major 2, the only contract this host serves. A request the negotiator
 * never stamped is not a protocol request.
 */
export function isProtocolRequest(req: Request): boolean {
  return (req as Negotiated)[MAJOR] === 2;
}

/**
 * The major the negotiator stamped. ADR 0812 P3c: the ONLY remaining caller is
 * the v1 discovery representation in `routes/discovery.ts`, which P3c deletes;
 * everything else asks {@link isProtocolRequest}. Do not add a caller.
 */
export function negotiatedMajor(req: Request): 1 | 2 {
  return (req as Negotiated)[MAJOR] ?? 1;
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

/** The withdrawn major-1 path prefix (ADR 0649). Only the negotiator's 410/308 front reads it (ADR 0812). */
export const V1_PATH_PREFIX = '/v1';
/**
 * ADR 0812 P3b — the canonical (unversioned) vendor path, `vendorPath('/x')` →
 * `/host/openwop-app/x`. A migrated family registers and matches on this; its old
 * `/v1` twin is no longer registered.
 */
export function vendorPath(path: string): string {
  return `${VENDOR_ROOT}${path}`;
}

/**
 * The newest `major.minor` this host serves, derived from `protocolVersions()`
 * and never restated.
 */
export function newestServedVersion(): string {
  return [...protocolVersions()].sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]) || Number(b.split('.')[1]) - Number(a.split('.')[1]))[0]!;
}

/**
 * Headers for the host's calls TO ITSELF (sub-run dispatch, the messaging
 * bridge). They name the newest major explicitly, on unversioned paths.
 *
 * A self-call pinned to an old major, or addressed through a versioned prefix,
 * breaks on the day that major retires. `/v1/runs` self-calls would have failed
 * every sub-workflow on the ADR 0669 cut. Deriving the version here makes the
 * next major a no-op for every self-caller.
 */
export function selfCallHeaders(): Record<string, string> {
  return { 'OpenWOP-Version': newestServedVersion(), accept: 'application/json' };
}

/**
 * The address to HAND A CLIENT for a path this host serves: a link, an
 * OpenAPI key, a `serverUrls` entry. `path` is unversioned, e.g. `/runs/{runId}`
 * or `${VENDOR_ROOT}/mcp`. Returns `null` when no address exists.
 *
 * - A host extension is always its unversioned vendor path.
 * - A protocol operation is its unversioned path if major 2 serves it, and
 *   `null` if the operation has no v2 address. Major 1 is retired (ADR 0812),
 *   so no response hands out a `/v1` address, which would only answer 410.
 *
 * Ratchet: `test/adr0669-self-calls-survive-cut.test.ts`.
 */
export function advertisedPath(path: string): string | null {
  if (isVendorPath(path)) return path;
  return isV2MountedPath(path) ? path : null;
}

/**
 * The `statusUrl` / `eventsUrl` pair a run-creating response hands out. It is
 * the one place every run-starting route (the protocol `POST /runs` and each
 * host-extension launcher) takes them from, so a future major changes one
 * function, not every launcher. Addresses follow `advertisedPath`, so they
 * survive the cut.
 */
export function runLinks(origin: string, runId: string, tenantId: string): { statusUrl: string; eventsUrl: string } {
  // An unversioned (major-2) address names the run by its TENANT-BOUND id
  // (`identity.md` §5). The host-extension launchers that call this run in the
  // host dialect, so the major-2 response projector never rewrites their body:
  // a bare id here was a dead link on a retired host (`GET /runs/<bare>` → 400).
  // Every address is unversioned since ADR 0812 P3c, so the id is always bound.
  const run = `/runs/${encodeURIComponent(toWireRunId(runId, tenantId))}`;
  // `/runs/{runId}` and `/events` have a v2 address, so advertisedPath never
  // returns null here. The `??` keeps the type honest without a cast.
  return {
    statusUrl: `${origin}${advertisedPath(run) ?? run}`,
    eventsUrl: `${origin}${advertisedPath(`${run}/events`) ?? `${run}/events`}`,
  };
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
// ADR 0812 P2b — the tenant group admits the `anon:` prefix that `ids.schema.json#/$defs/runId`
// admits (`^(anon:)?…`). Without it an anonymous visitor's bound id, decoded by the public
// origin, missed this re-encode and 404'd as a route miss while every other tenant's resolved.
const DECODED_BOUND_ID = /^\/(runs|webhooks|trigger-subscriptions)\/((?:anon:)?[A-Za-z0-9._~-]{1,128})\/([A-Za-z0-9._~-]{16,128})(?=$|[/:?])/;
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
  // ADR 0840 — a document operation is the protocol's whatever the Accept says.
  if (isDocumentOperationPath(req.path)) return true;
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
 * `/v<N>/host/openwop-app/assets/<token>` → the unversioned serve path, else null.
 * The token shape is the capability token's (no `/`, no `.`), so nothing but an
 * asset address can ride the exception. Spelled here rather than imported:
 * `host/assetServePath.ts` imports this module. `asset-serve-path.test.ts` pins
 * that the two agree.
 */
const RETIRED_ASSET_RE = new RegExp(`^/v[0-9]+(${VENDOR_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/assets/[A-Za-z0-9_-]{1,512})$`);
export function retiredAssetServePath(path: string): string | null {
  return RETIRED_ASSET_RE.exec(path)?.[1] ?? null;
}

/**
 * ADR 0806 — `/v<N>/host/openwop-app/<rest>` → `/host/openwop-app/<rest>`, else
 * null. The target is the unversioned vendor address and nothing else: the
 * match is anchored on the vendor root, so `/v1//evil.example` (which would
 * strip to a protocol-relative URL) cannot become an open redirect.
 */
const VENDOR_TWIN_RE = new RegExp(`^/v[0-9]+(${VENDOR_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/].*)$`);
export function retiredVendorTwinPath(path: string): string | null {
  const target = VENDOR_TWIN_RE.exec(path)?.[1] ?? null;
  // A `.`/`..` segment (raw or `%2e`-encoded) would let the BROWSER resolve the
  // Location onto a different vendor path than the one that was judged held —
  // `/v1/host/openwop-app/public/../orgs` → `/host/openwop-app/orgs`. Refused
  // rather than normalised: a held address never contains one.
  if (target === null || /(^|\/)(\.|%2e){1,2}(\/|$)/i.test(target)) return null;
  return target;
}

export interface ProtocolVersionOptions {
  /**
   * ADR 0806 — whether a vendor-twin address (`/v1/host/openwop-app/…`, as the
   * client spelled it) is one that parties outside this host hold: links in
   * search indexes, feeds, sent mail, embed snippets on customers' sites. After
   * the cut a READ of one forwards `308` to the unversioned address instead of
   * answering `410`. Injected because the set is the auth layer's unauthenticated
   * path list (`isPublicPath`), and `middleware/auth.ts` imports this module.
   */
  heldByThirdParties?: (versionedPath: string) => boolean;
}

/**
 * The negotiator. Mount ONCE, before auth: the unversioned mount rewrites
 * `req.url` onto the `/v1` key, and every downstream gate (the public-path
 * allowlist, the CSRF origin guard, the route table) must see the rewritten
 * path so a v2 request is authorized exactly like its v1 twin.
 */
export function protocolVersionMiddleware(opts: ProtocolVersionOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = (req.url.split('?')[0] ?? req.url) || '/';
    const versioned = isV1Path(path);

    // ADR 0669 / ADR 0812 — the `/v1` PATH SPACE is withdrawn. Checked against
    // the INBOUND path, before anything else. Nothing is registered under `/v1`
    // and nothing strips it, so this front is the whole of what `/v1` answers.
    //
    // `410 Gone` rather than `404`: the resource existed, its removal is
    // permanent and dated, and a client that has cached a `/v1` URL should stop
    // rather than retry. The body names the surviving address so the refusal is
    // actionable instead of merely correct.
    if (versioned) {
      // THE ONE EXCEPTION (ADR 0669 § "Stored asset addresses"): a media asset's
      // serve address was handed out and SAVED — in drawings, documents, run
      // event logs, sent emails, exported files. Those copies cannot all be
      // rewritten (some sit under integrity hashes, some are not ours to edit),
      // so the old address keeps resolving: a permanent redirect to the
      // unversioned one. Reads only; it is a host-extension address, not a
      // major-1 protocol operation, so nothing about v1 is being served.
      //
      // GENERALISED by ADR 0806 to every vendor address a third party holds
      // (`opts.heldByThirdParties`): public pages, feeds, shared cards, form and
      // booking pages, email links in mail already sent, a widget's `embed.js`
      // on a customer's site. Still reads only — a write to a held address is a
      // provider calling a webhook, which does not reliably follow a redirect,
      // so those are re-pointed by the operator before the cut and still 410.
      const isRead = req.method === 'GET' || req.method === 'HEAD';
      const forwardTo = !isRead ? null
        : retiredAssetServePath(path)
          ?? (opts.heldByThirdParties?.(path) ? retiredVendorTwinPath(path) : null);
      if (forwardTo) {
        // Measured, so the forward can itself be retired on evidence (ADR 0806):
        // the vendor family and a coarse caller class, nothing identifying.
        log.info('retired_twin_forward', { family: forwardTo.split('/').slice(1, 4).join('/'), caller: callerClass(req) });
        // Behind a proxy that forwards only `/api/**` (an operator deployment,
        // not this demo's Hosting, which also rewrites `/host/**`), the caller
        // reached us on `/api/v1/…` and the `/api` strip above already ran. Put
        // it back, or the Location leaves the backend for the SPA host.
        const prefix = apiPathPrefixOf(req);
        // A browser runs the CORS check on the REDIRECT itself, so a
        // cross-origin `fetch` from a customer's page would fail as a network
        // error without this. Non-credentialed `*`: the response carries no
        // body and a Location the caller could derive from its own URL. (A
        // PREFLIGHTED call still fails — OPTIONS is not a read — see ADR 0806.)
        if (req.header('origin')) res.setHeader('Access-Control-Allow-Origin', '*');
        // Revalidate every time, so `retired_twin_forward` counts real use and
        // the forward can be retired on evidence (a permanent redirect is
        // otherwise cached heuristically and the count undercounts).
        res.setHeader('Cache-Control', 'no-cache');
        // NO BODY (the steward's scoping for the §5 errata, 2026-10-03):
        // `res.redirect` writes a text/HTML body, which would be content served
        // at a retired address. A bare status + Location is the whole answer.
        res.status(308).setHeader('Location', prefix + forwardTo + req.url.slice(path.length));
        res.setHeader('Content-Length', '0');
        res.end();
        return;
      }
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

    // Major 2 is the only contract served (ADR 0812). A vendor path is handled
    // below before it is stamped, and `OpenWOP-Version: 1` is refused 406.
    // ADR 0646 — a SHARED NAME is an unversioned manifest path this host also
    // serves something else on (`/agents`, `/prompts`, `/runs` are SPA pages).
    // Which consumer a request is for is decided HERE, by content negotiation,
    // never by the v1 default: until this line existed the only thing keeping
    // the SPA page and the protocol operation apart was that a header-less
    // request defaulted to major 1 — and retirement flips that default
    // (`versioning.md` §5), turning three pages into JSON on cutover day.
    // RFC 0181 (ADR 0652): a vendor path is not a protocol operation. The
    // header selects nothing, nothing is stamped, no negotiation, host dialect.
    if (isVendorPath(path)) {
      (req as Negotiated)[MAJOR] = 1;
      // ADR 0812 P3b: vendor routes are registered unversioned; no rewrite.
      runUnderContract(1, next);
      return;
    }
    const sharedName = isV2MountedPath(path);
    const protocolClient = !sharedName || isProtocolClient(req);
    // §1.4 (errata 2026-09-10): every PROTOCOL response carries the version;
    // a non-protocol response on a shared name MUST NOT, so a reader, a cache
    // or the suite can never mistake the shell for the operation.
    if (protocolClient) {
      res.setHeader(VERSION_RESPONSE_HEADER, PROTOCOL_VERSION_V2);
    }
    // ADR 0631 — an unversioned path answers DIFFERENT bodies to the same URL
    // depending on the request header (the API under a named major; the SPA
    // shell to a headerless browser), so every such response must say so.
    // MEASURED 2026-09-05: the Firebase CDN in front of the origin strips Vary
    // on some routes, which is why the shell branch is also `no-store`; this
    // header is still the correct statement for every other cache.
    res.vary('OpenWOP-Version');
    if (sharedName) res.vary('Accept');
    (req as Negotiated)[MAJOR] = 2;
    installV2ResponseHygiene(req, res);

    if (malformed) {
      refuse(res, 400, 'validation_error', 'OpenWOP-Version MUST be <major> or <major>.<minor>.', {
        header: 'OpenWOP-Version',
      });
      return;
    }
    // The majors served are DERIVED from `protocolVersions()`, never the
    // literal `1 or 2`: the 2026-10-03 cut rehearsal found a retired host
    // silently serving major 2 to `OpenWOP-Version: 1` on an unversioned path,
    // where `versioning.md` §1.3 requires the 406 (honoured or refused, never
    // ignored).
    const servedMajors = new Set(protocolVersions().map((v) => Number(v.split('.')[0])));
    if (requested !== null && !servedMajors.has(requested)) {
      refuse(res, 406, 'protocol_version_unsupported', `This host does not serve protocol major ${requested}.`, {
        protocolVersions: [...protocolVersions()],
      });
      return;
    }

    // §1.5 — the client floor, a 2.x obligation (`minClientVersion` is advertised
    // in the v2 root).
    const announced = req.header(CLIENT_VERSION_HEADER);
    if (announced !== undefined && announced.trim() !== '') {
      // RFC 0219: the grammar is `<major>.<minor>[.<patch>]` (non-negative
      // integers, no leading zeros), compared on major.minor only, and a
      // MALFORMED value is treated as if the header were ABSENT — never 426,
      // never 400. This used to be unanchored (`1.0abc` parsed as 1.0) and sent
      // a non-match to '0.0', i.e. refused a malformed announcement with 426.
      const m = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*))?$/.exec(announced.trim());
      if (m && versionLessThan(`${m[1]}.${m[2]}`, minClientVersion())) {
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
      req.url = req.url.replace(DECODED_BOUND_ID, (_m, kind: string, tenant: string, opaque: string) => `/${kind}/${tenant}%2F${opaque}`);
      // ADR 0812 P3b: protocol routes are registered unversioned; no rewrite.
    }
    // v2 charter Phase 4 (P4-C) — park the negotiated contract for the storage
    // seat (`storage/eventEraAdapter.ts`). `persistence.md` §"The reader rule"
    // binds EVERY reader (poll, SSE, fork, replay, debug bundle); running the
    // rest of the request inside the contract's async context is what makes that
    // true without a per-call-site opt-in a v2 route could forget.
    runUnderContract(2, next);
  };
}
