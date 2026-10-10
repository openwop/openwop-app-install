# ADR 0857 — Analytics: a session key is its own keyspace, the run surface projects like the route, and the beacon honours consent recorded through the public lane

Status: implemented (2026-10-07; Accepted after the pre-code `/architect` pass, then corrected by `/grade-code` — see the correction notes and the implementation record; feature loop round 2 row 33, branch `feat/fl2-33-analytics`)

Builds on ADR 0018 (analytics), ADR 0020 (the one consent rule), ADR 0226 (the
session↔contact identity floor), ADR 0381 (the subject-key resolver), ADR 0569 (cookieless
visitor identity), ADR 0586 / CONS-2 (the public consent lane's `visitor:` keyspace and
`subjectToken`), ADR 0651 (beacon identity-link forgery, experiment re-derivation, typed
surface refusal), ADR 0657 D12 (two-hop key closure), ADR 0832 (the org floor in `gate()`),
ADR 0849 (consent is tenant-wide and admin-tier) and ADR 0851 (`clientIp` is the only IP
reader).

## Context

Round 1 closed Analytics at WF/UX/CODE **B / A− / B+**. This pass re-measured it on
`origin/main` @ `54e629220`. Each finding marked **RED** was witnessed failing by
`backend/typescript/test/adr0857-analytics-identity-boundary.test.ts` on that commit before any
fix (8 of 8 legs red; the log is in the PR).

ADR 0651 D1 closed the forgery it found: the email-click token is claimed by the first
session that presents it. It did not close the class. The class is that an identity link
is written from a **client-chosen string**, and the ADR 0381 resolver then reads that string
as if it belonged to the session keyspace.

1. **Erasing one person erases another (RED).** The public form submit takes
   `body.sessionKey` verbatim, capped at 1024 chars (`forms/routes.ts:289`), and writes
   `linkSession(tenant, sessionKey, submission.contactId, 'form-submit')` (`:339-345`). The
   gate is `isAllowed(…, 'analytics')`, which passes by default because the `consent`
   toggle is off. `submission.contactId` is the **existing** contact when the email matches
   one (`crm/formsSubmissionSink.ts:82-86`). The resolver
   (`analytics/identityLinkService.ts:131-139`) calls `contactForSession(tenant, subjectKey)`
   for **every** DSAR subject key. The only guard is on the other hop, and it filters only
   `crm:` keys.

   So an anonymous visitor can submit a published form with Bob's email and
   `sessionKey: 'alice@example.com'`. That writes the link `alice@example.com → crm:<bob>`.
   A later DSAR erasure for Alice, keyed by her email (the normal key), resolves Bob's
   contactId in hop 1 (ADR 0657 D12 closure) and erases Bob's contact. The witness shows
   Bob's contact gone after `eraseSubject(T, 'alice-legacy@example.com')`. Every DSAR key
   shape can be planted this way: an email, a raw E.164 number, a bare-UUID userId, a
   `crm:` contactId, a `visitor:` key. The email-click writer has the same shape, since
   its `sessionKey` is the beacon's, but ADR 0651's claim means the attacker needs a real
   token.
2. **The run surface returns what the route stopped returning (RED).** ANL-15 projected the
   `/events` HTTP response to the declared client shape, because `visitorHash`, `clickIds`
   (gclid/fbclid/ttclid/li_fat_id), `owx` and the experiment stamp were reaching every
   `workspace:read` member. `ctx.features.analytics.events` (`surface.ts:13-17,28-31`)
   strips only `tenantId`. So every run that calls it gets all four, and so does any model
   that sees the run. One exit was fixed and the other was not. The node is unbound today
   (`WF-ANL-4`), but builder-authored workflows can bind it.
