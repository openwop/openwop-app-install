# ADR 0860 — Visitors choose analytics on the public site: a region-aware banner on the existing consent lane, a visitor key written only after consent, and form submits that link only the contacts they create

Status: implemented (2026-10-07; Accepted after the pre-code `/architect` pass, then corrected by `/grade-code` + `/grade-ux` — the correction tables govern where they disagree with the text above them; special row after feature loop round 2 rows 31/32/33; branch `feat/visitor-consent-banner`)

Builds on ADR 0020 (the one consent rule, `isAllowed`), ADR 0236 (the first-party
visitor key `vk` and experiment assignment), ADR 0226 (the session↔contact identity
link), ADR 0512 (nav telemetry and its disclosure posture), ADR 0569 (cookieless
visitor identity), ADR 0586 / CONS-2 (the public consent lane and its `subjectToken`),
ADR 0627 D6 (a form submit attaches to an existing contact), ADR 0849 (the consent
regime is tenant-wide and admin-tier), ADR 0850 (forms capture) and ADR 0857 (the
session-key grammar, and the beacon's `consentToken`, D3).

## Context

ADR 0857 left three owner decisions open, and the owner decided all three on
2026-10-07. This ADR implements them, plus one disclosure line.

What is true on `origin/main` @ `90e7f78ee`, read at the cited lines:

1. **No first-party surface records a visitor's choice.** The public lane
   `POST /public-consent/:orgId` exists (`consent/routes.ts:119`). The beacon and the
   form link gate accept its token (`analytics/consentGate.ts`). But the SPA ships no
   banner, so nothing mints a token.
2. **So prod analytics records almost nothing.** The `consent` toggle resolves ON for
   every tenant (stored `beta`, no cohort). Exactly one tenant has a `consent:policy`.
   `isAllowed` denies under an unset policy (`consentService.ts:902`), and a visitor
   with no token has no record. Every beacon is answered `202 recorded:false`.
3. **`owp:vk` is written before any consent check.** `getVisitorKey()`
   (`site/visitorBeacon.ts:24-33`) mints and stores `vk-<uuid>` on every public
   page load (`FrontPage.tsx:165`, `FunnelViewerPage.tsx:85`). Consent is checked
   only later, on the server. The device write itself is the non-essential storage
   (ePrivacy Art. 5(3)), so a server-side refusal does not cure it.
4. **`regulatedRegions` is declarative only** (`consentService.ts:8-12`). No request
   carries a region, so no rule can read it.
5. **A form submit links the submitter's session to whichever contact the email
   matches** (`forms/routes.ts:339-346`). The CRM sink returns the EXISTING contact on
   a duplicate email (`crm/formsSubmissionSink.ts:82-86`, ADR 0627 D6). So someone who
   types Bob's email attaches their own browsing to Bob's lead score and attribution.
   ADR 0857 D1 stopped this from becoming an erasure edge. It did not stop the
   attribution leak.
6. **The nav telemetry disclosure is a dismissible banner** (`chrome/NavTelemetry.tsx`).
   Once a member dismisses it, nothing in the product says the counting happens.

## Decision

### D1 — The server decides the visitor's region, from a header only the operator's edge can set

New module `features/consent/visitorRegion.ts`:

- `visitorRegionOf(req)` reads the country from the header named by
  `OPENWOP_GEO_COUNTRY_HEADER`, and an optional subdivision from
  `OPENWOP_GEO_SUBDIVISION_HEADER`. Both are unset by default.
- **Unset, absent or malformed ⇒ the region is UNKNOWN.** Unknown is treated as
  regulated (opt-in). So the default deployment asks every visitor.
- A country must match `^[A-Z]{2}$` after trimming and upper-casing. A subdivision
  is accepted as `USCA` (the Google load balancer's `{client_region_subdivision}`),
  `US-CA` or `CA`, and is normalized to `US-CA`.

**Why a configured header, not a fixed one.** Cloud Run and Firebase Hosting add no
country header that this repo has ever read (`grep` finds none). The headers that do
exist belong to an edge: the Google external load balancer's custom request headers
(`{client_region}`, `{client_region_subdivision}`), or Cloudflare's `CF-IPCountry`.
A client can send any of those names itself. The value can be trusted only when the
operator's edge overwrites it, so only the operator can name it. The operator names
it once they have checked that their edge overwrites it. This mirrors ADR 0851,
where trusted proxy ranges are operator-added.

**Why a forged region is a bounded risk.** Region changes only the default for a
visitor who has made no choice, and it changes it only for that visitor's own data.
A visitor who forges a non-regulated country lowers only their own protection.
Unknown stays the safe direction.

### D2 — The visitor analytics default is region-aware; every other consent decision is unchanged

`isAllowed(tenantId, subjectKey, category, opts?)` gains one optional argument,
`opts.visitorRegion`. It is read in **one** place: the final fallback (no tombstone,
toggle ON, no record), and only for `category === 'analytics'`. Precedence stays
exactly as ADR 0657 D2 has it. Strict channels, marketing, email and every caller
that does not pass `visitorRegion` see no change. So this does not loosen the
ADR 0849 regime and does not reopen its findings.

The fallback when `visitorRegion` is supplied:

```
regulated = regionIsRegulated(region, FLOOR ∪ policy?.regulatedRegions)
regime    = regulated ? 'opt-in' : (policy?.defaultMode ?? 'opt-out')
allowed   = regime === 'opt-out'
```

- **`FLOOR = ['EEA', 'UK', 'US-CA']`** is a code constant. It is the code-level
  default the owner asked for, and it needs no prod data write. A tenant policy can
  ADD regions. It can never remove a floor region.
- **Token vocabulary.** `EU` is the EU-27. `EEA` is the EU-27 plus IS, LI and NO.
  `UK` and `GB` both mean GB. A bare two-letter code is a country. `XX-YY` is a
  subdivision. **`CA` matches BOTH Canada and `US-CA`.** The only prod policy says
  `EU, CA, UK`, which reads as California, while ISO says Canada. Matching both errs
  toward asking.
- **An unknown subdivision for a country that has a regulated subdivision is
  regulated.** A US visitor with no subdivision header gets opt-in, because they
  might be in California.
- **A tenant policy with `defaultMode: 'opt-in'` keeps opt-in everywhere.** The one
  prod tenant with a policy chose opt-in, and that choice is honoured outside its
  regulated list too.

`regulatedRegions` stops being declarative-only. The `consentService.ts` header and
the consent page's field hint are corrected to say which decision now reads it.

### D3 — One server helper decides every visitor lane, and it moves into `consent`

`visitorAnalyticsAllowed(tenantId, sessionKey, tokenSubject, region)` lives in
`features/consent/visitorConsent.ts`. It holds ADR 0857 D3's rule (a token decides
for its `visitor:` subject, and an erased `sessionKey` stays refused) and passes
`visitorRegion` to `isAllowed`. `analytics/consentGate.ts` keeps its exported names
and delegates, so the beacon and the form link gate still cannot disagree.

Three callers pass the request's region:

- `POST /public-analytics/:orgId/collect` (the beacon);
- the form submit's link gate;
- `GET /public/:orgId/pages/:slug`. Experiment assignment is the third visitor
  analytics decision, and it now takes the token from an
  `X-OpenWOP-Consent-Token` header. A query parameter would land the token in
  request logs. The header is added to the CORS allow-list.

The other `isAllowed` callers keep the unset-policy deny. That covers
`campaign-connectors` pixels and conversions, which are ad-platform surfaces and not
first-party analytics. This is listed as residue.

### D4 — The visitor reads their regime on the existing lane

`GET /public-consent/:orgId/posture` returns `{ regime: 'opt-in' | 'opt-out' }`, the
D2 fallback for this request, and nothing else. No region, country or header value
is echoed. It sends `Cache-Control: private, no-store` and `Vary` on the configured
geo headers, so a CDN cannot serve one visitor's regime to another. It sits behind
the lane's uniform 404 (unknown org or toggle off) and is registered before the
`/:orgId/:subjectToken` read, so the literal `posture` is never parsed as a token.

### D5 — The client stores nothing non-essential until the decision says it may

New module `features/site/visitorConsent.ts` replaces `getVisitorKey()`:

- **The choice** is stored in `localStorage['owp:consent']` as
  `{ [orgId]: { token, analytics, at } }`. Remembering the choice is the storage the
  choice itself needs, which ePrivacy treats as strictly necessary. The record of
  truth is server-side, on the consent lane. Every choice is POSTed there, and the
  token it returns is kept.
- **The decision** for an org is:
  - a stored choice ⇒ that choice;
  - else the posture: `opt-out` ⇒ allowed, `opt-in` ⇒ denied;
  - else (posture not loaded, failed or 404) ⇒ unknown, which writes nothing.
- **`owp:vk`** is written only when the decision is `allowed`. When the decision is
  `denied`, it is **removed**. That covers withdrawal, and also the key every past
  visitor already holds from before this change.
- The page read, the experiment pageview and web vitals send the token when there is
  one. So the server applies the same choice the client did.
- **A posture failure fails closed.** No banner is shown (there is nothing to record
  against), and no key is written.

The first page load of a visitor with no stored choice fetches the page without
`vk`, so the page is not delayed by the posture request. The posture resolves in
parallel. The cost is stated: a visitor with no choice gets no experiment exposure on
the first page of a tab session.

### D6 — The banner

`features/site/consent/VisitorConsentBanner.tsx` is lazy. Its strings live in the
lazy `site` namespace, in four locales. It is mounted by the two surfaces that use a
visitor key, `FrontPage` and `FunnelViewerPage`. Public forms, booking, e-sign and
docs write no key, so they show no banner.

- **Opt-in regime, no choice yet.** A non-modal region (`role="region"`, labelled)
  pinned to the bottom of the viewport. It does not trap focus and does not block
  the page. It offers **Accept analytics** and **Reject analytics** as two buttons
  of the SAME variant and size, side by side. There is no pre-ticked box, no
  "Reject" hidden behind a second layer, and no colour difference between the two
  (CNIL 2020 guidance and EDPB Guidelines 05/2020 §§ 86–90; EDPB cookie-banner
  taskforce report 2023, practices 3 and 5). One sentence says what is counted and
  that the choice can be changed from the footer.
- **Opt-out regime, or after any choice.** No banner. A **"Privacy choices"** button
  is portalled into a slot in the `PublicShell` footer. The slot is one empty
  element, which costs the entry chunk only a few bytes.

  > **CORRECTED 2026-10-08 (gate, entry budget).** Even the empty slot cost about
  > 30 B of an entry chunk with 37 B of headroom. The lazy banner chunk now creates
  > its own container (`div.visitor-consent__slot`) inside PublicShell's existing
  > `.app-footer` on mount and removes it on unmount, so `PublicShell` is unchanged
  > and the entry delta is 0 B. With no footer, the control renders inline.

  The button opens the same
  region in its "change" form: the current state, one button for the other choice,
  and a close button.
- **Focus.** The banner does not steal focus on load; it is reachable by Tab. When
  the visitor makes a choice, focus moves to the footer button, so the keyboard user
  is not dropped onto `<body>`. When the visitor opens the region from the footer,
  focus moves into it, and Esc closes it and returns focus to the button.
- **A failed POST is not a choice.** The region shows an inline error and stays open.
  A failed *reject* still stores the refusal locally and removes `vk`. Failing
  closed is always safe.
- Tokens only (no hex), `ui/Button`, and the `Notice` for the error.

### D7 — A form submit links a session only to a contact it created

- `SubmissionSinkResult` gains `contactCreated?: true`. The CRM sink sets it only on
  the `createContact` branch, not on the duplicate-email attach branch.
  `runSubmissionSinks` copies it with the `contactId` from the same sink, and
  `Submission.contactCreated?: true` persists it through the same `patchSubmission`
  as the `contactId`.
- The form link gate requires `submission.contactCreated === true` before it
  considers consent. An attach to an existing contact logs
  `forms_identity_link_skipped` with reason `existing_contact` and writes no link.
- **The existing contact still learns about the submission.** The sink appends a CRM
  activity on the attach branch: kind `note`, body `Submitted the form "<title>".`,
  deterministic id `act:form-sub-<submissionId>`. The id makes a re-run of the sinks
  idempotent, as in the commerce order-paid activity. No form values are written to
  the body, because an anonymous form is not an authority over the contact's record
  (ADR 0627 D6).
- **The verified path is untouched.** The beacon's signed email-click token
  (`owx`, ADR 0651 D1) still links any session to the contact the email was sent
  to, including an existing one. A test pins that it still does.

### D8 — The nav-telemetry disclosure is permanent in the privacy panel

`settings-shell/PrivacyPanel.tsx` gains one plain line:
*"We count which features members use, in aggregate, to improve the product."*
It is in four locales. It is shown always, not only when the toggle is on, because
the line describes the product's posture. The toggle's state is main's separate call.
The toggle, the dismissible banner and the beacon are unchanged.

## Architect pass corrections (pre-code, 2026-10-07)

An adversarial `/architect` pass read every decision against `90e7f78ee`. Every line
citation held. It found 1 Blocker, 3 High, 6 Medium and 4 Low issues. The decision
text above is kept so the trail shows what changed; **where a row and the text
disagree, the row governs.**

| # | Finding | Resolution |
|---|---|---|
| B1 | D3 missed two visitor-analytics callers. Funnels ask `isAllowed(vk,'analytics')` with no token and no region (`funnels/routes.ts:72-77`, used by view/step/`/next`), and so does the attribution sink (`funnels/formsAttributionSink.ts:56`). A visitor who accepts on `FunnelViewerPage` would still never be recorded, and the funnel and the beacon would disagree. | D3 covers them. `consentedVisitor` reads the `X-OpenWOP-Consent-Token` header and the request region through `visitorAnalyticsAllowed`. The submit route resolves `{ tokenSubject, region }` once and passes it to the sinks as a **transient** third argument (`SubmissionCapture`), never persisted. `meta.context` never carries a token. The funnel viewer hands its token to the embedded form through `FormEmbed.consentToken`. A path with no capture (a quarantine release, the demo seeder) keeps the legacy decision. The workflow node (`consent/surface.ts`) is unchanged on purpose: it has no request. |
| H1 | `email/formsConsentSink.ts` writes `marketing.email:true` onto whatever `contactId` the CRM sink returned, the existing contact included. So the Bob spoof also subscribes Bob. `service-desk/intake.ts` attaches the ticket to Bob. | **Out of this ADR's scope, recorded as residue and an owner decision** (product decision 4 below). The owner's decision 3 was about the session link. A double-opt-in confirmation is the industry cure, and ADR 0849 H5 already named it out of scope. `contactCreated` is visible in-loop (crm registers first), so a follow-up can gate on it. |
| H2 | The D7 activity is an anonymous write into a store capped at 5,000 per org (`activities.ts:146`). A per-submission id lets a bot fill the cap. | The id is `act:form-sub-<sha256(formId, contactId, UTC day)>`, so there is at most one activity per form, per contact, per day. It writes under `form.orgId`, with the commerce validators (deal and company refuse; the contact must be in the tenant). Best-effort: if the cap is reached, the append fails and is logged, and the capture still succeeds. |
| H3 | D2 overrides an admin's explicit `defaultMode:'opt-out'` for regulated or unknown visitors. Prod with no geo header makes every visitor unknown, so an opt-out tenant goes from recording to not recording. | Stated as a decision: **the floor out-ranks the tenant regime, for visitor analytics only.** The owner's rule is that regulated regions opt in. A ratchet leg pins opt-out policy + unknown region ⇒ 202. A CHANGELOG / upgrade note is added. |
| M1 | The Firebase `/api` rewrite and the direct `*.run.app` URL both pass client headers through. So a named header is trustworthy only if every ingress overwrites it. | **Kept, with the reason stated in D1:** a forged region changes the default only for the forger's own data, never a third party's. The operator docs (FEATURES row + `.env.example`) say: set the variable only when every ingress path overwrites that header. A shared-secret header was considered and rejected, because it guards against a harm that is self-regarding. |
| M2 | `owp:vk` is one key for the whole origin, but the decision is per org (`host-site` and every tenant's `/fn/:orgId`). A denial on org B would delete org A's key, and one key would be shared with several tenants. | The key becomes **`owp:vk:<orgId>`**. The legacy global `owp:vk` is deleted unconditionally on first use. A denial removes only that org's key. Two orgs of one tenant mint two `visitor:` subjects, which is accepted. |
| M3 | `DocsPublicPage` renders `FrontPage`, so docs get the banner. The reserved `host:site` tenant has no admin who could write a policy, so its regime is always the code default. `FunnelViewerPage` must not write storage during render. | All three are stated. The funnel viewer reads the key in an effect. |
| M4 | `GET /public-consent/:orgId/:token` with no record answers `defaultMode: policy?.defaultMode ?? 'opt-in'`, which contradicts D2 for a non-regulated visitor. | It answers the D2 regime for the request. |
| M5 | D7 merge path. A `clientKey` replay returns the stored row, and the route would link the request's `sessionKey`. `deliver()`'s patch must carry the flag. The flag must come from the same sink as the `contactId`. | The link requires `submission.contactCreated === true` **and** `sessionKey === submission.meta.sessionKey`. `runSubmissionSinks` sets `contactCreated` only in the branch that adopts that sink's `contactId`. The `deliver()` patch merges it and includes it in its no-op equality check. A row released from quarantine never links (the release has no request), by design. The flag is not PII, so the eraser keeps it. |
| M6 | First-party forms send no `sessionKey` (`PublicFormRenderer.tsx:357-362`), so the Context 5 spoof is reachable only through the API. | Premise corrected: reachable by any direct API caller. The renderer still sends no `sessionKey`. The link lane exists for operator sites. Only the funnel `consentToken` is wired (B1). |
| L1 | A fixed bottom banner can hide the focused control (WCAG 2.2 SC 2.4.11). Moving focus to the footer after a choice jumps the viewport. | While the banner is shown, the page gets `scroll-padding-bottom` equal to the banner height. After a choice, focus returns to the element that had it before. The choice is announced through `GlobalLiveRegion`. |
| L2 | Storage that throws, or Safari's 7-day ITP purge, brings the banner back, and each click mints a new `visitor:` row in a store with no age-out. | The choice is also held in memory for the tab, so a throwing store does not re-ask within the session. The `unknown` decision neither writes nor SENDS an already-stored `vk`. Age-out of `visitor:` rows is recorded as residue. |
| L3 | The page read now depends on the token and the region, but sends no `Cache-Control`. | It sends `private, no-store` when a `vk` or a token is present. The header is added to `HOST_REQUEST_HEADERS`. |
| L4 | A region denial would log `basis:'unset'`. | The basis becomes `visitor-default:regulated` or `visitor-default:unknown`. It never includes the country. |


## Correction notes from `/grade-code` and `/grade-ux` (post-implementation, 2026-10-07)

`/grade-code` graded the change **B+** (no Blocker or High). `/grade-ux` graded it
**B** (no Blocker, three High). Each finding below was fixed unless marked residue;
the new legs were sabotage-witnessed red.

| # | Finding | Resolution |
|---|---|---|
| CODE M1 | A form submit with an invalid token passed NO capture, so the funnel attribution sink fell back to the legacy region-less decision: under an opt-out policy, an EU visitor with a forged token was attributed. | A live submit always passes a capture; a refused token is `visitorConsent: null`, which every sink treats as NOT consented. Leg: opt-out policy + forged token + funnel context ⇒ the completion carries no visitor. |
| CODE M2 | Geo-database sentinels (`XX`, `ZZ`, `T1`, `A1`, `A2`, `O1`, `AP`, `EU`) passed the two-letter check as a country, so "unknown" failed open. | They resolve to unknown. Leg added. |
| CODE M3 | The replay leg could not fail if either new guard rotted (each masked the other). | Positive control: the persisted row has `contactCreated: true`, and the SAME session's consented replay links. |
| CODE M4 | A stored token the server refuses (a rotated secret) kept a visitor who chose "allow" dark forever. | A beacon 400 naming `consentToken` re-records the same choice once per tab, minting a fresh token (`repairConsentTokenFrom`). Leg added. |
| CODE L2 | `visitorRegionVaryHeaders` had no caller. | Deleted. D4's `Vary` sentence is superseded: both per-visitor answers are `private, no-store`, which a shared cache never stores. |
| CODE L3 | The activity-failure log said `OpenwopError` for every cause. | It logs the error code. |
| CODE L1 | The page read with a `vk` reads the org twice. | **Residue**: one extra point read, only when a `vk` is present. |
| UX H1 | A failed Reject unmounted the region (the refusal was stored, so the banner stopped "asking"), hid its own error and dropped focus. | A failed save keeps the region open in its change form, with the error, and focus goes to its heading. Leg added. |
| UX H2 | `scroll-padding-bottom` alone left the end of the page (the footer, the privacy link) unscrollable from under the pinned region. | The body also gets matching bottom padding, both tracked by a ResizeObserver; the banner body links the privacy policy. |
| UX H3 | A failed posture read hid the footer control, so a visitor who had accepted could not withdraw. | The control renders whenever a choice is stored. Leg added. |
| UX M4/M5 | `disabled` dropped focus from the pressed button; opening from the footer focused Accept. | `aria-disabled` + a busy guard; opening focuses the heading (`tabIndex=-1`). |
| UX M6/L14 | Too tall at phone width; footer target ~18px. | Buttons `flex: 1 1 8rem`, Close `0 0 auto`; footer control `min-height: 24px`. |
| UX M8/L16 | Funnel end states dropped the control; on FrontPage the region preceded the content in Tab order. | Every funnel state carries it; FrontPage mounts it after the content. |
| UX M9 | The admin hint said "visitors" generally and its key said `NotEnforced`. | "Public site visitors…; other consent decisions do not read this list"; key renamed `regulatedRegionsHint`. |
| UX L11–L13 | The change form offered both choices; its copy misstated the opt-out default; the body omitted page-version assignment. | The change form offers the other choice only; copy fixed in four locales. |
| UX M10 | The privacy-panel line says "members" in a panel a member reads, and does not say whether "Opt out of product analytics" covers it. | **Kept verbatim** — the sentence is the owner's (2026-10-07). Whether the per-user opt-out covers nav telemetry is reported to main as a question. |
| UX L15 | Esc on `document` fired even when another overlay handled it. | Skipped when `defaultPrevented`. |

## Implementation record

| Phase | Commit (subject) | Witness |
|---|---|---|
| P1, P2 | `feat(consent): region-aware visitor analytics default, posture route, one visitor decision; forms link only created contacts (ADR 0860 D1-D4, D7)` | `adr0860-visitor-consent.test.ts`; six guards sabotage-probed red (D2 fallback, created-only, replay, per-day id, funnel helper, page helper) |
| P3, P4 | `feat(site): visitor consent banner + footer control, visitor key only after consent, nav-telemetry disclosure line (ADR 0860 D5, D6, D8)` | `visitorConsent.test.tsx`; the key rule and equal-prominence probed red |
| grades | `fix(consent): grade-code + grade-ux corrections (ADR 0860)` | M1, M2 (backend) and H1, H3 (frontend) probed red |

## Alternatives weighed

- **Change `isAllowed`'s unset-policy default to region-aware for every category.**
  Rejected. It would make every contact marketable by email, SMS and push outside
  the floor regions, under a regime no tenant chose. That is the ADR 0849 lawful-basis
  concern again. The default applies only to visitor analytics, the decision the
  owner made.
- **Write a default `consent:policy` row for every tenant.** Rejected: that is a prod
  data change, and the owner asked for a code-level default instead.
- **A fixed geo header (`X-Client-Geo-Location` / `CF-IPCountry`) read by default.**
  Rejected. Behind the Firebase door, nothing overwrites those names, so any client
  could set them. Opt-in by configuration is the honest default (D1).
- **Store the choice only in `localStorage`.** Rejected: that is a parallel consent
  store. The server would not know the choice, and the beacon could not honour it.
- **Await the posture before the first page read.** Rejected: it would add one round
  trip to every first public page view, for an experiment exposure (D5).
- **A modal, focus-trapping banner.** Rejected. A non-modal region does not block
  reading the page, and it is the WAI-ARIA-appropriate pattern for a notice that the
  page does not need answered in order to work. The equal-prominence buttons are what
  the guidance requires; a modal is not.
- **Keep linking existing contacts, but only for an email-verified submit.** Forms
  have no verification step. The email-click lane IS the verified link (D7).

## Boundaries audit and evaluation matrix (extension of `consent`, `analytics`, `forms`, `crm`, `site`, `settings-shell`; no new toggle)

| # | Dimension | Answer |
|---|---|---|
| 1 | Feature-package | `consent` (D1–D4), `analytics` (delegates), `publishing` (passes region and token), `forms` + `crm` (D7), `site` + `funnels` (D5/D6), `settings-shell` (D8), `chrome/PublicShell` (unchanged; see the D6 correction), `middleware/cors.ts` (one header). |
| 2 | Toggle + admin UI | None new. `consent` gates the posture route like the rest of its lane. |
| 3 | Workflow surface | None. |
| 4 | Node pack | Unchanged. |
| 5 | AI chat + envelopes | None. |
| 6 | Agent pack | None. |
| 7 | Public surface | One read route (D4), one optional request header (D3). Uniform 404 kept; no new write. |
| 8 | RBAC + isolation | Public lanes keep resolving the tenant from the org. The token stays tenant-bound (`verifyPublicSubjectToken`). |
| 9 | Replay / fork | Not touched. |
| 10 | Frontend | Banner + footer control + privacy line; four locales; lazy; no hex. |

**RFC verdict:** host-extension, no RFC. Every route is under
`/v1/host/openwop-app/*`. The header and the field are additive and non-normative.

## Ratchet (each leg born red on `90e7f78ee`, sabotage-witnessed)

`backend/typescript/test/adr0860-visitor-consent.test.ts`:

- **Region.** Unset header env ⇒ unknown ⇒ opt-in. A configured header with `FR` ⇒
  opt-in; with `US` and subdivision `USNY` ⇒ opt-out; `US` and no subdivision ⇒
  opt-in; `CA` ⇒ opt-in; a malformed value ⇒ opt-in.
- **Default without a policy.** Beacon with no token: regulated region ⇒ 202
  `recorded:false`; non-regulated ⇒ 201. A policy can add a region and cannot remove
  `EEA`. A tenant with `defaultMode: 'opt-in'` stays opt-in outside its list.
- **Scope of D2.** Without `visitorRegion`, `isAllowed(…, 'analytics')` and
  `isAllowed(…, 'marketing.email')` under an unset policy stay `false`.
- **Token wins over region.** A non-regulated visitor who recorded `analytics:false`
  is not recorded.
- **Posture.** The route returns `regime` only, with `no-store`, and 404s when the
  toggle is off.
- **Page read.** An experiment assigns for a non-regulated `vk` with no token, and
  for a regulated `vk` with a granting token in the header. It does not assign for a
  regulated `vk` with no token.
- **D7, the spoof leg.** Bob is an existing contact. A submit with Bob's email,
  `sessionKey: 'vk-…'` and consent granted writes NO link for that session, and
  appends exactly one activity to Bob. A second submit that creates a NEW contact
  links its session.
- **D7, the verified leg.** An email-click (`owx`) beacon still links a session to
  an existing contact.

Frontend: `features/site/__tests__/visitorConsent.test.ts` (no `owp:vk` write under
opt-in until Accept; removal on Reject or withdrawal; write under opt-out unless
opted out; nothing written on a posture failure) and
`VisitorConsentBanner.test.tsx` (equal-variant buttons, keyboard, focus return,
Esc, four-locale key parity via `check-i18n`).

## Phased implementation

| Phase | Scope |
|---|---|
| P1 | D1–D4 server + ratchet legs |
| P2 | D7 forms/CRM + legs |
| P3 | D5/D6 client + tests |
| P4 | D8 line; doc corrections (consent header, ADR 0857 decision notes, FEATURES) |

## Product decisions for the owner

> **OWNER DECISIONS 2026-10-07** (relayed by main):
> - **A — ship as is.** Every visitor sees the opt-in banner while no geo header
>   exists. MEASURED by main: no geo header reaches prod (Cloud Run adds none, the
>   Firebase Hosting rewrite adds none, and no external load balancer is in front;
>   the #4516 rollout witness logged the Firebase hop's raw requests). The region
>   split comes later, through a fronting load balancer (the same one #4516's
>   residue needs); `OPENWOP_GEO_COUNTRY_HEADER` stays as the operator's switch.
>   This answers decision 1 below and the open question.
> - **B — approved, as a SEPARATE follow-up PR** after this one merges: a form's
>   email opt-in grants only when the submission CREATED the contact, plus double
>   opt-in for existing contacts as its own project. Decision 4 below; residue
>   until then.
> - **C — approved, as a SEPARATE follow-up PR:** the per-user "Opt out of product
>   analytics" preference must also cover nav telemetry (ADR 0512). Residue until
>   then. This PR adds only the D8 disclosure line and leaves the toggle and the
>   beacon unchanged.

1. **Prod shows the opt-in banner to every visitor until the edge supplies a region.**
   No geo header reaches the service today, so every region is unknown, and unknown
   is regulated. To get "allowed elsewhere" for real, the operator must put a load
   balancer (or an edge that overwrites a geo header) in front, then set
   `OPENWOP_GEO_COUNTRY_HEADER`. That is an infra and env change, not made here.
2. **Should the floor include more regions?** Switzerland (revFADP), Brazil (LGPD)
   and Québec (Law 25) are candidates. The floor is the owner's three. Canada is
   matched only because of the `CA` ambiguity.
3. **Tenants with the `consent` toggle OFF** get no banner (the lane 404s), and
   therefore no first-party `vk`. Their web vitals and experiment stickiness stop.
   The server is still permissive for them. Prod has no such tenant today (the
   toggle resolves ON for all).

4. **(architect H1) A form's email opt-in subscribes an EXISTING contact.** Someone
   who types Bob's email and ticks the box sets `marketing.email:true` on Bob.
   Options: double opt-in (a confirmation mail) for an existing contact, or grant
   only when the submission created the contact. Not changed here.

## Residue

- `campaign-connectors` pixels and conversions keep the unset-policy deny (D3).
- `visitor:` consent rows have no age-out (architect L2).
- **Owner decision B (follow-up PR):** a form's email opt-in sets
  `marketing.email:true` on an EXISTING contact matched by email (architect H1).
  Grant only for a created contact; double opt-in for existing ones. The
  service-desk attach to an existing contact goes with it.
- **Owner decision C (follow-up PR):** the per-user "Opt out of product
  analytics" preference does not yet cover nav telemetry.
- The page read with a `vk` reads the org twice (grade-code L1).

## Open questions

- [x] Does the measured prod request carry any geo header? **No** (main,
  2026-10-07; owner decision A). Every prod visitor is asked until a fronting load
  balancer sets one.
