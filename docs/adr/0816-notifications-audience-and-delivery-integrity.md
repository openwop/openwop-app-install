# ADR 0816 — Notifications: one audience per notice, decided once, and every delivery lane obeys it

Status: Accepted (2026-10-05) — implemented on `feat/fl2-13-notifications` (D0–D5, D7, the D8 guard); the D8 chain retarget is a named follow-up. Feature-loop 2026-10 row 13 (`docs/steward/FEATURE-LOOP-2026-10.md`); see § Implementation record

- **Composes:** ADR 0010 (notifications core), ADR 0050 (per-recipient targeting, Phase 3
  role addressing), ADR 0710 (run-notice audience; operator = `admin`), ADR 0591/0618
  (Layer-2 emit dedup), ADR 0214 D2 (the mute-policy seam), ADR 0815 D4
  (`onMemberAuthorityLost`, `membershipDefinesPresence`), ADR 0566 (180-day retention).
- **Supersedes nothing.** It corrects ADR 0050's push rule ("a broadcast — no
  `recipientUserId` — fans out to every tenant device"), which predates role addressing.
- **Toggle:** none. Notifications is always-on core (ADR 0010 § Correction).
- **Wire:** untouched. Every route is `/host/openwop-app/*`, and the node-pack config change
  is additive pack metadata. No RFC.

## Context — what the row-13 grade found

`/grade-workflows notifications` (WORKFLOWS-ASSESSMENT § Notifications, `NTFWF-*`) graded
the seam **C**. Each defect below is one question, "who is told this?", answered differently
by different delivery lanes:

| Lane | How it decides who is told |
|---|---|
| Inbox list (SQL) | `recipient_user_id = me` OR (no user AND (no role OR role ∈ my root-row roles)). Default-deny on role |
| SSE stream | the same, re-implemented in a closure |
| Web Push | `recipientUserId ? that user's devices : EVERY tenant device`, so **role rows go to everyone** |
| Teams / email | addressed rows only |
| State (read/archive/delete) | one row, one status, mutable by anyone who can see it |

Measured on `origin/main c8a125641` with real-HTTP witnesses (personal sign-in, real `ws:`
workspace, invite, accept, switch; demo mode off; Web Push configured with real VAPID keys;
every endpoint a local capture server). Each row below is RED there:

| Id | Finding |
|---|---|
| `NTFWF-1` | An ADR 0710 operator notice (`recipientRole:'admin'`: run failures and open gates in a shared workspace) is web-pushed to a Viewer's phone, which the inbox hides from them |
| `NTFWF-2` | After `DELETE /orgs/:ws/members/:id`, the removed member's device still receives the workspace's notices, and so does their already-open SSE stream |
| `NTFWF-3` | `POST /push/subscribe` accepts any `http(s)` endpoint, so the backend POSTs to `169.254.169.254` / RFC 1918 addresses (blind SSRF). `ON CONFLICT(endpoint) DO UPDATE tenant_id, user_id` re-homes another person's device. `GET /push/subscriptions` lists every member's endpoints, and `DELETE` removes any member's device |
| `NTFWF-4` | A Viewer deleting, archiving or reading a broadcast does it for EVERY member; `:mark-all-read` likewise |
| `NTFWF-5` | The workspace OWNER never sees an operator notice: its root row carries `owner`, and the role filter asks for `admin` |
| `NTFWF-6` | 54 of 56 chain `notify` nodes use `audience: tenant`, including "Notify me", "Notify owner" and "Decision back to requester". In a shared workspace a member's LLM output reaches every member |
| `NTFWF-7` | Mute, desktop-off and quiet hours suppress the in-tab toast only. Web Push (the toast when the tab is closed) ignores them |
| `NTFWF-9` | The service worker's `notificationclick` calls `openWindow(actionUrl)` without the in-app path guard the SPA applies |

