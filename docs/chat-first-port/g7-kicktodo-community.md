# KickTodo Community (unit G7) — chat-first port review

**Scope.** Backend `backend/typescript/src/features/kicktodo-community`; frontend
`frontend/react/src/features/kicktodo-community` (CommunityPage) +
`frontend/react/src/features/kicktodo-circles` (CirclesPage — a thin SPA over the
**`kicktodo-accountability`** backend, which is a *separate* review unit; only the
frontend page is audited here).

**Headline.** The community backend already rides the right owners for the hard
parts — the ONE approval owner (`createCommunityApproval`,
`approvalService.ts:398`), the entities content-kernel for public projections, the
exception ledger, and the subject-erasure seam — so it is *not* a parallel
architecture. Its chat-first gap is **agency, not ownership**: the entire
community surface (profiles, reviews, analytics) has **zero chat-drivability** —
no `openwop:kicktodo.community/*` tool exists in `feature.kicktodo.agents`, and the
one community node (`challenge-reviews`) is orphaned (declared, never ignited). One
real correctness defect: flag-resolution's approval card is decorative — the
moderator's decision on the card is *not* wired to the state change.

---

## Verdict table

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| 1 | Create/edit creator profile | Bespoke form → `POST /profile` (`CommunityPage.tsx:176-225`, `routes.ts:66-83`) | **PAGE-LEGIT** | Keep the small structural editor; ADD an agent tool so a creator can also do it by describing intent (see Blocker B1) |
| 2 | Submit profile for public visibility | `submitProfile` → `createCommunityApproval('community-profile')` (`communityService.ts:210-225`) | **RIDES** | Leave — rides the ONE approval owner + `host:kicktodo-community` roster (`approvalService.ts:408`) |
| 3 | Apply profile decision | `/profile/decide` reads `approval.status`, applies to state (COM-1 hardened, `communityService.ts:229-257`) | **ADAPTER** | Thin, honest — but its honesty loop is open (Blocker B2): nothing triggers it after the card is decided |
| 4 | Public profile read by handle | `publicProfileByHandle` + kernel projection, locale-switched (`communityService.ts:318-341`, `creatorProfileProjection.ts`) | **RIDES** | Leave — rides the entities content-kernel public-read gate |
| 5 | Write review (proof-gated) | Bespoke composer → `POST /reviews`, real proof gate (`CommunityPage.tsx:236-308`, `communityService.ts:363-397`) | **PAGE-LEGIT** | Keep; candidate for an agent tool later. Proof gate (`reviewProof`, `communityService.ts:344-360`) is genuine |
| 6 | Visible reviews + k-floor aggregate | Read projections, PII-free (`visibleReviews`/`aggregateRating`, `communityService.ts:400-433`) | **PAGE-LEGIT** | Leave — honest read; the anonymity invariant is enforced |
| 7 | Flag a review | `flagReview` → `createCommunityApproval('community-review')` + exception source (`communityService.ts:436-458`, `exceptionSources.ts`) | **RIDES** | Leave — rides approvals + the ADR 0460 exception ledger |
| 8 | **Resolve a flag (moderation)** | `requireKicktodoManage` route flips state **directly, WITHOUT reading the approval** (`communityService.ts:461-475`, `routes.ts:184-204`) | **THEATER** | The `community-review` approval card is created but decides nothing — close the loop (Blocker B3) |
| 9 | Creator analytics (counts-only) | Read projection over `revenueProjectionFor` (`communityService.ts:481-500`) | **PAGE-LEGIT** | Leave — no participant rows, counts only |
| 10 | Subject erasure / retention | `registerSubjectEraser(eraseCommunitySubject)` (`communityService.ts:514-546`); deliberate retention omit with reason | **RIDES** | Leave — rides the erasure seam, pulls kernel projections down |
| 11 | **`challenge-reviews` node** | Declared in `feature.kicktodo.nodes` + registered in `index.mjs:351`, but referenced by **no workflow and no agent allowlist** | **THEATER** | Orphaned read node — ignite it (wire into an agent/workflow) or drop it |
| 12 | **Chat-drivability of the whole feature** | No `openwop:kicktodo.community/reviews/profile/analytics` tool in `feature.kicktodo.agents/pack.json` | **THEATER** (absent agency) | Ship a community agent tool set (Blocker B1) — the ADR 0058 chat-drivability pattern |
| 13 | Circles: create/invite(scopes)/revoke/feed | Consent-management forms in `CirclesPage.tsx` over a backend that instantiates the conversation owner (`circleService.ts:106` `ensureConversationMeta`) | **PAGE-LEGIT** | Leave — legit consent surface; the §5.9 privacy preview (`CirclesPage.tsx:288-302`) is exemplary |
| 14 | Circles: coach plan-proposal decision | Decided on the approval **card in the ONE chat** (`/?conversation=`, `CirclesPage.tsx:381-386`); read-only history + honest degraded fallback here | **RIDES** | Leave — reference chat-first HITL (ADR 0459) |
| 15 | Circles: cohort sessions | Scheduled moments in the circle's conversation; join deep-links `/?conversation=` (`CirclesPage.tsx:405`, `sessionService.ts:95`) | **RIDES** | Leave — rides conversations + schedules, not a parallel store |

