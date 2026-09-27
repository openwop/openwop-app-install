# ADR 0569 — Analytics visitor identity: cookieless daily-rotating hash, or nothing

Status: implemented (2026-08-15 — visitorIdentity.ts + uniques aggregates + disclosure UI + opt-out toggle; see the correction note on §2 sessions)
Date: 2026-08-14
Feature: analytics (extends the public beacon, ADR-lineage) — privacy decision
Origin: UX_UPGRADE-analytics R2 deferral — AN-R2-3/4 (unique visitors /
sessions, converged across all 6 comparators) "gate on a beacon-identity
privacy ADR". This is that ADR.

## Context

The public beacon (`POST …/public-analytics/:orgId/collect`, unauthed by
design) ingests events with no visitor identity, so the page can count
EVENTS but not VISITORS — the single largest metric gap on the R2 matrix.
Every comparator ships uniques; the privacy-first leaders (Plausible,
Fathom) do it WITHOUT cookies, consent banners, or durable identifiers.

## The decision space (why this needs an ADR, not a field)

A visitor id is personal-data machinery. The three shapes:

1. **Cookie / localStorage id** — durable cross-day identity ⇒ consent
   banners (GDPR/ePrivacy), a compliance burden pushed onto every
   white-label operator's public pages. REJECTED.
2. **Raw IP+UA fingerprint stored per event** — server-side PII retention on
   an anonymous surface. REJECTED.
3. **Daily-rotating salted hash (the Plausible/Fathom shape)** —
   `hash(dailySalt, orgId, ip, userAgent)` computed AT INGEST, the raw
   IP/UA never persisted, the salt discarded on rotation so yesterday's
   hashes are unlinkable to today's. Uniques are per-day honest, cross-day
   impossible BY CONSTRUCTION. This is the proposed shape.

## Decision (proposed)

1. **Ingest**: the collect route computes `visitorHash` (SHA-256 over a
   per-day, per-host random salt + orgId + client IP + UA) and stores ONLY
   the hash on the event row. The salt lives in memory/KV with a 24h life
   and is never logged; a host restart mid-day mints a new salt (uniques
   split — an accepted, disclosed inaccuracy, not a defect).
2. **Metrics**: `uniqueVisitors` per window = distinct hashes per day,
   summed across days (the Plausible definition — a 7-day unique count is
   the SUM of daily uniques, and the UI says so); `sessions` = hash runs
   with a 30-minute idle gap, computed per day at read time.
3. **Disclosure**: the page labels uniques "daily uniques (cookieless)" with
   a help text naming the rotation; FEATURES/README name the mechanism for
   operators (their privacy pages can cite it).
4. **Erasure**: hashes are not linkable to a person by the host (no raw
   IP/UA retained, salt discarded) — recorded in the erasure audit as
   anonymous-by-construction, with the caveat that WITHIN a day the
   operator holding both the salt and traffic logs could theoretically
   correlate; the salt is therefore never surfaced via any route or log.
5. **No behavior change without the toggle work**: fields are additive on
   the event row; older events simply lack `visitorHash` and uniques begin
   at deployment (the UI names the start date rather than implying history).

## Alternatives weighed

- Durable first-party cookie — rejected (consent burden on operators).
- Server session inference from IP alone — rejected (NAT collapses offices;
  UA in the hash is the standard mitigation).
- Do nothing — keeps the largest converged metric gap; rejected as the
  default but this ADR's explicit fallback if the privacy posture is
  declined: uniques simply do not ship.

## Decisions (2026-08-15 design pass — open questions resolved; decision-ready)

