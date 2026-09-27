# H1 — Identity & Settings — chat-first port review

**Scope (single-unit mode):** the "Identity & settings" capability surface —
backend `backend/typescript/src/features/{users,orgs,profiles,settings}` +
frontend `frontend/react/src/features/{users,profiles,settings-shell,access-hub}`.
Audited the full capability surface (everything a user/operator can do or see),
not every file.

**Headline verdict:** This unit is **already chat-first-correct by being
correctly page-shaped.** It is an identity / auth / personal-settings console —
the class the skill's Law 7 names as *legitimately pages*. Every capability that
touches an owned concept (auth session, media, scheduler, runs, roster,
accessControl membership, BYOK budget, reasoning directive, shareable KB)
**instantiates the real owner** (evidence below); nothing shadows one. There is
**no orphaned workflow, no toothless agent, no painted status, no bespoke
"talk to AI" surface, and no duplicated approval/HITL machinery.** No PARALLEL,
no THEATER.

The only findings are two *deferred-honestly opportunities* (not defects): the
profiles read-surface + node pack exist but are **not exposed as chat agent
tools**, so "ask the chat who on the team knows X / invite alice as editor" is
not answerable in-chat today. These are additive ADAPTERs to file, never a
demolition.

---

## Verdict table

| # | Capability | Today (file:line) | Verdict | Port target / note |
|---|---|---|---|---|
| 1 | Session auth: OIDC bind / logout | `users/authRoutes.ts:36,49` → `issueUserSession`, `upsertFromPrincipal`, `rekeyMemberSubject` | **RIDES** | Instantiates the `middleware/auth` session owner + Firebase (ADR 0026). Keep. |
| 2 | `GET /me` reconciliation (principal→durable `User`) | `users/routes.ts:93`; `usersGuards.resolveCallerUser` | **RIDES** | The one identity seam; fail-closed on disabled (`:100`). Keep. |
| 3 | Self-edit own display name | `users/routes.ts:112` `PATCH /me` | **PAGE-LEGIT** | Self-service field; honesty loop intact. Keep. |
| 4 | Admin user CRUD (list/create/patch/disable/enable/delete) | `users/routes.ts:128-229`; `UsersPage.tsx:34` | **PAGE-LEGIT** | Identity console — must NOT be chat-driven. All writes gated `host:members:manage` (`:142,176,200,219`). Keep. |
| 5 | SSO/SCIM capability status | `users/SsoPanel.tsx:41` reads `/.well-known/openwop` | **PAGE-LEGIT** | Read-only projection of the live capability handshake; honest (advertises only configured profiles). Keep. |
| 6 | Security / MFA (TOTP enroll/unenroll) | `SecurityPanel.tsx:34`; `authRoutes.ts:99` `/me/security`, `:133` factor-event | **PAGE-LEGIT** | Firebase-delegated; host stores no factor material; honesty boundary documented (`authRoutes.ts:118-131`). Keep. |
| 7 | Org invitations (create/list/revoke/accept) | `orgs/routes.ts:107-147`; `invitationsService.ts:21,154` `createMember` | **RIDES** | Delegates membership + authz to the `accessControl` owner (`resolveEffectiveAccess`, `createMember`); adds ONLY the email-token flow. No parallel member tier. Keep. |
| 8 | Self profile edit (bio/skills/contact/availability/equipment/interests) | `profiles/routes.ts:184,294`; `ProfilePage.tsx:328` | **PAGE-LEGIT** | Self-only authority intrinsic (keyed on resolved userId). Keep. |
| 9 | Avatar / portfolio images | `profiles/routes.ts:251-289`; `requireImageToken` `:237` → `resolveMediaAsset` | **RIDES** | References the media-asset owner (RFC 0055); tenant-scoped fail-closed. Keep. |
| 10 | Team directory + peer skill endorsements | `TeamPage.tsx:70`; `profiles/routes.ts:213,386` | **PAGE-LEGIT** | Read collection; endorsement fail-closed (not own, one-per-endorser `:373-380`). Keep. |
| 11 | Assigned-workflow portfolio + "run now" | `ProfileWorkflowsTab.tsx:42` `createRun`; `routes.ts:324` `setOwnWorkflows` | **RIDES** | "Run now" ignites the REAL run owner (`client/runsClient.createRun`); the list is a curation pointer, not a second engine. Keep. |
| 12 | Personal scheduled workflows | `ProfileSchedulesTab.tsx:41` `<SubjectSchedulesPanel>` + `scheduleClient` (`owner:'me'`) | **ADAPTER** | Thin wrapper over the shared scheduler renderer + durable scheduler owner. Keep; watch for drift. |
| 13 | Own run-activity feed | `ProfileActivityTab.tsx:68`; `profiles/routes.ts:153` reads `storage.listRuns` + `projectAgentActivity` | **PAGE-LEGIT** | Real durable-run read with honest `truncated` flag (`routes.ts:162-165`). Keep. |
| 14 | Agent pin (sidebar / chat-welcome) | `profiles/routes.ts:341-363` → `getRosterEntry`/`setAgentPinned` | **RIDES** | Pins reference the roster owner; fail-closed IDOR on pin (`:349-353`). Keep. |
| 15 | Team-portfolio shareable KB | `profiles/routes.ts:144` `registerShareableKb(teamPortfolioShareableKbProvider)` | **RIDES** | Registers with the shared shareable-KB owner (ADR 0100 D2). Keep. |
| 16 | Profiles read nodes (`.list`/`.get`) | `packs/feature.profiles.nodes/pack.json`; `profiles/surface.ts:25` | **RIDES** | Real read nodes over `ctx.features.profiles`; composition primitives in the node catalog, tenant-scoped, descriptive-only. Keep. |
| 17 | Personal BYOK daily budget | `BudgetPanel.tsx`; `settings/feature.ts:32` `configurePersonalByokBudget` | **ADAPTER** | Composes the ADR 0178 `byokChatBudget` seam (personal `min()` lane only — can only LOWER). No second enforcement path. Keep. |
| 18 | Reasoning-directive strength override | `EscalationPanel.tsx`; `settings/feature.ts:73` `configureUserReasoningOverride` | **ADAPTER** | Composes the RFC 0030 `envelopeReasoningConfig` seam; honest scope (only strength, no faked confidence knob — OQ-4). Keep. |
| 19 | Privacy opt-outs (analytics/crash/recent-files) | `PrivacyPanel.tsx`; `settings/routes.ts:46,77` | **PAGE-LEGIT** | Server-authoritative per-user prefs; org/cookie consent stays with the `consent` feature (composed, not moved). Keep. |
| 20 | General (theme/motion/density) + Accessibility depth | `GeneralPanel.tsx:9`; `AccessibilityPanel.tsx` | **PAGE-LEGIT** | Re-surfaces existing `ui/a11yPrefs` store — "No second store anywhere" (`GeneralPanel.tsx:4`). Keep. |
| 21 | Account deep-links | `AccountPanel.tsx:8` | **PAGE-LEGIT** | Discovery only; every destination keeps its owning route/gate. Keep. |
| 22 | Access Hub console | `AccessHubPage.tsx:44` `visibleHubRoutes(FEATURES,…)` | **PAGE-LEGIT** | Projects tabs from the `FEATURES` manifest through the SAME `useFeatureVisible()` predicate the nav uses — no second registry. Keep. |

