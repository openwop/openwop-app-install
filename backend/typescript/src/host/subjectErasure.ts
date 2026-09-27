/**
 * Subject-erasure registry (GDPR data-subject erasure, cross-feature).
 *
 * A neutral host-level seam so a data-subject "delete" reaches ALL of a subject's
 * data, not just the feature that fielded the request. Consent (ADR 0020) owns the
 * request and calls `eraseSubject`; feature packages that store subject-keyed data
 * (Analytics events, future Email send-logs) register a `purgeSubject` handler.
 * Decoupled — Consent stays the foundation and does NOT depend on its consumers;
 * it just fans out to whoever registered.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '../observability/logger.js';
import { assertNoRetentionHold } from './retentionHold.js';
import { EXPECTED_SUBJECT_ERASERS } from './subjectEraserManifest.js';

const log = createLogger('host.subjectErasure');

/**
 * ADR 0657 D7 — the DSAR an eraser is running under.
 *
 * Erasers are invoked once per RESOLVED key, so an eraser handed `crm:c1` has
 * no way to know the request was for `u1` — yet a tombstone it writes must be
 * reversible as a GROUP (readmit clears every tombstone one DSAR wrote,
 * including the resolved keys the resolvers can no longer recover once the
 * ident rows are gone). The whole of `eraseSubject` (resolution + fan-out)
 * runs inside this store, so `currentErasureRequest()` answers with the
 * REQUESTED key from inside any eraser, for any resolved key, and `undefined`
 * outside a fan-out (an eraser called directly by a test or a route is not
 * under a DSAR and must not stamp one).
 */
export interface ErasureRequestContext {
  tenantId: string;
  /** The key the DSAR was requested for — NOT the resolved key the eraser was handed. */
  requestedKey: string;
}
const erasureRequest = new AsyncLocalStorage<ErasureRequestContext>();

/** The DSAR the current async context is executing under, or `undefined` when
 *  not inside `eraseSubject` at all. */
export function currentErasureRequest(): ErasureRequestContext | undefined {
  return erasureRequest.getStore();
}

/**
 * CONS-30 (ADR 0657 D12) — per-eraser timeout. A single eraser awaiting a
 * store that never answers used to pin the WHOLE fan-out (and the DSAR route
 * behind it) forever: no failure, no receipt, no retry. A timeout is counted
 * exactly like a throw — into `failed`, with the eraser NAMED in
 * `failedFeatures` — and the fan-out continues to the next eraser/key.
 * `OPENWOP_ERASER_TIMEOUT_MS`: default 10 000, read per call, `0` disables.
 */
const ERASER_TIMEOUT_DEFAULT_MS = 10_000;
function eraserTimeoutMs(): number {
  const raw = process.env.OPENWOP_ERASER_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return ERASER_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : ERASER_TIMEOUT_DEFAULT_MS;
}

class SubjectEraserTimeoutError extends Error {
  constructor(eraser: string, ms: number) {
    super(`subject eraser ${eraser} did not settle within ${ms} ms`);
    this.name = 'SubjectEraserTimeoutError';
  }
}

