/**
 * Cookieless visitor identity (ADR 0569) — the Plausible/Fathom shape.
 *
 * `visitorHash = sha256(dailySalt | orgId | clientIp | userAgent)` computed AT
 * INGEST; the raw IP/UA are never persisted, and the salt is reclaimed after a
 * bounded TTL, so yesterday's hashes stop being re-derivable once that TTL
 * lapses. No cookie, no localStorage, no consent-banner burden on operators'
 * public pages — uniques are per-UTC-day honest and cross-day impossible.
 *
 * Salt lifecycle (ADR 0569 decision 2): ONE salt per UTC day, shared across
 * instances through the durable KV (accuracy across Cloud Run instances wins
 * over a per-process salt), minted on first use, and reclaimed by TWO
 * independent layers — see `SALT_TTL_DAYS` below.
 *
 * The salt is NEVER logged, NEVER on a route response, and lives in a
 * host-global collection (no `tenantOf` → outside every tenant teardown /
 * export walk). The never-logged discipline is TEST-enforced (the tripwire in
 * analytics-visitor-identity.test.ts), not a comment.
 *
 * ANL-1 (CODEBASE-ASSESSMENT, 2026-08-18) — WHY THE TWO LAYERS EXIST. This
 * module used to reclaim ONLY by `salts.delete(utcDay(now − 1d))` fired on the
 * NEXT MINT, and its header claimed "a missed delete is retried on the next
 * mint day boundary". Both halves were false: the next mint targets a
 * DIFFERENT day, so ONE traffic-free day (an idle site, a quiet weekend, a
 * low-volume org) orphaned that day's salt PERMANENTLY — in a collection with
 * no `tenantOf`, no retention purger and no age-out, so nothing else reached
 * it either. A retained salt makes `sha256(salt|orgId|ip|ua)` enumerable over
 * the small IP×UA space, which re-identifies every `visitorHash` from that
 * day — the exact residual ADR 0569 decision 2 said "(a) the TTL" bounded,
 * while no TTL existed. Fixed at both layers:
 *   1. MINT-TIME: sweep EVERY row older than the TTL, not just yesterday's, so
 *      a gap is closed by the first mint after it rather than skipped forever.
 *   2. TICK-TIME: `registerKvAgeOut` (ADR 0380 §3, default-ON, swept from the
 *      ADR 0371 retention daemon tick) reclaims WITHOUT a mint — the layer that
 *      makes the bound hold on a site that never gets another beacon hit.
 * Layer 2 alone would be enough for the bound; layer 1 alone is what the old
 * code approximated. Both ship because they fail independently (a daemon that
 * is not ticking, an instance that never mints).
 *
 * TWO CORRECTIONS to the first cut of that fix (ANL-1 R2, review), because each
 * one silently un-did the bound for a real population:
 *   a. `mintedAt` is written ONLY by a NEW mint and no migration backfills it,
 *      while layer 2 SKIPS a row whose timestamp is not finite ("never delete on
 *      a guess"). So every PRE-EXISTING `{day, salt}` row — the orphaned-by-a-
 *      traffic-gap population this fix was for — stayed invisible to layer 2 and
 *      reachable only by layer 1, which needs a mint. The registration below now
 *      supplies `deriveTimestamp`, deriving the instant from the row's own UTC
 *      day; the bound holds for legacy rows without a migration.
 *   b. Layer 2 runs ONLY if the retention daemon is started, and that start is
 *      conditional (`index.ts`: `OPENWOP_RETENTION_SWEEP_ENABLED === 'true' ||
 *      defaultRetentionDays() > 0 || idempotencyTtlDays() > 0`). It is on by
 *      default because the idempotency TTL defaults on — but an operator running
 *      `OPENWOP_IDEMPOTENCY_TTL_DAYS=0` with no retention window and no sweep
 *      flag has NO layer 2 at all, and falls back to layer-1-on-next-mint. State
 *      it rather than let the header imply an unconditional bound.
 *
 * Per-operator opt-out (decision 3): the `analytics-visitor-identity` toggle
 * (default ON, tenant-bucketed). OFF ⇒ no visitor dimension at all — the
 * beacon stores counts only and the reporting UI adapts.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { resolveOne } from '../../host/featureToggles/service.js';

interface DailySalt {
  /** UTC day, `YYYY-MM-DD` — the row id. */
  day: string;
  /** 32 random bytes, hex. Never logged, never on a response. */
  salt: string;
  /** ISO-8601 mint instant. Exists SOLELY so the `registerKvAgeOut` sweep has
   *  the timestamp field that lane requires — it never deletes on a guess, so a
   *  row without a parseable timestamp is SKIPPED (i.e. retained forever). Do
   *  not remove it without removing the registration.
   *  OPTIONAL on the TYPE because rows written before ANL-1 do not have it; the
   *  registration's `deriveTimestamp` is what reaches those (typing it required
   *  would have made the legacy row unrepresentable and hidden the gap). */
  mintedAt?: string;
}

