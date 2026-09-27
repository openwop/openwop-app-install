# ADR 0245 — Ad targeting pass-through + email→campaign provenance

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| **Status** | implemented (2026-07-04) — the ADR 0223 + ADR 0219 §Deferred follow-ons |
| **Deciders** | openwop-app maintainers |
| **Relates** | ADR 0223 (ad dispatch payloads, §Deferred targeting), ADR 0219 (attribution, §Deferred email↔campaign join), ADR 0167 (ads adapter + idempotency), ADR 0162 (channel publish → email drafts) |

## Context

Two recorded deferrals, both additive:

1. **ADR 0223** created Meta ad sets / LinkedIn campaigns with **no targeting
   spec** — "inventing a default geo/audience here is a SPEND-SHAPING decision the
   host MUST NOT make. Left to the operator." Today the platforms require a
   targeting spec at activation (a human step), so the operator has no way to
   author one through the dispatch.
2. **ADR 0219** noted the "email ↔ MarketingCampaign join deferred: channel
   publish stamps NO draft provenance yet; the email column is honest per-EMAIL-
   campaign engagement, not a fake unified row."

## Decision

### 1. Targeting = an operator-authored OPAQUE pass-through

- `PublishAdArgs.targeting?: Record<string, unknown>` — the operator authors the
  **platform-native** shape; the host forwards it verbatim: Meta adset
  `targeting`, LinkedIn campaign `targetingCriteria`. **The host NEVER invents a
  default** (spend-shaping is the operator's). The publish-ad node reads a
  `targeting` INPUT and passes it only when supplied — absent → no targeting field
  (the platform requires it at activation; that stays a human step).
- **Validation:** only that it's a plain object (reject a primitive/array/null)
  and that its serialized size is bounded (≤ 32 KB, so a runaway operator object
  can't blow the request body). NOT the platform-specific shape — the platform
  validates that at activation, and the ad stays PAUSED/DRAFT regardless. No
  injection risk (it's `JSON.stringify`'d into a call to the operator's OWN ad
  account; no interpolation).
- **Idempotency:** `targeting` joins `idemKeyFor` **additively** (only when set —
  a record with no targeting keeps matching) and **canonically** (key-sorted, the
  ADR 0241/BRIEF-1 lesson — a reordered-but-equivalent object must not mint a new
  dispatch). A genuine targeting change mints a NEW PAUSED dispatch (targeting is
  spend-shaping — a different audience is a different ad); the prior PAUSED
  adset is orphaned but bounded (no spend).

### 2. Email→MarketingCampaign provenance = a `sourceBriefId` stamp

- `Campaign.sourceBriefId?: string` — the channel publish node threads its
  `briefId` into `createDraftCampaign` → `createCampaign`, stamping each email
  draft with the brief it came from. The brief is the stable join key (one
  MarketingCampaign per brief via `getCampaignByBrief`).
- This is a **pure provenance field, NOT a fake unified row** (ADR 0219's
  concern): the email campaign stays its own honest per-email-engagement row; the
  stamp just records the origin, ENABLING a future intel join (email engagement →
  the brief's MarketingCampaign) without forcing one now.
- Stamp the **briefId, not the resolved MarketingCampaign id**: the briefId is
  present + deterministic at publish (replay-stable), whereas resolving the
  campaign id would be a live lookup that can differ on replay (channel publish
  can run BEFORE finalize) and would couple email→campaign-orchestration.

## Alternatives weighed

- **Typed host targeting model (geo/age/interests) mapped per-platform** —
  REJECTED: the host would be modeling + owning a spend-shaping spec ADR 0223
  explicitly says it must not. Opaque pass-through keeps the operator in control.
- **Resolve + stamp the MarketingCampaign id at publish** — REJECTED: a live
  lookup (non-deterministic on replay; the campaign may not be finalized yet) +
  an email→orchestration coupling. The briefId is the stable, deterministic link.

## Scope & wire

- No wire/RFC: both are additive host-ext fields; the ad-dispatch BEHAVIOR is
  unchanged (still creates PAUSED — just carrying the operator's targeting the
  platform requires at activation); no capability-advert or email wire change.
- Replay-safe: targeting rides `PublishAdArgs` (in the idem key → a fork reuses
  the dispatch record); `sourceBriefId` is the deterministic briefId input.

## Open items (deferred)

- **The intel email↔campaign JOIN consumer** (surface a unified per-MarketingCampaign
  view joining ad + email engagement via `sourceBriefId`) — the provenance now
  exists; the join projection is a future intel follow-on. **DONE — ADR 0246**
  (read-time `emailEngagement` rollup on the attribution row, additive beside the
  honest per-email column).
- **TikTok/Google targeting** — Meta + LinkedIn are the targeting-bearing
  platforms today; the pass-through generalizes if the others gain it.