3. **A visitor's recorded refusal does not reach the beacon (RED).** The beacon evaluates
   consent only for `body.sessionKey` (`analytics/routes.ts:94-104`). The only consent a
   visitor can write is through `POST /public-consent/:orgId`. That lane mints its own
   subject `visitor:<uuid>` and refuses a caller-chosen key (CONS-2,
   `consent/routes.ts:131-139`). The two keyspaces never meet. Under `opt-out`, a visitor who
   recorded `analytics:false` is recorded anyway. Under `opt-in`, no visitor can grant, so
   the beacon records nothing for anyone; `analytics-route.test.ts:259-265` admits this and
   grants through the service. The CONS-2 docblock names the intended join
   (`analytics:identity-link`), but nothing implements it.
4. **Two stores never expire (RED).** `analytics:identity-link` is the most re-identifying
   artifact the feature holds (ANLWF-6), and `analytics:nav-counts` holds weekly rows.
   Neither registers a retention purger, so both grow until tenant teardown. This was
   carried as `ANLWF-12`.
5. **The cookieless claim is false at the client.** ADR 0569 rejected "Cookie / localStorage
   id" (`0569:22`), and `visitorIdentity.ts:6` says "No cookie, no localStorage". The
   first-party renderer mints `vk-<uuid>` into `localStorage['owp:vk']` on every public page
   load, before the server checks any consent (`site/visitorBeacon.ts:19-33`,
   `FrontPage.tsx:165`). It sends it as `?vk=` (experiment assignment) and as the beacon
   `sessionKey`. The server-side **visitor dimension** is cookieless. The page as shipped is
   not.

What is sound, so it is not re-audited: the org floor holds at `gate()` for the run surface
(ADR 0832 D1; analytics needs no per-method call). The routes use `authorizeOrgScope`. The
chat tool uses `resolveReadOrgScope` (principal, toggle and plan, `workspace:read`). The beacon
tenant comes from the org. The visitor hash reads `clientIp`, is computed only after consent
passes, and is never stored raw. Erasure of the event store reports partial failure, and the
experiment stamp is re-derived (ADR 0651 D3).

## Decision

**D1 — a session key is a closed grammar, and only that grammar is ever linked or resolved.**
`isLinkableSessionKey(k)` accepts `^[A-Za-z0-9_-]{1,128}$`, minus two shapes that collide
with DSAR identities: a bare UUID (a userId) and an all-digit string (an unprefixed phone
number). The grammar excludes `:` (every prefixed keyspace: `crm:`, `visitor:`, `user:`,
tenant ids), `@` (email), `+` (E.164), `.` and whitespace. The first-party key
`vk-<uuid>`, the demo seed's `demo-cdp-sess-N` and every key in the existing tests pass.

- `linkSession` returns `null` for a non-linkable key. Both writers go through it, so neither
  can mint the row.
- `contactForSession` returns `null` for a non-linkable key, and `sessionsForContact` drops
  non-linkable keys. So a row a pre-0857 writer already planted is inert in the resolver,
  CDP identity and lead score, with no migration. The resolver's `looksLikeContactId` filter
  is replaced by the grammar, which is a superset of it.
- Events are still **recorded** with any `sessionKey`. The grammar governs identity, not
  measurement.

*Residual, stated:* the event eraser still matches `sessionKey === subjectKey`. So a DSAR
for `alice@example.com` also deletes anonymous rows an attacker posted under that string,
and (hop 2) the attacker's own hashed rows. That is over-erasure of anonymous telemetry,
the posture ADR 0569 already accepts. It cannot reach a contact or another subject's
data.

**D2 — one projector for every exit of an event row.** `toEventView(e)` in
`analyticsService.ts` produces the declared client shape. The `/events` route and
`ctx.features.analytics.events` both call it. `visitorHash`, `clickIds`, `owx`, `experiment`,
`experimentDropped` and `tenantId` never leave through either exit. The witness asserts the
absence of each key by name.

**D3 — the beacon accepts the visitor's consent token.** `POST …/collect` (and the form
submit's link gate, which mirrors it) takes an optional `consentToken`, the `subjectToken`
the public consent lane minted.

