# Operations console (unit D5) — chat-first port review

Scope: backend `features/{operations, proposals, portability}` + frontend
`features/operations` (proposals/portability have **no** React UI). Single-feature
mode; read-only audit; verdicts against the app's real primitives.

**Headline:** This unit is overwhelmingly page-legit-or-rides-the-engine. The
Operations console is a textbook honest operator page (reads real primitives,
audits its writes, tells the per-instance truth); Portability's import/export
correctly materializes through the single owning services. The **one real defect
is THEATER in Proposals**: the RFC 0096 "reviewable-learning" lifecycle ships a
read-only agent tool that instructs the model to check "before proposing again"
(`agentTools.ts:24`) but **no route, tool, or synthesizer anywhere creates a
proposal** — the only writer is a hard-coded demo seed. There is nothing to
"port to chat" here; there is a producer to build or a claim to drop.

---

## Contract scouting (evidence)

**Operations — a composed read-console, not an engine feature.**
- Feature purpose is explicit: "read-panels over EXISTING backend primitives …
  NO new collectors, NO new authoritative stores"
  (`operations/feature.ts:1-9`). Every endpoint fans in existing services:
  webhook deliveries via `storage.listWebhookDeliveries` (`routes.ts:81`),
  trigger subs via `triggerBridgeService` (`routes.ts:26-33`), DLQ via
  `inMemorySurfaces`/`durableQueue` (`routes.ts:34-35`), health via
  `managedProvider`/`auth`/`health`/`sseChannel`/`rateLimit`/`daemonStatus`
  (`routes.ts:37-43`). No new owner is instantiated.
- Gating is two-tier, fail-closed: cross-tenant reads + all writes are
  `requireSuperadmin` (`routes.ts:130,148,170,190,223,250`); a tenant's own
  panel rides `authorizeOrgScope(req, FEATURE, 'webhooks:manage')`
  (`routes.ts:139`). The `operations` toggle gates only the surface, never auth
  (`feature.ts:12-15`, default **off** `feature.ts:32`).
- Frontend is two admin-tier pages wired in `chrome/features.tsx:180,185`
  (`/operations`, `/operations/webhooks`, `tier: 'admin'`), lazy-loaded
  (`features.tsx:44-45`). Writes surface backend 403/404 honestly
  (`OperationsHubPage.tsx:37-41` treats 403 as an operator-only state, not an
  error — detected by status, not message text).

**Proposals — a seam with a reader and no writer.**
- Routes are list / get / revise / apply / reject / archive — **there is no
  create route** (`proposals/routes.ts:64-131`; the only `app.post`s are
  `…/apply` and `…/reject`, `routes.ts:100,120`).
- The service exposes no public create either — a proposal is only born from
  `ensureDemoProposal` (a fixed-id demo draft, `proposalsService.ts:171-185`)
  or the test helper `putProposal` (`proposalsService.ts:161-163`,
  `__test` `:187`). Grep for external writers finds only `discovery.ts`
  (reads `activationMode`) and tests — nothing synthesizes a proposal.
- The agent tool is **read-only** `openwop:proposals.list`
  (`agentTools.ts:12,17-40`), whose description tells the model to "Check this
  BEFORE proposing an improvement — do not re-propose something already
  rejected" (`agentTools.ts:24`) — a premise with no matching propose path.
- Apply, when `OPENWOP_PROPOSALS_ACTIVATION=approval-gate`, mints a real
  approval via the owner (`proposalsService.ts:137-146` → `createApproval`),
  which `listApprovals` (the reviews inbox / heartbeat, `approvalService.ts:180,641`)
  reads — so the gate *would* ride the owner if a proposal ever existed.
- Advertised only when `OPENWOP_PROPOSALS_ENABLED=true` (`discovery.ts:776-781`);
  conformance/CLI seam, off by default (`feature.ts:1-10`).

**Portability — rides the single owners, cleanly.**
- Export/import route through **one owning service per kind** in a table, not a
  fork: roster (`portabilityService.ts:185-227`), agent-profile (`:230-267`),
  prompt-template (`:269-311`), connection-ref (`:313-337`, refs-only), schedule
  (`:339-379`), org-chart (`:381-407`), pack (`:409-418`, honest empty).
- Real safety posture: refs-only self-check on export (`:456-461`), credential
  scan → 422 before any apply even on `?dryRun` (`routes.ts:76-84`,
  `portabilityService.ts:139-148`), dependsOn-cycle → 422 (`:110-133`), 500-item
  cap (`:90,100`), CAS import-claim dedup (`:22-27`), inert-import (imported
  roster + schedules land **disabled**, `:224,373`), per-item isolation
  (`:427-437`). Deterministic tenant-scoped ids on schedules (`:360`).
