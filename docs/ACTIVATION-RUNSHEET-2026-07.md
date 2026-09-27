# Activation runsheet — 2026-07 (steward-only)

Everything below is MERGED and DEPLOYED code that is dark for lack of an
operator decision or a config flip. Three buckets: **A** = mechanical (flip
when wanted, no business input), **B** = needs a business decision first,
**C** = deliberately dark (leave off; listed so nobody "helpfully" enables
them). Switch locations: *Toggle* = FeatureTogglePanel (server-authoritative,
per workspace), *Env* = Cloud Run env (`gcloud run services update
openwop-app-backend --update-env-vars K=V` — incremental, never `--set-*`),
*Admin* = an in-app admin settings surface.

## A — Flip-ready (mechanical) — ✅ ALL ACTIVE as of 2026-07-22

Verified against the prod store (2026-07-22): the operator had ALREADY swept
most toggles to OPEN BETA on 2026-07-14/16 — `status:'beta'` with no cohort =
enabled for EVERYONE with a Beta badge (service.ts §3.6) — so the stale
"toggles OFF" intel behind this bucket was wrong. State:

| Capability | State (verified in prod) |
|---|---|
| Guided tours (`walkthroughs`) | OPEN BETA (+ operator tenant pinned on) |
| Forms (`forms`) | OPEN BETA (+ operator tenant pinned on) |
| CDP + segment copilot (`cdp`) | OPEN BETA |
| Canvas realtime collab (`realtime-collab`) | OPEN BETA (+ operator tenant pinned on) |
| App-builder (`app-builder`) | OPEN BETA |
| Calendar-MCP (`OPENWOP_CALENDAR_MCP_ENABLED`) | `true` (flipped by a parallel session) |
| Agent work-loop heartbeat (`OPENWOP_HEARTBEAT_DEFAULT_MS`) | **600000 — activated 2026-07-22 (rev 00559-xvv)**; runtime cadence/windows tunable in the ADR 0318 admin settings; set back to `0` to pin off |
| Transient workflows | no discrete toggle — rides the ADR 0315 default-on compose tool + run retention |

## B — Needs a business decision (the code is waiting on numbers)

| Capability | Decision needed | Then |
|---|---|---|
| Paid feature bundles store (ADR 0419) | Stripe Price ids per bundle + which plans stay free | follow `docs/` bundle-activation runbook (#2346); note the `OPENWOP_BYOK_EPHEMERAL` billing gotcha it records; `OPENWOP_BILLING_PLAN_FEATURES` needs only SELLABLE features per the #2348 correction |
| KickTodo revenue share (ADRs 0443-0445) | share bps per line | set share policy via the operator surface — accrual starts only when bps set; payout runs are operator records (host never moves money) |
| Billing plan limits | per-plan usage caps | `OPENWOP_BILLING_PLAN_LIMITS` env JSON |
| White-label / trust-tier (ADRs 0366/0367) | whether to onboard an external adopter | toggles on + signing-key handling (gitignored-public-key trap in memory) |

## C — Deliberately dark (do NOT enable casually)

| Lane | Why it stays off |
|---|---|
| `OPENWOP_TEST_AUTH_ENABLED` / `OPENWOP_TEST_SEAM_ENABLED` / `OPENWOP_UCP_REF_MERCHANT_ENABLED` / packs test namespace | test seams — "NEVER enable in a real deploy" by design |
| `OPENWOP_DEMO_SEED_ENABLED` / example widgets | demo fixtures |
| Analytics-off surfaces (2026-07-10 follow-ons) | deliberate non-ship, recorded in the ADRs |
| ADR 0413 native client push lanes | externally blocked (devices/store accounts), not config |
| Wearable webhook lane (ADR 0462) | gated off AND externally blocked on provider credentials |
| Break-glass (`OPENWOP_BREAKGLASS_ENABLED`) | emergency-only posture |

## Sequencing note

A-bucket flips are independent and reversible; suggest enabling in small
batches with a smoke check between (the toggles are server-authoritative, so
no deploy is needed). The B bucket's bundle store is the highest-leverage
single activation — everything else in that bucket compounds on it.