**Counts: RIDES 6 · ADAPTER 1 · PARALLEL 0 · THEATER 3 · PAGE-LEGIT 5.**

The lead's specific worry — "community feeds/chat must ride the ONE conversation
owner, not a parallel message store" — **does not fire.** Circles bind to a
deterministic `conversationId` via `ensureConversationMeta`
(`circleService.ts:89,106`); the circle "feed" is a progress *projection*
(`feedByCircle`, `CirclesPage.tsx:311-323`), not a message store; sessions and
proposal decisions deep-link the ONE chat. Community itself has no feed/chat surface
at all.

---

## Blockers (from scouting) — each with the honest alternative

**B1 — No agency lane exists for community (THEATER of intelligence).**
`feature.kicktodo.agents/pack.json` has nine agents; none expose a single community
tool (the full tool set is `openwop:kicktodo.{candidates,factory.run,today,progress,circles}`
— no `community`, `reviews`, `profile`, or `analytics`). So nothing a user
"describes" — "set up my creator profile", "review the challenge I finished", "how
are my challenges rated?" — can be done in the ONE chat. *Honest alternative:* add a
`kicktodo-community` agent (capability at core, activated via `agentProfile`) with
`registerFeatureAgentTool` tools that **share the routes' access predicate** —
read tools (`community.profile`, `community.reviews`, `community.analytics`) fail
EMPTY; action tools (`community.upsert-profile`, `community.submit-profile`,
`community.write-review`, `community.flag-review`) fail typed and honor the same
proof/separation-of-duties gates. This is additive; the forms stay as PAGE-LEGIT
editors.

**B2 — The profile-decision honesty loop is open.**
`applyProfileDecision` (`communityService.ts:229-257`) correctly *applies* a
terminal approval outcome (COM-1: it reads `approval.status` and refuses to mint a
decision). But **no reviewed surface calls `/profile/decide` after the card is
decided** — the community frontend is the creator's own editor only, and the
approval system has **no post-decision callback** (grep of `approvalService.ts`
shows no hook registry; the only caller of `applyProfileDecision` is its own route,
`routes.ts:104`). Net effect: a moderator can approve the `community-profile` card in
the reviews inbox and the profile can still sit `pending`/non-public until someone
out-of-band POSTs `/profile/decide`. *Honest alternative:* register a decision hook
on the `community-profile` kind that invokes `applyProfileDecision` on resolve (the
same seam B3 needs), OR reconcile profile state from approval status in the boot
sweep. Until then, mark the "approved → public" transition **deferred-visibly**.

**B3 — Flag resolution bypasses its own approval (THEATER).**
`flagReview` mints a `community-review` approval (`communityService.ts:445-451`) that
lands in the reviews inbox and the exception ledger — but `resolveReviewFlag`
(`communityService.ts:461-475`) flips `visible`/`removed` **from a raw `remove`
boolean, never consulting `getApproval`**. Authority comes entirely from
`requireKicktodoManage` on `/reviews/resolve-flag` (`routes.ts:184-204`). So the
moderation card is decorative: deciding it changes nothing, and resolving the flag
doesn't require the card to be decided. This is the exact inconsistency COM-1 already
fixed for profiles, left unfixed for reviews. *Honest alternative:* mirror the COM-1
pattern — `resolveReviewFlag` reads the `community-review` approval and applies its
terminal status (remove ⇔ approved), OR register a decision hook so the reviews-inbox
card drives the state change. One shared seam closes B2 and B3.

