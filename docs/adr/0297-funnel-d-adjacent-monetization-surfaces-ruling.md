# ADR 0297 — Funnel D: adjacent monetization surfaces — explicit in/out rulings

**Status:** implemented (2026-07-06) — the three IN builds shipped: **D1** pixel configs (campaign-connectors growth) with a marketing-consent-gated public read (unconsented = empty list, indistinguishable from none-configured) + the conversions relay (server-side SHA-256 of the email identifier — the raw address never persists; eventId dedup; rows stay honestly QUEUED — platform delivery is an injectable transport, none wired v1: the connector-transport wiring is the recorded follow-on, so no fake 'sent' state exists); **D2** affiliate ref capture at the public checkout (only a REAL code attributes — junk silently dropped, no validation oracle) + accrual-at-paid (existing ledger) + the payout CSV export (advisory — no money movement); **D3** explainable compute-on-read lead scoring (identity-linked funnel events + paid orders; fixed visible weights view=1/completion=5/order=20; no stored score, no hidden model). The six OUT rows stand as recorded non-goals with their revisit triggers. Follow-ons closed 2026-07-06 eve: the retention purger (FM-D1-RET, #1433) AND the delivery transport — `AdsAdapter.sendConversion` (Meta CAPI + TikTok Events through the Connections broker, hardcoded hosts, hashed identifiers only, provenance-stamped; no approval gate BY DESIGN: the visitor consented at collection, unlike syncAudience's operator-pushed lists) + the user-triggered `POST …/conversions/dispatch` route with the platform filter (google pixels stay client-side-only and can never wedge the queue). Remaining platform residue: google/linkedin conversions APIs (documented `unsupported`).
**Date:** 2026-07-06 · **Program:** [ADR 0293](0293-funnel-program.md) · **Closes:**
FM-6, FM-7, FM-8, FM-9, FM-10 (each as a build or a recorded non-goal)

## Context

Around the funnel spine, MyndHyve ships a ring of "Complete"-marked monetization
surfaces: tracking pixels + a server-side conversions API, affiliate attribution with
payouts, evergreen webinar funnels, membership/content gating, booking, realtime
social proof, a video studio, lead scoring/lifecycle stages, and 7 email-provider
adapters. Porting all of it uncritically would balloon the program; ignoring it
silently would leave the migration boundary ambient. This ADR forces one explicit
ruling per surface, with the default posture: **IN only if it feeds the funnel spine's
revenue loop and composes an existing owner; otherwise a recorded non-goal with a
revisit trigger.**

## Rulings (draft — each row is individually contestable at review)

| # | Surface | Ruling | Rationale / shape |
|---|---|---|---|
| FM-6 | **Pixels + server-side conversions API** | **IN** | Ads dispatch (0167) + attribution (0219/0248) already exist; closing the loop needs conversion signals back to Meta/Google/TikTok. Shape: consent-gated (0020/0268) pixel emitters injected at the public page read (the 0236 injection point), + a CAPI relay (hash/dedup server-side) as `campaign-connectors` growth — NOT a new package. Effort M. |
| FM-7 | **Affiliate attribution + payouts** | **IN (grow in place)** | `commerce/affiliate.ts` already holds the advisory ledger. Add: ref-code capture on public funnel/page/storefront reads (cookie-less: signed ref param persisted on the sessionKey, consent-gated), attribution window on order creation, payout-export CSV. No money movement — payouts stay an export (the no-new-rails rule). Effort M. |
| FM-10 | **Lead scoring / lifecycle stages** | **IN (CRM-owned)** | CRM owns contacts/segments; CDP traits (0265) already compute behavioral signals. Shape: a scoring model on the CRM side reading CDP traits + funnel events — no new store of truth. Effort M. |
| FM-9 | **Email provider breadth (7 adapters)** | **OUT — recorded non-goal** | The brokered BYOK SendGrid/SES posture (0193) is a deliberate doctrine, not a gap; MyndHyve itself backend-routed only SendGrid+Mautic. Revisit trigger: a real tenant blocked on a specific provider. |
| FM-8a | **Webinar funnels** | **OUT for day-1 — revisit after 0294 ships** | High build cost (session scheduling, replay gating, reminder sequences); nothing else depends on it. When revisited: a funnel-step kind + scheduler jobs + journey chains — no new engine. |
| FM-8b | **Membership / content gating** | **OUT — non-goal** | Adjacent product, not funnel spine. Publishing already has an editorial gate; paid gating would need an entitlement model better designed alongside subscriptions (0279) when demanded. |
| FM-8c | **Booking / calendar** | **OUT — composes existing surfaces when needed** | Scheduled-agent-chats + connections (Google Calendar) cover the assistant use case; a public booking page is a separate product decision. |
| FM-8d | **Realtime social proof widgets** | **OUT — non-goal** | Conversion cosmetics with a privacy cost (broadcasting recent purchases); revisit only on explicit product pull. |
| FM-8e | **Video studio** | **OUT — non-goal here** | Media/creative generation belongs to the campaign-studio creative lane (0229) and packs, not the funnel program. |

## Consequences

- The program's outer boundary becomes explicit: **three builds** (FM-6, FM-7, FM-10)
  join the roadmap behind 0294; six surfaces are recorded non-goals with named revisit
  triggers, so future "why don't we have X?" questions land on a decision, not a gap.
- MyndHyve feature-freeze scope: the OUT rows stay on the legacy app until their
  revisit triggers fire — the freeze exception list should quote this table.

## Phases (IN rows only; each behind 0294)

| Phase | Ships | Gate |
|---|---|---|
| D1 | FM-6 pixels + CAPI relay (consent-gated, connectors growth) | consent-off path verified; ad-platform sandbox |
| D2 | FM-7 ref capture + attribution window + payout export | attribution tests incl. window expiry |
| D3 | FM-10 scoring model + CRM surfacing | score explainability (which signals, which weights) |
