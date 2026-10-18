# ADR 0887 — Sharing: the publisher is re-checked on every read, the expiry answer comes last, public responses are never cached, and a dark link can be adopted

Status: implemented (2026-10-14, branch `feat/fl2-44-sharing`; adversarial `/architect` pass before code, amendments below)
Date: 2026-10-14
Feature: Sharing (ADR 0013) · feature loop round 2, row 44
Extends ADR 0013, ADR 0644 · Composes ADR 0886 D3 (the re-checked present remote), ADR 0448 (capability tokens), ADR 0464 (erasure), ADR 0819/0820 (the visitor/member mint lanes)
Source: `/grade-workflows sharing` 2026-10-14 (`docs/steward/WORKFLOWS-ASSESSMENT.md`, ids `SH2WF-1..3`) + the row-44 security probes (`backend/typescript/test/adr0887-sharing-probes.test.ts`, 6/6 RED on `origin/main` @ `132c1ea07`)

## Context

A share link is a grant: a member with `workspace:write` publishes a resource, and the
token becomes a public, unauthenticated read. The mint checks who may grant it. Nothing
checks it again.

### S1 — a link outlives its publisher (High)

`POST …/sharing/orgs/:orgId/links` runs `requireOrgScope(req, 'workspace:write')`
(`sharing/routes.ts:46`). `resolveActiveLink` (`sharingService.ts:1056-1120`) checks the
token, revocation, expiry, the org↔tenant binding, the owning toggle and the view cap.
It never looks at `link.createdBy`. MEASURED: after the publisher is removed from the
org, `/shared/:token`, `/card` and `/frame-view` all answer as before. The same holds
after the publisher is demoted to Viewer. ADR 0886 D3 fixed exactly this for the
present-remote token; share links are the older and larger instance of the class.

### S2 — a link outlives the publisher's access to the resource (High)

The mint asks the resolver whether the minter may publish (`validate(…, {subject})`,
`:797`; ADR 0644 D1). The answer is not re-asked. MEASURED: a `shared` prompt that a
second member published keeps serving its body after its owner makes it `private`.
`SHWF-11` (a KB collection that becomes subject-bound keeps serving) is the same defect
on another type.

### S3 — the expiry answer is given before every other gate (Low, oracle)

`resolveActiveLink` answers `410 {reason:'expired'}` at `:1089`, before the org, toggle
and view-cap gates. R2 SR-10 made the 410 deliberately: an expired link is a benign
lapse, and saying so is honest. But a link that is ALSO dead for a reason the uniform
404 exists to hide (a deleted org, a disabled feature, a removed publisher) still says
"this token existed". MEASURED with a removed publisher.

### S4 — public share responses carry no `Cache-Control` (Medium)

None of the three public routes set a cache header (`routes.ts:68-90`). Express sets an
`ETag`, not a `Last-Modified`, so browsers do not cache heuristically, and Firebase
Hosting's documented behaviour is to cache a Cloud Run response only when it opts in
(`public` / `s-maxage`). So no cache is KNOWN to hold these today — not verified
against prod, which needs a prod read. But a capability-token response whose freshness IS the revocation
mechanism must say `no-store` rather than depend on every hop's default. The publishing
lane already does this for its token-bearing reads (`publishing/routes.ts:141`).

### S5 — the owner list shows readers titles they cannot read (Medium)

`GET …/links` is `workspace:read` (`routes.ts:38`) and annotates every link with its
resource's live `cardTitle` (`listLinks`, `:976-1031`). MEASURED: a Viewer sees the
title of another member's `private` prompt. The same path exposes the title of another
user's conversation.

### What is clean (probed, not assumed)

- **Viewer mint:** 403 (`sharing-route.test.ts`). **Cross-org/tenant:** the org↔tenant
  binding plus a per-(tenant, org) `validate`; the IDOR test pins 404.
- **XSS on the public viewer:** `ui/Markdown` renders no raw HTML (no `rehype-raw`) and
  `react-markdown`'s `defaultUrlTransform` strips `javascript:`. The app-builder and
  slides renderers pass every `href`/`src` through `safeHref`/`safeImageSrc`
  (`AppBuilderPreview.tsx:37-45`, `SlidesPreview.tsx:25`). The quote viewer's redirect
  target is the server-created Stripe session URL.
- **Tokens:** `mintToken('shr')` from the ADR 0448 home (`host/capabilityToken.ts:40`),
  32 random bytes, sha256 at rest; the public lane hashes unconditionally.
- **Rate limits:** the global per-IP read (600/min) and write (60/min) budgets cover
  `/shared/*`; enumeration of a 256-bit space is not a rate-limit question.
