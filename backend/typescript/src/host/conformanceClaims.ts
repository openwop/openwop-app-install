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
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VENDOR_ROOT } from '../middleware/protocolVersion.js';
import { createLogger } from '../observability/logger.js';
import { locateRepoDir } from './_repoPath.js';
import { buildCommit } from './buildInfo.js';
import {
  CertificationEvidenceReader,
  parseBundleOrigin,
  type FetchLike,
  type OriginConfig,
  type ServedMajor,
} from './certificationEvidence.js';

const log = createLogger('host.conformanceClaims');

/** Stamp file names — the same constants `conformance/certify.ts` writes. */
export const CLAIMS_STAMP = 'conformance-claims.json';
export const BUNDLE_STAMP = 'certification-bundle.json';

/** Public host-extension paths. Non-normative placement; the POINTER is the wire surface. */
export const CERTIFICATION_BUNDLE_PATH = '/v1/host/openwop-app/conformance/certification-bundle';
export const CONFORMANCE_CLAIMS_PATH = '/v1/host/openwop-app/conformance/claims';

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
export const CERTIFICATION_BUNDLE_MAJOR2_PATH = `/v1${VENDOR_ROOT}${MAJOR2_SUFFIX}`;
export const CERTIFICATION_BUNDLE_MAJOR2_VENDOR_PATH = `${VENDOR_ROOT}${MAJOR2_SUFFIX}`;

// ── WHD-18 — where the SERVED evidence comes from ────────────────────────────
//
// `OPENWOP_CERT_BUNDLE_ORIGIN` UNSET ⇒ exactly the behaviour below this block,
// unchanged: the image's `build-meta/` stamp, major 1 only. That is every
// white-label adopter, every source boot, and every test that does not opt in.
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

/**
 * The claims document, typed only as far as this side needs it.
 *
 * Deliberately NOT a full mirror of `conformance/certify.ts`'s
 * `ConformanceClaims`. That type lives on the emitter side where the suite's
 * types are available (devDependency), and duplicating it here would create a
 * second definition of the artifact that could drift from the one that writes
 * it. The reader validates the two fields it actually reasons about and passes
 * the rest through untouched — the document a consumer receives is the document
 * the run produced, byte for byte.
 */
export interface StampedClaims {
  readonly claimsVersion: string;
  readonly claimedProfiles: readonly string[];
  readonly [k: string]: unknown;
}

function readStamp(dir: string, file: string): unknown | undefined {
  const path = join(dir, file);
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    // A stamp that will not parse is not evidence. Warn and omit rather than
    // serve a partial document: a malformed claim read as a claim is the exact
    // "success-with-empty" failure the exchange rules forbid.
    log.warn('conformance stamp unreadable — omitting', { file, error: String(err) });
    return undefined;
  }
}

/**
 * Where the image's `build-meta/` lives, or null.
 *
 * NOT MEMOISED, for the same reason `buildInfo.ts` gives: `OPENWOP_BUILD_META_DIR`
 * is a test seam that tests vary per case, and freezing it at first call breaks
 * them silently. The walk terminates on the second `existsSync` inside the image.
 */
function buildMetaDir(): string | null {
  const override = process.env.OPENWOP_BUILD_META_DIR?.trim();
  if (override) return override;
  try {
    // Same sentinel as `buildInfo.ts` — `build-meta/.gitkeep` is tracked, so the
    // directory is findable in a source tree and in the image alike.
    return locateRepoDir(dirname(fileURLToPath(import.meta.url)), 'build-meta', '.gitkeep');
  } catch {
    // `locateRepoDir` throws at the filesystem root. Absence is a normal state
    // here (unlike its schema/pack callers, where it is fatal), so it is caught.
    return null;
  }
}

/**
 * The stamped claims document, or `undefined` when this build carries none —
 * **or carries one whose evidence it cannot serve** (WHD-6).
 *
 * The claims document is a SECOND pointer at the bundle, and until WHD-6 it was
 * the ungated one. `conformance/certify.ts` stamps `evidence.bundlePath` (the
 * very route `certificationBundleUrl` advertises) and `evidence.bundleSha256`
 * into it, so a reader of `/claims` is told "the proof is at that URL, and it
 * hashes to this". Discovery's pointer was gated on the bundle being servable;
 * this reader looked only at its own file. So an image holding a valid
 * `conformance-claims.json` beside a missing or unservable bundle answered
 * `/claims` 200 — naming a URL that 404s — while discovery correctly said
 * nothing. One door honest, the sibling door into the same claim not: the same
 * advertised-but-not-served defect, reachable by a different route.
 *
 * That posture is not hypothetical. It is exactly what ADR 0735's own remedy
 * produces if done by hand: drop the suite CLI's bundle (`bundleVersion: '3'`)
 * over `build-meta/certification-bundle.json` and redeploy, and the reader below
 * refuses it (it serves v2 only) while the in-process run's claims file is still
 * sitting next to it.
 *
 * So the rule is ONE predicate for every surface that names the bundle URL —
 * `servedBundle(1) !== undefined` (WHD-18 rename of `certificationBundle()`),
 * the same call the route itself makes —
 * and a claim with no servable evidence is withheld rather than published
 * unsubstantiated. ADR 0550 P4: a host may only publish a claim it can witness.
 */