- **Absent:** unchanged. Consent is evaluated for `sessionKey`.
- **Present:** it must verify for the beacon's tenant (`verifyPublicSubjectToken`), and
  consent is then evaluated for the `visitor:<uuid>` subject it names. A
  supplied-but-invalid token is a typed **400** (`validation_error`, field
  `consentToken`). It is never a silent fall-back to `sessionKey`, because that would record
  under a regime the visitor did not choose (the CONS-2 / ADR 0586 D3 rule). The 400 names
  the exit: drop the field, or re-mint through the consent lane.
- One helper, `analyticsConsentAllows(tenantId, sessionKey, consentToken)`, serves both
  callers, so the beacon and the link writer cannot disagree.

The first-party renderer ships no consent banner, so it sends no token. This decision makes
the gate reachable for an operator's banner. It does not add a banner.

**D4 — both un-purged stores age out on the existing seam.** `registerRetentionPurger`:

- `analytics:identity-link`: `confidential-pii`, aged on `at`, read through the bounded
  `${tenantId}::` prefix.
- `analytics:nav-counts`: `internal`, aged on the **end** of its ISO week. A week is purged
  only when the whole week is older than the cutoff, which errs toward retention.

Both use `purgeRowsByAge`, so a per-row failure is counted rather than fatal.

**D5 — say what is true about the client key.** Correct ADR 0569 (inline note) and the
`visitorIdentity.ts` header. The visitor *dimension* is cookieless. The first-party
renderer stores a durable `vk` in `localStorage` for experiment stickiness and the beacon
session. Whether that key may be written before consent is a **product decision**
(decision 2 below). This ADR does not change the client.

**D6 — witnesses for the carried gaps that are pure test debt.**

- The agents pack's `toolAllowlist` ↔ `ANALYTICS_QUERY_TOOL_ID` parity (ANLWF-10, the CFP-1
  defect class).
- The consent-202-stores-nothing leg (ANLWF-9; asserted in the D3 witness).
- An analytics leg in `adr0832-org-scope-seam-probes.test.ts` for the run surface.

## Boundaries audit and evaluation matrix (extension of `analytics`; no new toggle)

- **No new route, store or toggle.** D3 adds one optional body field to an existing
  public route. D4 registers on the existing `registerRetentionPurger` seam. D2 is a
  function both existing exits call.
- **Single owners composed, not forked.** Consent tokens belong to
  `consent/publicSubjectToken.ts` (`verifyPublicSubjectToken`); analytics only calls it.
  Consent evaluation stays in `consentService.isAllowed`, the one rule (ADR 0020). The
  identity link stays in `identityLinkService`, the ADR 0226 owner.
- **Matrix rows:**
  1. Package: unchanged.
  2. Toggles: `analytics` ON and `analytics-visitor-identity` ON. `workspace-nav-telemetry`
     is **unchanged (currently ON in prod via beta-without-cohort; owner decision pending)**.

     > **CORRECTED 2026-10-07 (main, prod read).** This line first said nav telemetry was
     > "OFF and not touched", which was taken from the spawn brief. The compiled default
     > is OFF, but the stored prod row is `beta` with no `betaCohort`, which resolves ON
     > for every tenant. `POST /analytics/paywall` answers 202 live.
     >
     > So nav-counts and the paywall beacon are **live data paths**:
     > - the D4 nav-counts purger acts on real rows (702, back to 2026-W32);
     > - the non-atomic nav increment (a counts-only undercount) is live too.
     >
     > Nav telemetry is member telemetry under ADR 0512's disclosure posture, not visitor
     > consent, so D3 does not gate it. This ADR changes neither the default nor the stored
     > row.
  3. `ctx.features.analytics`: D2.
  4. Node pack: unchanged; the output shape is narrowed at the surface, so no pack bump.
  5. Envelopes: none.
  6. Agent pack: unchanged, plus a D6 parity witness.
  7. Public surface: D3. Tenant still comes from the org, the uniform 404 holds, and the
     per-org budget runs first.
  8. RBAC: unchanged, and verified clean (see Context).
  9. Replay: the nodes are pure reads, already pinned.
  10. Frontend: no change this ADR (decision 2 would be the first).
