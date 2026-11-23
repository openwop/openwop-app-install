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
 * not something that drifts in. That holds for BOTH halves: the host list below
 * and, since TST-OAD-1 (2026-11-18), the feature-declared `fireOnceMutexCallers`
 * (ADR 1031 P2), which are pinned in `REVIEWED_DECLARED_MUTEX_CALLERS`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { IDEMPOTENT_ENDPOINTS } from '../src/host/idempotentResponse.js';
import { collectFeatureRatchetDeclarations } from './helpers/featureRatchetDeclarations.js';

const SRC = join(__dirname, '..', 'src');

/** The mutex lane's API — host-generated keys only. */
// Whitespace (incl. a newline) is allowed between the handle and the method:
// `storage\n  .pruneOnceByPrefix(` is a live shape (connections/refreshDaemon.ts)
// and `deps.storage .claimOnce(` used to dodge a single-line pattern.
const MUTEX_CALLS = /\b(?:storage|deps\.storage)\s*\??\.\s*(claimOnce|putOnce|pruneOnceByPrefix)\s*\(/;

/** Reading the caller-supplied header. */
const READS_HEADER = /req\.header\(\s*['"]idempotency-key['"]\s*\)/i;

/**
 * Files permitted to call the fire-once mutex: the daemons and sweeps whose
 * keys are machine-generated. NO-GROWTH.
 */
const HOST_MUTEX_ALLOWLIST = new Set<string>([
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
  // ADR 0820 §7 (PR #4582) — the weekly paywall-funnel summary daemon. Its one
  // claim is `paywall-weekly-summary:sent:<isoWeek>`, a machine-generated ISO-week
  // key (never caller-supplied), so two instances or a redeploy send at most once a
  // week. Same hourly-poll shape as `features/crm/snapshotDaemon.ts`.
  'features/billing/funnelWeeklySummary.ts',
  // ADR 0906 D5 — the custom-domain sweep. Its one claim shape is
  // `custom-domain-recheck:<hostname>:<slot>` (and, from ADR 0906 P2,
  // `custom-domain-edge:<hostname>:<slot>`): hostname from the domain row and a
  // poll-slot number, both machine-generated, never caller-supplied. It fences N
  // instances to one check per row per slot, the `cms/publishSweep.ts` shape.
  'host/customDomainSweep.ts',
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
  'routes/hostEventTestTrigger.ts',
  'features/crm/leadIntel/routes.ts',
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
  return rel.startsWith('routes/') || /^features\/[^/]+\/(?:[^/]+\/)*routes\.ts$/.test(rel);
}

const FILES = walk(SRC).map((p) => ({
  rel: relative(SRC, p).split(sep).join('/'),
  text: readFileSync(p, 'utf8'),
}));

/** ADR 1031 P2 — the host list plus each feature package's declared
 *  `fireOnceMutexCallers` (paths relative to its own directory, resolved here to
 *  `src/`-relative), so a feature carries its own reviewed entry. Same NO-GROWTH
 *  and no-ghost assertions over the union. */
let MUTEX_ALLOWLIST: ReadonlySet<string> = HOST_MUTEX_ALLOWLIST;
let DECLARED_MUTEX_CALLERS: readonly string[] = [];
beforeAll(async () => {
  const declared = (await collectFeatureRatchetDeclarations())
    // TST-OAD-1 pins the IN-TREE half only. An adopter package (`adopter/features/<x>`)
    // declares through the same ADR 1031 P2 seam, and its `ratchetDeclarations.ts` IS its
    // reviewed list, reviewed in the adopter's own repo. Pinning it here would mean an
    // adopter could pass only by editing this upstream file, which is the exact coupling
    // ADR 1031 P2 removed. Adopter entries still enter MUTEX_ALLOWLIST, so the route ban
    // and the no-ghost (stale) case below hold for them too.
    .flatMap((d) => (d.declarations.fireOnceMutexCallers ?? []).map((f) => `${d.srcRel}/${f}`));
  DECLARED_MUTEX_CALLERS = declared.filter((r) => !isAdopterPath(r)).sort();
  MUTEX_ALLOWLIST = new Set([...HOST_MUTEX_ALLOWLIST, ...declared]);
});

/** ADR 1031 — an adopter package lives under `src/adopter/`, which the bundle builder
 *  refuses to ship, so upstream never authors (or reviews) anything there. */
function isAdopterPath(rel: string): boolean {
  return rel.startsWith('adopter/');
}

/** Owner decision TST-OAD-1 (2026-11-18): the IN-TREE feature-declared half of the
 *  allowlist is pinned here, so it is NO-GROWTH like the host list. A first-party
 *  feature's `fireOnceMutexCallers` entry still lives in its package, but it cannot land
 *  without an edit to this list, i.e. a reviewed change to this tripwire. MEASURED at
 *  0ca7f76944: no first-party feature declares one.
 *
 *  Scope correction (2026-11-22, found by the KickTodo adopter's v0.17.0 sync gate): the
 *  pin was measured in this repo, where no adopter exists, and it also caught adopter
 *  declarations, so `kicktodo-metrics/verifierSampleDaemon.ts` (declared via ADR 1031 P2)
 *  turned every adopter gate red with no adopter-side fix. Adopter declarations are now
 *  excluded from this pin; see `isAdopterPath`.
 *
 *  Sabotage witnesses (each must turn this file red):
 *   - declare `fireOnceMutexCallers: ['x.ts']` in any `src/features/<f>/ratchetDeclarations.ts`
 *     → this pin names `features/<f>/x.ts`;
 *   - add `storage.claimOnce(` to an undeclared in-tree module → "only the allowlisted
 *     daemons call the fire-once mutex" names it;
 *   - an ADOPTER declaration for a file that does not call the mutex → the no-ghost case. */
const REVIEWED_DECLARED_MUTEX_CALLERS: readonly string[] = [];

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
      // No allowlist exemption here: a route can never be allowlisted into the
      // mutex lane (with the exemption this case was the next one restricted to
      // routes and could not fail on its own).
      (f) => isRouteModule(f.rel) && MUTEX_CALLS.test(f.text),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('only the allowlisted daemons call the fire-once mutex', () => {
    const callers = FILES.filter((f) => MUTEX_CALLS.test(f.text)).map((f) => f.rel).sort();
    const unexpected = callers.filter((r) => !MUTEX_ALLOWLIST.has(r));
    expect(unexpected).toEqual([]);
  });

  it('in-tree feature-declared mutex callers are pinned (they cannot grow without an edit here)', () => {
    expect(
      DECLARED_MUTEX_CALLERS,
      'an in-tree feature package declared a new fireOnceMutexCallers entry. Add it to ' +
        'REVIEWED_DECLARED_MUTEX_CALLERS in this file with the reason in review (TST-OAD-1). ' +
        'Adopter (src/adopter/) declarations are not pinned here.',
    ).toEqual(REVIEWED_DECLARED_MUTEX_CALLERS);
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
    // One module may own multiple endpoint namespaces (lead grade + route).
    // Every endpoint still has exactly ONE reviewed owner, and every listed
    // owner must actually read the header and declare a registered endpoint.
    const owners = new Set<string>();
    for (const endpoint of IDEMPOTENT_ENDPOINTS) {
      const declarations = FILES.filter((f) => LEDGER_ROUTES.has(f.rel) && f.text.includes(`'${endpoint}'`));
      expect(declarations.map((f) => f.rel), `one owner for ${endpoint}`).toHaveLength(1);
      owners.add(declarations[0]!.rel);
    }
    expect([...owners].sort()).toEqual([...LEDGER_ROUTES].sort());
    for (const owner of owners) expect(FILES.find((f) => f.rel === owner)?.text).toMatch(READS_HEADER);
  });
});