// Host-global (NO tenantOf): the salt belongs to no tenant, so it must never
// ride a tenant index, teardown walk, or per-tenant export. Index-free is also
// what the kvAgeOut lane prefers (no `hostextidx:` marker to strand).
const salts = new DurableCollection<DailySalt>('analytics:visitor-salt', (s) => s.day);

/**
 * ADR 0569 decision 2's "(a) the TTL" — before ANL-1 that phrase named nothing.
 * ONE day: a salt is dead the instant its UTC day ends, so the age-out lane may
 * reclaim any row minted more than 24h ago. It can never take TODAY's row —
 * today's salt was, by construction, minted at some point during today, so its
 * age is < 24h for the whole day it is live.
 *
 * WORST CASE, stated rather than rounded down: layer 1 (below) deletes every
 * expired row on the first mint of a new day, so the usual bound is "gone
 * within one beacon hit of midnight UTC". With NO traffic at all, layer 2's
 * hourly tick reclaims it ≤ 24h after the day ends — so ≤ 48h from mint.
 */
export const SALT_TTL_DAYS = 1;

const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

/** Reclaim EVERY salt row from a PAST day, not just yesterday's. Runs at mint
 *  time as layer 1; the kvAgeOut registration below is layer 2 and runs without
 *  a mint. Best-effort — neither layer may fail a beacon write. Returns the
 *  number of rows removed (test-observable; never logged — the salt's own
 *  never-logged discipline extends to anything derived from it). */
async function sweepExpiredSalts(nowMs: number): Promise<number> {
  const today = utcDay(nowMs);
  let removed = 0;
  try {
    for (const row of await salts.list()) {
      // Lexicographic compare is a correct date compare on `YYYY-MM-DD`.
      if (row.day < today && (await salts.delete(row.day))) removed += 1;
    }
  } catch { /* best-effort */ }
  return removed;
}

/** Get-or-mint today's salt; on a mint, reclaim every salt past the TTL (the
 *  rotation discard that makes cross-day linking impossible). On a concurrent
 *  first mint, re-read after write so all instances converge on one salt. */
export async function ensureDailySalt(nowMs = Date.now()): Promise<string> {
  const day = utcDay(nowMs);
  const existing = await salts.get(day);
  if (existing) return existing.salt;
  await salts.put({ day, salt: randomBytes(32).toString('hex'), mintedAt: new Date(nowMs).toISOString() });
  // Converge on a mint race: the LAST write wins in KV, so re-read rather than
  // trusting our own candidate (a split day's uniques would double-count).
  const settled = await salts.get(day);
  // ANL-1 layer 1 — sweep EVERY expired row. The old `delete(utcDay(now − 1d))`
  // deleted exactly one day, so a traffic gap orphaned everything it skipped.
  await sweepExpiredSalts(nowMs);
  return (settled ?? { salt: '' }).salt || (await ensureDailySalt(nowMs));
}