- **RFC verdict: host-extension, no RFC.**

## Competitive alignment (`docs/steward/UX_UPGRADE-analytics.md`)

- **Plausible / Fathom.** ADR 0569 already adopts their visitor dimension (cookieless,
  daily salt). Their positioning is "no cookie, no device storage, no banner". Our
  first-party `vk` breaks that positioning, which is why D5 corrects the claim and
  decision 2 asks the owner.
- **GA4 / PostHog.** Their convention is that the measurement tag carries the consent
  state the banner captured: GA4's consent-mode signals, PostHog's opt-out state. The tag
  does not guess consent from its own identifier. D3 is that convention on our lane.
  This convention was read off the products; it is not a sourced vendor claim, because
  the session's web-search budget is spent (see the UX_UPGRADE round-3 note).
- **No competitor turns an anonymous submission into an erasure edge.** PostHog's person
  deletion and GA4's user-deletion API act on identifiers the operator holds, never on a
  key a visitor typed. D1 brings us to that floor.

## Alternatives weighed

- **D1 as a denylist** (refuse `@`, `crm:`, `visitor:`, `+`). It is open-world: the next
  identity shape (a WhatsApp id, a new prefix) would reopen the hole silently. The closed
  grammar is the repo's rule for model and visitor input reaching durable state.
- **D1 as "link only when the form CREATED the contact".** This closes the
  existing-contact hijack (decision 1 below), but not the planted-key over-erasure. A newly
  created contact plus `sessionKey: '<Alice's email>'` still links Alice's key. The grammar
  is needed either way, so the created-only rule is offered as an additional product
  choice.
- **D3 by writing a `visitor:` ↔ session identity link.** `identity-link` maps a session to
  a CRM *contact*, and a `visitor:` subject is not one. Overloading the table would put a
  non-contact on the contact side of every resolver hop. The token is verified per request
  instead, and no new durable mapping is created.
- **D3 failing the invalid token open (202 `reason:'consent_token_invalid'`).** A beacon is
  background traffic, so a quiet 202 is tempting. But the 400 is the CONS-2 precedent for
  the same token, and a 202 would look identical to a real refusal.

## Product decisions for the owner

1. **Form-submit links to an EXISTING contact.** Today a submission whose email matches an
   existing contact links the submitter's session to that contact. Someone who knows Bob's
   email can therefore attach their own browsing (funnel views, conversions) to Bob's lead
   score and attribution. Options: keep it (status quo, since a returning visitor re-identifies
   by submitting), or link only when the submission created the contact. **Recommendation:
   created-only.** The email-click lane already re-identifies returning contacts with proof.
   Not implemented without the owner's call.
2. **The `vk` localStorage key before consent.** Options: keep it (status quo; experiment
   stickiness and session counts depend on it), or, when the tenant's consent posture
   requires it, hold the key in memory until consent is recorded. The second needs the public
   page read to expose the posture. Not implemented without the owner's call.

## Phased implementation

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1 grammar + both writers + both readers + the resolver | `adr0857…` D1 legs |
| P2 | D2 projector | D2 leg |
| P3 | D3 `consentToken` on the beacon and the form link gate | D3 legs |
| P4 | D4 two purgers | D4 leg |
| P5 | D5 doc corrections; D6 witnesses | parity + probe tests |

No RFC: every surface here is a host-extension route (`/v1/host/openwop-app/*`) or an
in-process seam. `consentToken` is an additive optional body field on a non-normative
route.

