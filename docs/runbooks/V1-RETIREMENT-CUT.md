# Runbook — retiring OpenWOP v1 on app.openwop.dev (the ADR 0669 cut)

**Not before 2026-12-04.** That is the end-of-support floor
(`../openwop` `evidence/v1-end-of-support.json`, leg a), and `versioning.md` §5
makes retirement atomic, so nothing in this runbook may run earlier. The cut is
one flag, `OPENWOP_V1_RETIRED=true` (ADR 0669). Everything else here makes
sure flipping it breaks nothing.

> **CORRECTED 2026-10-04: the floor moved to 2026-10-04, and the cut has been
> executed.** RFC 0234 (corpus 2.45.14) amended `evidence/v1-end-of-support.json`
> to `endOfSupportNotBefore` **2026-10-04**. It added criterion (c): no
> third-party v1 traffic for at least 7 days, which the T−7 readiness measurement
> below satisfies. The 2026-12-04 date above is the original floor, kept as the
> record. See § Cut record.

Sources: ADR 0669 (the switch), ADR 0806 (addresses third parties hold),
`docs/steward/V2-COMPLETION-PLAN.md` (W8 / W9). The procedure was rehearsed on
production infrastructure on 2026-10-03; see § Rehearsal record.

## What the flag does

| Surface | Before | After |
|---|---|---|
| `protocolVersions[]` / `preferredVersion` | `1.x` + `2.0` / `1.x` | `["2.0"]` / `2.0` |
| any inbound `/v1/<protocol op>` | served under major 1, with `Deprecation` | `410 protocol_version_unsupported` |
| a header-less unversioned protocol request | major 2 | major 2 (unchanged) |
| GET/HEAD of an unauthenticated `/v1/host/openwop-app/…` address, or the OAuth callback | served | bodiless `308` to the same `/host/openwop-app/…` path (`retired_twin_forward` logged) |
| any other `/v1/host/…` request (writes, authenticated addresses) | served | `410` |
| OAuth `redirect_uri` the host sends | `/v1/host/openwop-app/connections/<p>/callback` | unchanged: the registered `/v1` URI keeps working through the callback forward (ADR 0806 correction 2026-10-04). Set `OPENWOP_OAUTH_REDIRECT_UNVERSIONED=true` only once every provider console holds the unversioned URI |

Background workers are **not** affected: `currentContract()` defaults to 1
whatever the flag says (inverting that is W9, after the cut).

## T−14 days — announce the date

1. `gcloud run services update openwop-app-backend --update-env-vars OPENWOP_V1_SUNSET=<YYYY-MM-DD> --region us-central1 --project openwop-dev`.
   This adds the RFC 8594 `Sunset` header to every `/v1` response. Use a merge-style update, never `--set-*`.
   The update mints a 0% revision, so fold it into the next deploy or shift traffic by name.

## T−7 days — readiness: no provider still calls a `/v1` address

2. Run the ADR 0806 query. Any **non-GET** line on a held family is a provider that has to be re-pointed first:
   ```
   gcloud logging read 'resource.type="cloud_run_revision"
     AND resource.labels.service_name="openwop-app-backend"
     AND jsonPayload.msg="deprecated_major_request"
     AND jsonPayload.method!="GET"
     AND jsonPayload.family=~"^host/"' \
     --freshness=7d --project openwop-dev \
     --format='value(jsonPayload.family,jsonPayload.method,jsonPayload.caller)' | sort | uniq -c
   ```
   Expect `host/openwop-app/test` and `host/sample/*` from the conformance suite (caller `other`).
   Those are seam traffic and stop mattering at the cut. Anything else needs a name and an owner.
   **Run the same query without the `method` filter as a control.** An empty control means the query is wrong, not that nobody is calling.
3. Provider re-points (ADR 0806 § Operator steps). Status as measured 2026-10-03:

   | Surface | Status |
   |---|---|
   | Cloud Scheduler `openwop-app-daily-cleanup` | **DONE 2026-10-03**: now `POST …/api/host/openwop-app/admin/cleanup`, a manual run answered `200` |
   | Stripe webhooks (platform + Connect) | no `/v1` webhook traffic in 30 days; re-check step 2 at T−7 |
   | Commerce / email bounce / connection inbound / app-builder sync | no `/v1` traffic in 30 days |
   | OAuth apps | only the GitHub Copilot client is configured, and it is already unversioned. For any new provider, register BOTH callback URIs (README) |
   | SAML | not configured in production |