**Counts:** RIDES 8 · ADAPTER 3 · PARALLEL 0 · THEATER 0 · PAGE-LEGIT 11.

---

## Contract scouting (what actually holds)

- **No workflows/agents are declared anywhere in the H1 backend.** Grep for
  `WorkflowDefinition`/`registerAgent`/`agentPack` across the four packages
  returns nothing. There is therefore **no un-ignited workflow and no toothless
  agent to flag** — the classic THEATER shapes are simply absent.
- **No `registerFeatureAgentTool` and no `startWorkflowRun` in H1 backend.**
  Confirmed by grep across `features/{users,orgs,profiles,settings}`. The only
  run igniter in the unit is the **frontend** "run now" button, which calls the
  real `createRun` (`ProfileWorkflowsTab.tsx:42`) — a correct RIDES, not a
  route accepting caller-supplied results.
- **The one node pack is honest.** `feature.profiles.nodes` declares two
  `role:"action"` **read** nodes (`.list`/`.get`) backed by the real
  `ctx.features.profiles` surface (`surface.ts:25`). They are catalog
  composition primitives available to any workflow author; not a declared
  pipeline needing an igniter. `NP-STALE-PROFILES-1` marks a tracked
  freshness note, not a coverage hole.
- **Owner instantiation is real everywhere it matters** (the RIDES grep):
  media (`resolveMediaAsset` `profiles/routes.ts:241`), roster
  (`getRosterEntry` `:351`), scheduler (`scheduleClient` in
  `ProfileSchedulesTab.tsx:15`), runs (`createRun`/`storage.listRuns`),
  accessControl membership (`createMember` `invitationsService.ts:154`),
  shareable-KB (`registerShareableKb` `:144`), BYOK budget +
  reasoning-directive seams (`settings/feature.ts:32,73`). Nothing is shadowed
  with a fake id.
