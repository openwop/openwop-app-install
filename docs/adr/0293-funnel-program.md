# ADR 0293 — The Funnel Program (finishing the MyndHyve full-funnel migration)

**Status:** implemented (2026-07-06 — all four lanes shipped in one day: 0294 all 6 phases (PRs #1413/#1415/#1418/#1419/#1420/#1421), 0296 P1–P4 (#1422), 0295 P0–P3 host-side (#1423), 0297 D1–D3 + the OUT rulings (#1424). Definition-of-done: FM-1..FM-5 closed and demonstrated end-to-end — public funnel → routed steps → checkout w/ bumps → one-click upsell → per-step analytics + experiments; FM-6..FM-10 each shipped or recorded as a non-goal with a revisit trigger; FM-DOC-1 fixed in the first program PR. Operator-gated residue, by design: enabling one-click money movement (SCA review + env), the GCLB cert-map infra tier, and the conversions delivery transport.)
**Date:** 2026-07-06
**Research basis:** [`docs/research/funnel-migration-gap-analysis.md`](../research/funnel-migration-gap-analysis.md)
**Sub-ADRs:** 0294 (A — funnel entity/builder/analytics/experiments), 0295 (B — custom-domain
hosting), 0296 (C — order bumps + one-click upsell chains), 0297 (D — adjacent-surfaces ruling)
**Relates to:** ADR 0009/0012/0027/0236 (CMS/publishing/experiments), 0177/0224/0225/0228
(commerce), 0273–0279 (merchandising), 0262–0270 (CDP), 0222/0267 (journeys), 0155–0167 (campaign
studio), 0176 (subscriptions-billing / Stripe continuity)

## Context

MyndHyve — which is migrating onto openwop-app as its runtime — earns revenue through a
GoHighLevel-style full-funnel product: published landing pages composed into multi-step
funnels (opt-in → sales → checkout → upsell/downsell → thank-you) with conditional
routing, embedded checkout, order bumps, one-click post-purchase upsells, per-step
conversion analytics, funnel-level A/B optimization, and custom-domain hosting.

The 2026-06/07 native build-out (campaign studio, email, commerce, merchandising, CDP,
CMS + page experiments, forms) migrated **every supporting surface** — but the **funnel
spine itself never crossed**: openwop-app has no funnel entity, no step routing, no
per-step conversion analytics, no one-click upsell chain, and custom domains are an
explicit ADR 0012 deferral. No tracker owned this residue until the gap analysis above
(`MIGRATION-TODO.md` is the repo-extraction tracker only).

## Decision

Run a four-lane program, one sub-ADR per lane, sequenced by dependency and revenue
leverage:

| Lane | ADR | Closes | Shape |
|---|---|---|---|
| **A — Funnel entity, builder, analytics, experiments** | 0294 | FM-1, FM-2, FM-5 | New `funnels` feature package composing CMS pages (0009), publishing (0012), CDP events (0269), journey runtime (0267), `variantAssignment.ts` (0236) |
| **C — Order bumps + one-click upsell chains** | 0296 | FM-3 | Extends `commerce` + `promotions` + `recommendations` in place; Stripe saved-PM off-session |
| **B — Custom domains + SSL** | 0295 | FM-4 | Infra + host-extension surface; closes the ADR 0012 deferral |
| **D — Adjacent-surfaces ruling** | 0297 | FM-6..FM-10 | Explicit in/out decision per surface (pixels/CAPI, affiliates, webinars, membership, booking, lead scoring, email-provider breadth) |

Program-wide rules (binding on every sub-ADR):

1. **No parallel architecture.** Funnels are compositions of existing primitives —
   pages ARE CMS pages, steps route via the journey/chain runtime, experiments use the
   shared variant assigner, events ride the CDP spine, money rides commerce. A sub-ADR
   that needs a new primitive must name the seam it extends (`ARCHITECTURE.md` seam
   table) — never a second copy.
2. **Feature-package + toggle discipline** (ADR 0001): each lane lands as/extends a
   package wired only through the registries, toggle-gated OFF (`tenant` bucketing),
   with FEATURES.md rows in the same PR.
3. **No wire changes expected.** Everything is host-extension
   (`/v1/host/openwop-app/*`) or public host routes. If any lane discovers a genuine
   wire need (e.g. a new capability advert), that half stops for an RFC in
   `../openwop` first.
4. **Public-surface security floor:** every new public route follows the
   publishing/forms precedent — published-only reads, no existence leak, consent-gated
   analytics, rate-limit review (`middleware/rateLimit.ts`), and the LEAK-11 money
   rules for anything touching payment.
5. **Honest catalog:** FM-DOC-1 (stale FEATURES/ROADMAP rows for merch + CDP) is fixed
   in the first program PR so the catalog stops under-reporting migration state.

## Sequencing

1. **0294 Phase 1–2** (entity + routing + public serving) — the spine; nothing else
   can ship user-visible value without it.
2. **0296** (bumps + chains) — highest revenue leverage; composes already-shipped
   merch primitives; can start once 0294's checkout-step shape is fixed (its Stripe
   work is independent of 0294's later phases).
3. **0295** (domains) — independent infra track with the longest lead time (DNS/TLS/
   CDN decisions, deploy topology); start the decision review early, land the build
   whenever ready. 0294 explicitly must not *assume* custom domains.
4. **0297** (ruling) — cheap, do immediately after 0294 is Accepted so the program's
   outer boundary is explicit and the non-goals are recorded rather than ambient.

## Alternatives considered

- **Keep funnels on MyndHyve, integrate via the `vendor.myndhyve.*` node packs** (the
  2026-05 boundary): rejected as the end-state — the cutover doctrine makes openwop-app
  the runtime, and every supporting surface has already been re-homed natively; leaving
  only the funnel spine behind strands the revenue path on a frozen legacy app.
- **Port the MyndHyve funnel code** (routing services, upsell services, domain wizard):
  rejected — Firestore/client-heavy architecture, duplicates entities that now have
  native owners (pages, promotions, checkout, experiments). Parity by re-composition,
  not transplantation.
- **One monolithic funnel ADR**: rejected — the lanes have independent gates (Stripe
  SCA review for C, hosting infra for B, product rulings for D) and radically different
  effort profiles; one document would force the slowest gate onto every lane.

## Open questions (tracked in sub-ADRs)

- 0294: funnel steps as first-class rows vs a typed view over journey definitions.
- 0296: saved-PM consent UX + SCA posture per market; refund semantics across a chain.
- 0295: proxy-in-front (CDN/LB per domain) vs certificate-per-domain on the app origin;
  who operates DNS verification.
- 0297: which adjacent surfaces are IN for MyndHyve day-1 parity vs recorded non-goals.

## Verification (program definition-of-done)

Each sub-ADR carries its own phase→PR table. The program is done when: the FM-1..FM-5
blockers are closed and demonstrated end-to-end (public funnel → checkout → bump →
one-click upsell → thank-you, with per-step analytics and an experiment), FM-6..FM-10
each have either a shipped build or a recorded non-goal, and the MyndHyve funnel
surface can be feature-frozen with a straight face.
