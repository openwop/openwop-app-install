# ADR 0248 — Email opens in the attribution projections

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| **Status** | implemented (2026-07-04) — the ADR 0242 + ADR 0246 §"Open items" opens follow-on |
| **Deciders** | openwop-app maintainers |
| **Relates** | ADR 0242 (open tracking — records `kind:'opened'`, labels opens APPROXIMATE), ADR 0246 (email→campaign provenance rollup), ADR 0218 (per-email engagement) |

## Context

ADR 0242 added the tracking pixel and began recording `kind:'opened'` engagement
events, but the attribution read projections never surfaced them:

- the per-EMAIL `EmailEngagementRow` (ADR 0218) reported only clicks / uniqueClicks
  / unsubscribes;
- the per-MarketingCampaign `EmailRollup` (ADR 0246) mirrored that shape.

Both ADRs recorded the gap as an open item — ADR 0246: "Opens in the rollup —
mirror-shaped to the per-email column, which omits opens today (ADR 0242). Add
together if/when the per-email column gains them." This ADR adds opens to **both**
projections in one change (per-email first, then the rollup mirrors it).

## Decision

Add `opens` + `uniqueOpens` to `EmailEngagementRow` and to `EmailRollup`, computed
in `buildAttribution` exactly as clicks already are:

- **Per-email (`byEmailCampaign`):** count `kind:'opened'` events into `opens`;
  `uniqueOpens` = distinct opening contacts for that email campaign.
- **Rollup (`emailByBrief`):** count opens across the brief's `sourceBriefId`-
  linked email campaigns; `uniqueOpens` dedups opening contacts across ALL of the
  brief's campaigns (a contact who opens two campaigns counts once) — the same
  brief-level dedup ADR 0246 established for clicks.
- **Re-opens are real.** The raw event has no dedup (ADR 0242); `opens` counts
  every recorded open, `uniqueOpens` is the deduped contact count. A contact who
  opens one email twice is `opens:2, uniqueOpens:1`.

### Opens are labeled APPROXIMATE — honesty carries to the surface

ADR 0242 established opens as approximate (images-off undercounts; proxy/prefetch
over-counts). That label rides through:

- a doc comment on the `opens` fields marking them approximate;
- the frontend chip prefixes opens with `~` ("~{opens} open(s) · {clicks}
  click(s)") — the click count stays unmarked (reliable), opens carry the `~`.

## Alternatives weighed

- **Rollup opens only, not the per-email column.** Rejected — ADR 0246 tied the two
  together deliberately ("mirror-shaped to the per-email column"); adding opens to
  the rollup while the per-email column omits them would make the two projections
  disagree on which signals they carry.
- **Drop `uniqueClicks`/`unique*` from the FE chip to make room for opens.** The
  chip now shows opens + clicks totals (the two headline owned signals); the unique
  counts remain in the read model for API/node consumers. A compact chip beats a
  four-number chip; the full detail is one API read away.
- **Suppress the `~` approximate marker in the UI.** Rejected — silently presenting
  an approximate metric as exact is the dishonesty ADR 0242 called out.

## Boundaries / wire

- **No wire change, no RFC.** `AttributionReport` is a host-ext read model; adding
  optional numeric fields is additive and non-normative. Consumers that don't read
  `opens`/`uniqueOpens` are unaffected.
- **Feature-package boundary (ADR 0001).** All changes are inside `campaign-intel`'s
  attribution projection + the intel FE feature; no email-feature code changes (it
  already records `kind:'opened'`).
- **Replay/fork.** Pure read-time projection over durable engagement rows; nothing
  stamped on a run.

## Implementation

| Change | File |
| --- | --- |
| `opens`/`uniqueOpens` on `EmailEngagementRow` + `EmailRollup`; count `'opened'` in `byEmailCampaign` + `emailByBrief`; openers dedup sets | `backend/typescript/src/features/campaign-intel/attribution.ts` |
| Test — per-email opens (re-open counts, unique dedups) + rollup opens/uniqueOpens across the brief | `backend/typescript/test/campaign-intel-attribution-pacing.test.ts` |
| `opens`/`uniqueOpens` on the FE `emailEngagement` type; chip shows `~opens · clicks` | `frontend/react/src/features/campaign-intel/{campaignIntelClient.ts,CampaignIntelPage.tsx}` |
| `emailRollup` key reshaped to opens+clicks (en/es/fr/pt-BR) | `frontend/react/src/features/campaign-intel/i18n/*.ts` |

## Open items (deferred)

- **Open-rate as a derived ratio** (opens/sends) — needs a per-campaign send count
  in the projection; a later intel refinement (the raw opens are the primitive).
- **Ad + email "channel mix" view** — still the larger dedicated intel surface ADR
  0246 flagged, unchanged by this projection-level addition.