- **Authority parity holds.** User/invite mutations share the accessControl
  predicate `host:members:manage` at every route (`users/routes.ts:142,176,200,219`;
  `orgs/routes.ts:56-73`). The `orgs` gate carries a **fixed** privesc
  (2026-07 vuln-scan H2, `orgs/routes.ts:57-64`): a bare `{}` used to resolve to
  FULL OWNER scope; it now derives authority from the authenticated subject.
  Settings/profile writes are self-keyed on the resolved `userId` (IDOR-safe by
  construction), and the profiles read surface is tenant-scoped
  (`surface.ts:26`), matching the "read = any member" ADR-0005 authority.
- **Honesty loops close.** Every displayed state has a real read: SSO status ←
  live caps handshake; MFA session chip ← `/me/security` token claim; activity
  ← durable runs with a `truncated` flag; budget "used today" ← the ADR-0118
  counter. The single client-asserted signal (MFA factor-event,
  `authRoutes.ts:133`) is explicitly **notification+audit only, gating
  nothing**, with the honesty boundary documented in-code (`:118-131`).

---

## Blockers (assumptions that failed) — with honest alternatives

**None that block the unit.** Because nothing here needs porting *into* the
engine (it is correctly page-shaped), there is no executor/chassis assumption to
falsify. The two items below are opportunities, filed honestly rather than as
blockers:

1. **The profiles directory is not reachable from chat.** `ctx.features.profiles`
   + the node pack expose team-roster reads to *workflows*, but no
   `registerFeatureAgentTool` exposes them to a *chat agent*
   (grep: zero in H1). *Honest alternative:* if "who on the team knows
   Kubernetes / who's available this week" should be answerable in the ONE chat,
   add a **read-only `registerFeatureAgentTool`** that SHARES the profiles route
   access predicate (signed-in tenant member; fail EMPTY without an acting
   user) — the ADR-0315-allowlisted pattern. Additive; demolishes nothing.
2. **Org invitation is form-only.** "Invite alice@x.com as editor" is
   describing intent, but is a form today (`orgs/routes.ts:107`). *Honest
   alternative (optional):* an **action `registerFeatureAgentTool`** that calls
   the SAME `createInvitation` + `requireMemberManage` helper (route + tool one
   predicate) would make it chat-drivable. Low priority: the admin form is a
   legitimate PAGE and the op is tenant-management, so this is a convenience
   ADAPTER, not a correctness fix.

---

## Demolition list (with regression pins)

**Empty.** There is no bespoke UI substituting for a primitive: no second chat,
no bespoke approve/submit button duplicating HITL, no hand-rolled scheduler or
run panel, no second settings/prefs store (`GeneralPanel.tsx:4` "No second store
anywhere"), no second hub registry (`AccessHubPage.tsx:10-13`). Nothing to
demolish. Existing regression pins to preserve (do not weaken): the
`orgs/routes.ts:57` owner-scope guard, the `users/routes.ts` `host:members:manage`
gates, and the settings-shell "shell owns zero data" composition
(`settings-shell/__tests__`).

---

## New-code inventory (only if opportunities #1/#2 are pursued — SMALL)

- One read-only `registerFeatureAgentTool` for the team directory (reuse the
  profiles route access predicate + `listProfiles`/`getProfile`; pack-allowlisted).
- Optionally one action `registerFeatureAgentTool` for invitations (reuse
  `createInvitation` + `requireMemberManage`).
- No new workflows, no new nodes (the read surface already exists), no new
  durable rows, no HITL cards.

---

## Phased plan

**No port phase is required for correctness.** If the two ADAPTERs are pursued:

- **Phase A (additive, gated on `npm run ci`):** add the read-only profiles
  agent tool sharing the route predicate; pack-allowlist it; parity test that
  the tool + route call one helper and both fail EMPTY without an acting user.
  Close with `/code-review` + `/ux-review`.
- **Phase B (optional):** add the invitation action tool over the shared
  `requireMemberManage`; verify the tool honors the same `host:members:manage`
  scope. Close with `/code-review`.

Both are purely additive — no demolition, so no "replacement works first"
ordering risk.

---

## Deferred honestly

- **Chat-reachability of the team directory** (opportunity #1) — deferred; the
  read surface + nodes exist for workflows but no agent tool yet. Not faked.
- **Chat-driven invitations** (opportunity #2) — deferred; form is the honest
  page today.
- **MFA independent-channel notification** — the factor-event notice
  approximates NIST 800-63B-4's independent-channel requirement via in-app +
  Web Push; recorded as a known limitation in-code (`authRoutes.ts:129-131`),
  not painted as satisfied.
- **`NP-STALE-PROFILES-1`** — a tracked node-pack freshness marker
  (`profiles/feature.ts:22`); surfaced, not silently dropped.

**Definition-of-done met:** every capability has a verdict, blockers/opportunities
carry honest alternatives, the demolition list is explicitly empty with the pins
to preserve, the new-code inventory is small and conditional, and the
deferred-honestly list is explicit. This unit **already rides the engine** — a
valid, evidenced outcome.
