# ADR 0451 — KickTodo referrals → the affiliate attribution + commission lane

| | |
|---|---|
| **Status** | implemented (P1 + P2a + P2b + P3 + P4) — 2026-07-21 · COMPLETE |
| **Feature** | EXTENDS `kicktodo-core` invites + `commerce/affiliate`. No new package/toggle. |
| **Source** | KickTodo leverage map #4 — the invite/referral loop is a PARALLEL private system that never touches `affiliateCode`/commission. |
| **RFC verdict** | Host work, no RFC (host-ext; rides the existing commerce checkout `ref` channel + obligation ledger). |
| **Composes** | ADR 0444 (invites), ADR 0177/0447 (affiliate lane on the obligation ledger — the SAME ledger KickTodo author shares already ride), ADR 0449 (the subject→contact bridge whose `link*/resolve*ForSubject` shape this mirrors) |

## Boundaries audit (verified file:line)

- **KickTodo invites are attribution-only and opaque.** `inviteService.ts:17-24` — `InviteRow{tokenHash, tenantId, challengeId, inviterSubject, …}`; the inviter is the opaque `inviterSubject` (ADR 0426). Invites mint via `mintToken('ktinv')` (`inviteService.ts:57`), hash-keyed (`'kicktodo-invites'`, `:27`), one-live-per-(inviter,challenge) index (`:30-33`). They "grant NOTHING but attribution."
- **The referrer subject reaches `enroll()`, NEVER checkout.** `enrollmentService.ts:121-131` `inviteAttribution()` resolves the token and stamps `enrollment.invitedBy` (`types.ts:144-147`) — attribution-only, "never caller-asserted." A **self-invite guard already exists**: `enrollmentService.ts:129` `if (!row || row.inviterSubject === ownerSubject) return {}`.
- **kicktodo-commerce does NOT create Orders — checkout and enroll are DECOUPLED.** The paid flow is two independent steps: (a) checkout a Commerce Product → Order → paid → `reprocessOrder` grants the entitlement keyed by `order.createdBy` (`entitlementService.ts:111-154`, reads no invite field); (b) *later* `enroll()` with the `inviteToken` (`kicktodo-core/routes.ts:230`). **At order create/paid, the referrer subject is not in scope.**
- **The Order's ONLY attribution channel is `affiliateCode` (a string).** `commerceService.ts:533` `Order.affiliateCode?`; stamped verbatim at `createOrderInner` (`:879`); captured at checkout from a `ref` param and validated against a real affiliate via `affiliateCodeExists` (`commerce/routes.ts:482-486,507`). Junk `ref` is silently dropped.
- **Commission already rides the obligation ledger — zero new money machinery.** `affiliate.ts:61-65` `createObligationLedger({ns:'commerce:affiliate-ledger', …})` — the SAME ledger primitive KickTodo author shares use (ADR 0447). `accrueCommission(order)` fires **inline in `markAsPaid`** on the pending→paid CAS (`commerceService.ts:1097`), idempotent by `sourceId=orderId` (`affiliate.ts:145-158`); refund clawback `reverseCommission` is already wired (`commerceService.ts:1245,1331`).
- **Two real gaps this ADR must close.** (1) `Affiliate` rows have **no subject/owner field** (`affiliate.ts:47-55`) — codes are operator-supplied free strings minted only by the admin `POST {BASE}/affiliates` (`routes.ts:585`, `workspace:write`); there is no subject→code mapping. (2) The affiliate accrue path has **NO self-referral guard** anywhere (affiliates have no owner to compare a buyer against) — a buyer can use any code, including one that maps back to themselves.

## Decision

Bridge the opaque KickTodo referrer subject to the existing `affiliateCode` string **at the seam that already carries attribution into an Order — the checkout `ref` param — mint-side, not checkout-side.**

1. **A subject→affiliate-code bridge, mirroring ADR 0449.** New `DurableCollection 'kicktodo-subject-affiliate'` keyed `${tenantId}::${ownerSubject}` → `{tenantId, ownerSubject, affiliateId, code, createdAt}`, `tenantOf = l.tenantId` (KTD-1 purge-safe), idempotent first-write-wins with conflict logging — the exact `linkSubjectToContact`/`resolveContactForSubject` shape (`contactBridgeService.ts:34-84`). `ensureAffiliateForSubject(tenantId, orgId, ownerSubject)` resolves the existing link or mints an affiliate (`createAffiliate`, deterministic code derived from the subject, e.g. `KT-<short-hash>`; on the 409 dup it resolves instead — idempotent) and stores the link.
2. **The invite LINK carries the code as `ref`.** When a KickTodo invite is minted (or when its share URL is built), call `ensureAffiliateForSubject(inviterSubject)` and append `?ref=<code>` to the challenge's checkout/landing URL. A referred participant who buys the paid challenge then flows through the **unchanged** `ref → affiliateCodeExists → Order.affiliateCode → accrueCommission` path — the referrer is credited through the obligation ledger with **no change to commerce checkout or `markAsPaid`.**
3. **Add the missing self-referral guard, at accrual.** Before accruing (or when stamping the code), resolve `affiliateCode → ownerSubject` via the reverse of the bridge and refuse when it equals `order.createdBy` — the affiliate analogue of the enroll-side `inviterSubject === ownerSubject` guard (`enrollmentService.ts:129`). Because the guard must live where the buyer subject is known (checkout/accrual) and the affiliate lane has none today, KickTodo owns it via a small `commerce` extension hook or a pre-stamp check in the KickTodo checkout-link builder (see OQ3).

Advisory, host-never-moves-money, refund-clawback inherited (`reverseCommission` already fires on refund).

## PRD-vs-architecture corrections

