# ADR 0246 — Intel email→marketing-campaign provenance rollup

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| **Status** | implemented (2026-07-04) — the ADR 0245 §"Open items (deferred)" intel-join consumer |
| **Deciders** | openwop-app maintainers |
| **Relates** | ADR 0245 (stamped `sourceBriefId` provenance — the enabling change), ADR 0219 (attribution floor, §Deferred email↔campaign join), ADR 0218 (email engagement), ADR 0226 (identity-link known-contact projection — the same "additive projection, never a merge" shape) |

## Context

ADR 0219 built the attribution floor as a read-time projection and deliberately
left the owned channel un-joined:

> "Email ↔ MarketingCampaign join deferred: channel publish stamps NO draft
> provenance yet; the email column is honest per-EMAIL-campaign engagement, not a
> fake unified row."

ADR 0245 then closed the missing half: the channel-publish node stamps
`sourceBriefId` on each email campaign it drafts (a pure link to the brief that
owns the MarketingCampaign, one per brief via `getCampaignByBrief`). ADR 0245's
own "Open items" recorded the remaining consumer:

> "The intel email↔campaign JOIN consumer … the provenance now exists; the join
> projection is a future intel follow-on."

This ADR is that consumer. It does not add a pipeline, a store, or a wire field —
it is a read-time rollup over data that already exists.

## Decision

`buildAttribution` additionally rolls owned-channel (email) engagement up to each
MarketingCampaign **through the ADR 0245 `sourceBriefId` provenance**, and exposes
it as an optional `emailEngagement` field on each `AttributionRow`.

- **Join key = the brief.** Each MarketingCampaign carries a `briefId`; each
  channel-published email campaign carries `sourceBriefId`. The rollup groups
  email engagement events (already loaded via `listEngagement`) by the brief that
  owns their email campaign, then attaches the group to the marketing campaign row
  with the matching `briefId`. No new read beyond one org-scoped `listCampaigns`
  from the email feature (mirrors the existing `listRecords`/`listConversions`
  org-scoped reads in the same `Promise.all`).
- **Additive, never a synthesised row.** The honest per-EMAIL-campaign `email[]`
  column ADR 0218 built is untouched and still returned. `emailEngagement` is
  present on a row **only** when that campaign's brief owns ≥1 `sourceBriefId`-
  linked email campaign — a real provenance join, not a fabricated unified row.
  This is the same discipline as ADR 0226's `knownContactConversions`: an additive
  projection beside the honest number, never a replacement or a probabilistic merge.
- **Unique clickers dedup across the brief.** `uniqueClicks` is the count of
  DISTINCT clicking contacts across ALL of the brief's email campaigns — a contact
  who clicks two of the brief's campaigns counts once. (Summing per-campaign
  `uniqueClicks` would over-count; the rollup computes it from the raw engagement.)
- **Frontend surfacing.** `CampaignIntelPage` renders a compact muted chip
  (`MailIcon` + "{clicks} email click(s) · {unique} unique") under the campaign
  name in the attribution table, present only when `emailEngagement` is set — no
  new mostly-empty column. One feature-local i18n key `emailRollup` across the 4
  supported locales, riding the lazy i18n chunk (entry chunk 178.4/179.0 kB gzip).

## Alternatives weighed

- **A separate unified "campaign performance" store/row that merges ad + email.**
  Rejected — this is exactly the "fake unified row" ADR 0219 warned against, and it
  would drift from the two honest source projections. A read-time rollup keyed on
  real provenance cannot drift; it recomputes from the sources every read.
- **A new column in the attribution table for every row.** Rejected — email
  engagement exists only for email-channel campaigns, so most rows would show "—".
  The additive chip keeps the table honest about which campaigns actually have an
  owned-channel presence.
- **Summing per-campaign `uniqueClicks`.** Rejected — over-counts a contact active
  across two of a brief's campaigns; the brief-level dedup is the correct unique.
- **Rolling opens into the rollup.** Deferred — the ADR 0218 `EmailEngagementRow`
  omits opens (ADR 0242 labels opens approximate), so the rollup mirrors its
  clicks/uniqueClicks/unsubscribes shape for consistency. Adding opens is a trivial
  follow-on if the per-email column gains them first.

## Boundaries / wire

- **No wire change, no RFC.** `AttributionReport` is a host-extension read model
  (surfaced via `/v1/host/openwop-app/*` intel routes + the `campaign-intel.nodes`
  pack); adding an optional field is additive and non-normative. Consumers that
  don't read `emailEngagement` are unaffected.
- **Feature-package boundary (ADR 0001).** The join lives in `campaign-intel`
  (which already owns the attribution projection and already imports
  `listEngagement` from the email feature). It reads the email feature's
  `listCampaigns` + `Campaign.sourceBriefId` — a downward read into a peer feature's
  public reader, consistent with the module's existing cross-feature reads
  (analytics conversions, connector performance). No email-feature code changes.
- **Replay/fork.** Pure read-time projection over durable rows; nothing is stamped
  on a run. Deterministic given the same stored engagement + campaigns.

## Implementation

| Change | File |
| --- | --- |
| `emailEngagement?` on `AttributionRow` + `EmailRollup` type; `listEmailCampaigns` read; `emailToBrief` + `emailByBrief` rollup; attach per row | `backend/typescript/src/features/campaign-intel/attribution.ts` |
| Test — rollup via `sourceBriefId`, unique-clicker dedup across the brief's campaigns, honest per-email column intact, no rollup when the brief owns no email campaign | `backend/typescript/test/campaign-intel-attribution-pacing.test.ts` |
| `emailEngagement?` on the FE `AttributionRow`; compact `MailIcon` chip in the attribution table | `frontend/react/src/features/campaign-intel/{campaignIntelClient.ts,CampaignIntelPage.tsx}` |
| `emailRollup` key (en/es/fr/pt-BR) | `frontend/react/src/features/campaign-intel/i18n/*.ts` |

## Open items (deferred)

- **Opens in the rollup** — mirror-shaped to the per-email column, which omits
  opens today (ADR 0242). Add together if/when the per-email column gains them.
  **DONE — ADR 0248** (opens + uniqueOpens added to BOTH `EmailEngagementRow` and
  `EmailRollup`, labeled approximate; FE chip shows `~opens · clicks`).
- **Ad + email in one "channel mix" view** — this ADR joins the OWNED channel to
  the campaign; a full paid-vs-owned mix visualization is a larger intel surface,
  not this projection.