## T−1 day — rehearse again on the release candidate

4. Rehearse exactly as in § Rehearsal record, on the commit you will ship.

## Cut day

5. **Hold check.** Broadcast to every live session that production is held for the cut. Do not proceed until each session has acknowledged.
6. `scripts/preflight-deploy.sh`, with no peer build in the window and the connection budget fitting.
7. Mint the cut revision at 0% with a tag:
   ```
   gcloud run deploy openwop-app-backend --image <the serving image> --no-traffic --tag v1cut \
     --update-env-vars OPENWOP_V1_RETIRED=true --region us-central1 --project openwop-dev
   ```
8. Probe the tag URL (`https://v1cut---openwop-app-backend-<hash>-uc.a.run.app`) with § Probe checklist. Every row must match.
9. Shift by name: `gcloud run services update-traffic openwop-app-backend --to-revisions <the v1cut revision>=100`.
   Then `--remove-tags v1cut`, and confirm no live instance remains on the previous revision (WHD-28).
10. Through the public origin, re-check what the tag URL could not show: `https://app.openwop.dev/api/v1/runs` → `410`, `https://app.openwop.dev/v1/host/openwop-app/public/pricing` → `308`.
    The tag bypasses Firebase Hosting (the `/api` strip, `%2F` decoding, the `/host/**` rewrite).
    `scripts/verify-deploy.sh` must pass.
11. Evidence: `scripts/publish-evidence.sh --major 2`. The script defaults to cutting both majors, and after the cut there is no major 1 to certify.

### Rollback

`gcloud run services update-traffic openwop-app-backend --to-revisions <previous revision>=100`,
then `--update-env-vars OPENWOP_V1_RETIRED=false` so the next deploy does not re-apply retirement.

> **CORRECTED 2026-10-04 (ADR 0812 P1): `--remove-env-vars` no longer rolls
> back.** v1 is now retired BY DEFAULT, and only the exact value `false` serves
> it. Removing the variable leaves the host retired. The opt-back-in lasts one
> deprecation window, because P3 deletes v1 from the codebase.
A rollback re-opens `/v1` and is conformant only while it lasts: retirement is
atomic, so treat a rollback as an incident and fix forward.

## Probe checklist

| # | Request (tag or origin) | Expect |
|---|---|---|
| 1 | `GET /.well-known/openwop` (no header) | `200`, `protocolVersions: ["2.0"]`, no `Deprecation` |
| 2 | `GET /v1/runs` | `410 protocol_version_unsupported` |
| 3 | `GET /v1/.well-known/openwop` | `410` |
| 4 | `GET /v1/host/openwop-app/public/pricing?x=1` | `308`, `Location: /host/openwop-app/public/pricing?x=1`, empty body, `Cache-Control: no-cache` |
| 5 | `GET /api/v1/host/openwop-app/public/pricing` | `308`, `Location: /api/host/…` (prefix kept) |
| 6 | `POST /v1/host/openwop-app/billing/webhook` | `410` (writes are never forwarded) |
| 7 | `GET /v1/host/openwop-app/connections/<p>/callback?code=c&state=s` | `308` to the unversioned callback, query kept |
| 8 | `GET /host/openwop-app/public/pricing` | `200` |
| 9 | `GET /v1/host/openwop-app/orgs` (authenticated vendor address) | `410` |
| 10 | `GET /runs` (no header, no credential) | `401` carrying `OpenWOP-Version: 2.0` |
| 11 | `GET /v1/host/openwop-app/assets/<token>` | `308` (ADR 0669 asset rule) |
| 12 | `GET /` (browser UA) | `200 text/html` (SPA routes are served by Hosting, not the backend) |
| 13 | major-2 certify against the tag (`OPENWOP_MAX_WORKERS=2`) | no `executed-fail` caused by the cut |

## Rehearsal record

**2026-10-03, revision `openwop-app-backend-01033-tiq`** (image of `451a665e8`, tag `v1cut`, 0% traffic, flag on).