- **DSAR:** `eraseSubjectSharing` revokes and anonymizes `createdBy` and is witnessed
  through the registry (ADR 0644 D5).
- **Timing:** an unknown token costs one more point-get (the ADR 0448 legacy view) than
  a revoked one. Only a holder of a once-valid 256-bit token can observe it, and that
  holder already knows the token existed. Accepted, not fixed.

## Decision

### D1 — one publisher-entitlement predicate, run at mint, on every read, and by the list

Each resolver gains a REQUIRED hook beside `toggleId`:

```ts
/** May `subject` publish this resource? `null` = yes. An OpenwopError = no, and is
 *  what the MINT throws. ABSENCE is not this hook's question: a resource that no
 *  longer exists answers `null` here and `load` reports it gone. */
entitlement(tenantId, orgId, resourceId, subject): Promise<OpenwopError | null>;
```

The subject checks move out of `validate` (existence + status only) and out of
`createLink`'s inline owner checks into this hook, so ONE function decides:

| type | entitlement |
|---|---|
| `prompt` | `readableBy(entry, subject)` (was in `validate`) |
| `document` | `canReadDocument(…, subject)` (was in `validate`) |
| `kb_collection` | the collection exists unfiltered ⇒ it must resolve for `subject` (was in `validate`; closes `SHWF-11`) |
| `app_builder_canvas`, `slides_canvas` | `getCanvasForCaller` + `canvasWriteAllowed` (ADR 0886 D1) + the user-owner rule (was inline in `createLink`) |
| `conversation` | the owner rule (was inline in `createLink`) |
| `cms_page`, `commerce_quote`, `commerce_order`, `creative_brief`, `booking_manage`, `sign_request` | `null` — org-scoped resources: the org write below is the whole entitlement. Each says so in place (the `toggleId: null` discipline). |

`assertPublisherLive(link)` runs in `resolveActiveLink`, the chokepoint every public
lane already shares (resolve, card, frame view, `assertLiveLinkFor`,
`resolveActiveResource`), after the owning-toggle gate:

1. **Visitor-lane mints are exempt.** A `createdBy` that starts with `system:` was minted
   by the host for a visitor (booking manage, e-sign, order receipt; ADR 0820). There is
   no publisher to re-check, and darkening a buyer's receipt when a staff member leaves
   would be wrong. Pinned by a test that enumerates every `createLink` call site's actor.
2. **The publisher is still PRESENT** — the three checks a mint request passes, not
   only the last one (architect H1): the user record is not `disabled`/`erased`
   (`resolveSessionSubject`, when the session authority is registered; "no row" is a
   seed actor, as in `delegationIssuerIsLive`); in a shared `ws:` tenant,
   `isWorkspaceMember(createdBy, tenantId)` (removal from the workspace root leaves
   sub-org twins); then `assertOrgScope(link.tenantId, link.createdBy, link.orgId,
   'workspace:write')`, the call `requireOrgScope` makes at mint (ADR 0886 D3's
   argument: never valid at mint and dead on first use, or the reverse).
3. `RESOLVERS[type].entitlement(…, link.createdBy, 'publish')` is `null`.

**Only a refusal darkens (architect M1).** A refusal is an `OpenwopError` with status
403 or 404, or a `false` from steps 2's presence reads. Anything else (a storage
error, a 503 from the session authority) is RETHROWN, never mapped to 404 — an outage
must not read as "publisher inactive", which D5 would then let someone take over.

**Freshness bound (architect H3).** `assertOrgScope` scans `customRoles` and `groups`
on every call, so the anonymous lane must not pay it per request. The result of steps
2–3 is memoized per `(tenantId, orgId, createdBy, type, resourceId)` for **30 s**
(bounded map, process-local). So a removal or demotion darkens a link within 30 s on
every instance, not instantly. The memo also bounds the demo-mode
`demo_owner_bypass_granted` WARN to one line per publisher per 30 s (architect M5).

**Ordering (architect M4).** The cheap view-cap pre-check runs BEFORE the publisher
check, so a spent link refuses without paying for it.

**Existence vs refusal (architect H2).** "Absence answers null" is decided by an
UNFILTERED existence read only (`getCanvasForTenant`, `getEntryUnfiltered`,
`getDocument`, a `PREAUTHORIZED_CALLER` collection read). A filtered read that returns
null for a caller it refuses (`getCanvasForCaller`) is never the existence test.

Any failure is the uniform reason-less 404, the same as a revoked token. This is a live
re-check, not a revocation: restoring the publisher's role restores the link (pinned).
`erased` links are already revoked (ADR 0464) and never reach step 2.

