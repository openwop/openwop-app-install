# ADR 0219 — Campaign Studio: attribution floor (the last-click join)

| Field | Value |
|---|---|
| **Status** | implemented (2026-07-03) |
| **Date** | 2026-07-03 |
| **Feature(s)** | `campaign-intel` (`attribution.ts`, route, surface, read node, page section) |
| **Plan** | `docs/research/campaign-gap-analysis.md` §5C **C5** (E7: the two measurement halves never meet — no revenue linkage, no lineage) |
| **Depends on** | C8 (ADR 0216 — the `utm_campaign` join key stamped at publish), C2 (ADR 0215 — fresh spend), C4 (ADR 0218 — email engagement), ADR 0159 (performance store), ADR 0018 (analytics conversions + UTM) |
| **RFC gate** | **None** — a pure host-ext read projection. |

## Decision

A **read-time projection** in `campaign-intel` (no new pipeline, no copied rows): per marketing campaign, performance-store spend/revenue (grouped by linked `campaignId`, falling back to `campaignName`) joined **last-click** to analytics `conversion` events on the C8 `utm_campaign` key (`campaign.utm.campaign ?? briefId`). Platform-reported conversions and web-attributed conversions are shown **side by side, never summed** (they overlap). Per-email-campaign engagement (clicks/uniques/unsubscribes) rides beside the paid rows. Every row carries **lineage** (spend-row count + latest date, conversion count + latest timestamp, the join key) — the research doc's trace-a-KPI criterion. Unattributed conversions are surfaced as a count, never silently dropped.

Served by `GET /campaign-intel/attribution?orgId=`, the `attribution` surface method + read node, and one Attribution section on the intel page (single fetch).

## Boundaries (explicit)

- **Last-click only.** Multi-touch/MMM/incrementality are the recorded non-goal (gap analysis §6).
- **Email ↔ MarketingCampaign join deferred:** channel publish stamps no draft provenance yet; the email column is honest per-EMAIL-campaign engagement, not a fake unified row. **PROVENANCE ADDED by ADR 0245 (2026-07-04):** the email-sequence publish now stamps `Campaign.sourceBriefId` (the brief → its MarketingCampaign via `getCampaignByBrief`) — a PURE link, still not a fake unified row; the intel join projection remains a follow-on. **JOIN SHIPPED by ADR 0246 (2026-07-04):** `buildAttribution` now rolls email engagement up per MarketingCampaign via `sourceBriefId` (`AttributionRow.emailEngagement`), additive beside the honest per-EMAIL `email[]` column — a real provenance join, never synthesised.
- **Session↔contact linkage is D4** — until then web conversions are anonymous-session-scoped.

> **Correction note (2026-07-03, ADR 0226):** D4 landed the deterministic
> session↔contact identity floor (`analytics:identity-link` — form-submit +
> email-click writers, consent-gated, erasure-cascaded). Each `AttributionRow`
> now also carries **`knownContactConversions`** — the subset of
> `webConversions` whose sessionKey resolves to a CRM contact through the link
> table — ADDITIVE beside `webConversions`, never replacing it. Web conversions
> without a link remain anonymous-session-scoped, as designed.

## Verification

`campaign-intel-attribution-pacing.test.ts`: join on utm key + name fallback, side-by-side (never summed) semantics, unattributed count, email grouping, lineage fields.
