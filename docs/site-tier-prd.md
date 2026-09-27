# PRD — The `site` tier: product surfaces at clean URLs, signed in or signed out

**Status:** proposed, pending ADR 0641.
**Owner:** `openwop-app` session, with `kicktodo-1` on the adopter cut.
**Decision record:** [ADR 0641](adr/0641-site-tier-and-per-route-auth-posture.md) —
the structural reasoning and every `file:line` citation live there; this document
covers product scope, phasing, and what is still open.

---

## 1. What is being asked for

KickTodo's six participant surfaces — **Today, Plan, Discover, Progress, Circles,
Leaderboard** — should live at clean root URLs (`kicktodo.com/today`), free of
console chrome, with a CMS-managed menu, CMS components embeddable in the page,
and the existing feature toggle still gating them.

**Discover must additionally work signed-out.** It is the acquisition funnel: an
anonymous visitor browses challenges, finds one, and signs up. That is not a
nicety attached to the tier — it is the reason a stranger ever reaches KickTodo.

KickTodo is the first adopter. The capability is generic and every other
distribution gets it.

## 2. Why this is one capability and not six features

Every surface above is already a working feature package behind the console. The
gap is not functionality, it is **posture**: which shell wraps the route, whether
it carries navigation, and whether a session is required. Those three questions
have one answer today (`workspace`) and need three.

Stated as posture × chrome, the missing cell is obvious:

|                 | console chrome      | bare chrome              |
|-----------------|---------------------|--------------------------|
| anonymous       | —                   | `public` (ADR 0027)      |
| authenticated   | `workspace`/`admin` | **the gap** → `site`     |

And Discover then adds a row the grid does not have: a route whose posture is
decided per visitor rather than per route. That is what forced auth posture off
the tier and onto the route.

## 3. Reuse map — what already exists vs. what is net-new

The strong version of this proposal is that **almost none of it is new**.

| Need | Already exists | Net-new |
|---|---|---|
| Bare shell above the gate | `PublicShell` (ADR 0027) | — |
| Toggle gating a route | `ownerFeatureId` + `EntitlementGuard` (ADR 0419) | — |
| Nav declared by a feature | `FeatureNav` on the `FEATURES` manifest | — |
| Auth-aware rendering with no provider | `useAuth()` subscription; storefront precedent | — |
| Anonymous read surface | `/v1/host/openwop-app/public/:orgId/*` (ADR 0012) | one member: `challenges` |
| CMS blocks in a page | `Section`/`SectionType`, `RenderSections` (exported, mode-parameterised) | one section: `challengeCatalog` |
| Crawler prerendering of feature data | `registerContentSectionResolver` | one resolver |
| Rewrite-collision checking | `check-hosting-wire-rewrites.cjs` (3 call sites) | one assertion |
| **Shell selection per route** | — | **`site` tier member** |
| **Auth posture per route** | — | **`auth: required \| optional`** |
| A curated menu of feature routes | `FEATURES` manifest + toggle resolution; `usePublicNav` curated list | ~~`cms.menu` entity~~ — **withdrawn, see Q1** |
| **Binary-only toggles on public routes** | — | **a registration-time validation** |

**Three genuinely new things — and the third changed identity on 2026-09-09.**
The menu entity is gone (Q1); a validation rule took its place (Q1's third
finding). Everything else is a seam that already exists and is already used by
something.

## 4. Product decisions

1. **Discover is TWO surfaces sharing a resolver**, not one route wearing two
   hats. A public acquisition page (a CMS page carrying the challenge-catalog
   section — prerendered, anonymous, converting to sign-up) and the in-app
   `site`-tier `/discover` a participant browses and enrols from.

   This conclusion flipped twice during design and the reason is worth keeping:
   the section resolver enriches what a **CMS page** can contain; it does **not**
   make a React feature route crawlable. The two prerender doors stay CMS-only. One
   route would need a third door, built on the acquisition path, where being wrong
   means being invisible. Two surfaces need no prerender change at all.

   Useful consequence: **the `optional` posture is no longer load-bearing for
   acquisition.** It stays right for the in-app page, but if it slipped a phase the
   funnel still works. That de-risks the tier.