### D2 — the owner list says why a link is dark, and redacts what the reader can't read

`listLinks` takes the caller's subject. Per row:

- `publisherInactive: true` when D1 steps 2–3 fail for `createdBy`. The status chip is
  "Publisher lost access" (warning), and the row offers **Adopt** (D5).
- `cardRedacted: true`, and no `cardTitle`, when the CALLER is not the publisher and
  `entitlement(…, caller, 'read')` refuses. The hook takes a `mode`: `read` differs from
  `publish` only for canvases (read = `getCanvasForCaller`; publish adds
  `canvasWriteAllowed`), so a Viewer who can read a project canvas sees its title
  (architect M3). Presence checks are memoized per distinct `createdBy` within one call. Type, label, status and counts stay (a governance
  list must still show that the link exists). The label is the publisher's own text.

### D3 — the expiry answer comes after every other gate

The 410 moves to after the org, toggle, view-cap and D1 gates. A 410 is then only ever given for a link that
would be live but for the date. Revoked, never-existed, and dead-for-any-other-reason
stay byte-identical 404s.

### D4 — public share responses are `Cache-Control: private, no-store`

A route-local middleware on `/host/openwop-app/shared/*` sets the header before the
handler, so 200, 404 and 410 all carry it.

### D5 — upgrade: adopt a dark link so its URL survives a departure

Market basis: when a member leaves, Dropbox Business and Box both let an admin transfer
the member's content, and with it the member's shared links. A link that dies with its
publisher breaks every place the URL was pasted. That is the right default (D1), and
it needs a way back.

`POST …/sharing/orgs/:orgId/links/:token/adopt` (`workspace:write`):

- refuses (409 `validation_error`) unless the link is not revoked, not expired, is
  human-minted, and its publisher is inactive by D1 (a REFUSAL — never an error, M1). A live publisher's link cannot be taken over, so
  adopt is a recovery action, not a reassignment.
- runs the FULL member mint gate as the caller: `assertMintAccess` (toggle + plan),
  `validate`, `entitlement`. Adopting is publishing.
- CAS-writes `createdBy = caller` and `adoptedAt`. The token, the URL, the counts and
  the expiry are unchanged. No `adoptedFrom` field is stored, so no second
  person-identifier column needs DSAR. The previous publisher goes to the audit log
  (`shared_link_adopted`) as the hash prefix and the two ids, the same as other
  member-action logs.

- **Adopting ends a temporary inactivity for good** (architect L5): once adopted, a
  restored publisher does not get the link back. That is the intent — adopt is the
  answer to "they left" — and it is why adopt refuses while the publisher is present.

### Consequence stated: a quote link dies with its rep (architect M2)

`commerce_quote` is member-minted, so D1 darkens the buyer's view AND the Accept
(`assertLiveLinkFor`) when the rep leaves or is demoted. No money has moved before
Accept, and Stripe webhooks never ride share links, so the money invariants hold; it is
a sales outage, not a money one. D2's "Publisher lost access" chip and D5's adopt are
the recovery.

> **CORRECTED 2026-10-14 (`SH2CD-5`):** this paragraph first said "the list sorts dark links
> first in the owner view". Nothing sorts them; the page keeps its newest-first order and files
> "Needs a new owner" rows in the visible list (not the collapsed dead-links section).

### Alternatives weighed

- **Revoke on removal via `onMemberAuthorityLost` (ADR 0815 D4).** Rejected as the sole
  mechanism. It fires on removal and on losing `host:members:manage`, not on losing
  `workspace:write`. It cannot see S2 at all (a resource's access changing is not a
  membership event). And a revoke is one-way, so a mistaken removal would kill every
  link for good. A per-read re-check covers all three, and ADR 0886 D3 set the
  precedent.
- **Re-run `validate` at read.** Rejected: `validate` carries mint-only STATUS rules
  (`commerce_quote` must be `sent` to mint, but an accepted quote is still served), so
  re-running it would darken links the read contract keeps. Hence the split hook.
- **Gate the list at `workspace:write`.** Rejected: a writer also must not see another
  member's private prompt title, so the rule is per row, not per route.
- **A report-only rollout first (architect H4).** Considered: an
  `off|report|enforce` switch. Same-subject consistency holds by construction (the
  route stamps `user.userId`, the re-check asks `assertOrgScope` about the same id),
  and the only rows that could predate deterministic user ids are older than the
  ADR 0448 P2 re-key. Adopted as an operator ESCAPE HATCH, not a phase:
  `OPENWOP_SHARE_PUBLISHER_RECHECK=report` logs `shared_link_publisher_would_darken`
  and serves; the default is `enforce`. A read-only prod count of live human-minted
  links whose publisher is no longer a member is requested before deploy.
