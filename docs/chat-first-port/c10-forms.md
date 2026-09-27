# Forms (C10) — chat-first port review

**Scope:** single-feature mode. Backend `backend/typescript/src/features/forms/*`;
frontend `frontend/react/src/features/forms/*`; packs `packs/feature.forms.{nodes,agents}`;
example chain `examples/workflow-chain-packs/forms-intake`. Context ADRs 0330 (standalone
capture primitive / submission-sink seam), 0331 (ONE `PublicFormRenderer` + shared
`deriveFields` engine), 0332 (funnel opt-in embed). Toggle `forms`, off by default
(`feature.ts:28`).

## Headline

Forms is **already the engine's capture primitive, and it rides correctly.** Nearly every
capability either instantiates a real owner or is an honest page. It is not a feature that
shadows a primitive — it *is* one, and five other features RIDE its seam (CRM, webinars,
funnels, email, service-desk all `registerSubmissionSink`; `submissionSinks.ts:45` callers).
Its own intelligence (lead insights) is expressed the chat-first way: an agent pack + node
pack over `ctx.features.forms`, driven through the ONE chat. There is **no parallel
architecture, no shadowed owner, and no bespoke "talk to AI" surface** (grep for
aipanel/askAi/conversationToolLoop in the package returns empty). The single genuine
chat-first opportunity is **additive, not demolition**: form *authoring by describing intent*
has no agency — the shipped agent is deliberately read-only — so "make me a contact form with
name/email that routes to my CRM list" cannot be done in chat today.

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Public render + submit (the capture core) | ONE `PublicFormRenderer` fetches the public render schema, validates via the shared ADR 0197 engine, POSTs back; server owns honeypot/caps/rate-limit (`PublicFormRenderer.tsx:65`, `routes.ts:146-223`, `formsService.ts:374`) | **RIDES** | Leave alone — the ADR 0331 single-renderer story holds; consumed by CMS `form` section (`cms/SectionRenderer.tsx:334`) and funnel viewer (`funnels/viewer/FunnelViewerPage.tsx:115`) through one `FormEmbedProvider` |
| CRM contact-on-submit | Post-persist submission sink; CRM registers its own sink at boot, forms imports no CRM (`crm/formsSubmissionSink.ts:29`, seam `submissionSinks.ts:45`) | **RIDES** | Leave — clean inversion seam; CRM/webinars/funnels/email/service-desk all ride it |
| Route submission → priority-matrix idea | `host.forms.submission.created` emitted unconditionally (`emit.ts:11`); `forms-intake` chain re-reads under authz + files via existing `submit-idea` node; built entirely from catalog nodes (`core.trigger.event`, `feature.forms.nodes.get-submission`, `feature.priority-matrix.nodes.submit-idea`, `core.flow.noop`) (`examples/workflow-chain-packs/forms-intake/pack.json:18-32`) | **RIDES** | Leave — real workflow, real igniter mechanism (ADR 0208 event→workflow binding). Deferred-honestly: no default per-tenant binding ships (examples-only) |
| Lead insights (summarize submissions) | Agent pack `feature.forms.agents.lead-insights`, tools `list-forms`/`list-submissions` over `ctx.features.forms`, driven through the ONE chat, read-only by design (`packs/feature.forms.agents/pack.json:14-27`) | **RIDES** | Leave — this is the chat-first-correct expression of the feature's intelligence (ADR 0058 agent+nodes pattern) |
| `ctx.features.forms` read surface | Thin tenant/org-guarded projection over `formsService`, drops internal columns (`surface.ts:21-52`) | **ADAPTER** | Leave; watch for drift as write nodes land |
| Analytics session↔contact link on submit | Rides `analytics/identityLinkService.linkSession` behind the ONE consent gate `consent/consentService.isAllowed` (`routes.ts:214-220`) | **RIDES** | Leave |
| Email marketing opt-in | Designated checkbox field feeds email's consent sink; email registers its own sink (`email/formsConsentSink.ts:21`) | **RIDES** | Leave |
| Retention + erasure lifecycle | `registerRetentionPurger` by classification; `onCrmRecordDeleted` unlinks dangling `contactId`; `fireFormDeleted` on delete; deterministic cascade of submissions+counter (`formsService.ts:107-130`, `291-308`) | **RIDES** | Leave — deliberately not a subject-eraser (business-record-about-another posture, documented `formsService.ts:100`) |
| Build a form (create/edit fields, config, intake binding) | Bespoke structural builder panel (`FormsPage.tsx:307-430`), server-validated writes (`formsService.ts:217-289`) | **PAGE-LEGIT** | Keep the builder as structural editing; **add** an authoring agent tool for describe-intent creation (see Blocker B1 — the one real port) |
| Publish / unpublish | Bespoke toggle → `status` field flip (`FormsPage.tsx:314`, `routes.ts:93`, `formsService.ts:283`) | **PAGE-LEGIT** | Keep — a self-service state flip on your own draft, not a multi-party decision; NOT an approvals shadow |
| Submission inbox (view captured leads) | Read-only paginated projection with search (`FormsPage.tsx:433-470`, `listSubmissionsPage` `formsService.ts:333`) | **PAGE-LEGIT** | Keep — honest read page; complements (does not compete with) the lead-insights agent |

**Counts:** RIDES 6, ADAPTER 1, PARALLEL 0, THEATER 0, PAGE-LEGIT 3.

## Blockers (from scouting) — each with the honest alternative

