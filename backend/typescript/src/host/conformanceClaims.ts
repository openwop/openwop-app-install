/**
 * ADR 0550 P4 — the RUNTIME half of the public exact-profile claims.
 *
 * This file does exactly one thing: read what the CERTIFY step stamped into
 * `build-meta/`. It computes nothing.
 *
 * That division is the whole design, and it is the same one ADR 0550 P3 arrived
 * at when it refused a runtime signer:
 *
 *   > A host may only publish a claim it can witness.
 *
 * The backend cannot witness a conformance result. It has no way to know whether
 * a profile's floor executed against itself — only the run that executed the
 * suite knows that, and it knows it because it read the RFC 0148 §A ledger. So
 * the run decides (`conformance/certify.ts`), the image carries the answer, and
 * this module serves it verbatim. A route that derived a profile list from
 * capability flags at request time would be restating its own configuration and
 * calling it evidence — the tautology class this ADR has now found four times
 * (a CI job named for a check it never ran; a provenance check comparing a value
 * to itself; an advert leg gating on the flag it then asserted; a floor that
 * verified against an undefined set).
 *
 * ABSENT IS THE HONEST DEFAULT. A source checkout, a dev boot, and any image
 * built without the certify step carry no stamp, and every reader here returns
 * `undefined`. Discovery then OMITS `conformance.certificationBundleUrl` and the
 * routes 404. Omission is legitimate (RFC 0089 §D: "Omitting it is fully
 * conformant; clients MUST tolerate its absence") — and it is strictly better
 * than a placeholder, because a placeholder claim is a false claim. Same
 * discipline as `host/contractProvenance.ts`.
 *
 * WHD-18 (ADR 0735 decision 2) — a SECOND source, chosen by
 * `OPENWOP_CERT_BUNDLE_ORIGIN`. Unset, everything above holds verbatim. Set,
 * the image stamp is no longer served and the evidence is the suite CLI's
 * signed, post-deploy v3 cut, read from outside the image and VERIFIED against
 * this host's commit, major and published keys before it is served or
 * advertised (`host/certificationEvidence.ts`). The "computes nothing" rule
 * survives: verification decides whether to SERVE, never what is claimed.
 *
 * > **CORRECTED 2026-10-16 (ADR 0812 P4 slice 3) — the IMAGE half is deleted.**
 * > Nothing has written the `build-meta/` stamp since ADR 0869 (deploy.sh builds
 * > no image bundle), and the in-process emitter that wrote it
 * > (`conformance/certify.ts`, `run.ts --certify`) is gone with this slice. The
 * > image reader, the major-1 bundle route and the `/claims` document served
 * > only that stamp, so they went too. What remains is the origin reader: unset
 * > `OPENWOP_CERT_BUNDLE_ORIGIN` now means "no evidence served" (the pointer is
 * > absent, RFC 0089 §D), and set means the verified v3 cut, as before. The
 * > paragraphs above describe the design as it was; "ABSENT IS THE HONEST
 * > DEFAULT" still holds, now for every image build.
 */

import { VENDOR_ROOT } from '../middleware/protocolVersion.js';
import { createLogger } from '../observability/logger.js';
import { buildCommit } from './buildInfo.js';
import {
  CertificationEvidenceReader,
  parseBundleOrigin,
  type FetchLike,
  type OriginConfig,
  type ServedMajor,
} from './certificationEvidence.js';

const log = createLogger('host.conformanceClaims');


/**
 * WHD-18 — the MAJOR-2 bundle's address, served only in origin mode.
 *
 * A sibling of the major-1 path rather than a query parameter, so each URL names
 * exactly one document and a cache keyed on the URL can never hand one major's
 * evidence to a reader of the other. Registered on the `/v1` twin like every
 * host route, but ADVERTISED at the major-2 root in its version-agnostic
 * RFC 0181 form (`/host/openwop-app/…`, ADR 0652): the `/v1` twin retires
 * atomically with `/v1`, and a major-2 pointer that dies at the v1 sunset would
 * be a pointer built to break. `protocolVersion.ts` rewrites the vendor path onto
 * the twin BEFORE auth, so both spellings reach the one public handler.
 */
const MAJOR2_SUFFIX = '/conformance/certification-bundle/major-2';
export const CERTIFICATION_BUNDLE_MAJOR2_VENDOR_PATH = `${VENDOR_ROOT}${MAJOR2_SUFFIX}`;

// ── WHD-18 — where the SERVED evidence comes from ────────────────────────────
//
// `OPENWOP_CERT_BUNDLE_ORIGIN` UNSET ⇒ no evidence is served (ADR 0812 P4
// slice 3; until then it meant the image's `build-meta/` stamp, major 1 only).
// That is every white-label adopter, every source boot, and every test that
// does not opt in.
//
// SET ⇒ the image's bundle is NOT served, at all, for either major. ADR 0735:
// the in-image bundle is "cut before the thing it describes exists", so the
// moment an operator has somewhere honest to publish, the dishonest artifact
// must stop being the answer — serving it as a fallback while the bucket is
// empty would be the defect with a longer fuse. The only served evidence is a
// VERIFIED object from `host/certificationEvidence.ts`, and until one exists
// for this build the pointer is simply absent.