## Architect pass corrections (pre-code, 2026-10-07)

The adversarial pass read every subject-key resolver, the token lane and the purger seam
against the decision text. It found one High issue and three Medium issues. Each one
changes a decision above, and the decision text stands as amended here.

- **A1 (High, data integrity) — D3 as written lets a token resurrect an erased session.**
  "Present: consent is evaluated for the `visitor:<uuid>` subject" ignores the
  `sessionKey`. If the vk itself was DSAR-erased, its tombstone lives on the vk, not on the
  visitor subject. A valid granting token would then resume recording under a key the
  operator erased. That is the "nothing resurrects an erased subject" non-negotiable
  (FRMCD-1 / EMWF-3 class). **Amended D3:** with a token, the beacon records only if the
  token subject is allowed AND the `sessionKey` (when non-empty) is not
  erasure-tombstoned (`isErasureTombstoned`). The witness gains a tombstone leg.
- **A2 (Medium) — the email-click writer would burn a token on a refused key.**
  `recordEvent` calls `claimClickTokenForSession(owx, sessionKey)` before `linkSession`. With
  the D1 grammar, a non-linkable session would CLAIM the token, have the link refused, and
  strand the token, so the real recipient's later click links nothing. **Amended D1:** the
  owx branch checks `isLinkableSessionKey` before it claims.
- **A3 (Medium) — D1's premise is a claim about the resolver set.** The grammar is safe only
  if no OTHER identity space mints grammar-legal keys. Measured at HEAD, there are four
  resolvers:
  - analytics: session ↔ contact.
  - crm: email or `+phone` → `crm:`.
  - users: userId → email. New ids are `user:<hex>`; legacy randomUUID-era ids are bare
    UUIDs, which is why bare UUIDs are excluded.
  - kicktodo: subject ↔ contact. The subject is `order.createdBy`, a principal or userId
    shape that always carries `:` or is a bare UUID.

  None of these collide today. A fifth resolver could. **Amended D6:** a tripwire pins the
  registered resolver set by function name. A new resolver reds it, and the failure message
  names this ADR's grammar as the thing to re-check.
- **A4 (Medium) — the D4 week math must hold at the ISO-year boundary.** ISO week 1 can
  start in the previous calendar year (2020-W01 starts 2019-12-30). The end-of-week
  derivation anchors on 4 January of the ISO year and is pinned by a cross-year leg. It is
  not derived from the calendar year.
- **Kept as decided (trade-off recorded):** a supplied `consentToken` is validated even when
  the `consent` toggle is off. A stale token after a session-secret rotation therefore 400s
  until the banner drops it. The alternative is ignoring the token when consent is off. That
  would make the same request mean different things depending on a toggle the caller cannot
  see, and the 400 already names its exit.
- **Checked and clean:**
  - Cross-org replay of a token inside one tenant is consistent, because consent is
    tenant-wide (ADR 0849).
  - Under D1, an existing-contact link (decision 1) reaches only the attacker's OWN rows in
    an erasure. Hop 2 keys are not re-fed, and no other resolver maps a `vk-` key anywhere.
  - CDP's cookie fallback (`cdp/identityService.ts:109`) loses only links that D1 forbids
    writing.
  - `forms` already imports `analytics` (`linkSession`), so the helper adds no new feature
    edge.

## Correction notes from `/grade-code` (post-implementation, 2026-10-07)

- **H1 — the grammar and the store saw two different strings.** `linkSession` and
  `contactForSession` ran `cleanString` (which calls `scrubSecretShaped`) before the
  grammar check. `scrubSecretShaped` rewrites any run of 40 or more `[A-Za-z0-9_-]`
  characters, so a legal 64-character SDK session id passed the `recordEvent` pre-check,
  claimed the click token, and then failed inside `linkSession`. That is the A2 defect by
  another door. Both functions now check and store the RAW key; the grammar already
  bounds it. A 72-character witness was sabotage-probed red against the cleaned form.