**B1 — Form authoring has no agency (the one real chat-first gap).** The declared agent
`feature.forms.agents.lead-insights` is `toolAllowlist`-scoped to `list-forms` +
`list-submissions` and is explicitly read-only ("Report, do not mutate … You have no tool to
edit a form" — `prompts/forms-lead-insights.md:24-26`). The node pack ships **only read
nodes** (`packs/feature.forms.nodes/index.mjs:86-90`; the surface is read-only in v1,
`surface.ts:5`). So a user cannot accomplish form creation/editing "by describing intent" —
the interface test's chat path is absent. This is a **capability gap, not theater** (nothing
claims chat authoring). *Honest alternative:* the additive port target below (B1-port) —
create-form / update-form / set-status **action** nodes on the surface, a small authoring
agent whose action tools share the routes' `authorizeOrgScope` predicate (one helper, route +
tool both call it), driven through the existing chat. Until then, authoring stays the
PAGE-LEGIT builder and this is deferred honestly.

**B2 — The routing chain ships no default ignition.** The `forms-intake` chain lives under
`examples/workflow-chain-packs/`. Its own manifest says an operator must "bind it per tenant to
`host.forms.submission.created` via the ADR 0208 event→workflow bindings"
(`forms-intake/pack.json:5`). The emit is real and unconditional (`emit.ts:11`), the ignition
*mechanism* is real (`host/hostEventDispatcher.ts`), and every other event→workflow chain in
the app is the same per-tenant-config shape — so this is **RIDES with operator-config
ignition**, not theater. *Honest statement:* out-of-the-box a form submission emits an event
nothing consumes; that is expected and deferred visibly, not painted green.

> **CORRECTION (WF-FORM-4, ADR 0584).** This paragraph used to add that the chain
> is "**not** in `packs/`, **not seeded**, and **not in the deploy `/install`
> bundle** (grep for `forms-intake` across `backend/typescript/src`, `scripts`,
> `DEPLOY.md` returns nothing)". Only the first of the three is true.
> `Dockerfile:161` COPYs the whole `examples/workflow-chain-packs` tree into the
> Cloud Run image, and the chain declares `"required": []`, so it is
> **zero-config** and `seedZeroConfigWorkflows` mints a per-tenant OWNED,
> picker-runnable copy (`seedWorkflows.ts:70-80`). The cited grep is exactly why
> the claim read true: `forms-intake` is never NAMED in `src/` because the seeder
> iterates `listChains()` generically — grep the mechanism, not the string. This
> is not a pedantic correction: the "not seeded" error is what let WF-FORM-2 sit
> unnoticed, because a chain nobody believed was runnable turned out to be one
> click away in the `/` picker, where it completed GREEN and EMPTY.

**B3 (non-blocker, discoverability) — the lead-insights agent has no forms-specific
deep-link.** It surfaces only through the generic agents page (loaded-pack agents auto-appear;
CRM/kb precedent). There is no `navigate('/?agent=feature.forms.agents.lead-insights')`
affordance from the submissions inbox where an operator would want it. *Alternative:* an
additive "Analyze leads in chat" deep-link button on the inbox header (the agents-page /
ProjectChatTab precedent) — cheap, additive, no new chat.

## Demolition list (with regression pins)

**Nothing qualifies for demolition.** There is no bespoke AI surface, no second renderer, no
second chat, and no owner shadowed. The builder, publish toggle, and inbox are PAGE-LEGIT and
stay. The regression pins that matter here are **anti-resurrection guards for invariants
already in place**, to add alongside any future authoring port:

- **One renderer pin:** a test asserting CMS + funnel + hosted-fill all import
  `forms/render/PublicFormRenderer` (no second fill component appears) — protects ADR 0331.
- **Read-then-write authority-parity pin:** if B1-port lands, a test that the new action nodes
  and the HTTP routes call the *same* `authorizeOrgScope`/`getForm` tenant+org guard (the
  0458-B1 lesson — the surface you forget is the one a co-tenant finds).
- **Ids-only event pin:** `formSubmissionCreated` payload carries no `values` (`emit.ts:14`) —
  keep the "re-fetch under authz" discipline (`surface.ts:39`) enforced.

## New-code inventory (only if B1-port is pursued — SMALL and additive)

1. Three **action** nodes on `feature.forms.nodes`: `create-form`, `update-form`,
   `set-status` (thin wrappers over `formsService.createForm/updateForm/setFormStatus`, which
   already validate closed-world).
2. Surface writes on `buildFormsSurface` sharing the existing tenant/org guard (`surface.ts`).
3. One authoring agent (or extend lead-insights with a write allowlist behind an
   `agentProfile` grant) whose action tools call the **same** `authorizeOrgScope` predicate the
   routes use.
4. An optional inbox→chat deep-link (B3). No new chat, no new renderer, no new store, no new
   durable row — publish stays the self-service flip.

## Phased plan (gated on real gates)

- **Phase 0 (now):** ship this review. No code change. Forms already rides the engine.
- **Phase 1 (additive, optional):** authoring nodes + surface writes + authority-parity test
  (B1-port §1–2). Gate: backend `npm run ci` green, the parity pin passing.
- **Phase 2:** authoring agent + inbox deep-link (B1-port §3, B3). Gate: `/code-review` +
  `/ux-review`, fixes applied; the one-renderer pin added.
- No demolition phase — there is nothing to demolish.

## Deferred honestly

- **No chat-authoring today** (B1): the shipped agent is read-only by design; describe-intent
  form creation is a gap, stated not faked.
- **No default routing binding** (B2): the `forms-intake` chain is examples-only and
  operator-installed per tenant; out-of-the-box the submission event has no consumer.
- **Single `contactId` slot** on the sink merge (first-marker-wins, `submissionSinks.ts:28`) —
  a documented ADR 0330 open question, not a defect.
