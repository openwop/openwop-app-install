# H2 — Connections + Environments — chat-first port review

**Scope:** `backend/typescript/src/features/{connections,environments}` +
`frontend/react/src/features/{connections,environments}`.
**Mode:** single-feature (unit of two sibling admin features).
**One-line verdict:** This unit is the app's **credential + config console** — it
is *supposed* to be page-shaped, and it overwhelmingly is. Secrets and OAuth
consent MUST NOT be chat-driven, so the review's job here is honesty-loop /
authority-parity verification, not "force it into chat." The unit already
contains the single strongest *honest* engine-igniter in the whole H-band (the
inbound-webhook → `startWorkflowRun` / interrupt-resume path) and one honest
adapter (the credential resolver that injects into the existing core node
packs). The only genuine defect is a **declared-but-unwired approval seam** in
environments: the data model reserves `approvalId` on promote/rollback/apply,
the route never sets it, and no HITL card ever ignites — a schema promise with
no execution path.

---

## Contract scouting (pinned evidence)

**No agent tools, no feature-owned workflows, no agent pack.** Neither feature
calls `registerFeatureAgentTool`, declares a `WorkflowDefinition`, or ships an
agent persona. Repo-wide grep for `registerFeatureAgentTool` scoped to
`conn|env` returns nothing; the only `startWorkflowRun` import in either package
is the inbound-webhook igniter. So there is **no toothless persona to flag** —
the intelligence surface is deliberately absent, which for a secrets broker is
correct.

- **The one igniter is honest and rides the engine.** `inboundWebhooks.ts:675`
  calls `startWorkflowRun(deps, { tenantId, workflowId, metadata.inbound, inputs.event })`
  on a signature-verified provider event; `inboundWebhooks.ts:669-673`
  *first* tries `pickResumeInterrupt` → `resolveAndResume(...)` to feed the
  message into an in-flight run's open interrupt instead of starting a new run.
  This is the shared HITL/run machinery, not a shadow. The public ingest carries
  **no host credential** — the provider HMAC verified against the stored signing
  secret IS the credential (`routes.ts:372-477`), dedup-keyed on the provider
  event id (`inboundWebhooks.ts:659`).
- **Connections ships NO new I/O — it is an adapter over core node packs.**
  `feature.ts:5-6`: "injects the resolved credential into the EXISTING core node
  packs (core.openwop.{mcp,http,integration}). It ships NO new I/O." That is a
  textbook honest ADAPTER, not a parallel engine.
- **Revoke rides the lifecycle owner.** `feature.ts:31` registers
  `onConnectionRevoked('connections-inbound', …)` — the keyed, idempotent
  revoke-consumer seam from `host/connectionLifecycle.js`; the DELETE route
  (`routes.ts:316-325`) tears down inbound wiring *before* revoking so no orphan
  signing secret survives. Owner instantiated, not shadowed.
- **Authorization is one predicate, route-shared, fail-closed.** Connections:
  `requireConnectionsManage` / `authorizeManage` (`routes.ts:71-96`) resolve
  `host:connections:manage` via `resolveEffectiveAccess`, and the create/authorize
  paths call the *same* `isProviderAllowed` allowlist predicate the resolve seam
  uses (`routes.ts:198,243`). Environments: every config-changing op is
  `host:members:manage` and every read is `workspace:read`, deny-on-throw
  (`routes.ts:40-51`). Authority parity holds across routes.
- **The environments approval seam is declared but never ignited.** The service
  reserves `approvalId?` on the promotion record and threads it through
  `promote` / `rollback` / `applyToLive` (`environmentsService.ts:62, 324, 347,
  381, 401`), and comments say the pointer move "assumes it was gated … (admin/
  approval)" (`environmentsService.ts:313-316`). But the routes
  (`routes.ts:135-174`) never construct or pass an `approvalId`; gating is
  `host:members:manage` + a client-side `confirm()` dialog
  (`EnvironmentsPage.tsx:130-137, 256-263`). No approval card is ever created,
  read, or recorded. **The read behind "this promotion was approved" does not
  exist.**

### Assumptions that FAILED (→ blockers below)
1. *"A config console this security-sensitive must route promote-to-prod through
   the reviews inbox."* — It does not; it's a `confirm()` dialog. The data model
   anticipates the fix (`approvalId`) but the wire is dead. → **BLOCKER-1.**
2. *"There must be an agent somewhere that can connect an app for a user on
   request."* — There is not, and there should not be for secret entry; but OAuth
   *initiation* (not secret handling) is a legitimate chat affordance the unit
   currently can't offer. → **BLOCKER-2 (deferred-honestly, not a defect).**