- **M1 — residual, accepted on prod evidence.** `sessionsForContact` drops keys outside the
  grammar. So a legitimate pre-0857 link under, say, a bare-UUID session id is no longer
  expanded when its contact is erased. The link row itself is still deleted
  (`eraseSubjectLinks` matches `contactId` without the filter), but events under that
  session survive until retention. Prod measured **40 of 40** link rows grammar-legal
  (one demo tenant, `demo-cdp-sess-N`; main, 2026-10-07 ~17:30Z), so no live row is in
  this population. The output direction has to stay filtered: unfiltered, a planted
  `alice@…` would be fed into Bob's erasure as a subject key, and the CRM resolver would
  then reach Alice.
- **L1:** a form-submit link skipped because of an invalid token now logs
  `forms_identity_link_skipped`; the swallow was silent. **L2:** the nav row key has one
  definition (`navKeyOf`). **B1:** `docs/FEATURE-DEPENDENCIES.md` regenerated. `forms`
  now reaches `consent` only through `analytics/consentGate`.

## Implementation record

| Phase | Commit (subject) | Witness |
|---|---|---|
| P1–P4, D6 | `fix(analytics): session-key grammar, one event projector, consent-lane token, two purgers (ADR 0857 D1-D4, D6)` | `adr0857-analytics-identity-boundary.test.ts`: 8 legs born red on `54e629220`; each D sabotage-probed red |
| P5 (D5) | `docs(analytics): correct the no-localStorage claim (ADR 0569 note, visitorIdentity header) + FEATURES row (ADR 0857 D5)` | — |
| UX | `feat(analytics): disclose that figures are consent-filtered …` and `fix(analytics): route plan refusals through the entitlement seam …` | `consentFilterNote.test.tsx` (sabotage red), `planRefusalRefresh.test.ts` |
| grade-code | `fix(analytics): grammar and store see one raw session key; …` | the H1 leg (sabotage red) |

## Prod facts this ADR leans on (main, read-only, 2026-10-07 ~17:30Z)

- 40 identity-link rows, all grammar-legal (D1 invalidates nothing live). There are
  702 nav-count rows, the oldest from week 2026-W32 (D4 has real work to do).
- **`consent` is effectively ON for every tenant.** It is stored as `beta` with no cohort,
  which resolves ON for all. Only one tenant has a `consent:policy` (opt-in); every other
  tenant has none, and `isAllowed` DENIES under an unset policy. So in prod today the
  beacon records nothing for any visitor who has no consent record, which is every
  visitor, since nothing first-party writes one. This ADR does not change that. D3 makes
  it fixable by an operator's banner, and the new page note (ANL-UX-23) now says so. It is
  recorded as owner decision 3 below.

> **RESOLVED 2026-10-07 (ADR 0860).** The owner decided all three product decisions:
> decision 1 is **created-only** (ADR 0860 D7); decision 2 is **write `vk` only after
> consent**, per org (ADR 0860 D5); decision 3 is **(b), a first-party banner** with a
> code-level, region-aware default instead of any prod policy write (ADR 0860 D1–D6).
> D3's helper moved to `consent/visitorConsent.ts`; `analytics/consentGate.ts` delegates.

## Product decision 3 (added on the prod evidence)

3. **Prod analytics records (almost) nothing, by consent.** Options: (a) leave it; the
   page now says why. (b) Ship a first-party consent banner on public pages that mints a
   token and sends it with the beacon; this is new UI with legal copy and a separate ADR.
   (c) Set a tenant `consent:policy` default. That is a prod data change, and only the
   owner can make it. **Recommendation: (b), as its own ADR.** (c) changes a legal posture
   for tenants who never chose one.

## Open questions

- [x] Does the D1 grammar break a live key? **No.** In prod, 40 of 40 rows pass, and none
  is a UUID or all digits (main, 2026-10-07).