export function conformanceClaims(): StampedClaims | undefined {
  // WHD-18 — WITHHELD in origin mode, and this is a decision rather than an
  // unfinished branch (ADR 0735 § Implementation record 2026-09-21 says why at
  // length). The only claims derivation this host has — ADR 0550 P4, "a
  // profile is claimed when every floor requirement is executed-pass with ≥1
  // assertion" — lives in `conformance/certify.ts` and runs on the suite's
  // `deriveRequirementDispositions` + floor tables, a devDependency the release
  // image does not contain (`npm ci --omit=dev`). Re-deriving it here would be a
  // SECOND derivation of a public claim, which ADR 0735 forbids by name. And the
  // image's stamped claims document binds `evidence.bundleSha256` to the
  // in-image v2 bundle this mode refuses to serve — publishing it would point a
  // third party at evidence we have just withdrawn. The v3 bundle carries its
  // own per-profile `certified` verdicts, which the suite's `--verify`
  // re-derives; that document IS the claim in this mode.
  if (evidenceFromOrigin()) return undefined;
  const dir = buildMetaDir();
  if (dir === null) return undefined;
  // The WHD-6 predicate, spelled as the route spells it. In image mode (the only
  // mode that reaches this line) `servedBundle(1)` IS the image stamp.
  if (servedBundle(1) === undefined) return undefined;
  const parsed = readStamp(dir, CLAIMS_STAMP);
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const doc = parsed as Record<string, unknown>;
  // The two structural facts a reader must be able to rely on. A document
  // missing either is not a claims document; serving it would let a malformed
  // stamp masquerade as "this host claims nothing", which is a different
  // statement from "this host published no claims".
  if (typeof doc['claimsVersion'] !== 'string' || !Array.isArray(doc['claimedProfiles'])) {
    log.warn('conformance claims stamp is missing claimsVersion/claimedProfiles — omitting', {});
    return undefined;
  }
  return doc as unknown as StampedClaims;
}

/**
 * The stamped RFC 0148 §C bundle v2, or `undefined`.
 *
 * WHD-18: the IMAGE reader only, and no longer exported. It knows nothing about
 * the origin; `servedBundle()` below is the ONE mode-aware entry point, and the
 * only caller. An earlier draft also guarded this function on origin mode —
 * a second copy of the rule that no test could see (every path to it was already
 * guarded), i.e. a guard whose removal nothing would notice. One guard, in the
 * one place every surface goes through, is the WHD-6 shape.
 */
function imageCertificationBundle(): Record<string, unknown> | undefined {
  const dir = buildMetaDir();
  if (dir === null) return undefined;
  const parsed = readStamp(dir, BUNDLE_STAMP);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const doc = parsed as Record<string, unknown>;
  // `bundleVersion: '2'` is the discriminator RFC 0148 §C requires a verifier to
  // switch on. Refusing anything else keeps a v1 bundle — which cannot express
  // dispositions and therefore cannot substantiate a claim — from being served
  // through a pointer that promises v2 evidence.
  if (doc['bundleVersion'] !== '2') {
    log.warn('certification bundle stamp is not bundleVersion 2 — omitting', { found: String(doc['bundleVersion']) });
    return undefined;
  }
  return doc;
}

/**
 * The value for `capabilities.conformance.certificationBundleUrl`, or
 * `undefined` to OMIT the field.
 *
 * Gated on the BUNDLE being present, not on the claims file: RFC 0089 §D defines
 * the pointer as addressing a certification bundle, so advertising it while the
 * route would 404 is precisely the advertised-but-not-served defect the
 * container lane caught in `workflowChainPacks.hostExpansionSeam` — a claim the
 * artifact cannot honour.
 */
export function certificationBundleUrl(origin: string): string | undefined {
  if (servedBundle(1) === undefined) return undefined;
  return `${origin.replace(/\/+$/, '')}${CERTIFICATION_BUNDLE_PATH}`;
}

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

/** What a bundle route serves: the parsed image stamp, or the origin's exact verified bytes. */
export type ServedBundle =
  | { readonly source: 'image'; readonly doc: Record<string, unknown> }
  | { readonly source: 'origin'; readonly bytes: string };

/**
 * THE one predicate (WHD-6): the route serves this, the pointer is advertised
 * iff this is defined, and `/claims` is gated on it. Mode-aware — image stamp
 * (major 1 only) when no origin is configured, the verified origin object
 * otherwise, and never a mix of the two.
 */
export function servedBundle(major: ServedMajor): ServedBundle | undefined {
  if (evidenceFromOrigin()) {
    const bytes = originCertificationBundle(major);
    return bytes === undefined ? undefined : { source: 'origin', bytes };
  }
  if (major !== 1) return undefined;
  const doc = imageCertificationBundle();
  return doc === undefined ? undefined : { source: 'image', doc };
}