async function withEraserTimeout<T>(work: Promise<T>, ms: number, eraser: string): Promise<T> {
  if (ms <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SubjectEraserTimeoutError(eraser, ms)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A per-feature subject-purge handler. Invoked ONCE PER linked subject-key (see
 * `SubjectKeyResolver`) — so it MUST be idempotent / side-effect-free beyond deletion
 * (never per-call counters, notifications, etc., which would fire K times). It deletes or
 * anonymizes this tenant's rows keyed by `subjectKey`; a key from a different identity space
 * simply matches nothing (a harmless no-op).
 */
export type SubjectEraser = (tenantId: string, subjectKey: string) => Promise<void | SubjectEraseReport>;

/**
 * WF-TWIN-3 / GEN-TWIN-4 — what an eraser ACTUALLY touched.
 *
 * `failed === 0` used to be the whole success test, and it is satisfied by a
 * fan-out that matched nothing anywhere: every eraser is individually correct and
 * tenant-scoped, so handing them the WRONG tenant makes each one a silent, honest
 * no-op and the composition reports a clean erasure over data that was never
 * reached. The three-layer manifest proves an eraser was registered and RAN; it
 * cannot prove it was handed the tenant its data lives in.
 *
 * Returning this is OPTIONAL and additive — an eraser that returns `void` is
 * simply not counted in `reportingErasers`, so a partial roll-out never turns
 * "nobody reports" into a false zero.
 */
export interface SubjectEraseReport {
  /** Rows deleted or scrubbed by this eraser, for this (tenant, key) pair. */
  rowsTouched: number;
}



/**
 * Expands a subject to the FULL set of its linked identity keys (ADR 0381). A person's data
 * spans identity spaces — a CDP `sessionKey` and a CRM `contactId` for the same person are
 * joined by `analytics:identity-link`; without expansion an erasure keyed by one never reaches
 * data keyed by the other. The owning feature registers a resolver (host never imports the
 * feature); `eraseSubject` runs every resolver UPFRONT (before any eraser) so no eraser races
 * another eraser's deletion of the link. MUST return ONLY authoritative, store-backed
 * same-subject keys (never a heuristic match) — that is what prevents over-erasure. Best-effort:
 * a throwing resolver is caught, degrading to the keys resolved so far (the bare subjectKey is
 * always retained).
 */
export type SubjectKeyResolver = (tenantId: string, subjectKey: string) => Promise<readonly string[]>;

const erasers: SubjectEraser[] = [];
const resolvers: SubjectKeyResolver[] = [];

/**
 * The eraser's stable id. `fn.name` is what `eraseSubject` already reports as
 * `failedFeatures`, so it is the id the manifest keys on too — one name, not
 * two that can disagree.
 */
export function subjectEraserId(fn: SubjectEraser): string {
  return fn.name;
}

/** Register a per-feature subject-purge handler (idempotent by reference).
 *
 *  WF-CONS-2 — the handler MUST be a NAMED function. An anonymous one has
 *  `fn.name === ''`, which makes it unreportable in `failedFeatures` and
 *  invisible to the `EXPECTED_SUBJECT_ERASERS` manifest, i.e. exactly the
 *  "never-registered is indistinguishable from clean" state the manifest
 *  exists to end. Throwing at REGISTRATION (boot) rather than at DSAR time is
 *  deliberate: a compliance path must not discover its own gap mid-request. */
export function registerSubjectEraser(fn: SubjectEraser): void {
  if (!fn.name) {
    throw new Error('registerSubjectEraser requires a NAMED function — an anonymous eraser cannot be reported or manifest-checked (WF-CONS-2).');
  }
  if (!erasers.includes(fn)) erasers.push(fn);
}

/** The ids currently registered. */
export function registeredSubjectEraserIds(): string[] {
  return erasers.map(subjectEraserId);
}

/**
 * WF-CONS-2 — expected-but-UNREGISTERED erasers.
 *
 * `eraseSubject` reported `total: erasers.length` against no expected set, and
 * every caller's success test is `failed === 0`. An eraser whose module was
 * never imported contributes to NEITHER number, so a never-registered feature
 * was indistinguishable from a cleanly-erased one — a silent, unrecoverable
 * under-erasure reported as success. `host/applyGrant.ts` was a LIVE instance:
 * it registered at module scope, outside the one explicit host boot list that
 * exists to prevent precisely this.
 */
export function missingSubjectErasers(): string[] {
  // A suite that called `__resetSubjectErasers()` has DELIBERATELY replaced the
  // registry with a synthetic one to assert the counting arithmetic; reporting
  // all 76 as missing there would be noise, not a finding. This is the same
  // structural blindness WF-CONS-10 names in the erasure witness, and the
  // answer to it is the BOOT layer of `test/subject-eraser-manifest.test.ts`,
  // which asserts a real `createApp()` against the manifest with no synthetic
  // registry anywhere near it. Stated here so the trade is visible at the code
  // that makes it, rather than inferred from a green suite.
  if (syntheticRegistry) return [];
  const live = new Set(registeredSubjectEraserIds());
  return [...EXPECTED_SUBJECT_ERASERS].filter((id) => !live.has(id)).sort();
}

/** True once a test seam has emptied the registry — see `missingSubjectErasers`. */
let syntheticRegistry = false;

/** Test-only: is the registry the real, boot-populated one? */
export function __isSyntheticEraserRegistry(): boolean { return syntheticRegistry; }

/** Register a subject-key resolver (idempotent by reference) — see `SubjectKeyResolver`. */
export function registerSubjectKeyResolver(fn: SubjectKeyResolver): void {
  if (!resolvers.includes(fn)) resolvers.push(fn);
}


/** Expand a subject to the set of its linked keys via every registered resolver, best-effort.
 *  The bare `subjectKey` is always included, even if every resolver fails.
 *
 *  CONS-11 (ADR 0657 D12) — TWO-HOP closure. Resolvers answer for ONE key
 *  shape each (`usersEmailKeyResolver`: userId → email; `resolveCrmSubjectKeys`:
 *  email → contactId), so a single pass from `userId` reached the email and
 *  stopped: the CRM contact keyed by that email was never enumerated and never
 *  erased. Every key DERIVED in hop 1 is fed through the resolvers exactly once
 *  more (hop 2); keys derived in hop 2 are NOT re-fed — the bound is two hops,
 *  not a fixpoint, so a pathological link graph cannot turn a DSAR into an
 *  unbounded walk. Deduped through one set: a resolver that maps a derived key
 *  BACK to the original (or to a sibling already seen) adds nothing and is not
 *  re-fed. `resolverFailures` counts DISTINCT resolvers that threw (in either
 *  hop), the same arithmetic `failed` uses for erasers — one broken store is one
 *  failure however many keys it was tried with. */
async function resolveSubjectKeys(tenantId: string, subjectKey: string): Promise<{ keys: Set<string>; resolverFailures: number }> {
  const keys = new Set<string>([subjectKey]);
  const failedResolvers = new Set<number>();
  const hop = async (input: string): Promise<string[]> => {
    const derived: string[] = [];
    for (let i = 0; i < resolvers.length; i += 1) {
      try {
        for (const k of await resolvers[i]!(tenantId, input)) {
          if (!k || keys.has(k)) continue;
          keys.add(k);
          derived.push(k);
        }
      } catch (err) {
        // R2 CN-SP-1 — a throwing resolver means LINKED-KEY data (a CRM contact
        // reached via an identity link, a CDP session) was never enumerated and
        // therefore never erased. Swallow-and-log made the fan-out report
        // ok:true over an incomplete erasure — CONS-G1's exact class, one layer
        // down. The failure now COUNTS.
        failedResolvers.add(i);
        log.error('subject_key_resolver_failed', {
          tenantId, subjectKey, input, resolverIndex: i, error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return derived;
  };
  const firstHop = await hop(subjectKey);
  for (const derivedKey of firstHop) await hop(derivedKey);
  return { keys, resolverFailures: failedResolvers.size };
}

/** Fan out a data-subject erasure to every registered feature (best-effort — one feature's
 *  failure must not block the others). The subject is first expanded to the full set of its
 *  linked identity keys (ADR 0381) UPFRONT, then each eraser is invoked once per key so a
 *  session-keyed erasure reaches the same person's contact-keyed data (and vice-versa) without
 *  racing the link's own deletion. `failed` counts DISTINCT erasers that threw for ≥1 key so
 *  the caller's `failed > 0` reaction is unchanged; each failure is logged so an incomplete
 *  GDPR erasure leaves an audit trail (SEC-4). `keysResolved` reports the expansion for
 *  observability on the compliance path.
 *
 *  CONS-4 / WF-CONS-1 — REFUSES on a tenant under LEGAL HOLD, before any eraser runs.
 *  GDPR Art. 17(3)(b)/(e) makes a hold override erasure, and the failure ran in the
 *  unrecoverable direction (spoliation). The refusal is a TYPED throw
 *  (`RetentionHoldError`), never a silent skip or a `failed: 0` no-op: a caller
 *  must not be able to mistake "a hold forbade this" for "there was nothing to
 *  erase". The exit exists and is named in the error — lift the hold, retry. */
export async function eraseSubject(
  tenantId: string,
  subjectKey: string,
): Promise<SubjectErasureResult> {
  // The hold is asserted HERE, in the exported lane, before any context is
  // entered — `test/destructive-lane-census.test.ts` proves it by scanning
  // this function's own text, so it must not move into a helper.
  await assertNoRetentionHold(tenantId);
  // ADR 0657 D7 — resolution AND fan-out run under the request context, so
  // every eraser (for every resolved key) can read `currentErasureRequest()`.
  return erasureRequest.run({ tenantId, requestedKey: subjectKey }, () => eraseSubjectUnderRequest(tenantId, subjectKey));
}

async function eraseSubjectUnderRequest(
  tenantId: string,
  subjectKey: string,
): Promise<SubjectErasureResult> {
  const { keys, resolverFailures } = await resolveSubjectKeys(tenantId, subjectKey);
  // WF-TWIN-3, CORRECTED — the fan-out deliberately does NOT expand the TENANT
  // axis. A candidate fix that resolved the subject's HOME tenant and erased
  // there too was built, and the existing `pii-erasure-retention` guard caught it
  // as a CROSS-TENANT DESTRUCTIVE ESCALATION: `subjectKey` is caller-supplied, so
  // any workspace admin could have named any user id and wiped that person's
  // personal-tenant data across every OTHER workspace they belong to. Tenant
  // isolation wins; what is fixed instead is the LIE — see `foundNothing`.
  const failedErasers = new Set<number>();
  let rowsTouched = 0;
  const reporting = new Set<number>();
  // R2 CN-SP-6 — a failed eraser must be NAMEABLE to the operator (the market
  // bar is per-system outcomes; an anonymous index gives nothing to escalate
  // with). Registered erasers are named functions, so fn.name is free.
  const eraserName = (i: number): string => erasers[i]?.name || `eraser#${i}`;
  const timeoutMs = eraserTimeoutMs(); // CONS-30 — read once per fan-out, so a test can set it per call
  for (const key of keys) {
    for (let i = 0; i < erasers.length; i++) {
      try {
        const report = await withEraserTimeout(Promise.resolve(erasers[i]!(tenantId, key)), timeoutMs, eraserName(i));
        if (report && typeof report.rowsTouched === 'number') {
          reporting.add(i);
          rowsTouched += report.rowsTouched;
        }
      } catch (err) {
        // CONS-30 — a timeout is a failure with the same shape as a throw (it
        // is in `failed` and NAMED in `failedFeatures`), logged under its own
        // event so an operator can tell "errored" from "never answered".
        failedErasers.add(i);
        const event = err instanceof SubjectEraserTimeoutError ? 'subject_eraser_timeout' : 'subject_eraser_failed';
        log.error(event, {
          tenantId,
          subjectKey,
          resolvedKey: key,
          eraserIndex: i,
          eraser: eraserName(i),
          ...(err instanceof SubjectEraserTimeoutError ? { timeoutMs } : {}),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  // R2 CN-SP-1 — resolver failures make the erasure INCOMPLETE exactly like
  // eraser failures do (unenumerated keys are unerased data): they count.
  // WF-CONS-2 — an eraser that was never REGISTERED is data that was never
  // erased. It contributed to neither `total` nor `failed`, so a missing
  // feature read as a clean fan-out. It now counts as a failure, is named
  // alongside the ones that threw, and is reported separately so the operator
  // can tell "this system errored" from "this system never ran".
  const missing = missingSubjectErasers();
  const failed = failedErasers.size + resolverFailures + missing.length;
  const failedFeatures = [...failedErasers].map(eraserName);
  for (let i = 0; i < resolverFailures; i += 1) failedFeatures.push('identity-link-resolution'); // one entry per failure — counts stay aligned
  for (const id of missing) failedFeatures.push(`${id} (never registered)`);
  // `total` is registered PLUS missing, not the registration-order artifact it
  // used to be — otherwise a never-imported eraser would shrink the very
  // denominator it is supposed to be measured against, and "1 of 1 succeeded"
  // would be printed over a fan-out that skipped a feature entirely.
  // Deliberately `erasers.length + missing.length` rather than the manifest's
  // size: a synthetic test registry has no missing entries, so the counting
  // suites keep measuring exactly what they registered, and production gets the
  // expected population because `missing` supplies the difference.
  const total = erasers.length + missing.length;
  if (failed > 0) {
    log.warn('subject_erasure_incomplete', { tenantId, subjectKey, failed, total, resolverFailures, missing, failedFeatures });
  }
  // WF-TWIN-3 / GEN-TWIN-4 — a fan-out where every REPORTING eraser touched
  // nothing is not a clean erasure, it is an unanswered question: either the
  // subject genuinely had no data, or the fan-out was handed the wrong tenant.
  // Both are true statements; `erasure_complete` is not. Callers must not
  // collapse them (see `consentService.recordGovernanceDecision`).
  const foundNothing = reporting.size > 0 && rowsTouched === 0;
  if (foundNothing) {
    log.warn('subject_erasure_zero_rows', {
      tenantId, subjectKey, keysResolved: keys.size, reportingErasers: reporting.size,
    });
  }
  return {
    total, failed, keysResolved: keys.size, resolverFailures, failedFeatures, missing,
    rowsTouched, reportingErasers: reporting.size, foundNothing,
  };
}

/** The outcome of a DSAR fan-out. `failed === 0` alone is NOT a success test —
 *  see `foundNothing`. */
export interface SubjectErasureResult {
  total: number;
  failed: number;
  keysResolved: number;
  resolverFailures: number;
  failedFeatures: string[];
  missing: string[];
  /** Rows deleted/scrubbed, summed over erasers that REPORT (opt-in). */
  rowsTouched: number;
  /** How many erasers reported — `0` means `rowsTouched` measures nothing. */
  reportingErasers: number;
  /** `true` when erasers reported and the TOTAL was zero — an erasure that
   *  reached nothing must not be recorded as `erasure_complete`. */
  foundNothing: boolean;
}

/** Test-only: clear registered erasers. Marks the registry SYNTHETIC, which
 *  suppresses the expected-set check (see `missingSubjectErasers`). */
export function __resetSubjectErasers(): void { erasers.length = 0; syntheticRegistry = true; }

/** Test-only: clear registered subject-key resolvers (mirrors `__resetSubjectErasers`). */
export function __resetSubjectKeyResolvers(): void { resolvers.length = 0; }