2. **The menu is derived, not stored.** *(CORRECTED 2026-09-09 — this decision
   previously read "a curated entity, not a derived list", and Q1's answer
   reversed it.)* The public half is the distribution's curated list; the
   authenticated half derives from the `FEATURES` manifest filtered by toggle
   resolution. The signed-out subset needs no stored flag because a route's `auth`
   posture already is that flag. ADR 0486's rule that the sitemap must not be
   promoted into the primary menu is inherited either way.
3. **Embedding and crawlability are one mechanism.** A registered content section
   is simultaneously what the SPA renders and what the crawler consumes. Building
   them separately builds two things that drift.
4. **An empty funnel page must fail loudly, not publish.** See §7.

## 5. Journeys

**Anonymous acquisition (the new one).** Visitor arrives at `/discover` from
search or a shared link → sees real challenges, because the page is prerendered
and the catalog read needs no credential → picks one → is asked to sign up at the
point of intent, not before it → lands on `/today` as a member. The shell does not
change under them at the sign-up boundary; only the menu widens.

**Member daily loop.** `/today` requires a session and shows the day's actions.
Navigation between the six is in-shell and does not remount, because they share a
tier.

**Operator.** Curates the menu in the CMS, marks which entries are visible
signed-out, and flips the feature toggle. No code change to add or remove a
destination.

## 6. Phasing

Each phase is independently shippable and independently gated. Phase 1 is behind
a toggle from the first commit.

| Phase | Scope | Gate to the next |
|---|---|---|
| **1 — the tier** | `site` member; `auth` posture field; the third App.tsx branch; exhaustive tier mapper; block operator tier-assignment | Route-level tests for all three postures pass; console chrome verifiably absent |
| **2 — the collision gate** | Extend `check-hosting-wire-rewrites.cjs`; fail closed on an underivable list | **Sabotage-tested**: a deliberately colliding route goes red |
| **3 — the public read** | `/public/:orgId/challenges` on the ADR 0012 family; published-only | Anonymous GET returns published rows for the named org; drafts never resolve |
| **4 — the section** | `challengeCatalog` section + registered resolver; refuse-on-empty | Prerendered document contains real challenges; a resolver fault fails rather than emitting empty chrome |
| **5 — the menu** | Wiring only: `site` routes draw nav from `FEATURES`; public destinations are curated in the distribution; public-route toggles validated binary | A destination appears/disappears by toggle for an authenticated tenant; a public route declaring variants fails at registration |

Phases 1–2 are the tier. Phases 3–5 are the funnel. **A distribution that wants
clean URLs but no anonymous surface stops after phase 2** — which is most of them,
and is why the phase boundary sits there.

Note on sequencing cost, not scope: this machine has been memory-starved all day
and a full `npm run ci` has been killed outright with no verdict. That argues for
fewer, larger pull requests per phase rather than many small ones, and for running
the gate when the machine is quiet.

## 7. Risks