---

## Verdict table

| # | Capability | Today | Verdict | Port target / action |
|---|---|---|---|---|
| 1 | Inbound provider webhook → run | HMAC-verified ingest → `startWorkflowRun` / resume interrupt (`inboundWebhooks.ts:669-696`) | **RIDES** | Leave alone — the reference honest igniter |
| 2 | Revoke connection + teardown | DELETE → `removeInboundConfig` + `revokeConnection` + `onConnectionRevoked` seam (`routes.ts:316-325`, `feature.ts:31`) | **RIDES** | Leave; lifecycle owner instantiated |
| 3 | Credential injection into nodes | resolver feeds core.openwop.{mcp,http,integration} (`feature.ts:5-6`) | **ADAPTER** | Leave; watch for a second resolver appearing |
| 4 | Browse provider catalog | GET `/providers` (`routes.ts:117-135`) | **PAGE-LEGIT** | Keep; `oauthConfigured` honesty signal already present |
| 5 | Connect via posted secret (api_key/bearer/basic/SMTP) | secret form (`ConnectionsManager.tsx:293-349`) | **PAGE-LEGIT** | Keep — secrets MUST stay off chat; verify parity ✓ |
| 6 | Connect via OAuth consent + write re-consent | browser redirect flow (`routes.ts:236-305`) | **PAGE-LEGIT** | Keep — consent is inherently a browser redirect |
| 7 | Test / health-probe connection | button → POST `/test` (`routes.ts:308-314`) | **PAGE-LEGIT** | Keep; low-value chat candidate (see deferred) |
| 8 | Org-share a connection | scope selector, `host:connections:manage` (`routes.ts:216-220`) | **PAGE-LEGIT** | Keep; RBAC-gated |
| 9 | Host OAuth client config (superadmin) | write-only secret form (`OAuthClientAdminPanel.tsx`) | **PAGE-LEGIT** | Keep — secret console; 403-hides |
| 10 | Secrets Vault (add/reveal/rotate/delete) | superadmin projection, step-up gated (`VaultAdminPanel.tsx`) | **PAGE-LEGIT** | Keep — secret console; masked, one-time reveal |
| 11 | Governance policy (allowlist / action policy / MFA / media·BYOK·egress budgets) | superadmin form (`GovernancePanel.tsx`) | **PAGE-LEGIT** | Keep — policy console, 403-hides |
| 12 | Inbound webhook config (author trigger) | admin form, signing secret (`routes.ts:339-362`) | **PAGE-LEGIT** | Keep — trigger authoring + secret |
| 13 | List environments + on-demand drift | GET `?drift=1` (`routes.ts:54-63`) | **PAGE-LEGIT** | Keep; drift computed on demand only ✓ |
| 14 | Create env / seed default chain | form + button (`EnvironmentsPage.tsx:184-190`) | **PAGE-LEGIT** | Keep |
| 15 | Set protection (open/protected/locked) | select (`EnvironmentsPage.tsx:206-216`) | **PAGE-LEGIT** | Keep |
| 16 | Snapshot live config | button (`routes.ts:108-119`) | **PAGE-LEGIT** | Keep — content-hashed |
| 17 | Preview promotion diff | button, read-only (`routes.ts:122-133`) | **PAGE-LEGIT** | Keep |
| 18 | Promote / rollback / apply-to-live | button + `confirm()` dialog; `approvalId` reserved but never set (`routes.ts:135-174`; `environmentsService.ts:62,347,401`) | **THEATER** | Ignite the approval seam OR delete the `approvalId` field |
| 19 | Promotion history ledger | read table (`routes.ts:176-181`) | **PAGE-LEGIT** | Keep |

**Counts:** RIDES 2 · ADAPTER 1 · PARALLEL 0 · THEATER 1 · PAGE-LEGIT 15.

---

## Blockers (from scouting) — each with the honest alternative