**B4 — The moderation surface is off-unit and unverified.**
The exception source deep-links `/admin/kicktodo/safety` (`exceptionSources.ts:24`);
that admin page is not in either reviewed frontend package. The port must confirm it
exists and calls `/reviews/resolve-flag` (else B3 has no UI at all). Filed as a
cross-surface honesty check, not a local workaround.

---

## Demolition list (with regression pins to add)

Little to demolish — the community forms are PAGE-LEGIT and circles already routes
decisions to chat. The targets are **theater to ignite-or-remove**, not UI to delete:

- **`challenge-reviews` node** (`packs/feature.kicktodo.nodes`, `index.mjs:351`) — if
  B1's agent doesn't adopt it, delete the node + its pack entry. **Pin:** a
  pack-parity test asserting every declared kicktodo node is referenced by a
  workflow, a builtin, or an agent allowlist (the cross-cutting drop-pattern guard —
  a node typeId no agent projects is silently dropped at dispatch).
- **The decorative `community-review` approval** — do NOT demolish; wire it (B3).
  **Pin:** a test that a decided `community-review` card resolves the flag, and that
  `resolveReviewFlag` refuses when the approval is still pending.
- **Post-B1**, if the profile/review agent tools subsume the composer forms, keep the
  forms as PAGE-LEGIT editors (short structural records — a form is defensible). No
  demolition. **Pin (already present, keep):** `CommunityPage.test.tsx` KTUX-7/-11
  (label-not-placeholder; failed-fetch never fabricates an empty state).

---

## New-code inventory (small)

1. **`kicktodo-community` agent + tools** — one agent pack entry; `registerFeatureAgentTool`
   tools sharing the route predicates (read → fail-empty, action → fail-typed). No new
   store, no new owner. (B1)
2. **One approval-decision seam** — a `community-*` post-decision hook (or a
   reconcile-from-approval-status pass) shared by profile (B2) and flag (B3). Additive
   to `approvalService`; every other kind unchanged.
3. **`resolveReviewFlag` hardening** — read the approval, apply its terminal status
   (mirror COM-1). ~5 lines. (B3)
4. **Pack-parity test** for orphaned kicktodo nodes. (demolition pin)
5. **No new durable rows** — profiles/reviews/handle-index already have tenant-scoped
   deterministic keys, erasure coverage (`communityService.ts:514-546`), and the
   deliberate retention-omit note (`communityService.ts:543-546`). Lifecycle test passes as-is.

---

## Phased plan (gated on real gates)

- **Phase 1 — close the correctness loops first (no demolition).** Ship the shared
  approval-decision seam; harden `resolveReviewFlag` (B3) and wire `applyProfileDecision`
  (B2). Add the two decision-wiring regression pins. Gate: backend vitest green +
  `/code-review`. *These are real bugs — do them before any chat work.*
- **Phase 2 — ignite agency (B1).** Add the `kicktodo-community` agent + read/action
  tools with predicate parity; adopt or delete `challenge-reviews` (B11) and add the
  pack-parity pin. Verify the profile/review asks work in the ONE chat. Gate:
  `promptCatalogParity` + `agent-prompt-tool-ids` + `npm run ci` + `/code-review`.
- **Phase 3 — honesty + a11y sweep.** Confirm B4's moderation surface calls the hardened
  route; mark any still-deferred transition visibly. Gate: `/ux-review` + `/grade-ux` fixes.

## Deferred honestly

- **Free-challenge creator attribution** in `creatorAnalytics` is already a recorded ADR
  correction ("arrives with creator onboarding", `communityService.ts:478-480`) — leave
  deferred-visibly, don't fake it.
- **`/admin/kicktodo/safety`** moderation UI verification (B4) is cross-unit; tracked, not
  worked around here.
- **Review composer as an agent tool** (B1 action set) is optional polish; the proof-gated
  form is honest today. Ship reads + profile/flag actions first.