- **No React UI**; only callers are tests (`test/portability.test.ts`). Off by
  default (`OPENWOP_PORTABILITY_ENABLED`, `discovery.ts:806-814`). Its
  operator is the external `openwop` CLI (`chrome.tsx` CLI cards
  `chrome/…/en/chrome.ts:88,133`).

---

## Verdict table

| # | Capability | Today | Verdict | Port target / disposition |
|---|---|---|---|---|
| 1 | System-health panel (readiness/SSE/rate-limit/daemon) | superadmin read, ONE batched request, per-instance-honest (`routes.ts:221-245`, `OperationsHubPage.tsx:70-93`) | **PAGE-LEGIT** | Keep. Honesty loop intact. |
| 2 | DLQ depths + gated replay | superadmin read + audited replay (`routes.ts:168-217`, `OperationsHubPage.tsx:95-128`) | **PAGE-LEGIT** | Keep. Operator infra action, not a model decision. |
| 3 | Webhook-delivery health + manual retry | own-tenant read via `webhooks:manage`, retry superadmin+audited (`routes.ts:137-163`, `OperationsWebhooksPage.tsx`) | **PAGE-LEGIT** | Keep; safe projection (no secret/payload) verified `routes.ts:61-74`. |
| 4 | Trigger-subscription pause/resume | superadmin write via existing state machine (`routes.ts:247-268`) | **PAGE-LEGIT** | Keep. Rides `setSubscriptionState`; audited. |
| 5 | Ops-hub console navigation | link cards to per-surface routes (`OperationsHubPage.tsx:130-154`) | **PAGE-LEGIT** | Keep. Each link keeps its own gate (D3). |
| 6 | **Reviewable-learning producer** (agent learns → proposes) | **no route/tool/synthesizer exists**; only demo seed (`proposalsService.ts:171-185`) | **THEATER** | Build the producer or drop the "before proposing" claim. See Blocker P-1. |
| 7 | Proposals list (agent tool) | read-only `openwop:proposals.list`, tenant-scoped (`agentTools.ts:17-40`) | **ADAPTER** | Honest read; but its guidance premise is unmet until #6 exists. |
| 8 | Proposal apply → approval gate | `createApproval` in approval-gate mode (`proposalsService.ts:135-147`) | **RIDES** | Rides approvals owner; surfaces in reviews inbox. Leave. |
| 9 | Export bundle | refs-only read through single owners (`portabilityService.ts:442-462`) | **RIDES** | Rides one owner per kind. No app UI (deferred honestly). |
| 10 | Import bundle (dry-run + apply) | materializes through single owners, CAS-deduped, inert (`portabilityService.ts:421-439`) | **RIDES** | Rides owners; apply is RBAC-gated (`routes.ts:27-37`). No app UI. |

**Tally:** RIDES 3 · ADAPTER 1 · PARALLEL 0 · THEATER 1 · PAGE-LEGIT 5.

---

## Blockers (from scouting) — each with the honest alternative