| # | Risk | Why it bites | Mitigation |
|---|---|---|---|
| R1 | **A future corpus sync silently shadows a `site` route.** The reserved root list is derived from the vendored path manifest, so it grows with no change to this repo. | The route stops reaching the SPA. No Express or Router check can see it; it happens one layer above. | Phase 2 build gate, running in all three call sites including the hand-deploy path. |
| R2 | **The funnel page publishes empty.** The section resolver catches every error and degrades to chrome-only. | An indexed page with intact chrome and zero challenges passes every check we have, converts nobody, and reports nothing. | Refuse the prerender for funnel sections (ADR 0641 §8). Absent is recoverable; hollow is not. |
| R3 | **The new tier gets a wrong label rather than a compile error.** The menu-settings mapper is typed on the full union but branches binary. | Silent wrong behaviour, not a crash. | Make it exhaustive so the FIFTH member is a compile error. |
| R4 | **An operator relocates a console route to bare chrome** via stored menu overrides. | Not an authorization bypass — auth still holds — but a posture change from a settings page. | Block `site` on the override write path. |
| R5 | **Member state leaks into a shared cache.** | Same URL serves anonymous and member. | Cache the shell, never the authenticated data; no `auth: optional` route server-renders member state. |
| R6 | **The new guards cannot fail.** This repo has shipped five gates that could not. | A green gate is indistinguishable from one that never ran. | Sabotage each new gate before trusting it (phase 2 and 4 gates explicitly). |
| R7 | **An operator switches a public route on "for this tenant" and nothing happens.** `tenantOverrides` keys on a per-session `anon:` tenant that never matches a visitor. | A control that reports success and has no effect — the failure shape this repo keeps rediscovering. | ADR 0641 decision 12: public-route toggles are binary, rejected at registration if they declare variants or a rollout. |

## 8. Open questions

**Q1 — Who curates the menu: per-tenant or per-distribution? ANSWERED
2026-09-09 by the adopter session (`kicktodo-1`): per-distribution for the public
set, and per-tenant ONLY through toggle resolution. No new curation primitive in
either posture, and no `cms.menu` entity.**

The marked assumption above — *"the menu is per-tenant"* — was **wrong, and wrong
for a reason neither session had in view when it was written**: on a public route
there is no stable tenant to be per. An anonymous caller is minted
`tenantId = "anon:<sid>"`, fresh per browser session
(`backend/typescript/src/middleware/auth.ts:1-10`). Per-tenant curation there is
not merely unavailable — it keys on a value that changes every visit.

So: the public menu is the distribution's curated list plus host-global published
CMS pages, which is where ADR 0486 already put it
(`PublicShell.tsx:60-73,81-91`). The authenticated menu derives from the
`FEATURES` manifest filtered by toggle resolution, whose per-tenant knob already
exists (`host/featureToggles/service.ts:449`). A second per-tenant menu store
would be a second owner of "is this destination live for this tenant", and two
owners of one fact drift. **Cost of the reversal: phase 5 loses an entity and
becomes wiring** — cheaper than the assumption it replaced, which is the
uncommon direction.

**Q1 also surfaced a third finding, now ADR 0641 decision 12: a public route's
toggle cannot use variants or percentage rollout.** `unitIdFor`
(`host/featureToggles/service.ts:431`) buckets on `subject.tenantId`, and the
`'user'` unit falls back to it when there is no principal — so a public route
buckets on a per-session random. The same visitor is reassigned next visit, and a
cached or prerendered public document has no coherent assignment at all. Binary
on/off, default off, enforced at registration rather than by convention.

**Q2 — Is Leaderboard public? ANSWERED 2026-09-11 by David: NO — behind a login
AND scoped to the challenge's participants.** Verbatim: *"others, like the
leaderboard are not only behind a login, but also only visible to those who are
participating in the challenge."*

The escalation below was right to refuse a default, and the answer is narrower
than either option it framed. `auth: 'required'` stands; a second, independent
constraint joins it — participant-scoped visibility, which is a SERVICE-side
predicate rather than a third posture value (ADR 0641 decision 13). The Circles
tension dissolves rather than needing adjudication: participant-scoped is what
that principle already asks for.

**It is not free.** MEASURED: today's leaderboard is tenant-scoped and opt-in, not
challenge-scoped (`kicktodo-engagement/routes.ts:69`,
`engagementService.ts:246`). Participants of different challenges share one board.
The rule needs a `challengeId` argument and a membership check via the existing
`listEnrollmentsFor` self-scoping primitive. That is net-new work on a shipped
surface and belongs in the adopter's plan, not this capability's phases.

