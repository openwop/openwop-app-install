/**
 * WHD-18 / ADR 0735 decision 2 — serve the SIGNED, POST-DEPLOY certification
 * bundle from an origin OUTSIDE the image.
 *
 * WHY AN OUT-OF-IMAGE ORIGIN AT ALL. ADR 0735's defect is an ordering one: the
 * bundle `build-meta/` carries is cut BEFORE the revision it describes exists
 * (`deploy.sh` certifies in-process, then builds). The honest evidence is the
 * suite CLI's v3 cut against the DEPLOYED revision — and that artifact exists
 * only after the image is immutable, so nothing baked into the image can ever
 * be it. The WHD-6 correction in the ADR says exactly this. Hence a bucket the
 * operator writes AFTER the deploy (`scripts/publish-evidence.sh`) and this
 * module reads at request time.
 *
 * THE KEY IS THE HOST'S OWN COMMIT. The object for a build is
 * `<prefix>/<commit>/major-<m>.json`, where `<commit>` is `buildCommit()` — the
 * SAME resolver `/api/readiness` reports, image stamp preferred over the env
 * var (`host/buildInfo.ts`, the 2026-08-10 correction: `OPENWOP_BUILD_COMMIT`
 * alone survives a bare redeploy and can name the PREVIOUS build). So serving a
 * bundle cut against a different build is structurally impossible: there is no
 * "current" pointer to go stale, a new revision simply looks up a key nobody has
 * written yet, and the pointer is ABSENT until someone does. Absent is the
 * honest state for a revision nobody has measured (RFC 0089 §D: clients MUST
 * tolerate it).
 *
 * VERIFY BEFORE SERVING, AND BEFORE ADVERTISING. The bucket is writable only by
 * project owners/editors, so the threat this guards is not forgery by an
 * outsider — it is operator error: the wrong file at the right key, a bundle cut
 * against another commit or the other major, a hand-edited row, a key rotated
 * without its bundles. Every check below is one of those, and every failure
 * WITHHOLDS (pointer absent, routes 404, logged with the reason and never the
 * body). A verification failure is never "serve it anyway with a warning": a
 * pointer is a claim, and the WHD-6 invariant is that the route, the pointer
 * and `/claims` hang off ONE predicate.
 *
 * FETCH DISCIPLINE, and why it is not the SPA-shell refresh. Cloud Run runs this
 * service with `cpu-throttling=true`; a detached continuation may not resume
 * for 16+ minutes (#3056, ARCHITECTURE.md's detached-work row). So:
 *   - the refresh is AWAITED inside the request that needs it — the only place
 *     CPU is guaranteed — and never fired and forgotten;
 *   - it is BOUNDED: one deadline (`FETCH_DEADLINE_MS`) covers the metadata
 *     token AND the object read, enforced by a race the promise cannot outlive,
 *     plus an `AbortSignal` so the socket is torn down too;
 *   - it is SINGLE-FLIGHT per object key, and the in-flight entry is deleted in
 *     `.finally` of the RACED promise — which always settles by the deadline, so
 *     a hung fetch cannot wedge the next refresh. (The memory lesson this avoids
 *     exactly: a re-entry flag released in a `finally` is NOT released when an
 *     `await` inside the guarded block hangs. Here the `finally` is attached to
 *     the deadline race, not to the fetch.)
 *   - it is CACHED: positive `POSITIVE_TTL_MS`, negative `NEGATIVE_TTL_MS`, so a
 *     discovery read costs a Map lookup almost always.
 * The latch is a Map on a reader instance rather than a module-scope
 * `let x: Promise | null`, so `test/detached-latch-tripwire.test.ts` does not
 * scan it — the property that tripwire asserts (clear-on-settle AND a time
 * bound) is pinned behaviourally in `test/whd18-certification-evidence.test.ts`
 * instead, which is the stronger form.
 */

import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';