- **The Proposed plan said "invite→checkout carries the referrer code → `Order.affiliateCode`" without noting checkout and enroll are decoupled.** Corrected: the referrer subject never reaches checkout, so the bridge must be resolved **at invite-mint / link-build time** and ride the existing `ref` param — not derived from the enrollment's `invitedBy` (which is stamped downstream, after the Order). The `invitedBy` enrollment stamp and the `affiliateCode` order stamp are two independent attribution records; this ADR wires the **order** one.
- **Self-referral guard is NOT free.** The map assumed the `inviteAttribution` self-check covers it; it does not — that guard is enroll-side only, and the affiliate accrual path has none. This ADR adds the affiliate-side guard explicitly.

## Data model

`kicktodo-subject-affiliate` (new): `{ tenantId, ownerSubject, affiliateId, code, createdAt }`, key `${tenantId}::${ownerSubject}`, purge-safe. Reuses the existing `commerce:affiliate` row (no schema change to `Affiliate`). No change to `Order`.

## Phased plan
| Phase | Ships | Gate |
|---|---|---|
| P1 | ✅ **implemented 2026-07-20** — `kicktodo-commerce/subjectAffiliateBridge.ts` (`ensureAffiliateForSubject` lazy-mints one stable affiliate per subject; `resolveSubjectForAffiliateCode` reverse index for the P2 guard). Deterministic code `KT-<12 hex of sha256(tenant::subject)>`; collision-safe via a reverse-index check + bounded suffix loop (two subjects never share a code); first-write-wins on a concurrent mint. Rides `commerce/affiliate.createAffiliate` (rate 0 until an operator sets it, OQ1) — no ledger/schema change. `test/kicktodo-subject-affiliate.test.ts` green. |
| P2a | ✅ **implemented 2026-07-20** — self-referral guard as a commerce **accrual-guard seam** (OQ3 upgrade chosen over KickTodo-local): `registerAffiliateAccrualGuard` in `commerce/affiliate.ts` (core-defines-seam / feature-registers, the `notificationPolicy` pattern; fail-OPEN); `accrueCommission` widened to carry `createdBy` and consult guards before ledger accrual. `kicktodo-commerce/feature.ts` registers `isSelfReferralAccrual` (resolves the code→referrer via the P1 reverse index, blocks when it equals the buyer). Tests: guard-seam veto + composed self-referral verdict green. |
| P2b | ✅ **implemented 2026-07-20** — the full referral loop: backend `GET …/challenges/:id/:version/referral-code` (`productForChallenge` org → `ensureAffiliateForSubject` → code; null for free); the KickTodo invite URL carries `?ref=<code>`; the Detail Buy CTA forwards `?ref=` to `/store/:orgId`; **`StorefrontPage` now forwards a URL `?ref=` into the checkout body** (a generic affiliate-URL improvement) → `Order.affiliateCode` → the UNCHANGED `accrueCommission`. **LEV-3 CLOSED:** the guest `/store` checkout has no subject, so the self-referral guard now ALSO matches by `contactId` — the referrer's linked Contact vs the buyer's order Contact (same email = same person). `accrueCommission`/`AccrualGuardOrder` widened with `contactId`. Tests: referral-code composition + guest-checkout-by-contactId self-referral. FE build + lint green. |
| P3 | ✅ **implemented 2026-07-20** — `referralEarningsForSubject` (bridge read-only `getAffiliateLinkForSubject` → `affiliateByCode` live `balanceOwed` ledger projection) + `GET …/referral-earnings` route + `CreatorInsightsPage` shows the referral commission **only once they've actually referred** (a real code — never a fabricated zero), `formatCurrency`, 4-locale. Advisory; no new money UI. Tests + FE build/lint green. | P2 |
| P4 (node pack) | ✅ **implemented 2026-07-21** — `feature.kicktodo.nodes.referral-code` (pack v1.14.0): resolve-or-mint the referrer's affiliate code for a paid challenge via a new `ctx.features.kicktodo-commerce.referralCode` surface method (idempotent; null for a free challenge), so a workflow can build the `?ref=` invite link. `index.mjs` handler + `nodes` map + `pack.json` manifest (parity-test green); all 7 `requiredPacks` pins repinned 1.13.0→1.14.0 (pin-parity green). Agent-pack: none. |

## Alternatives weighed
- **Stamp `affiliateCode` from the enrollment's `invitedBy` post-hoc** (reconcile after enroll): rejected — the Order is already paid + accrued by then; retroactive accrual would need a second write path and breaks the idempotent-by-orderId invariant.
- **Add a `subject` column to `Affiliate`**: rejected — widens the shared commerce type for a KickTodo need; the sidecar bridge keeps commerce unchanged (ADR 0446 ethic) and is the proven 0449 shape.

## Open questions
- OQ1: referral commission rate — a KickTodo-level policy (like author `shareBps`) or the affiliate row's own rate? **Start with the affiliate row's rate** (`accrueCommission` already computes from it; no new policy).
- OQ2: deterministic code scheme — `KT-<base32(hash(subject))[:8]>` uppercased; on `createAffiliate` 409 (collision or re-mint) resolve-instead. Confirm the collision probability + the resolve-on-409 path in P1.
- OQ3: where the self-referral guard lives — a new `commerce` extension hook (`registerAffiliateAccrualGuard`) so ANY feature benefits, vs a KickTodo-local pre-stamp check. Lean toward the KickTodo-local check in P2 (smaller blast radius) and note the shared-hook upgrade as follow-up.
- OQ4: should `ensureAffiliateForSubject` fire lazily at first invite-mint (chosen) or eagerly for every participant? Lazy — no affiliate row for someone who never refers.