let originWarned: string | undefined;

function originConfig(): OriginConfig {
  // Read per call, not memoised: tests vary it per case, and it is one env read.
  const cfg = parseBundleOrigin(process.env.OPENWOP_CERT_BUNDLE_ORIGIN);
  if (cfg.mode === 'misconfigured' && originWarned !== cfg.why) {
    originWarned = cfg.why;
    log.warn('certification_bundle_origin_misconfigured — withholding ALL certification evidence', { why: cfg.why });
  }
  return cfg;
}

/** True when the operator has moved the served evidence out of the image (set, even if unusable). */
export function evidenceFromOrigin(): boolean {
  return originConfig().mode !== 'image';
}

let reader = new CertificationEvidenceReader();

/**
 * Test seam: a fresh reader (empty cache, no in-flight work) over an injected
 * `fetch`. Production never calls this; the default reader uses global `fetch`.
 */
export function __resetCertificationEvidenceForTests(opts: { fetchImpl?: FetchLike; now?: () => number; deadlineMs?: number } = {}): CertificationEvidenceReader {
  reader = new CertificationEvidenceReader(opts);
  return reader;
}

/**
 * The host's own commit, only when it is a FULL sha. The object key and
 * `host.build.id` are both full 40-hex; a short or `unknown` stamp cannot name
 * an object honestly, so it names none.
 */
function fullCommit(): string | undefined {
  const c = buildCommit();
  return /^[0-9a-f]{40}$/.test(c) ? c : undefined;
}

/**
 * Make this major's origin evidence current, AWAITING at most the reader's
 * deadline (2 s). Call it at the top of any handler that will read the pointer
 * or the bundle. A no-op in image mode.
 *
 * `signingKeys` is passed IN — the caller already has `readBundleSigningKeys()`
 * (the one parser of `OPENWOP_BUNDLE_SIGNING_KEYS`, in `routes/discovery.ts`),
 * and importing that module from here would close an import cycle
 * (discovery → this file → discovery).
 */
export async function ensureCertificationEvidence(
  major: ServedMajor,
  signingKeys: readonly Record<string, unknown>[],
): Promise<void> {
  const cfg = originConfig();
  if (cfg.mode !== 'origin') return;
  const commit = fullCommit();
  if (commit === undefined) {
    // Not an error to retry: this build does not know which commit it is, so
    // there is no key it could honestly read. The pointer stays absent.
    return;
  }
  await reader.ensure({ origin: cfg.origin, commit, major, signingKeys });
}

/**
 * The VERIFIED origin bytes for a major, or undefined. Synchronous — it reads
 * what the last `ensureCertificationEvidence` recorded. Undefined in image mode.
 */
export function originCertificationBundle(major: ServedMajor): string | undefined {
  const cfg = originConfig();
  if (cfg.mode !== 'origin') return undefined;
  const commit = fullCommit();
  if (commit === undefined) return undefined;
  return reader.snapshot({ origin: cfg.origin, commit, major });
}

// ADR 0812 P4 slice 3: the image-stamp readers (`conformanceClaims()`, the
// `build-meta/` bundle reader) are deleted with the emitter that wrote the stamp.

/**
 * WHD-18 — the value for the MAJOR-2 root's `conformance.certificationBundleUrl`
 * (the slot `schemas/v2/capabilities.schema.json` already declares; RFC 0147 §A
 * freezes NEW discovery fields, and this adds none), or `undefined` to omit it.
 *
 * ORIGIN MODE ONLY, by construction: the image carries no major-2 bundle, and
 * the v2 slot addresses a `bundleVersion: "3"` document, which only the verified
 * origin can supply. The WHD-6 omission this replaces was right for the image
 * and is still what an unset origin produces.
 */
export function certificationBundleUrlV2(origin: string): string | undefined {
  if (servedBundle(2) === undefined) return undefined;
  return `${origin.replace(/\/+$/, '')}${CERTIFICATION_BUNDLE_MAJOR2_VENDOR_PATH}`;
}

/** What the bundle route serves: the origin's exact verified bytes. */
export type ServedBundle = { readonly source: 'origin'; readonly bytes: string };

/**
 * THE one predicate (WHD-6): the route serves this, and the pointer is
 * advertised iff it is defined. Origin mode only since ADR 0812 P4 slice 3 —
 * an image build serves no evidence, so with no origin configured this is
 * always `undefined`.
 */
export function servedBundle(major: ServedMajor): ServedBundle | undefined {
  const bytes = originCertificationBundle(major);
  return bytes === undefined ? undefined : { source: 'origin', bytes };
}
