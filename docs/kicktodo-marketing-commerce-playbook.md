# KickTodo marketing + commerce operator playbook

> Operator recipes that compose the shipped KickTodo→platform seams (ADRs
> 0451/0455/0456). These are **configuration recipes**, not code — the engines
> (funnels, commerce, CDP, CRM segments/journeys) already exist; KickTodo now
> feeds them. This is the deliverable for **ADR 0455 P3** (sell a paid challenge
> via a funnel) and **ADR 0456 P3** (re-engage stalled participants), which the
> ADRs scoped as "an operator playbook + template, no new engine code."

---

## 1. Sell a paid challenge (ADR 0455 P3)

A paid challenge is already a Commerce **Product** linked to the published
challenge version (`linkChallengeProduct`). Two ways to sell it:

### 1a. Direct — the Detail page (shipped, ADR 0455 P2)
Nothing to configure. Once a challenge version is linked to an active Product,
its **Discover → Detail** page surfaces the price + a **Buy** CTA
(`/store/:orgId`); after checkout the participant returns and uses "Already
purchased? Start" to enroll (the backend entitlement guard admits them).

### 1b. Via a funnel (operator-built)
To run a campaign landing → sales → checkout for a challenge:
1. **Create the Product** for the challenge version (Commerce) and
   `linkChallengeProduct` it (KickTodo Studio / the entitlements route).
2. **Build a funnel** (Funnels feature): steps `landing → sales → checkout →
   thankyou`. Each step renders a CMS page (funnels bind a `pageId`, not a
   `productId`).
3. On the **checkout** step's CMS page, embed the storefront checkout for the
   challenge's Product (the same `/public-store/:orgId/checkout` the Detail Buy
   CTA uses). The order carries the funnel provenance (`funnelRef`) automatically.
4. On **payment**, `reprocessOrder` grants the `ChallengeEntitlement`
   (unchanged); the buyer's `thankyou` page can deep-link `/kicktodo/discover/<id>`
   to enroll.

**Referral attribution (ADR 0451):** any storefront checkout carries a `?ref=`
from the URL into `Order.affiliateCode` (`StorefrontPage`). A KickTodo inviter's
share link already appends `?ref=<their-code>` (ADR 0451 P2b), so a referred
purchase through the funnel or the Detail Buy CTA accrues them commission — no
extra funnel config. Self-referrals are refused (the accrual guard).

---

## 2. Re-engage stalled participants (ADR 0456 P3)

KickTodo now emits **consent-gated** lifecycle events into the CDP collect seam
(ADR 0456), keyed to the participant's CRM Contact (ADR 0449). Events:
`kicktodo.participant.enrolled` / `.completed` / `.stalled`,
`kicktodo.challenge.purchased`. **No engine code** — build the campaign in CRM/CDP:

### The "re-engage stalled" recipe
1. **Confirm consent flows.** Events fire ONLY for participants with a linked
   Contact (paid checkout / reminder consent / leaderboard opt-in). No Contact ⇒
   no marketing signal (the privacy floor — by design).
2. **Create a CRM segment** — "Stalled in an active challenge": members are
   Contacts that emitted `kicktodo.participant.stalled` and have **not** since
   emitted `.completed`. (Segment membership is computed by the CRM segments
   engine over the collected events.)
3. **Attach a journey / email.** The `segmentEntryDaemon` emits
   `crm.segment.entered{segmentId, contactId}` for each newly-entered Contact;
   bind a journey (email/notification) to it — e.g. "Pick your challenge back up"
   deep-linking `/kicktodo/today`.
4. **Other segments** the same events unlock: `.completed` → an upsell/next-
   challenge journey; `.purchased` → an onboarding sequence; `.enrolled` → a
   day-1 encouragement.

### Guardrails (already enforced)
- **PII boundary:** events carry only the opaque `contactId` + challenge ids;
  the opaque participant subject and any email/name NEVER enter the payload.
- **Purpose:** confirm the consent that produced the Contact covers a *marketing*
  purpose before using these events for outbound email (ADR 0268 governance).
- **Dedup:** each transition is deduped once per (subject, challenge, version) —
  `stalled` in particular is a single off-track signal, not a repeating one.

---

## Deferred / follow-on (not blocking)
- **Stripe-success → auto-enroll landing** (ADR 0455): a nicety over the shipped
  "Already purchased? Start" path; needs the storefront checkout success URL to
  be KickTodo-aware (cross-feature coupling).
- **Node packs** (ADR 0451 P4 / 0456 P4): `ctx.kicktodo` workflow nodes for the
  referral code + lifecycle reads — a pack-pipeline task (manifest + Ed25519
  re-sign + `requiredPacks` repin).
- **Renewing cohorts** (ADR 0450): BLOCKED — subscription cycle Orders are created
  `pending` and never `markAsPaid`, so the entitlement observer can't re-grant on
  renewal. A commerce-fulfilment question to resolve first.