- **Store `mintLane` on the row instead of the `system:` prefix.** Better long-term, but
  legacy rows have no lane, and the prefix is how every system mint already identifies
  itself. Pinned by the call-site test instead (OQ-2).

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1 hook + `assertPublisherLive` in the chokepoint; `createLink` uses the hook; ~30 service-test call sites that mint as a bare actor (`u1`, `alice`, …) seeded with real memberships | probes S1 + S2 (+ SCIM-disable, leftover sub-org, project canvas read loss); existing sharing suites |
| P2 | D3 expiry ordering; D4 no-store | probes S3 + S4 |
| P3 | D2 list annotations + redaction; D5 adopt route | probe S5; adopt tests (refusals + happy path) |
| P4 | Frontend: chip + Adopt action + redacted title copy, 4 locales | `SharingPage` tests |

## RFC verdict

Host-extension (`/v1/host/openwop-app/*`, non-normative). No wire change, no RFC.

## Matrix

1 Feature-package: extends `features/sharing/` only; resolvers stay in the one registry.
2 Toggle: none (always-on since ADR 0434); owning toggles unchanged.
3 `ctx.sharing`: none. Not adding one.
4 Node pack / 6 agent pack / 5 envelopes: none. Sharing is a host seam, not an AI surface.
7 Public surface: unchanged prefix; adds `no-store`; every refusal stays uniform.
8 RBAC: adopt is `workspace:write` + the member mint gate; the list is per-row redacted.
9 Replay: N/A (no runs).
10 Frontend: `SharingPage` chip + action; `sharingClient` types.

## Open questions

- [ ] OQ-1 Should the owner list offer a bulk "adopt all from <departed member>"? Deferred
  until there is evidence of departures at volume.
- [ ] OQ-2 Persist `mintLane` on new rows so D1 step 1 stops relying on the `system:` prefix.
- [ ] OQ-3 `SHWF-14` (legacy unowned conversations mintable by any member) is unchanged:
  the owner rule still only fires when an owner is recorded.
- [ ] OQ-4 (`SH2UX-5`) name WHO lost access on a "Needs a new owner" row. A removed member's row
  is usually gone, so this needs a users-store display-name lookup on a `workspace:read` list —
  a PII exposure decision, deferred.
- [ ] OQ-5 (`SH2CD-11`) the CRM booking-manage and e-sign public token GETs carry no
  `Cache-Control` either. Same class as S4, CRM's routes.

## Architect pass (2026-10-14, before code) — what changed

An independent adversarial review found 0 CRITICAL, 4 HIGH, 5 MEDIUM, 5 LOW. Folded:

- **H1** the re-check named only `assertOrgScope`; a SCIM-deprovisioned or disabled
  user keeps their member rows, and a workspace-root removal can leave a sub-org twin.
  D1 step 2 is now the three-part presence check.
- **H2** `getCanvasForCaller` returns null for "missing" AND "refused"; "absence answers
  null" would have read a refusal as absence and GRANTED. Existence is now an unfiltered
  read, stated once.