**Generator.** ADR 0710 already named this shape ("an audience boundary copied per call site
drifts") and moved the *emit* decision into one predicate. The *delivery* decision was never
moved: four lanes each re-derive it, and the two that disagree (push, state) are the holes.

## Decision

> **Shaped by an adversarial /architect pass on the first draft (2026-10-05).**
> It found 3 Blockers, 5 Highs and 5 Mediums. § "/architect round" lists each
> one and what was done about it. The decisions below are the corrected ones.

### D0 — one notification subject per request

Today list, SSE, mutate and push ownership each key on `req.userId`, and push
subscribe on `req.userId ?? principal.principalId`. `req.userId` is set only for
BOUND sessions (`middleware/auth.ts:1226`). An unbound OIDC member of a `ws:`
workspace is admitted by `isWorkspaceMember(effectiveSubject)` but has no
`req.userId`, so today it gets the UNFILTERED tenant view and can mutate every
row.

One helper, `notificationSubject(req)`, now serves every lane:
- **wildcard principal** → `undefined`, the unfiltered admin view (unchanged);
- **`ws:` tenant** → `req.principal.principalId`. That is the `effectiveSubject`
  the auth middleware admitted the member under (`auth.ts:1209/1229`), and so,
  by construction, the member row's `subject`;
- **otherwise** → `req.userId ?? undefined`, which is today's behaviour.

In a `ws:` tenant a non-wildcard caller is never unfiltered.

### D1 — in a shared workspace, a durable notice is materialised per person at emit

`emitter.emit` resolves the audience ONCE. Fan-out applies only when all of these hold:
- the tenant is a shared workspace (`isSharedWorkspaceTenant`, the `ws:` prefix);
- the record has no `recipientUserId`;
- the workspace has at least one root member with a `subject`.

The trigger is deliberately NOT `membershipDefinesPresence`. That also fires on
every tenant once RFC 0049 enforcement is on, which would fan out personal and
conformance tenants, and the RFC 0158 oracle counts exactly one row per
`conformance.effect.emit`.

When it applies, the record becomes one addressed row per recipient:
- **broadcast** (no role) → every root member;
- **role-addressed** (`recipientRole: r`) → root members whose
  `effectiveNotificationRoles(roles)` (D2) contain `r`.

Each row keeps `recipientRole` and stamps `metadata.audience` (`tenant` |
`role:<r>`). Recipients are deduplicated by subject. `recipientUserId` is the
member row's `subject`, which matches D0's subject for that member's sessions.
No alias is ever applied.

The whole fan-out is ONE logical effect under the ADR 0591/0618 identity, and it
is made crash-safe:
- **Deterministic per-recipient ids:** `<base>.<sha256(subject)[:16]>`. `<base>` is
  the caller's `notificationId` when one is given; otherwise it is derived from the
  effect identity when one exists, or is random when there is none (no run context).
  A re-execution after a partial crash therefore re-derives the SAME ids.
- **Insert-if-absent:** each insert is skipped when the id already exists, and each
  insert is isolated, so one failure does not drop the rest (`emitMany`'s rule).
- **Downstream after the loop:** SSE, push, Teams and email fire per inserted row,
  AFTER the insert loop. The memo stores the first row.

The pre-existing window (a crash after the claim, then a redelivery inside
`CLAIM_STALE_AFTER_MS`, reads as suppressed) is unchanged and is not widened.

**Lanes.** Push already filters addressed rows to the recipient's devices, and SSE
already drops rows addressed to someone else. Teams and email are addressed-only
lanes. A materialised row (carrying `metadata.audience`) is SKIPPED by both,
because broadcasts and role notices never reached them before and D1 must not
silently widen delivery. Approval-SLA role rows, for example, stay in-app.

`emit` returns the first materialised row. The callers that read the return value
are `notify.ts` (addressed approvers, so never fanned out), the RFC 0140
conformance node (`conformance.*` tenants, never `ws:`), and the ADR 0591 memo.

This closes:
- `-1`: role notices become addressed rows;
- `-2` for notices: a removed member is not a root member, so nothing new is
  addressed to them;
- `-4` for every new row;
- `-5`: via D2.

**Not done:** retroactive delivery to a member who joins later. That is Linear,
GitHub and Slack parity.

**Cost.** Root membership is read only on the broadcast/role path in `ws:` tenants.
It uses `listTenantMembers`, which is authoritative but a full member scan. The
bounded `listForTenantIndexed` is not authoritative on absence, and a missed
recipient is a silent drop. Filed as a measured perf residual.

### D2 — the operator audience includes owners

`effectiveNotificationRoles(roles): string[]` adds `admin` when `owner` is held.
It is the ONE role expansion used by D1, list, SSE and mutate (`callerTenantRoles`).
`runNoticeAudience` keeps `recipientRole: 'admin'` (ADR 0710). A custom
`role:<name>` audience from the node gets no hierarchy.

ADR 0710's per-job-per-day aggregation (`alreadyNoticedToday`, `notify.ts:315`) is
an existence check over a 200-row window. N rows per notice fill that window faster,
and the failure direction is more notices, never fewer. Accepted, and not re-keyed.

### D3 — push subscriptions belong to a person

- **Endpoint policy.** The endpoint must be `https:` on port 443, with no userinfo.
  Its host must dot-boundary match a known Web Push service: `fcm.googleapis.com`,
  `push.services.mozilla.com` / `*.push.services.mozilla.com`,
  `*.notify.windows.com`, `web.push.apple.com` / `*.push.apple.com`. Operators may
  extend the list (`OPENWOP_PUSH_ENDPOINT_HOSTS`), and every added host still
  passes `isDeniedWebhookHost`.
- **Test hatch.** It is the WHD-19 exact-origin shape (`parseWebhookAllowOrigins`)
  under its own env, `OPENWOP_PUSH_ENDPOINT_ALLOW_ORIGINS`. That is never a
  blanket private-egress flag.
- **Where it applies.** At subscribe AND at delivery, so a pre-0816 row stops
  egressing.
- **Rebinding needs proof of possession.** An endpoint held by a different person
  rebinds only when the request presents the SAME `p256dh` + `auth` keys. That is
  what a second person signing in on the same browser does, and the keys are never
  returned by any GET. A key mismatch is a 409 `push_endpoint_taken`, and the store
  is not touched.
- **One device, one workspace.** An endpoint holds ONE `(tenant, user)`, so a
  device receives push for the workspace it last subscribed in. This was already
  true, and is now stated.
- **Owner-only access.** `GET /push/subscriptions` lists D0's own devices.
  `DELETE` removes only your own (404 otherwise). The wildcard principal keeps the
  tenant view.
- **Removal cascade.** `features/notifications` subscribes to
  `onMemberAuthorityLost`. On `reason:'removed'` of a ROOT membership it deletes
  that subject's push subscriptions in the tenant. D4 is the guard; the cascade is
  hygiene.

### D4 — delivery re-checks presence

- **Push.** In a `ws:` tenant a subscription is delivered only when its `userId`
  is a current root member, re-read at delivery.
- **SSE.** A stream in a `ws:` tenant re-checks `isWorkspaceMember(D0 subject)` at
  most every 30 s while frames flow, and ends when the member is gone. That covers
  other instances and transient `signal()` frames.
- **Out of scope.** Deactivated accounts that still hold a membership. The auth
  layer refuses their sessions, but their devices keep push. Filed.

### D5 — device push honours the person's preferences

The push lane asks `isDevicePushSuppressed(tenantId, sub.userId, {type, priority})`.
It is a second seam in `host/notificationPolicy.ts`, registered by
`features/notifications` over the same prefs store. The key is the SUBSCRIPTION's
user, because personal-tenant broadcasts carry no recipient.

It suppresses on any of:
- global mute;
- the type muted;
- the type with `desktop:false`;
- quiet hours (`allowUrgent` lets **urgent** through).

That is exactly the in-tab toast rule (`frontend/.../preferences.ts`).

> **Correction (grade-code `NTFCD-8`).** The first text said `allowUrgent` let
> "urgent/high" through. The in-tab rule admits only `urgent`, and so does the
> code. The ADR 0214 mute policy (channel activity) still admits `high`. That
> lane is out of scope here and is left unchanged.
>
> **Correction (found by the witness).** Preferences are keyed on the person's
> HOME tenant (`resolveCallerUser`). So a notice in a shared `ws:` workspace
> found no `${ws}:${user}` row, and a member's mute had NO effect in any shared
> workspace, on this lane or on the ADR 0214 channel-activity lane.
> `preferencesFor` falls back to the home row. It applies
to both `pushNotification` and `pushNotificationsBatch`. The inbox row is still
written, because the prefs copy says mute "hides the row from the badge count
(still appears in the panel)". The seam fails open (deliver).

### D6 — pre-0816 shared rows

Rows written before D1 in `ws:` tenants stay shared, and they age out under
ADR 0566 (180 days). This ADR adds no authority branch for them. The first draft's
403 had no frontend support and would have rolled back whole `:archive-read`
batches. Prod sizing (§ Open questions) decides whether a one-shot
materialisation is warranted. If it is, it is a background app job, never boot DDL.

### D7 — the service worker applies the in-app path guard

`sw-push.js` navigates only to a value that passes the `isSafeActionUrl` rule,
inlined because a service worker cannot import the SPA module. A parity test pins
the copy. Anything else opens `/inbox`.

### D8 — chain audiences say what they mean (no node bump)

The `self` audience already addresses the schedule owner on scheduled runs.
`host/scheduleDaemon.ts:147-160` spreads `metadata.actingUserId` into the run, and
the executor threads it to `BundleScope.actingUserId` (`executor/executor.ts:714-740`).
The stale docstring at `host/inMemorySurfaces.ts:253` is corrected. So the
"requester" intent needs no new audience value and no node-version bump.

**The chain retarget itself is DEFERRED** (`NTFWF-6`, P4). Changing a chain's
config needs two things:
- a patch bump of every touched chain pack (`check-pack-version-bump`, ADR 0766 P3);
- a REPUBLISH of those packs to the registry. Otherwise ADR 0713's lesson applies:
  the registry's same-version copy wins over the in-tree one.

The republish is an outward publish that needs the orchestrator's coordination,
not a host PR.

Until then, D1 bounds the harm: a `tenant` notice in a shared workspace reaches
current members only, one row per member. The measured list of nodes to move
(2026-10-05) is:
- **to `self`** (person-run, personal deliverable):
  - approvals ×2 "Decision back to requester";
  - data-ops rollup and to-table;
  - devops pr-review, release-notes and stale-issues;
  - exec-ops daily-briefing and meeting-prep;
  - inbox triage ×2 and call-debrief;
  - knowledge policy-qa and doc-summarizer;
  - marketing content-brief;
  - research web-brief;
  - starters fetch-to-storage and scheduled-digest;
  - strategy weekly-checkin, board-pack and metric-sync;
  - support kb-answer and email-triage.
- **needs an `operators` audience** (no human; "Notify me" on a webhook, form or
  event trigger): starters webhook-notify, form-to-table and
  verified-webhook-router; devops ci-failure-explainer. That audience is the
  ADR 0710 predicate exposed to the node.

Everything else stays `tenant`, because the notice is team-wide by intent.

## Alternatives weighed

- **Fan-out keyed on `membershipDefinesPresence`** (the first draft). Rejected by /architect B1.
- **A read-side per-person state overlay** (a `notification_receipts` table joined into the list
  query) instead of D1's write-time fan-out. Rejected: it fixes `-4` only. Push, SSE and Teams
  would still each need their own audience filter, which is the generator this ADR exists to
  remove. It also adds a migration in both adapters.
- **Filter role rows in `webPush.ts` only.** It closes `-1` and nothing else. That would be the
  fifth per-lane copy.
- **Keep one shared row and add a role/membership check to every lane.** Same objection, plus
  state stays shared.
- **Refuse `audience: tenant` in shared workspaces.** Too blunt: team-wide notices are real, and
  D1 already makes them per person.

## Trade-offs

- Row count grows with workspace size for every broadcast or role notice. Shared workspaces are
  small today (row-12 prod sizing: one `ws:`). `emitMany` already writes per recipient for
  channel posts. Retention is unchanged.
- The wildcard admin view shows N rows per notice instead of one.
- `emit` now reads root membership (`listTenantMembers`, a full member scan) on the
  broadcast/role path in membership-defined tenants only. The addressed path (most volume) is
  untouched.

## /architect round (2026-10-05, first draft)

| # | Finding | Disposition |
|---|---|---|
| B1 | `membershipDefinesPresence` fans out conformance/personal tenants under enforcement. The RFC 0158 oracle counts 1 row | D1 trigger narrowed to `ws:` |
| B2 | N plain inserts: a partial crash loses or duplicates; one throw aborts the rest | D1 deterministic ids + insert-if-absent + isolation + downstream after the loop |
| B3 | Unbound OIDC member / no `req.userId` sees and mutates everything | D0 `notificationSubject` |
| H1 | Fan-out silently enables Teams/email | D1: materialised rows skipped by both |
| H2 | 409 on re-home breaks two people on one browser (FE then unsubscribes) | D3 proof-of-possession rebind |
| H3 | `self` already reaches schedule owners; `ownerSubject` is not on the run | D8 uses `self`, no new audience; member guard; stale docstring corrected |
| H4 | A node version bump re-pins 56 sites + stamps a mismatch | D8: no node bump. The chain retarget is deferred, because it needs chain-pack bumps + a registry republish |
| H5 | Recipient read cost vs. authority | D1 uses the authoritative scan; perf residual filed |
| M1 | Role predicate vs. role list | D2 `effectiveNotificationRoles` |
| M2 | `alreadyNoticedToday` counts rows | **Premise false on re-read**: it is an existence check (`rows.some`), so it stays correct. Only its 200-row window fills N× faster, and it fails toward MORE notices (its own documented direction). The D2 re-key was dropped |
| M3 | Reuse the egress-guard pattern | D3 |
| M4 | D6 403 unsupported by the FE | D6 dropped to residual |
| M5 | Prefs keyed on the subscription's user; batch path | D5 |

## Phased plan

| Phase | Scope |
|---|---|
| P1 | RED witnesses on `origin/main` (S1–S4 + owner + chain audience), committed with the ADR |
| P2 | D0 + D1 + D2 (one subject, emitter fan-out, one role expansion), D4 |
| P3 | D3 (push-subscription policy + cascade), D5 (device prefs), D7 |
| P4 | D8 `self` member guard + docstring correction (in this PR). Chain retarget = follow-up after a coordinated registry republish |
| P5 | grade-ux / grade-code, fix their Blockers, gate |

## Open questions

1. ~~Prod sizing~~ **Answered 2026-10-05** (orchestrator, read-only):
   - VAPID keys are SET on the serving revision, so Web Push is live.
   - `push_subscriptions`: 1 row, in a `user:` tenant, 0 in `ws:`.
   - Role-addressed notifications: 2,115, all outside `ws:`.

   So `-1`, `-2` and `-4` were LATENT in prod. `-3` (SSRF via the subscribe endpoint) does
   not depend on tenancy and was **live-class**. Unaddressed broadcast rows in `ws:` were
   not counted; D6 stays a residual until they are.
2. Should D1 count group-derived roles (ADR 0815 D2) for role audiences? The read path today
   uses direct root-row roles only. D1 matches the read path, and the gap is filed rather than
   widened here.

## Implementation record (2026-10-05)

| Phase | Commit | Witness |
|---|---|---|
| P1 RED | `8c8e4477e` (+ HTTPS capture in `416c7a4f6`) | `test/adr0816-notifications-security.test.ts`: **15/15 RED on `origin/main c8a125641`**, in a detached worktree |
| P2/P3 D0–D5, D7, D8 guard | `ae66768ee`, `416c7a4f6` | the same file: 15/15 GREEN |
| /grade-code round (`NTFCD-1..9`) | `3d3c09ae2` | +5 witnesses (D4 push gate, D4 stream removal, D0 lanes). The removal hook and the push presence gate were each sabotaged red on committed code |
| /grade-ux round (`NTFUX-1..5`, `-9`) | `ab17d40f4` | `frontend/.../__tests__/adr0816PushAndPrefsHonesty.test.ts` (7). The timezone and busy guards were sabotaged red; `swPushActionUrlParity.test.ts` (3) runs the shipped worker, with its guard sabotaged red |

**D0 addition (grade-code `NTFCD-3`).** In a `ws:` tenant an `owk_` key reads as its
issuer (`auth.issuer`, ADR 0601). An env-scoped bearer reads as its own principal,
which owns no rows: an empty inbox, never the unfiltered one.

**D1 correction (grade-code `NTFCD-1/2/6`).** Recipients are read through the bounded
per-tenant member index (`listWorkspaceRootMembers`), not `listTenantMembers`. Every
materialised row (N ≥ 1) goes through insert-if-absent. The memo is written only when
all N rows are present, and an emit that lands none throws. Push for the fan-out is ONE
`pushNotificationsBatch`.

**Residuals (named, not closed here):**
- `NTFWF-6` / D8: the chain audience retarget, which needs a chain-pack bump + a registry
  republish (the orchestrator schedules it).
- `NTFWF-8`: `emitMany` dedup.
- `NTFCD-10`: rows addressed to a removed member persist to retention, unreadable without
  re-joining.
- The 30 s cross-instance SSE recheck has no timer witness.
- The N>1 partial-failure memo path has no witness.
- `NTFUX-6/7/8/10`.
- D6: pre-0816 shared rows. Prod has 0 role rows in `ws:`. Unaddressed broadcast rows in
  `ws:` were not counted, and a materialisation job is warranted only if they are material.