**BLOCKER-1 — Environments' approval integration is theater.**
Evidence: `environmentsService.ts:62` (record field), `:313-316` ("assumes it
was gated … admin/approval"), `:347, :401` (threads `approvalId` into the record),
vs. `routes.ts:135-174` (promote/rollback/apply never construct one). The UI's
only gate is a bespoke `confirm()` (`EnvironmentsPage.tsx:130-137, 256-263`) —
exactly the "bespoke approve/submit button duplicating HITL" the method names a
demolition target (Law 4). Promote-to-**protected**/`prod` is the highest-
consequence config act in the unit and it leaves no durable decision record
beyond `actor` + timestamp.
**Honest alternative:** wire promote-to-protected/`prod` (and any `locked`
override) to the **approvals owner** as a new approval kind that renders in the
**reviews inbox**, and set the already-reserved `approvalId` on the promotion
record from the resolved decision. `open→open` promotions stay direct (gate
fatigue rots gates — cadence is an input, Law 5/HITL test). This is the
challenge-publish precedent, and the schema already anticipates it — so it is a
*wiring* job, not a new store. If the team decides prod promotion should remain
RBAC-only, then **delete the `approvalId` field** rather than let the model
promise an approval that never happens.

**BLOCKER-2 — There is no chat affordance to *start* an OAuth connect, only a
page.** Secret entry must never be chat-driven (correct today). But "connect my
Google account" is a describe-intent action whose *safe* part (mint the consent
URL, bounce the browser) has no agent tool. Scouting confirms no
`registerFeatureAgentTool` in the package.
**Honest alternative (deferred, low priority):** a single **read-safe agent tool**
`connections.beginOAuth(provider)` that shares `isProviderAllowed` +
`isOAuthConfigured` (the route's own predicates, `routes.ts:243-248`) and
returns the authorize URL as a link the user clicks — the secret exchange still
happens only in the server callback, never in chat. This is additive; it does
not touch the secret path. Deferred honestly below — it is a nicety, not a gap.

---

## Demolition list (with regression pins)

There is **almost nothing to demolish** — this unit is correctly page-shaped.
The only candidate is conditional on BLOCKER-1's resolution:

- **IF** promote-to-protected ports to the approvals owner: demolish the
  bespoke promote/rollback/apply `confirm()` path in `EnvironmentsPage.tsx`
  (:130-137, :256-263) for protected/`prod` targets, replacing it with the
  reviews-inbox card. **Regression pin:** a test asserting that a promote whose
  target env is `protected`/`locked` **returns a pending approval** (not an
  applied pointer move) and that the resulting promotion row carries a non-null
  `approvalId` — so a resurrected direct-`confirm()` path fails the suite.
- **IF** the team keeps RBAC-only: demolish the `approvalId` field across
  `environmentsService.ts` and pin a test that the promotion record type has no
  approval field (so no future reader is lied to).

Everything else (secret forms, OAuth flow, vault, governance, catalog) is
PAGE-LEGIT and must **not** be demolished.

---

## New-code inventory (small, as the method demands)

Only if BLOCKER-1 is taken (recommended):
1. One **approval kind** registration for env-promotion (reuse the approvals
   owner + reviews-inbox renderer; no new inbox).
2. A **route wiring** change in `routes.ts` promote/rollback/apply to: resolve
   the target env's protection, and for `protected`/`locked` create the approval
   and return pending instead of applying; on approval, apply and stamp
   `approvalId` on the promotion record (field already exists).
3. Two **reads/pins**: the pending-approval test and the `approvalId`-set test.

Optional (BLOCKER-2, deferred): one read-safe `connections.beginOAuth` agent
tool sharing the existing route predicates. No new store, no secret path change.

**No new workflow, no new node, no new agent persona, no canvas.**

---

## Phased plan (gated on real gates)

- **Phase 0 (honesty, do first):** Decide BLOCKER-1's direction. If keeping
  RBAC-only, remove `approvalId` now (stop the lie) — this is a pure-subtraction
  PR with the type-pin test. `/code-review`.
- **Phase 1 (if igniting the seam):** Register the promotion approval kind +
  wire promote/rollback/apply to create-and-await it for protected/`prod`; stamp
  `approvalId` on apply. Reviews-inbox rendering is inherited. Close with
  `/code-review` + `/ux-review`; the compliance seam (approval record) lands
  *before* any UI change.
- **Phase 2 (demolition, only after Phase 1 works):** Replace the protected-
  target `confirm()` with the approval hand-off; add the regression pins. `/ux-review`.
- **Phase 3 (deferred nicety):** `connections.beginOAuth` agent tool. Gate on
  `/grade-ai-exchange` (the tool must share the route predicates and fail typed).

---

## Deferred honestly

- **Chat-initiated OAuth connect** (BLOCKER-2): not built; low value; the secret
  exchange must stay server-side regardless. Stated, not faked.
- **Chat-driven "test my connection"**: could be a read-safe agent tool but adds
  little over the button; not proposed.
- **Everything secret/policy (vault, governance, OAuth client, secret forms)**:
  intentionally page-only forever — chat-driving secrets is a non-goal, not a gap.
- **Environments has no per-domain approval cadence control**: if Phase 1 lands,
  cadence (which protection levels require approval) should be an input, not
  hard-coded — noted for that phase, not silently assumed.