// ANL-1 layer 2 — the sanctioned ADR 0380 §3 age-out lane: default-ON, swept
// from the retention daemon tick, and (unlike layer 1) it runs with NO beacon
// traffic at all. This is the layer that makes the TTL a real bound instead of
// a hope that someone visits the site again. Index-free collection, so no
// `hostextidx:` marker can strand (the WF-ORGINV-1 constraint).
registerKvAgeOut({
  id: 'analytics:visitor-salt',
  prefix: 'hostext:analytics:visitor-salt:',
  ttlDays: SALT_TTL_DAYS,
  timestampField: 'mintedAt',
  // Review F7 — the salt belongs to NO tenant by construction (see the
  // index-free `salts` collection above: "the salt belongs to no tenant, so it
  // must never ride a tenant index"). Row shape is `{day, salt, mintedAt}` with
  // no `tenantId`, and the row id is a UTC DATE, which carries no `:` — so
  // without this flag every salt row counted as `heldUnresolved` and the
  // `kv_age_out_hold_unresolvable` warn fired on EVERY tick for as long as any
  // tenant anywhere was held. A tripwire guaranteed to fire while its watched
  // condition is active teaches the operator to ignore it.
  hostGlobal: true,
  // ANL-1 R2 — `mintedAt` is stamped only by `ensureDailySalt` on a NEW mint, and
  // no migration backfills it. Without this the LEGACY `{day, salt}` rows — which
  // are exactly the orphaned-by-a-traffic-gap population ANL-1 was about — are
  // skipped by layer 2 on every tick forever, and layer 1 needs a mint to reach
  // them. So the fix would have been inert for the very rows that motivated it.
  //
  // The derivation is exact, not a guess: the row ID IS the salt's UTC mint day,
  // and midnight of that day is the EARLIEST instant the row can have been
  // written — so the row can only age out later than the truth, never sooner.
  // Today's row is still safe: `<today>T00:00:00Z` is never older than
  // `now − 1 day` while today is in progress.
  deriveTimestamp: (row, id) => {
    const day = typeof row.day === 'string' ? row.day : id;
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00.000Z` : undefined;
  },
});

/** Test-only: run the mint-time expiry sweep without minting (layer 1 in
 *  isolation). Not a route, not exported through any surface. */
export async function __sweepExpiredSaltsForTest(nowMs = Date.now()): Promise<number> {
  return sweepExpiredSalts(nowMs);
}

/** The rate-limiter's client-IP convention (middleware/rateLimit.ts) — first
 *  X-Forwarded-For hop behind Cloud Run's trusted L7 proxy, else the socket. */
function clientIp(req: Request): string {
  const xff = req.header('x-forwarded-for');
  if (xff) return (xff.split(',')[0] ?? xff).trim();
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * The visitor hash for one beacon hit, or undefined when the tenant opted out
 * (`analytics-visitor-identity` OFF). The raw IP/UA never leave this function.
 */
export async function visitorHashFor(tenantId: string, orgId: string, req: Request, nowMs = Date.now()): Promise<string | undefined> {
  const toggle = await resolveOne('analytics-visitor-identity', { tenantId });
  if (!toggle?.enabled) return undefined;
  const salt = await ensureDailySalt(nowMs);
  const ua = req.header('user-agent') ?? '';
  return createHash('sha256').update(`${salt}|${orgId}|${clientIp(req)}|${ua}`).digest('hex');
}

/** Test-only: read a day's salt (never exposed on any route). */
export async function __peekSaltForTest(nowMs = Date.now()): Promise<string | null> {
  const row = await salts.get(utcDay(nowMs));
  return row?.salt ?? null;
}

/** Test-only: clear the salt store. */
export async function __resetVisitorSalts(): Promise<void> { await salts.__clear(); }