import { createLogger } from '../observability/logger.js';
import { JcsRefusal, canonicalJSON, codeUnitCompare, parseIJson } from './jcs.js';

const log = createLogger('host.certificationEvidence');

export type ServedMajor = 1 | 2;

/** One deadline for the whole refresh: metadata token + object read. */
export const FETCH_DEADLINE_MS = 2_000;
/** A verified bundle is re-read at most this often. It is commit-bound, so staleness is bounded to "the operator replaced it". */
export const POSITIVE_TTL_MS = 5 * 60_000;
/** A withheld result is retried at most this often — how long a freshly published bundle waits to appear. */
export const NEGATIVE_TTL_MS = 60_000;
/** Far above any real bundle (the major-2 cut is ~95 kB) and far below anything that could hurt the instance. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

// ── configuration ───────────────────────────────────────────────────────────

export interface BundleOrigin {
  readonly bucket: string;
  /** No leading or trailing slash; may be empty. */
  readonly prefix: string;
  /** The raw `gs://…` value, used in the cache key so a changed origin never reads another's cache. */
  readonly raw: string;
}

export type OriginConfig =
  | { readonly mode: 'image' }
  | { readonly mode: 'origin'; readonly origin: BundleOrigin }
  /**
   * SET but unusable. Deliberately NOT a fallback to `image`: the operator said
   * "the served evidence lives in the bucket", and quietly serving the in-image
   * pre-deploy bundle instead would publish exactly the artifact ADR 0735 says
   * must stop being served. So a typo withholds everything, loudly.
   */
  | { readonly mode: 'misconfigured'; readonly why: string };

const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const PREFIX_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function parseBundleOrigin(raw: string | undefined): OriginConfig {
  const value = raw?.trim();
  if (!value) return { mode: 'image' };
  const m = /^gs:\/\/([^/]+)(?:\/(.*))?$/.exec(value);
  if (!m) return { mode: 'misconfigured', why: 'OPENWOP_CERT_BUNDLE_ORIGIN must be gs://<bucket>[/<prefix>]' };
  const bucket = m[1] ?? '';
  if (!BUCKET_RE.test(bucket)) return { mode: 'misconfigured', why: `not a GCS bucket name: ${JSON.stringify(bucket)}` };
  const prefix = (m[2] ?? '').replace(/^\/+|\/+$/g, '');
  if (prefix !== '') {
    for (const seg of prefix.split('/')) {
      // `..` and empty segments are refused rather than normalised: the prefix
      // becomes part of an object NAME, and a name the operator did not type is
      // a name nobody will find when they go looking for what was served.
      if (seg === '' || seg === '.' || seg === '..' || !PREFIX_SEGMENT_RE.test(seg)) {
        return { mode: 'misconfigured', why: `unsafe prefix segment ${JSON.stringify(seg)}` };
      }
    }
  }
  return { mode: 'origin', origin: { bucket, prefix, raw: value } };
}

/** `<prefix>/<commit>/major-<m>.json` — the contract `scripts/publish-evidence.sh` writes to. */
export function bundleObjectKey(origin: BundleOrigin, commit: string, major: ServedMajor): string {
  return `${origin.prefix === '' ? '' : `${origin.prefix}/`}${commit}/major-${major}.json`;
}