1. **Adopt the daily-rotating-hash posture.** It is the established cookieless
   industry model (the Plausible/Fathom lineage this ADR's design mirrors):
   no cookie, no cross-day identity, uniques within a UTC day only. The
   privacy-maximal "no uniques" stance stays RECORDED as the fallback if the
   operator's counsel objects — flipping to it is deleting one hash call, so
   the decision is cheaply reversible in that direction (and only that
   direction: retro-adding uniques cannot recover history, which is a feature
   of the design, not a bug).
2. **KV-shared salt, 24h TTL, never-logged** — accuracy across instances wins;
   the salt's brief KV existence is bounded by (a) the TTL, (b) a tripwire
   test asserting the salt key is excluded from every log/export/backup-list
   surface (the never-logged discipline gets a test, not a comment), and
   (c) the salt derives nothing after rotation (yesterday's hashes are
   permanently unlinkable — the whole point).

   > **CORRECTION (2026-08-18, `ANL-1`) — (a) DID NOT EXIST, and (c) failed
   > with it.** The shipped implementation had **no TTL**: no `expiresAt`, no
   > `registerKvAgeOut`, no retention purger, and `analytics:visitor-salt` is
   > host-global (no `tenantOf`), so no tenant teardown reached it either. The
   > only reclaim was `salts.delete(utcDay(now − 1d))` fired on the **next
   > mint** — which deletes exactly one day. **One traffic-free day orphaned
   > that day's salt permanently**, because the next mint targets a different
   > day; the module header's compensating claim ("a missed delete is retried
   > on the next mint day boundary") was false. A retained salt makes
   > `sha256(salt|orgId|ip|ua)` enumerable over the small IP×UA space, so (c)'s
   > "permanently unlinkable" was untrue for exactly the days the reclaim
   > skipped. The bound is now real and has two independent layers:
   > **layer 1** — the mint-time sweep deletes EVERY past day's row, not just
   > yesterday's; **layer 2** — `registerKvAgeOut({ id:'analytics:visitor-salt',
   > ttlDays: 1, timestampField:'mintedAt' })`, the ADR 0380 §3 default-ON lane
   > swept from the retention daemon tick, which runs **without a mint** and is
   > what makes the bound hold on a site that never receives another hit.
   > Worst case is now ≤ 48h from mint (24h of liveness + one tick interval),
   > versus unbounded. The gap case is pinned by a **traffic-gap** test that
   > steps three days rather than one — the pre-existing rotation test stepped
   > only CONSECUTIVE days and so was structurally unable to see this.
   >
   > **CORRECTION TO THE CORRECTION (2026-08-18, review R2).** The "≤ 48h from
   > mint … versus unbounded" claim above was, as first shipped, **false for the
   > exact population that motivated it**. `mintedAt` is stamped only by
   > `ensureDailySalt` on a NEW mint, and no migration backfills it; layer 2
   > SKIPS a row whose timestamp is not finite ("never delete on a guess"). So
   > every PRE-EXISTING `{day, salt}` row — the orphaned-by-a-traffic-gap rows —
   > was invisible to layer 2 forever and reachable only by layer 1, which needs
   > a mint. Closed by a `deriveTimestamp` hook on the ADR 0380 §3 registration:
   > the row id IS the salt's UTC mint day, so the lane derives
   > `<day>T00:00:00.000Z`, the EARLIEST instant consistent with the row — a row
   > can therefore only age out later than the truth, never sooner, and today's
   > row is never taken while today is in progress. Pinned by a test that seeds
   > the legacy shape directly (a mint cannot produce it) and asserts both
   > polarities.
   >
   > **And the bound is CONDITIONAL, which the sentence above hid.** Layer 2
   > runs only if the retention daemon starts, and that start is gated:
   > `OPENWOP_RETENTION_SWEEP_ENABLED === 'true' || defaultRetentionDays() > 0
   > || idempotencyTtlDays() > 0` (`index.ts`). It is on for a default
   > deployment because the ADR 0380 idempotency TTL defaults on — but an
   > operator running `OPENWOP_IDEMPOTENCY_TTL_DAYS=0` with no retention window
   > and no sweep flag has **no layer 2 at all**, and falls back to
   > layer-1-on-next-mint, i.e. unbounded again on a site with no traffic.
   > Operators who disable those knobs must set
   > `OPENWOP_RETENTION_SWEEP_ENABLED=true` to keep the TTL this ADR claims.
3. **Per-operator opt-out toggle: yes.** Default ON with the cookieless
   disclosure copy in the white-label privacy surface; OFF ⇒ the beacon sends
   no visitor dimension at all (counts only), and the disclosure copy adapts.

Residual open point: none blocking — implement on approval.

## RFC verdict

Host work only (beacon + aggregates are host-extension). No OpenWOP wire.

## Correction note (2026-08-15, implementation)

§2's "`sessions` = hash runs with a 30-minute idle gap" was NOT implemented:
the summary already ships a `sessions` metric counting distinct `sessionKey`s
(the consent subject key the beacon has always carried). A second, hash-run
definition of the same word would put two disagreeing "sessions" figures on
one page. The visitor dimension therefore adds `uniqueVisitors` (+`since`)
and per-day trend `uniques` ONLY; the existing sessions metric is untouched.
Revisit hash-run sessions only if sessionKey coverage proves poor in practice.

## Accepted residual: third-party over-erasure on the DSAR path (2026-08-18, ANL-2 R2)

The ADR 0381 subject-erasure fan-out reaches analytics rows in two hops: DIRECT
(`sessionKey` or `visitorHash` equals the subject key) and TRANSITIVE (every row
carrying a `visitorHash` seen on a direct row). The transitive hop is what makes
a sessionless-but-hashed row reachable at all — without it, an erasure leaves
advertising identifiers (`clickIds`, `owx`) behind.

It also over-reaches, and that is a DECISION rather than a defect, recorded here
because until now it lived only in a source comment. `visitorHash =
sha256(salt|orgId|ip|ua)`, so distinct people behind one NAT on the same browser
build share a hash for a day: erasing one subject deletes those neighbours'
anonymous beacon rows too.

- **Why accept it.** On an anonymous, counts-only row, over-erasure costs a
  count in a report. Under-erasure leaves cross-site advertising identifiers
  attached to a person who asked to be forgotten. The asymmetry is not close.
- **The real bound — stated correctly.** The source comment used to say the
  over-reach is bounded to "one org and one UTC day". The DAY half was wrong.
  The eraser collects a hash from EVERY direct row, and a subject's direct rows
  span every day they were active, each contributing a different hash (the salt
  rotates daily), each of which the transitive hop then expands across that
  day's co-located visitors. **The bound is one org × every UTC day the subject
  was active.** The ORG half holds — `orgId` is inside the hash, so a hash
  cannot collide across orgs.
- **What is NOT reached.** A row with neither a `sessionKey` nor a
  `visitorHash` is linked to no subject identifier and is retained, not erased
  (the `crm:suppression` precedent of saying so rather than implying coverage
  by silence). The retention purger and tenant teardown reclaim it.

## Phased implementation record

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 1 | salt lifecycle + ingest hash + tests (incl. never-logged sabotage) | done | `visitorIdentity.ts`; `analytics-visitor-identity.test.ts` (8 tests, 6 backend sabotage probes each fired) |
| 2 | uniques aggregates + disclosed UI | done | `countDailyUniques` (pure mechanism) + summary/trend/comparison fields; `AnalyticsPage` tile + disclosure; `visitorUniques.test.tsx` |
| 3 | operator opt-out toggle + docs | done | `analytics-visitor-identity` toggle (default ON, tenant-bucketed) in `feature.ts`; OFF ⇒ counts-only pinned both sides |
