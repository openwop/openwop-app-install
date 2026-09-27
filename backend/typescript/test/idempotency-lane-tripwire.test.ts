/**
 * ADR 0549 P0 — the idempotency-lane tripwire.
 *
 * There are TWO lanes and they must never be crossed again:
 *
 *   - the HTTP ledger (`claimIdempotentResponse` / `completeIdempotentResponse`)
 *     for CALLER-SUPPLIED `Idempotency-Key` values, keyed
 *     (tenant, endpoint, key); and
 *   - the fire-once mutex (`claimOnce` / `putOnce` / `pruneOnceByPrefix`) for
 *     HOST-GENERATED daemon keys, keyed by one opaque string.
 *
 * Crossing them was a live security defect on both sides: one raw keyspace let
 * tenant B replay tenant A's cached response, AND let any caller send
 * `Idempotency-Key: schedule-fire:<jobId>:<slot>` to win the scheduler's mutex
 * and suppress a host-scheduled job.
 *
 * The compile-time half of the forcing function is the closed
 * `IdempotentEndpoint` union — a new participating route cannot pass an ad-hoc
 * endpoint string. This file is the runtime half, modelled on the
 * `capability-token-tripwire.test.ts` precedent named in `ARCHITECTURE.md`:
 * a third route reintroducing the raw-key call is a red test, not a review
 * catch.
 *
 * The daemon allowlist is NO-GROWTH. Adding an entry means a new daemon needs
 * the mutex, which is legitimate — but it is a deliberate edit with a reason,
 * not something that drifts in.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDEMPOTENT_ENDPOINTS } from '../src/host/idempotentResponse.js';

const SRC = join(__dirname, '..', 'src');

/** The mutex lane's API — host-generated keys only. */
const MUTEX_CALLS = /\b(?:storage|deps\.storage)\??\.(claimOnce|putOnce|pruneOnceByPrefix)\s*\(/;

/** Reading the caller-supplied header. */
const READS_HEADER = /req\.header\(\s*['"]idempotency-key['"]\s*\)/i;

/**
 * Files permitted to call the fire-once mutex: the daemons and sweeps whose
 * keys are machine-generated. NO-GROWTH.
 */
const MUTEX_ALLOWLIST = new Set<string>([
  'host/retentionSweepDaemon.ts',
  'host/scheduleDaemon.ts',
  'host/heartbeatService.ts',
  'features/cdp/segmentEntryDaemon.ts',
  'features/ambient-work-graph/workGraphSweep.ts',
  'features/crm/snapshotDaemon.ts',
  // ADR 0605 Tier 5 (`KSWF-4`) + WF-KB-3 — BOTH mutex uses now live here: `claimSyncRun`
  // (the per-source claim, taken inside `syncNow`, keyed on the source's own state
  // version — never caller-supplied) AND `pruneStaleKnowledgeSyncClaims` (the
  // claim-prefix self-prune, `KSWF-15`). WF-KB-3 DELETED `knowledgeSyncDaemon.ts`
  // (its former home for the prune) and folded the recurring sync onto the ONE host
  // scheduler; the mutex primitives moved here, so this gate SHRANK by one entry —
  // the shrink-only check doing its job.
  'features/knowledge-sync/knowledgeSyncService.ts',
  'features/connections/refreshDaemon.ts',
  'features/cms/publishSweep.ts',
  'features/kicktodo-metrics/verifierSampleDaemon.ts',
  // NOTE: the Storage interface and the two adapters are deliberately ABSENT.
  // They DECLARE and IMPLEMENT these methods (`async claimOnce(...)`) rather
  // than invoking them on a storage handle, so the call-site predicate does
  // not match — and listing them would leave three permanent entries that the
  // shrink-only check below would have to special-case.
]);

/**
 * Files that read the header but are NOT part of the ledger lane, cleared by
 * per-edge review rather than dodged.
 */
const REVIEWED_EXEMPT = new Map<string, string>([
  // Booking uses the key as a GUARD FIELD, never as a storage key. The row id
  // is `bookingIdFor(bookingLinkId, slotStartUtcMs)` — already scoped to a
  // booking link, hence to a tenant — and the key is only compared against
  // `prior.idempotencyKey` to confirm the retry belongs to the same caller
  // (bookingService.ts:210-217). It touches neither the ledger nor the mutex
  // table, so no shared keyspace exists to collide in. Cleared 2026-08-11 by
  // the ADR 0549 P0 review; the tripwire FOUND this file, which is the point.
  ['features/crm/bookingRoutes.ts', 'key is a guard field on a deterministically-identified booking row, not a storage key'],
  // v2 charter Phase 4 (P4-D / ADR 0629). The major-2 identity gate reads the
  // header to enforce ONE THING: the `spec/v2/core/idempotency.md` §"Layer 1"
  // GRAMMAR (`^[A-Za-z0-9._~-]{22,128}$`), refusing a value outside it with
  // `400 idempotency_key_invalid`. It never claims, never completes, never
  // keys anything by the value, and imports neither lane — so there is no
  // shared keyspace for it to collide in. It must run BEFORE the ledger
  // precisely because §Layer 1 says `idempotency_key_invalid` MUST NOT be
  // cached: refusing here means the claim is never taken. The tripwire FOUND
  // this file on the first run of the P4-D branch, which is the point; cleared
  // by per-edge review rather than by routing the grammar check through a
  // ledger it has no business touching.
  ['middleware/v2Identity.ts', 'reads the header only to enforce the v2 §Layer 1 grammar before any claim is taken; touches neither keyspace'],
]);

/**
 * Routes permitted to read the `Idempotency-Key` header. Each MUST appear in
 * the `IdempotentEndpoint` union, which the final test cross-checks.
 */
const LEDGER_ROUTES = new Set<string>([
  'routes/runs.ts',
  'routes/userAgents.ts',
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** A ROUTE module in either shape this app uses: the host `routes/` directory and
 *  a feature package's own `routes.ts`. A route's idempotency key is caller-supplied
 *  by definition, which is the whole reason routes are excluded from the mutex lane. */
function isRouteModule(rel: string): boolean {
  return rel.startsWith('routes/') || /^features\/[^/]+\/routes\.ts$/.test(rel);
}

const FILES = walk(SRC).map((p) => ({
  rel: relative(SRC, p).split(sep).join('/'),
  text: readFileSync(p, 'utf8'),
}));

describe('ADR 0549 — idempotency lane separation', () => {
  it('no route module calls the fire-once mutex', () => {
    // A route's key is caller-supplied by definition, so a route reaching the
    // mutex lane is the poisoning vector, restated.
    // ADR 0605 — the population was `f.rel.startsWith('routes/')` ONLY, so every
    // FEATURE-PACKAGE route file (`features/<x>/routes.ts`) was outside it. That is
    // most of this app's routes, and it meant the check could not have observed
    // `KSWF-4` — the knowledge-sync "Sync now" route — even in principle. Broadened
    // to both shapes. MEASURED before broadening: `grep -rln 'claimOnce('` over
    // `src/features/*/routes.ts` returns ZERO files, so this adds no false
    // positives and no quarantine; it only removes a blind spot.
    const offenders = FILES.filter(
      (f) => isRouteModule(f.rel) && MUTEX_CALLS.test(f.text) && !MUTEX_ALLOWLIST.has(f.rel),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('only the allowlisted daemons call the fire-once mutex', () => {
    const callers = FILES.filter((f) => MUTEX_CALLS.test(f.text)).map((f) => f.rel).sort();
    const unexpected = callers.filter((r) => !MUTEX_ALLOWLIST.has(r));
    expect(unexpected).toEqual([]);
  });

  it('the mutex allowlist does not grow silently', () => {
    // Shrink-only: an entry that no longer calls the mutex should be REMOVED,
    // and a new caller must be added deliberately with a reason in review.
    const callers = new Set(FILES.filter((f) => MUTEX_CALLS.test(f.text)).map((f) => f.rel));
    const stale = [...MUTEX_ALLOWLIST].filter((r) => !callers.has(r));
    expect(stale).toEqual([]);
  });

  it('every file reading the Idempotency-Key header goes through the ledger', () => {
    const readers = FILES.filter((f) => READS_HEADER.test(f.text) && !REVIEWED_EXEMPT.has(f.rel));
    // A reader that never imports the one owner is hand-rolling the contract.
    const notUsingLedger = readers
      .filter((f) => !f.text.includes('host/idempotentResponse.js'))
      .map((f) => f.rel);
    expect(notUsingLedger).toEqual([]);

    const unregistered = readers.map((f) => f.rel).filter((r) => !LEDGER_ROUTES.has(r));
    expect(unregistered).toEqual([]);
  });

  it('every exemption still reads the header (no stale exemptions)', () => {
    // An exemption for a file that no longer reads the header is dead weight
    // that would silently cover a FUTURE reintroduction in the same path.
    const stale = [...REVIEWED_EXEMPT.keys()].filter(
      (rel) => !FILES.some((f) => f.rel === rel && READS_HEADER.test(f.text)),
    );
    expect(stale).toEqual([]);
  });

  it('no route hand-rolls a process-local body-hash map', () => {
    // The exact shape that used to live in BOTH routes and drift: a
    // module-scope Map keyed by the idempotency key. It does not survive a
    // restart, so it silently downgrades a 409 mismatch into a served replay
    // of the wrong body.
    const offenders = FILES.filter(
      (f) => f.rel.startsWith('routes/') && /idempotencyBodyHashes|hashRequestBody/.test(f.text),
    )
      // The comments recording WHY they were removed are allowed to name them.
      .filter((f) => /^\s*(?:const|function|let)\s+(?:idempotencyBodyHashes|hashRequestBody)\b/m.test(f.text))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('every allowlisted ledger route is registered in the endpoint union', () => {
    // Keeps the two lists honest against each other: a route may read the
    // header only if the union has a literal for it.
    expect(LEDGER_ROUTES.size).toBe(IDEMPOTENT_ENDPOINTS.length);
    for (const endpoint of IDEMPOTENT_ENDPOINTS) {
      const declared = FILES.some((f) => LEDGER_ROUTES.has(f.rel) && f.text.includes(`'${endpoint}'`));
      expect(declared, `no route declares the endpoint literal ${endpoint}`).toBe(true);
    }
  });
});