export function bundleObjectUrl(origin: BundleOrigin, commit: string, major: ServedMajor): string {
  return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(origin.bucket)}/o/${encodeURIComponent(bundleObjectKey(origin, commit, major))}?alt=media`;
}

// ── the verifier ────────────────────────────────────────────────────────────
//
// Mirrors `@openwop/openwop-conformance` `src/lib/certification-bundle-v3.ts`
// (suite 2.34.0, the version the reference fixture was cut with). It is a
// MIRROR, not an import, for the reason `conformance/certify.ts` gives: the
// suite is a devDependency and the release stage runs `npm ci --omit=dev`, so
// nothing here may import it. The mirror fails CLOSED — a drift in
// canonicalisation or row reduction changes the recomputed digest, and the real
// signed fixture (`test/fixtures/certification-bundle-v3-27315b41c-major2.json`)
// then stops verifying, which reds the test that pins it.

// RFC 0212: canonical JSON is RFC 8785 JCS over I-JSON (`./jcs.ts`, a mirror of
// the suite's `src/lib/jcs.ts`). It REFUSES rather than coerces — a duplicate
// member name, a lone surrogate, an integer literal beyond ±(2^53 − 1) or a
// non-finite number fails verification with reason `non-ijson`. The old
// `Object.keys().sort()` + `JSON.stringify` helper turned NaN into `null` and
// kept the last duplicate, so two verifiers could read one document differently.
export { canonicalJSON, parseIJson, JcsRefusal };

const RESULTS = ['executed-pass', 'executed-fail', 'skipped', 'inapplicable', 'blocked'] as const;
type Result = (typeof RESULTS)[number];
const TOTAL_KEY: Record<Result, string> = {
  'executed-pass': 'executedPass',
  'executed-fail': 'executedFail',
  skipped: 'skipped',
  inapplicable: 'inapplicable',
  blocked: 'blocked',
};

interface Row {
  readonly id: string;
  readonly scenario: string;
  readonly result: Result;
  readonly assertions?: unknown;
  readonly detail?: unknown;
  readonly evidence?: unknown;
}

/**
 * RFC 0148 §C — sha256 hex over the canonical reporter record.
 *
 * ADR 0744 (CORRECTS the `'en'` pin that stood here): rows are ordered by
 * UTF-16 CODE UNIT (the RFC 8785 §3.2.3 comparator, a plain `<`), never by a
 * collation. `'en'` was chosen to match the producer's locale, but a collation
 * is a property of the machine, not of the bundle: MEASURED 2026-09-23 under
 * `cs`/`sk`/`lt`/`haw` the suite's default-locale `localeCompare` already
 * reorders the committed myndhyve and v2-reference bundles (`ch` sorts after
 * `h` in Czech), and ICU ignores punctuation that code-unit order does not. A
 * census of the five committed v3 bundles found every stored digest identical
 * under code-unit order, so this changes no result today (openwop TODO.md
 * RFC 0212 §b).
 *
 * `relaxations` joins the preimage ONLY WHEN NON-EMPTY, exactly as the suite's
 * `certification-bundle-v3.ts` does (2.35.0): the attestation covers
 * `witnessSha256`, so an operator relaxation beside the rows would otherwise be
 * unsigned. Ignoring it here made every relaxed bundle fail `witness-digest`
 * for the wrong reason.
 */
export function witnessDigest(rows: readonly Row[], relaxations?: readonly unknown[]): string {
  const canonicalRows = [...rows]
    .sort((a, b) => codeUnitCompare(a.id, b.id))
    .map((r) => ({
      id: r.id,
      scenario: r.scenario,
      result: r.result,
      ...(r.assertions === undefined ? {} : { assertions: r.assertions }),
      ...(r.detail === undefined ? {} : { detail: r.detail }),
      // Suite 2.34.0 (RFC 0158 §E): structured evidence is INSIDE the digest,
      // and only when present — a bundle without it digests byte-identically to
      // every pre-2.34 cut.
      ...(r.evidence === undefined ? {} : { evidence: r.evidence }),
    }));
  const preimage = relaxations !== undefined && relaxations.length > 0 ? { rows: canonicalRows, relaxations } : canonicalRows;
  return createHash('sha256').update(canonicalJSON(preimage), 'utf8').digest('hex');
}

export const SIGNATURE_OVER = ['witnessSha256', 'host.build', 'suite.version', 'discovery.sha256'] as const;

/** The exact bytes the attestation covers (suite `attestationPayload`). */
export function attestationPayload(fields: {
  readonly witnessSha256: string;
  readonly build: unknown;
  readonly suiteVersion: string;
  readonly discoverySha256: string;
}): Buffer {
  return Buffer.from(
    canonicalJSON({
      witnessSha256: fields.witnessSha256,
      'host.build': fields.build,
      'suite.version': fields.suiteVersion,
      'discovery.sha256': fields.discoverySha256,
    }),
    'utf8',
  );
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const fromBase64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export interface VerifyExpectation {
  /** The host's own full 40-hex commit. */
  readonly commit: string;
  readonly major: ServedMajor;
  /** `readBundleSigningKeys()` — the keys this host publishes in discovery. */
  readonly signingKeys: readonly Record<string, unknown>[];
}

export type BundleVerdict =
  | { readonly ok: true; readonly keyId: string }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

const reject = (reason: string, detail: string): BundleVerdict => ({ ok: false, reason, detail });

/**
 * Verify a parsed bundle for THIS host, THIS build, THIS major.
 *
 * Returns the FIRST failure, with a stable `reason` a test (and a log search)
 * can key on. Deliberately narrower than the suite's `verifyBundleV3`: that
 * function answers "which profiles does this bundle certify"; this one answers
 * "may this host serve this document as its own evidence". The two share the
 * integrity core (rows ↔ totals ↔ digest ↔ signature) and differ in what they
 * bind it to — the suite binds nothing to a host, this binds to the commit, the
 * major and the host's own published keys.
 */
export function verifyServedBundle(doc: unknown, expect: VerifyExpectation): BundleVerdict {
  const b = rec(doc);
  if (b === undefined) return reject('not-an-object', 'the object is not a JSON object');
  if (b['bundleVersion'] !== '3') return reject('not-v3', `bundleVersion is ${JSON.stringify(b['bundleVersion'])}, expected "3"`);

  const host = rec(b['host']);
  const build = rec(host?.['build']);
  if (build === undefined || build['kind'] !== 'commit') {
    return reject('build-kind', `host.build.kind is ${JSON.stringify(build?.['kind'])}, expected "commit" — the object key is a commit, so the bundle must attribute to one`);
  }
  if (build['id'] !== expect.commit) {
    return reject('build-mismatch', `host.build.id ${String(build['id']).slice(0, 12)} is not this host's commit ${expect.commit.slice(0, 12)}`);
  }

  const suite = rec(b['suite']);
  if (suite?.['targetMajor'] !== expect.major) {
    return reject('target-major', `suite.targetMajor is ${JSON.stringify(suite?.['targetMajor'])}, but this is the major-${expect.major} bundle`);
  }

  const results = rec(b['results']);
  const rawRows = results?.['requirements'];
  if (!Array.isArray(rawRows)) return reject('rows-malformed', 'results.requirements is not an array');
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const r of rawRows) {
    const row = rec(r);
    const id = row?.['id'];
    const scenario = row?.['scenario'];
    const result = row?.['result'];
    if (row === undefined || typeof id !== 'string' || typeof scenario !== 'string'
      || typeof result !== 'string' || !(RESULTS as readonly string[]).includes(result)) {
      return reject('rows-malformed', 'a requirement row is missing id/scenario or carries an unknown result');
    }
    if (seen.has(id)) return reject('rows-malformed', `requirement ${id} has more than one row (RFC 0148 §A)`);
    seen.add(id);
    rows.push({
      id,
      scenario,
      result: result as Result,
      ...(row['assertions'] === undefined ? {} : { assertions: row['assertions'] }),
      ...(row['detail'] === undefined ? {} : { detail: row['detail'] }),
      ...(row['evidence'] === undefined ? {} : { evidence: row['evidence'] }),
    });
  }

  const totals = rec(results?.['totals']);
  for (const k of RESULTS) {
    const counted = rows.filter((r) => r.result === k).length;
    const key = TOTAL_KEY[k];
    if (totals?.[key] !== counted) return reject('totals-mismatch', `totals.${key} is ${String(totals?.[key])} but the rows count ${counted}`);
  }
  const assertionSum = rows.reduce((n, r) => n + (typeof r.assertions === 'number' ? r.assertions : 0), 0);
  if (b['assertionCount'] !== assertionSum) {
    return reject('assertion-count', `assertionCount is ${String(b['assertionCount'])} but the rows sum to ${assertionSum}`);
  }

  const hostRelaxations = rec(b['host'])?.['relaxations'];
  let digest: string;
  try {
    digest = witnessDigest(rows, Array.isArray(hostRelaxations) ? hostRelaxations : undefined);
  } catch (err) {
    if (err instanceof JcsRefusal) return reject('non-ijson', err.message);
    throw err;
  }
  if (b['witnessSha256'] !== digest) {
    return reject('witness-digest', `witnessSha256 ${String(b['witnessSha256']).slice(0, 12)} is not the digest of the rows (${digest.slice(0, 12)})`);
  }

  const sig = rec(b['signature']);
  if (sig === undefined || sig['alg'] !== 'ed25519' || typeof sig['keyId'] !== 'string' || typeof sig['sig'] !== 'string' || sig['sig'] === '') {
    return reject('signature-missing', 'signature.{alg: ed25519, keyId, sig} is required — an unsigned bundle does not exist in v3');
  }
  if (JSON.stringify(sig['over']) !== JSON.stringify(SIGNATURE_OVER)) {
    return reject('signature-over', `signature.over must be ${JSON.stringify(SIGNATURE_OVER)}`);
  }
  const keyId = sig['keyId'];
  const key = expect.signingKeys.find((k) => k['keyId'] === keyId);
  if (key === undefined || typeof key['publicKey'] !== 'string') {
    // The trust root is self-asserted by design (IMPLEMENT-CORE.md: a verifier
    // resolves `keyId` in THIS host's discovery document). A key we do not
    // publish is a signature nobody can check — serving it would advertise
    // evidence that fails the RFC 0168 Front door.
    return reject('signature-key-unknown', `signature.keyId ${JSON.stringify(keyId)} is not among this host's published signingKeys`);
  }

  const generatedAt = typeof b['generatedAt'] === 'string' ? Date.parse(b['generatedAt']) : Number.NaN;
  if (Number.isNaN(generatedAt)) return reject('generated-at-invalid', 'generatedAt is missing or not a timestamp');
  if (key['retiredAt'] !== undefined) {
    const retiredAt = typeof key['retiredAt'] === 'string' ? Date.parse(key['retiredAt']) : Number.NaN;
    // Unparseable reads as retired: fail closed.
    //
    // HONEST SCOPE: `generatedAt` is NOT inside the signature (`over` names four
    // fields and it is not one), so this compares against a CLAIMED time. It
    // catches the realistic error — a bundle cut with a key after that key was
    // retired — and does not pretend to stop someone holding a retired private
    // key from back-dating a bundle. That threat is out of scope for a bucket
    // only project owners can write.
    if (Number.isNaN(retiredAt) || retiredAt < generatedAt) {
      return reject('signature-key-retired', `key ${keyId} was retired at ${String(key['retiredAt'])}, before this bundle's generatedAt ${String(b['generatedAt'])}`);
    }
  }

  const suiteVersion = suite?.['version'];
  const discoverySha = rec(b['discovery'])?.['sha256'];
  if (typeof suiteVersion !== 'string' || typeof discoverySha !== 'string') {
    return reject('signature-invalid', 'suite.version or discovery.sha256 is missing, so the signed bytes cannot be reconstructed');
  }
  let ok = false;
  try {
    const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key['publicKey'] }, format: 'jwk' });
    ok = edVerify(
      null,
      attestationPayload({ witnessSha256: digest, build, suiteVersion, discoverySha256: discoverySha }),
      publicKey,
      fromBase64url(sig['sig']),
    );
  } catch (err) {
    if (err instanceof JcsRefusal) return reject('non-ijson', err.message);
    return reject('signature-invalid', `the signature could not be checked: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!ok) return reject('signature-invalid', `the attestation does not verify under ${keyId}`);
  return { ok: true, keyId };
}

// ── the origin reader ───────────────────────────────────────────────────────

/** The subset of `fetch` the reader uses — injectable so a test never touches the network. */
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

type Entry =
  | { readonly state: 'verified'; readonly bytes: string; readonly expiresAt: number }
  | { readonly state: 'withheld'; readonly reason: string; readonly expiresAt: number };

export interface ReaderOptions {
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
  readonly deadlineMs?: number;
}

/** A failure the cache should treat as "we could not look", not "we looked and it is wrong". */
class TransportError extends Error {}

/** What one bounded load concluded. */
type LoadOutcome =
  | { readonly kind: 'verified'; readonly bytes: string }
  | { readonly kind: 'withheld'; readonly reason: string; readonly detail: string }
  | { readonly kind: 'transport'; readonly detail: string };

export interface EnsureRequest {
  readonly origin: BundleOrigin;
  readonly commit: string;
  readonly major: ServedMajor;
  readonly signingKeys: readonly Record<string, unknown>[];
}

export class CertificationEvidenceReader {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly deadlineMs: number;
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<void>>();
  private token: { readonly value: string; readonly expiresAt: number } | undefined;

  constructor(opts: ReaderOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.deadlineMs = opts.deadlineMs ?? FETCH_DEADLINE_MS;
  }

  static key(req: Pick<EnsureRequest, 'origin' | 'commit' | 'major'>): string {
    return `${req.origin.raw}|${req.commit}|${req.major}`;
  }

  /** The verified bytes for this key, or undefined. Synchronous: callers `ensure` first. */
  snapshot(req: Pick<EnsureRequest, 'origin' | 'commit' | 'major'>): string | undefined {
    const e = this.cache.get(CertificationEvidenceReader.key(req));
    return e?.state === 'verified' ? e.bytes : undefined;
  }

  /** How many refreshes are in flight right now — exported for the wedge test. */
  inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * Make the cache current for this key, awaiting at most the deadline.
   *
   * NEVER throws: every outcome is recorded in the cache, and a caller that
   * awaited this and then reads `snapshot()` sees the honest answer.
   */
  async ensure(req: EnsureRequest): Promise<void> {
    const k = CertificationEvidenceReader.key(req);
    const cached = this.cache.get(k);
    if (cached !== undefined && cached.expiresAt > this.now()) return;
    let running = this.inflight.get(k);
    if (running === undefined) {
      running = this.boundedLoad(req)
        .then((outcome) => this.record(k, req, outcome))
        .finally(() => {
          // Attached to the DEADLINE-BOUNDED promise, which always settles
          // within `deadlineMs` — so this runs even when the fetch underneath
          // hangs forever. That is the whole difference from #3056.
          this.inflight.delete(k);
        });
      this.inflight.set(k, running);
    }
    await running;
  }

  private record(k: string, req: EnsureRequest, outcome: LoadOutcome): void {
    const now = this.now();
    if (outcome.kind === 'verified') {
      this.cache.set(k, { state: 'verified', bytes: outcome.bytes, expiresAt: now + POSITIVE_TTL_MS });
      return;
    }
    const prior = this.cache.get(k);
    if (outcome.kind === 'transport' && prior?.state === 'verified') {
      // STALE-IF-ERROR, for transport failures ONLY. A bundle already verified
      // against this commit and this host's keys does not become false because
      // GCS or the metadata server hiccupped; withdrawing the pointer for that
      // would make the claim flap with the weather. Retried after the NEGATIVE
      // TTL, so the stale window is short. A 404 or a verification failure is
      // NOT transport — the operator deleted or replaced it — and does withhold.
      log.warn('certification_evidence_refresh_failed_serving_verified', {
        major: req.major, commit: req.commit.slice(0, 12), detail: outcome.detail,
      });
      this.cache.set(k, { state: 'verified', bytes: prior.bytes, expiresAt: now + NEGATIVE_TTL_MS });
      return;
    }
    const reason = outcome.kind === 'transport' ? 'transport' : outcome.reason;
    const detail = outcome.detail;
    // Every withhold is logged with its reason, NEVER with the bundle body — the
    // body is public evidence, but a log line is not the place to publish it and
    // a hostile or broken object must not be able to fill the log.
    log.warn('certification_evidence_withheld', { major: req.major, commit: req.commit.slice(0, 12), reason, detail });
    this.cache.set(k, { state: 'withheld', reason, expiresAt: now + NEGATIVE_TTL_MS });
  }

  /** Race the load against the deadline. The returned promise ALWAYS settles by `deadlineMs`. */
  private boundedLoad(req: EnsureRequest): Promise<LoadOutcome> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<LoadOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: 'transport', detail: `no answer within ${this.deadlineMs} ms` });
      }, this.deadlineMs);
    });
    const work = this.load(req, controller.signal).catch((err: unknown): LoadOutcome => ({
      kind: 'transport',
      detail: err instanceof Error ? err.message : String(err),
    }));
    return Promise.race([work, deadline]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  private async accessToken(signal: AbortSignal): Promise<string> {
    const now = this.now();
    if (this.token !== undefined && this.token.expiresAt > now) return this.token.value;
    const res = await this.fetchImpl(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' }, signal });
    if (!res.ok) throw new TransportError(`metadata token: HTTP ${res.status}`);
    const body = rec(await res.json());
    const value = body?.['access_token'];
    const expiresIn = body?.['expires_in'];
    if (typeof value !== 'string' || value === '') throw new TransportError('metadata token: no access_token');
    // Refresh a minute early so a token never expires between here and the read.
    const ttlMs = typeof expiresIn === 'number' && expiresIn > 120 ? (expiresIn - 60) * 1000 : 60_000;
    this.token = { value, expiresAt: now + ttlMs };
    return value;
  }

  private async load(req: EnsureRequest, signal: AbortSignal): Promise<LoadOutcome> {
    const token = await this.accessToken(signal);
    const res = await this.fetchImpl(bundleObjectUrl(req.origin, req.commit, req.major), {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (res.status === 404) {
      return { kind: 'withheld', reason: 'not-published', detail: `no evidence published at ${bundleObjectKey(req.origin, req.commit, req.major)}` };
    }
    if (res.status === 401 || res.status === 403) {
      // The token is cached; a 401 may mean it was revoked early. Drop it so the
      // next refresh mints a fresh one rather than failing until expiry.
      this.token = undefined;
    }
    if (!res.ok) return { kind: 'transport', detail: `object read: HTTP ${res.status}` };
    const bytes = await res.text();
    if (bytes.length > MAX_BUNDLE_BYTES) {
      return { kind: 'withheld', reason: 'too-large', detail: `${bytes.length} bytes exceeds ${MAX_BUNDLE_BYTES}` };
    }
    // RFC 0212 §B: parse through the I-JSON boundary — a duplicate member name
    // or an out-of-range integer literal is invisible after `JSON.parse`, which
    // would verify a document another verifier reads differently.
    let doc: unknown;
    try {
      doc = parseIJson(bytes);
    } catch (err) {
      if (err instanceof JcsRefusal && err.kind !== 'not-json') return { kind: 'withheld', reason: 'non-ijson', detail: err.message };
      return { kind: 'withheld', reason: 'not-json', detail: 'the object is not JSON' };
    }
    const verdict = verifyServedBundle(doc, { commit: req.commit, major: req.major, signingKeys: req.signingKeys });
    if (!verdict.ok) return { kind: 'withheld', reason: verdict.reason, detail: verdict.detail };
    return { kind: 'verified', bytes };
  }
}