- Probes 1–12 matched.
- A raw `…/public/../orgs` is resolved by Google's front end with a `302` before it reaches the app, on production too. The app's own dot-segment refusal is therefore defence in depth.
- **Certify at major 2 against the tag** (suite 2.45.11; a throwaway signing key, so the bundle was never published) found **five defects no pre-cut test could see**, because each exists only with the flag on:
  1. `protocolVersion` stayed `1.1` while `preferredVersion` became `2.0`. Fixed: derived from `preferredVersion()`.
  2. `OpenWOP-Version: 1` on an unversioned path was silently served major 2. Fixed: the 406 check derives served majors from `protocolVersions()`.
  3. A bare run id was still admitted after the overlap. Fixed: refused `400 validation_error` once retired.
  4. A double-projected id answered `404`. Same fix as 3.
  5. `v2-advertised-path-space-served` read the blanket `/v1` `410` as "served under /v1". A **scenario** defect: the corpus fixed it in 2.45.12 (410 is not-served; the leg is inapplicable with no 1.x member).

  Host fixes 1–4 are pinned by `test/adr0669-cut-rehearsal-findings.test.ts`, each with a pre-cut control, and three sabotages red it. Re-run in-process with the flag on, the four scenarios pass.
  The other 35 `blocked` rows were the hand-run lacking `publish-evidence.sh`'s receiver tunnel and second-tenant / low-scope keys, not the cut. On cut day, certify with `publish-evidence.sh --major 2`.
- **Teardown, verified:** the flag was removed from the service template (`--remove-env-vars`) and the tag dropped (`update-traffic --remove-tags`; `services update` has no `--remove-tags`). A diff showed the template equal to the pre-rehearsal snapshot (86 env vars, `OPENWOP_TRIGGER_INBOUND_SIGNING=true`). `01033-tiq` went `Active=False/Retired` and its instance shut down. Traffic never left `00836-5q8`.
- **Hazard found while rehearsing:** while the flag sits in the TEMPLATE, any other deploy or env update inherits it and retires v1 for real. **Hold every session for the whole rehearsal**, and diff the template against a snapshot before lifting the hold.

## Cut record

**2026-10-04, revision `openwop-app-backend-01043-rum`** (commit `09e5ae590`, both
halves). Shifted to 100% by name. The template now carries
`OPENWOP_V1_RETIRED=true`, together with `OPENWOP_CONFORMANCE_PROVIDER_FIXTURES=true`
(RFC 0233) and `OPENWOP_TRIGGER_INBOUND_SIGNING=true`. Every later deploy
inherits all three on purpose, so never unset the first.

- **Pre-cut fixes the rehearsal could not see** (#4361): the pack catalog moved
  to a vendor home, because `@openwop/cli` read `/v1/packs` (CLI 1.4.1 tries
  `/v1/host/openwop-app/packs` first). OAuth `redirect_uri` became unversioned.
  #4362 pins signed trigger ingest across the cut.
- **Probes, verified on the public origin:**
  - `/v1/runs` and `/api/v1/runs` → `410`.
  - A public read twin → bodiless `308`, with the `/api` prefix kept.
  - Header-less discovery → `protocolVersions ["2.0"]`.
  - `/` bundle → `200 text/javascript`; `/dashboard` → `text/html`.
  - `verify-deploy.sh` → commit OK on both halves.
  - `@openwop/cli@1.4.1 capabilities` → exit 0, representation v2.
- **`check-wire-claims` false reds:**
  - On a v2-only host, `contractProvenance` read MISSING and
    `replay.sideEffectSuppression` read STALE. Neither field exists in the v2
    capabilities schema. Fixed: on a host whose `protocolVersions` has no 1.x
    member, both rows report `N/A`, and gate fixtures cover both directions.
  - The two claims-arm reds in the same run were a different cause. That
    verify run lacked `OPENWOP_DEPLOY_PROJECT`/`REGION`, so it fell back to
    image mode against an origin-mode service. They were not a v2 defect: the
    claims route is served unversioned after the cut.
- **Open follow-ups:**
  - The v2 document carries no `a2a`/`mcp` records, although both are in the
    v2 schema. It under-advertises; declaring them may un-skip v2 scenarios.
  - RFC 0146 `contractProvenance` has no v2 home. That is a corpus question.
  - W9 (contract default 2, retire the `/v1` registrations) is no longer
    date-gated.