**David also settled the framing question this PRD had been circling.** All six
surfaces are *"on the public side of the app, not the private side"* — regardless
of each one's individual auth requirement. That is a direct confirmation of the
central design move: **the tier is the side, the posture is per route.** A
signed-in, participant-scoped Leaderboard is still a `site` surface. It was not
obvious this would hold; a reasonable reading of "public side" would have put only
the anonymous surfaces there and left the rest on the console, which would have
split the six across two shells and defeated the clean-URL goal.

---

*Original escalation, retained for the reasoning trail:*

**Q2 — Is Leaderboard public? ESCALATED to David, deliberately not defaulted.**
A public leaderboard is a strong acquisition surface **and it contradicts this
product's stated principle.** `kicktodo-circles` ships the line "Share exactly what
you choose, with exactly who you choose", and its scopes are per-member opt-ins
over exactly this data — day counts, completed actions. A public leaderboard would
publish by default what Circles makes people choose to share with one person.

Neither session is willing to decide that from the engineering side, and shipping
a default here would decide it silently. If it goes public, the read from the
adopter side is **opt-in per participant, never retroactive.** Until answered,
Leaderboard is `required` — the conservative posture, and a one-line change if
David says otherwise.

**Q3 — Which org owns the public acquisition page? ANSWERED 2026-09-09:
`host-site`, the reserved system-site org, under super-admin authority. It
already exists.** `host/systemSite.ts:29-31` reserves
`SYSTEM_SITE_TENANT = 'host:site'` / `SYSTEM_SITE_ORG = 'host-site'`, and the
`host:` prefix is one no auth path mints, so the org is unreachable by every real
caller. Its own header already states the model: a global page edited by the
host-level role, not by tenant membership — a real CMS page in a real
`accessControl` org. `PublicShell` already reads this org for published pages.
Nothing new is needed but the authority.

A tenant admin must not be able to publish there, for Q1's reason: the public nav
has no tenant to scope by, so a tenant-published page would appear on every
visitor's menu.

**Q4 — Are challenges a kernel entity type? ANSWERED: no.** They are a bespoke
`DurableCollection`, so `entityList` cannot project them and the `publicRead` flag
does not apply — it lives on an entity type. Kernelising them would additionally
inherit the scalars-only rule and drop the day-by-day activities, shipping a
catalog of stubs that looks correct. **This does not block phase 3**: the section
resolver is the vehicle and needs no kernel migration. It does mean the
`entityList` precedent cited early in design is a shape analogy, not a recipe.

## 9. Non-goals

- Not a second navigation model. `site` routes draw nav from the same `FEATURES`
  manifest the workspace rail reads.
- Not a second chat, canvas, or content system.
- Not a wire change. See ADR 0641 §"RFC gate".
- Not a redesign of the six surfaces. This is posture and routing; the pages
  themselves are unchanged.

## 10. Deliverables of this planning pass

- [ADR 0641](adr/0641-site-tier-and-per-route-auth-posture.md) — decision,
  alternatives, consequences, test plan, RFC gate, correction notes on ADR
  0614/0631.
- This document — scope, reuse map, phasing, risks, open questions.
- Correction notes to file at ADR 0614 and ADR 0631 when the tier lands.

## References

- ADR 0027 — CMS front page, the bare `PublicShell` posture
- ADR 0012 — the `/v1/host/openwop-app/public/:orgId/*` family
- ADR 0419 — paid feature bundles; `ownerFeatureId` and `EntitlementGuard`
- ADR 0486 — public site navigation; the deferred nav-taxonomy half
- ADR 0614 — the wire must be reachable at the origin root
- ADR 0630 — adopter/steward reachability; the `publicRoutes` seam
- ADR 0631 — the major-2 origin path space
- RFC 0117 — `ui-plugin/1`, considered and rejected as the embedding vehicle
