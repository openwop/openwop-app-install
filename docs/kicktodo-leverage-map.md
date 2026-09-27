# KickTodo → platform leverage map (2026-07-20)

An exhaustive re-analysis of how KickTodo (9 packages, 39 DurableCollections) should
lean on the existing openwop-app engines rather than reinvent them. Built from six
code-verified inventories (KickTodo surface, CMS/entities kernel, CRM/Commerce/Marketing,
subscriptions/billing, notifications/scheduling/sharing, frontend UX).

## Already leveraged (credit — do NOT redo)

| Concern | Engine already used | Evidence |
|---|---|---|
| Paid access fulfilment | Commerce paid/refund observers (ADR 0420) | `kicktodo-commerce/feature.ts:27-37` |
| Author payouts | host obligation ledger (ADR 0447) | `shareLedgerService.ts` |
| KickBot Plus tier limit | billing central `resolveEntitlements` | `tierGuard.ts:19-24` (`limits['kicktodo.maxActiveEnrollments']`) |
| Reminder cadence | host scheduler `registerJob` | `enrollmentService.ts:341-368` |
| Reminder delivery | `getNotificationEmitter()` | `calendarWriteService.ts:120` |
| Participant→Contact (paid path) | CRM Contact + the ADR 0449 bridge | `contactBridgeService.ts` (this session) |
| AI coach | the ONE chat (`/?agent=host:kickbot`) | `GuidePage.tsx:16` — never forks |
| Design system / nav | `ui/` tokens, `FrontendFeature` registry | 0 inline styles; `registry.ts:89-117` |

## Opportunities — ranked (each now has an ADR; audit corrections noted)

| # | Work | ADR | Effort | Status / correction |
|---|---|---|---|---|
| 1 | Renewing cohorts/tiers → `Product.subscription` | 0450 | — | **BLOCKED (OQ1):** subscription cycle Orders are created `pending` and never `markAsPaid` (`subscriptions.ts:94,137`) → the KickTodo paid observer never re-grants on renewal. A commerce-fulfilment question; resolve before scoping. |
| 2 | Today + **Progress** home-dashboard tiles | 0452 | S | **DONE, merged #2281.** Correction: shipped `kicktodo-progress` not "streak" — `ProgressView` has no streak field (honesty). |
| 3 | Shared **`host/ics.ts`** ICS builder | 0454 | S–M | **Correction:** the feed *token* layer already uses `host/capabilityToken` (NOT a reimpl — map was wrong); and the feed is a recurring subscription, semantically unlike sharing's snapshot links, so it does NOT fold into the `RESOLVERS` map. Real dup = the ICS *text* builder (`kicktodo renderFeed` vs `crm/ics.ts`). |
| 4 | Invites → affiliate attribution + commission | 0451 | M | **Refined.** Correction: checkout & enroll are DECOUPLED — the referrer subject never reaches checkout, so mint the affiliate code at invite-time and ride the existing `?ref=` channel; affiliate lane has NO self-referral guard (must add). |
| 5 | Creator profiles → CMS/entities kernel + l10n | 0453 | M | Public projection → `kicktodo.creator_profile` façade (`makeKernelAdapter`); approval/handle-uniqueness stay in kicktodo-community. Challenges STAY off-kernel (ADR 0430). |
| 6 | Paid challenge sold via storefront/funnel | 0455 | M | **Correction:** the storefront path already EXISTS (linked Product sells via `/public-store`); the gap is surfacing the price/Buy-CTA on Detail + a post-purchase enroll bridge — NOT a new storefront. |
| 7 | Lifecycle events → CDP → segments/journeys/email | 0456 | L | Consent-gated `collectEvent('kicktodo.participant.*')` keyed to the ADR 0449 Contact; CRM/CDP own identity+segments+send. Depends on 0449 live. |
| 8 | Quiet-hours respect + PageHeader adoption | 0457 | S | **Correction:** GuidePage chat deep-link is CORRECT (ADR 0073 landing pattern) — embed DROPPED. Real gaps: reminders skip `isNotificationMuted`; `PageHeader` used 0×. |

## Sequencing
- #2 (0452) DONE. #3 (0454), #8 (0457) are unblocked quick wins.
- #4 (0451), #7 (0456) build on the ADR 0449 CRM bridge (shipped). #5 (0453) rides the content kernel.
- #6 (0455) is mostly frontend surfacing over the existing storefront.
- #1 (0450) needs the subscription-fulfilment OQ resolved first (a commerce question, not a KickTodo one).

ADRs authored from this map (all `Proposed` unless noted): 0450 (subscriptions, OQ-blocked),
0451 (referral→affiliate, refined), 0452 (dashboard tiles, **DONE #2281**), 0453 (creator profiles →
kernel), 0454 (shared ICS builder), 0455 (paid-challenge storefront), 0456 (lifecycle → CDP marketing),
0457 (notification + UX polish). See `docs/adr/`.