**P-1 (THEATER, the only material finding): the reviewable-learning loop has no
producer.** The agent tool instructs the model to check proposals "BEFORE
proposing an improvement" (`agentTools.ts:24`), the CLI markets a full
"an agent's learned change lands inert; a human applies it" lifecycle
(`en/chrome.ts:86,130`), and `discovery.ts:776-781` advertises `agents.proposals`
— but **nothing in this app writes a proposal**. The list is always exactly the
one demo draft (`proposalsService.ts:171-185`). Honest alternatives, pick one:
- *(recommended, chat-first)* Add a **write** agent tool `openwop:proposals.propose`
  (action-typed, shares the route's `packs:publish`-adjacent predicate) so an
  agent that notices a recurring improvement can file an **inert** proposal
  mid-conversation; the human applies it through the **existing approval gate**
  (`proposalsService.ts:135-147`) rendered in the **reviews inbox** — no new
  approve UI. This turns #6 RIDES and makes #7's read tool's premise true.
- *(cheapest)* If no producer is intended in-app, **drop the "before proposing"
  sentence** from `agentTools.ts:24` and reword the CLI cards so the advertised
  capability matches reality (read/review-only of externally-created proposals).

**P-2 (not a blocker, a scope truth): Proposals & Portability have no app
surface by design.** They are conformance + CLI seams, off by default. This is
**not** theater and **not** something to force into chat — the operator drives
them through the `openwop` CLI, which the frontend honestly documents rather than
reimplements (`CliPage`, `en/chrome.ts:67,88`). Do **not** build a bespoke
export/import wizard or a proposals panel; if an in-app affordance is ever wanted,
it is an agent tool + the reviews inbox, not a form.

**No blocker for Operations.** It is the reference shape for a PAGE-LEGIT
operator console: real reads, per-instance honesty (`routes.ts:239-242`,
`OperationsHubPage.tsx:81`), capped-sample truthfulness (`routes.ts:82-84`),
safe projection of secret-bearing records (`routes.ts:51-74`), audited writes
(`routes.ts:152-159,206-214`), and a 403→operator-only state instead of a broken
panel (`OperationsHubPage.tsx:37-41`).

---

## Demolition list (with regression pins)

Nothing to demolish. There is **no bespoke "talk to AI" surface, no second chat,
no duplicated approvals/gate UI, and no parallel owner** anywhere in D5. The only
"remove" candidate is a false claim, not a surface:
- If P-1 is resolved the cheap way, **delete the "before proposing" clause**
  (`agentTools.ts:24`) — pin with a test asserting the tool description makes no
  claim the app can't satisfy (a resurrected "propose" instruction with no
  propose path fails the suite).

Regression pins to *keep* (already-correct invariants worth locking so a future
edit can't rot them into parallel architecture):
- Operations never adds a Stripe/second-owner client or a new store —
  `feature.ts:1-9` intent; pin a grep test that `operations/` imports no
  `new Durable*`/authoritative store constructor.
- Webhook projection never emits `secret`/`payload` (`routes.ts:61-74`) — the
  existing safe-projection assertion must stay green.
- Portability export self-scans for credential material (`:456-461`) — the
  `export-bundle-no-credential-material` leg must stay red on a leak.

---

## New-code inventory (small — only if P-1 is built)

1. One **action** agent tool `openwop:proposals.propose(kind, title, artifact,
   rationale?)` in `proposals/agentTools.ts`, sharing the same scope predicate as
   a new `POST /proposals` route (one helper, route + tool both call it; typed
   failure, never success-with-empty).
2. A thin `createProposal(tenant, …)` in `proposalsService.ts` that writes an
   **inert** `draft` (mirrors `ensureDemoProposal`'s shape; deterministic id off
   content hash so a retry replaces, never duplicates — `lifecycle test`).
3. No new UI: apply continues through `createApproval` → reviews inbox
   (`proposalsService.ts:137-146`); the proposal card is a **plain interrupt/
   approval card** (fixed approve/reject kind, no model-variable layout) — not
   A2UI, not a new typed renderer (card-mechanism test: fixed decision kind →
   `interrupt.<kind>` registry).

That's the whole port. Everything else already rides the engine or is a
legitimate page.

---

## Phased plan (gated on real gates)

**Phase 0 — honesty first (no code, or one-line copy fix).** Decide P-1 direction.
If "no in-app producer intended," land the copy correction
(`agentTools.ts:24` + CLI cards) + the description-parity test. Close
`/code-review`. *(This alone makes the unit fully honest.)*

**Phase 1 — (only if a producer is wanted) the propose seam.** Add the route +
action tool + `createProposal` + deterministic id + erasure/retention parity for
the new writer (proposals already tenant-partition by row key
`proposalsService.ts:22`; confirm the eraser covers the `proposals` collection).
Apply stays on the existing approval gate. Close `/code-review` + `/ux-review`
(the only UX is the reviews-inbox card, already localized).

**No phase touches Operations or Portability** — they are correct as-is.

---

## Deferred honestly

- **Proposals & Portability in-app UI**: intentionally absent (CLI/conformance
  seams, off by default). Not deferred-as-broken — deferred-as-designed; stated
  in `feature.ts` for both. Do not paint an app surface green for them.
- **Fleet-aggregate ops metrics**: the health/DLQ/SSE panels are explicitly
  **per-instance** on Cloud Run (`routes.ts:239-242,175-181`), surfaced as a
  warning chip (`OperationsHubPage.tsx:81,105`). A cross-instance aggregate needs
  a shared metrics store — correctly deferred, visibly, not faked.
- **Import HITL card**: portability apply is RBAC-gated (`packs:publish`), not
  human-gated with an inline card. Acceptable for a CLI/REST seam; if it ever
  gets an in-app apply, that apply should mint an approval like proposals does.