- **H3** `assertOrgScope` does two full cross-tenant scans per call, which on an
  unauthenticated lane (and on every slide change's frame-view POST) is a read
  amplifier. 30 s memo, freshness bound written into D1.
- **H4** report mode adopted as an escape hatch, default enforce, prod count requested.
- **M1** only a refusal darkens; errors rethrow (and D5 needs a refusal).
- **M2** the quote consequence stated. **M3** a `read` mode for D2. **M4** cap before D1.
  **M5** the demo WARN bounded by the memo.
- **L1** the `system:` exemption verified complete (`system:commerce`,
  `system:crm-booking`, `system:crm-sign`; prefixed since introduction). **L2** the mint
  error codes are kept by keeping the check order. **L3** D3 changes no pinned test.
  **L4** no middleware overwrites `Cache-Control`. **L5** adopt refuses expired links,
  and its permanence is stated.

## Implementation record (2026-10-14, branch `feat/fl2-44-sharing`)

| Phase | What | Witness |
|---|---|---|
| probes | S1–S5 written first, 6/6 RED on `132c1ea07` (`1f2fcc904`) | `test/adr0887-sharing-probes.test.ts` |
| P1 | D1 `entitlement` hook on all 12 resolvers; `publisherVerdict` (presence + entitlement, 30 s memo) in `resolveActiveLink`; `createLink` uses the hook; 7 existing suites' bare-actor fixtures given real memberships / real user ids (`b01cff522`) | S1, S2, the bound leg, SCIM-disable leg; `adr0887-sharing-presence-and-adopt.test.ts` (ws: root removal with a surviving sub-org twin) |
| P2 | D3 expiry last; D4 `noStore` on the three `/shared/*` routes | S3, S4 |
| P3 | D2 redaction (`read` mode) + `publisherInactive` + `canAdopt`; D5 `adoptLink` + route | S5, adopt route legs, adopt entitlement leg, canvas read-mode leg |
| P4 | FE "Needs a new owner" chip, Adopt (busy, `canAdopt`-gated), translated refusals, withheld title, public next step; 4 locales (`5ce004841` + follow-ups) | `publisherInactive.test.tsx` (7) |
| pin | every `createLink` call site's actor (`system:*` except the member route) | `adr0887-visitor-mint-actors.test.ts` |
| valves | M1 rethrow (session authority, org scope), report mode, `system:` exemption at runtime | `adr0887-sharing-recheck-escape-valves.test.ts` |

**Sabotage (each fix reverted after commit, the named test went red, file restored from a backup
copy):** no publisher check (7 red) · no disabled check · no `ws:` root check · no org-scope
check · no entitlement re-check · expiry first · no `no-store` · no redaction · TTL 0 · adopt
without the publisher-active refusal · adopt without the mint gate · mint without the
entitlement · `canAdopt` without the caller-write check · an org-scope error read as a refusal ·
a session-authority error read as a refusal · report mode ignored · canvas `read` mode treated as
`publish`. All 17 red. Two were GREEN on the first run (no `ws:` probe; no adopt-entitlement
probe); both got a witness and re-ran red.

**Ratchets touched:** `adr0886-canvas-write-gate-ratchet.test.ts` — `sharingService.ts` now makes
ONE `canvasWriteAllowed` call (the shared `canvasEntitlement`) where it made two (one per canvas
resolver); the pin was lowered with that reason, and the call still gates both types at mint AND
on every read.

**Grades:** `/grade-workflows` A → B+ (`SH2WF-1..3`); `/grade-code` A− → A (`SH2CD-1..12`, 10
fixed, 2 filed); `/grade-ux` B → A− (`SH2UX-1..8`, 6 fixed, 2 filed). No live browser pass.

**Deploy:** no migration, no backfill. Default `enforce` darkens links whose publisher is gone
the moment it ships; `OPENWOP_SHARE_PUBLISHER_RECHECK=report` is the escape hatch. The read-only
prod count (live human-minted links whose publisher is no longer a member) was requested before
deploy (`SH2CD-12`).

## Addendum (2026-10-14, team-lead review notes, after merge)

- **D4: who caches these routes today (checked).** No one does, so `private, no-store` breaks nothing.
  - `firebase.json` has no `/shared/**` rewrite. A browser or bot opening `/shared/:token` gets the static SPA shell, which sets an unlisted `noindex` head through `applyUnlistedHead`. The JSON reaches the backend only through the `/api/**` door, which has never cached these responses.
  - No bot prerender covers share links. `publishing/routes.ts` prerenders CMS and site pages, not `/shared`.
  - `GET /shared/:token/card` has **no consumer**. A grep finds nothing that fetches it: no unfurler, no OG tags, no prerender.
  - So no separate short policy for unfurler bots was needed, and none was chosen. The card gets `no-store` like the rest.
  - If social cards are ever wired, the card is a fresh-or-nothing read of live state behind a revocable token. A cacheable card would keep a revoked link's title visible for as long as the TTL. That decision belongs to whoever wires the cards, and would need its own ADR line.
- **D3: the viewer's "expired" copy is preserved.** `sharingClient.ts` maps `410 → 'expired'` (the "ask the owner for a fresh link" state). A link that would otherwise be live still gets the 410. This is pinned by the S3 positive control in `adr0887-sharing-probes.test.ts`: an expired link from a live publisher answers 410.
  - Only links that are expired AND dead for another reason now get the 404 "no longer available" copy. That copy now ends with "Ask whoever shared it for a new link." It is the same advice the expired copy gives, so the visitor loses nothing.
- **S1 is user-visible.** The deploy note to the release coordinator says so. It names the `report` escape hatch and the read-only log query that counts darkened links. In the product, the owner list shows "Needs a new owner" and an Adopt button for writers.
- **Timing residue.** This is recorded under "What is clean" with its reason: only a holder of a once-valid 256-bit token can observe the one extra point-get.
