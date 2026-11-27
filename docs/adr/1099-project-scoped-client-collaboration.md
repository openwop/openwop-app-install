# ADR 1099 — Project-scoped client collaboration

Status: Accepted (2026-11-11, the user's decision: option A′). P0 through P4 are
implemented (see the implementation record at the end); P5 is not built.

> **CORRECTED 2026-11-26:** this line still said "P2–P5 are not built" after P2,
> P3a–P3d had merged. P4 (this PR) adds D10.

> **CORRECTED 2026-11-17:** this line said "nothing is built yet" after P0 had
> merged (#5773, `b81316cab3`). It read as if the per-kind gate (D1) still had to
> be built, and a peer was asked to build it.

Host-extension work under `/host/openwop-app/*`. It adds no run-event field,
capability, event type or endpoint contract on the OpenWOP wire, so it needs no
RFC (to be re-checked once the shape is chosen).

## Context

A firm runs each client engagement as a project. Its client is not a workspace
member, and the firm wants the client to:

1. **Chat with an agent about their own project only.** The agent may read that
   one project, and nothing else in the workspace.
2. **Send the firm messages that a firm member reviews** before they count.
3. **Be interviewed by the agent,** which writes what it learns as **proposals**
   into a project record the firm accepts or rejects.

The first adopter is a white-label deployment for residential design firms: its
client portal and room-by-room interview. The need is generic: any services
business with an outside client.

### What exists (measured on `main`, 2026-11-11)

- **ADR 0958 external collaborators** (`host/externalCollaborators.ts`) is a
  generic grant seam:
  - Any feature registers a grant kind with `registerGrantResourceKind`. Three do
    today: change-set, `campaign`, `creative-brief`.
  - Grants carry actions (`view|comment|upload|mark-ready|decide`) and a required
    expiry of 30 days by default, 180 at most.
  - Every use is re-checked live by `checkGrantUse`: the grant, the person, the
    feature toggle, the org, the granter's authority, the target's existence. A
    refusal is a uniform 404.
  - Grants can be revoked, and every step is audited.
  - Two identity modes: **signed-in**, an email-verified account in the
    collaborator's own tenant, bound by CAS on invite accept; and **link-only**,
    grant-backed sharing links with no session.
- **Two blockers in 0958:**
  - The **org gate** is one slot, filled only by campaign-ops with the rule
    "active client account". An org with no campaign-ops client fails closed for
    every invite, grant and use. The routes also need the campaign-ops toggles.
  - **D1 forbids chat for collaborators**: grants "never authorize … chat,
    agents", and a witness test asserts it. This was deliberate.
- **ADR 1040 focus kinds** (`host/conversationFocus.ts`):
  - A focus is authorized at bind and on every tool read.
  - It requires an acting member user, and only `canvas` is registered.
  - `EmbeddedChatPanel` needs a member session and the caller's BYOK key.
- **The chat-widget** (`features/chat-widget/`) has a public gateway:
  - The capability token plus an origin allowlist admits the visitor, and the
    visitor is an opaque hashed session id.
  - Turns run on the **owner's credential**.
  - The anonymous turn (`host/anonymousActor.ts`) compiles **only the granted
    tools**, never the baseline. Its writes are held as `anon-surface-write`
    approvals. It sits behind `OPENWOP_ANON_ACTOR_ENABLED`.
  - Its scope is the whole tenant, and visitor *messages* have no review step.
- **Narrow channel turns** (`conversationToolLoop.ts`) restrict a turn to a
  reviewed safe list. Every tool on that list is data-free, so none reads a
  project.
- **Projects** (`features/projects/`) are always on and org-scoped; members must
  be org members. There is no project grant kind or project focus kind.
- **Team intent ledger deltas** are already project-scoped proposals: status
  `proposed → accepted | rejected`, an agent author kind, owner CAS accept. So is
  campaign-ops **vendor intake**: an outsider submission held inert until a
  member accepts it.

## Options

### A. Generalize ADR 0958 and give signed-in collaborators a scoped chat

- Make the org gate **per feature**. Campaign-ops keeps its client-account rule
  for its kinds, and projects register their own rule.
- Add a `project` grant kind.
- Amend 0958 D1: a collaborator holding `project:view` may chat, in a
  collaborator turn scoped to that one project.
- Bind the turn's focus from the grant, server-side, never from model input.
- Reads: new reviewed project-read tools. Writes: proposals only, as ledger
  deltas or intake. Messages to the firm: held for review.
- Clients need an account (signed-in mode).

### B. Extend the chat-widget's public gateway

- A widget session bound to one resource by a capability token (a sharing link)
  instead of the origin allowlist.
- An anonymous turn whose tools take the project id from the server-held binding.
- Writes as `anon-surface-write` approvals, plus a new reviewed-message inbox.
- No account and no stable identity: anyone holding the link is the client.
- Needs `OPENWOP_ANON_ACTOR_ENABLED` and a resource binding the gateway does not
  have.

### C. Hybrid: 0958 grants for identity, the anonymous turn for the chat

- Identity, expiry, revocation, per-use checks and audit come from a 0958
  **link-only** (or signed-in) collaborator holding a `project` grant. This
  needs the per-feature org gate from A.
- The turn reuses the anonymous-actor machinery: the firm's credential, granted
  tools only. Its scope comes from the **grant** instead of the tenant, and
  `checkGrantUse` runs on every tool call.
- Proposals are ledger deltas with an outsider author kind. Messages to the firm
  are intake items.
- 0958 D1 is still amended, but the chat lane is the anonymous turn, not member
  chat.

## Questions for review

1. A, B or C? Which keeps one identity model, and which reuses the most
   per-use checking?
2. Is amending 0958 D1 acceptable, and what is the narrowest wording?
3. How should the org gate become per feature without weakening campaign-ops'
   fail-closed rule for its own kinds?
4. Which project reads are safe for an outsider? Is that a new reviewed safe
   list, or per-tool grant checks?
5. Whose model credential and spend cap does a client turn use, and how is abuse
   bounded (rate, session and day caps)?
6. Are reviewed messages and agent proposals one primitive or two (ledger delta
   versus intake)?
7. Does anything touch the wire? The expected answer is no.
8. Erasure: what does subject erasure do with a client's turns, messages and
   proposals?

## Review (`/architect`, 2026-11-11)

Tracks: A (app architecture, options mode) and B (wire check). Reads were
targeted, and no suite ran.

### The finding that decides it: B and C misuse RFC 0132

The anonymous-actor turn (`host/anonymousActor.ts`) implements **RFC 0132**
(Draft). It stamps `metadata.principalKind: 'anonymous'` on a real run
(`anonRunOwner`, `:184`), advertises `capabilities.anonymousActor` when enabled,
and emits RFC 0049 `authorization.decided` records. RFC 0132 §A.2–A.3 require
that identifier to be "scoped to a single public-surface session", never "a
stable, long-lived handle", and never "resolvable … to an authenticated
principal … or any other anonymous-actor session".

A portal client is one person across weeks of sessions, whose messages and
proposals the firm attributes to them. Running their turns as anonymous puts a
false principal kind on the wire:
- **C as drafted:** anonymous-turn mechanics with a grant identity. Rejected.
- **B, once messages and proposals are attributed:** the same conflict. B is
  also tenant-wide today, has no review step for messages, and depends on a flag
  that advertises a capability. Rejected.

### Option scores

| | Identity | Per-use authz | Wire honesty | Boundaries | Verdict |
|---|---|---|---|---|---|
| A as drafted | One model (0958) | `checkGrantUse` | Honest | Implies member chat (`EmbeddedChatPanel` needs a member session and the caller's BYOK), which is the wrong surface | Right identity, wrong turn |
| B | Bearer link, none | Widget caps only | Violates 0132 §A once attributed | A second identity model beside 0958 | Rejected |
| C | 0958 | `checkGrantUse` | Violates 0132 §A.2–A.3 | Good reuse | Right mechanics, wrong principal kind |

**Dominant force:** one identity model, plus an honest principal on the wire,
plus one per-use authorization on every tool call.

**Recommendation: A's identity with C's mechanics, under an identified
principal (call it A′).** The default-deny, granted-tools-only turn machinery is
extracted from the anonymous actor into a shared helper. The anonymous lane keeps
using it unchanged, and a new collaborator lane uses it under a non-anonymous
principal.

### Answers to the review questions

1. **Which option:** A′, above.
2. **The 0958 D1 amendment (narrowest wording):** "Grants never authorize a
   member route, `/runs`, member chat or agents. One exception (ADR 1099): a
   holder of a `project` grant with `view` may drive the host collaborator-turn
   lane for that one project. Its tools are only the registered client-project
   tools, and every tool call re-runs `checkGrantUse`." Member chat stays closed.
3. **A per-feature org gate without weakening campaign-ops:** a grant kind may
   bring its own `orgGate`. A kind without one keeps the existing single gate,
   which is campaign-ops' client-account rule. If no gate is registered at all,
   the use is refused, as today. Every existing kind (change-set, `campaign`,
   `creative-brief`) behaves byte-for-byte as before.
4. **Safe project reads:** neither the ADR 0315 baseline nor the channel safe
   list, whose tools read no workspace data. Instead, a new registry,
   `registerClientProjectTool({ id, featureId, effect: 'read' | 'propose',
   approvalKind?, run })`:
   - The host supplies `{ tenantId, orgId, projectId, grantId }` **from the
     grant**, never from model input.
   - It re-runs `checkGrantUse` (`view` for reads, `comment` for proposals)
     before every call.
   - Upstream ships two tools, `client.project.overview` (only fields the firm
     marks client-visible) and `client.message.send`. Adopter features register
     their own.
5. **Credential and abuse bounds:**
   - Turns use the **firm's** tenant resolution (the managed tier or the
     tenant's BYOK), never the client's.
   - Bounds: a turn cap per grant per day, a cap per tenant per day, a maximum
     message length, and the existing per-IP limits. The grant's expiry and
     revocation end everything.
   - `actingUserId` stays undefined, so member-keyed tools fail closed, and a
     collaborator's home-tenant user id is never aliased into the firm's tenant.
6. **Messages and proposals are ONE primitive: the approval service.** A
   `propose` tool never writes. The lane holds the call as the tool's declared
   approval kind, and that kind's recipe applies it on approve. This is the
   anonymous actor's held-write pattern (`:550–641`) on the host "Human
   approvals" seam. Kinds:
   - the host's `project-client-message`: on approve, the message joins the
     project's client thread;
   - adopters' own kinds, through `registerFeatureApprovalKind` (ADR 1031 P2).

   The team ledger is the wrong fit: its patch is the project charter, not a
   record. Vendor intake is owned by campaign-ops, so using it would make
   projects depend on campaign-ops.
7. **Wire:** none, under three conditions:
   - runs carry an opaque principal `collab:<collaboratorId>`, with
     `principalKind` **absent** (RFC 0132's own "unconstrained" default);
   - no capability is advertised;
   - no event type is added, and tool decisions are audited through 0958's host
     `appendAudit`, not a new wire record.

   If any of these changes, the RFC gate applies.
8. **Erasure:** extend 0958's collaborator subject eraser to cover:
   - the client's turn transcripts in the firm's tenant;
   - held approvals, redacted the way `eraseApprovalSubject` does for anonymous
     writes;
   - accepted client messages, whose author becomes the erased sentinel.

   Applied proposals are the firm's data and lose only their attribution.

### Two boundary findings A exposed

- **The collaborator routes live in campaign-ops** and require its toggles
  (`campaign-ops/collaboration/routes.ts:57–66`, `collabEnabledFor`). The
  identity flow (invite, accept, shared list, grant view) is host-level, because
  the seam is in `host/`, but its routes are owned by one consumer. P0 lifts them
  to a host route module, gated by each grant kind's owning-feature toggle
  (`ownerOn`). Campaign-ops keeps its portal-specific routes.
- **"No second chat system."** The client portal must reuse `chat/`'s
  `ConversationView` (feed, composer, cards) through a pluggable transport for
  the collaborator-turn endpoint, not a new chat panel. That transport is a
  frontend seam item in P4.

## Decision

A′, accepted by the user on 2026-11-11.

| # | Decision |
|---|---|
| D1 | A grant kind may register its own `orgGate`. Kinds without one keep the single campaign-ops gate. No gate at all means refused. |
| D2 | The collaborator invite, accept, shared and grant routes move to a host module, gated per grant kind's owning feature. |
| D3 | A `project` grant kind (actions `view`, `comment`) behind a new sub-toggle `projects.client-portal` (tenant bucket, default **off**). |
| D4 | 0958 D1 is amended with the one exception worded in answer 2. |
| D5 | A host collaborator-turn lane: a run in the firm's tenant; principal `collab:<id>` with `principalKind` absent; `actingUserId` undefined; the firm's credential; caps per grant and per tenant. Its tools are only the registered client tools, compiled through the default-deny helper extracted from the anonymous actor. |
| D6 | `registerClientProjectTool`: the scope comes from the grant, and `checkGrantUse` runs before every call. `propose` tools are held as approvals and applied by their kind's recipe on approve. |
| D7 | A host approval kind, `project-client-message`, and a project client thread (an ADR 1090 project tab for members; the portal for the client). |

> **CORRECTED 2026-11-25 (P3c), two parts.** (1) No separate `project-client-message`
> kind: P3a's `collab-proposal` kind already holds one item, lets a member decide it
> and applies it through the tool's `apply`, so a client message is the propose tool
> `openwop:client.project.message-send` on that kind, and approving it adds the
> message to the thread. (2) One thread per (project, collaborator), not one per
> project: a project can have a client and a builder, and they must not read each
> other's messages or the firm's replies to the other (the reason P2 added
> `audience`). Members read every thread of the project as a section of the Client
> access tab; a collaborator reads only their own. The ADR 1090 tab is not needed:
> the Client access tab already lives in the projects feature.
| D8 | The erasure scope in answer 8. |
| D9 | The portal UI reuses `chat/ConversationView` through a pluggable transport. |
| D10 | (Added 2026-11-26, P4, asked for by CasaVoga CV-0245 P4b.) A feature may add READ-ONLY **sections** to a collaborator's view of a granted resource: a server reader (`registerGrantViewSection`) plus a display component (`FeatureLazyExtensions.portalSections`). The scope comes from the grant only. The list and every read pass the per-use check and the kind's switch. Output is closed and bounded. |

## Phases and the witness each needs

| Phase | Ships | Witness (a route test unless noted) |
|---|---|---|
| P0 | D1 and D2, with no behaviour change | Every existing 0958 test still green. A kind with its own gate works for an org with no client account. A kind without one still refuses. Campaign kinds still need both campaign-ops toggles. |
| P1 | D3, D4, the firm's invite UI (a project tab) | The grant lifecycle: invite, accept, expiry, revoke, and the granter losing authority each give a uniform 404. A cross-org project gives 404. The toggle off refuses everything. |
| P2 | D5, plus the extraction refactor (the anonymous lane is unchanged) | The compiled tool list equals the registered client tools (no baseline). A model-supplied `projectId` is ignored. Revoking mid-conversation denies the next tool call. Run metadata never carries `principalKind: 'anonymous'`. Caps exhausted gives 429. The anonymous-actor suite is unchanged. |
| P3 | D6, D7 | A `propose` writes nothing before approval (sabotage: a direct write turns the test red). Reject applies nothing and redacts. Approve applies exactly once (CAS; a double approve is a no-op). A replay fork does not re-hold. |
| P4 | D9, the client portal page | Frontend: the portal renders `ConversationView` with the collab transport. No new chat component (the import-boundary check). |
| P4 (D10) | The section seam | A route test: the list and a read each 404 without a usable grant and with the switch off; the scope ignores the request; another kind's section is never served; least view closed; 64 KB cap; bounded per grant. |
| P5 | D8, adopter docs for the room interview | The eraser covers transcripts, held approvals and messages, through the census and erasure tests. |

## What would change this recommendation

- If RFC 0132 is revised to allow a stable, identified "guest" principal kind,
  the anonymous lane itself could carry these turns, and D5 would collapse into
  it. That needs the RFC first.
- If the firm wants clients with **no** identity at all (forwardable links, no
  account), then the right answer is B, but then messages and proposals must not
  be attributed to a person.
- If `checkGrantUse` cannot run inside a turn without a member session (unproven
  here), D5 needs a grant-bound turn session first. P2's first task is to prove
  this.

## Implementation record

| Phase | What shipped | Witness |
|---|---|---|
| P0 (#5773, `b81316cab3`) | D1: `GrantResourceKind.surface` (`enabledFor`, `orgOpen`), the default surface campaign-ops registers, every check on the KIND's surface. D2, the collaborator's half: shared, grant view, invite accept moved to `routes/externalCollaborators.ts`. | `adr1099-p0-collab-surfaces.test.ts`; all `adr0958-*` unchanged |
| P0b | D2, the firm's half, which P0 left behind campaign-ops' toggles and a client account (so a kind with its own surface could be used but never minted): `/host/openwop-app/orgs/:orgId/collaborators{,/audit,/grantable,/:id/grants,/:id/grants/:gid}`. Invite and admin reads need `host:members:manage` and some surface that takes the org. A grant or revoke needs the kind's new `grantScope` (default `host:members:manage`), floored at registration to `workspace:write` or a management scope, and the per-use granter re-check uses the same scope. Two gaps found on the way: `grantAccess` checks the kind surface's org rule but not its switch (its callers had each checked their own toggles), so the host mint route checks the switch itself; and `collab_invite` links were gated on the campaign-ops toggle, and now go through the surfaces. `grantAccess` is unchanged for its existing callers: putting the switch check there refused the client portal's system mint. Grant and revoke audit name the granter (`by`) and the kind. The campaign-ops agency routes are unchanged. | `adr1099-p0b-member-routes.test.ts`, with six sabotages, each red: route authorizing with the default scope, route without authority, re-check with the default scope, no floor, no `by` in the audit, no switch check at mint |
| P0c | Per-viewer projections and a recipient check, found while CasaVoga drafted its purchase-order kind. A grant names one id, so a second vendor's grant never projected the first vendor's PO. But a kind could not show each recipient only its own rows of a SHARED resource (`project` had no viewer), and nothing stopped a member granting one vendor's PO to another. `project(tenantId, orgId, id, viewer?)` now receives `{collaboratorId, grantId}` on every collaborator read (`projectForGrant`). A `requiresViewer` kind's projection is never called without one, and `grantResourceKind()` hands out only the guarded projection, so no host path reaches it. `mayGrantTo` runs at mint: false or a fault is 400 `grant_recipient_refused`. All three are optional; existing kinds are unchanged. | `adr1099-p0c-project-viewer.test.ts`, with four sabotages, each red: the guard ignoring `requiresViewer`, `projectForGrant` with no viewer, the read route projecting without a viewer, no `mayGrantTo` at mint |
| P1 | D3: the `project` grant kind (`features/projects/clientPortal.ts`), actions `view` and `comment`, under its own surface: the `projects.client-portal` sub-toggle (tenant bucket, default off; projects are always-on, so it is the only switch) and "the org exists in this tenant". A grant reaches the project only while the project is still in the grant's org. The projection is closed: the name and the charter status; what else a client sees is the firm's choice per field, in P3 (answer 4). Who may invite and grant stays the default, `host:members:manage`. A project delete revokes its live grants through the `host/subjectDependents` seam (`collaboratorGrants`), and the delete confirm names them. D4: the 0958 D1 amendment is written into ADR 0958 (it admits nothing until P2's lane exists). The firm's UI is a **Client access** project tab over the P0b host routes: invite a client or another firm (a builder) and grant this project in one step, give someone already invited access, take access back behind a confirm. The collaborator's grant page renders a project. No new route: everything rides the P0b host routes and the 0958 collaborator pages. | `adr1099-p1-project-grant.test.ts` (the lifecycle: invite, accept, the projection only, a builder granted the same shape, only view and comment, another org's and another tenant's project 404, revoke / expiry / the granter demoted each 404, an editor neither invites nor grants, a project delete revokes and the preview counts, the switch off refuses the picker, the invite and the mint and darkens a live grant); `adr0839-projects-delete-dependents` updated for the new key; frontend `projectClientAccessTab.test.tsx` |

| P2 (#6261, merged `390aa6c4a` in TRAIN 529; four ratchet fixes and the grantable shape fix on the way, see the PR) | D5. **Extraction:** `host/scopedToolTurn.ts` is the default-deny turn both non-member lanes run (`runAnonReadTurn` calls it; the anonymous lane is unchanged), and `host/outsiderTurnCredential.ts` is the ADR 1018 D8 credential rule lifted from chat-widget (the widget keeps thin wrappers). **Client tools:** `host/clientProjectTools.ts` `registerClientProjectTool`, read-only until P3, ids `openwop:client.<kind>.*` (classified by the capability firewall's `openwop:client.project` row), schemas that name a scope key refused, scope keys in model input dropped. **Audience** (decided 2026-11-23): `registerGrantAudience`, stored at mint, passed as `viewer.audience` and `ClientToolScope.audience`. **The lane:** `host/collaboratorTurn.ts` `runCollaboratorTurn` and `POST /host/openwop-app/collab/grants/:grantId/turn`: `checkGrantUse`, the kind's switch, a `turnAgentId`, the firm's credential (refused is 503), day caps per grant (50) and per tenant (500, `OPENWOP_COLLAB_TURNS_PER_{GRANT,TENANT}_DAY`, 429), the message fenced, a run owned by `collab:<collaboratorId>` (issuer `urn:openwop-app:collaborator`, no `principalKind`), tools resolved only from the client registry, `checkGrantUse` again before every call, each decision audited (`collab-turn.tool`). One turn, no history: a client-supplied history would let a client write the assistant's turns; the thread is P3 (D7). **Project:** the Project Guide agent (`vendor.openwop-app.projects.agents`) and `openwop:client.project.overview` (the P1 projection). | `adr1099-p2-collab-turn.test.ts` (exact tools, scope keys dropped, revoke between calls, the owner, 429, refusals), four sabotages each red: the pack allowlist instead of `clientToolsFor`, no `withoutScopeKeys`, no per-call re-check, `anonOwnerStamp`; `adr1099-p2-audience.test.ts`; the anonymous-actor suite unchanged |
| P2 follow-up (#6268, merged `3c77d85b9`, in v0.21.0) | The user's decision (2026-11-25): the Project Guide is not offered to members. `isCollaboratorOnlyAgent` (every allowlisted tool is `openwop:client.*`) keeps it out of `GET /agents`, and the pack sets `a2aExposed: false`. It stays installed and served to the collaborator turn. | `adr1099-hide-collab-agents.test.ts`; both sabotages red on their own case |
| P3a (#6273, merged `8fb30c474`) | D6. A client tool may be `effect: 'propose'`: `run` returns `{ proposals: [{ groupKey, idempotencyKey, summary, payload }] }` (≤ 10 per call, 20 propose calls per grant per day) and writes nothing. Each item is ONE approval of the new host kind `collab-proposal` (audience `workspace:write` in the org, a dispatch recipe, a redactor), id derived from grant + tool + idempotency key, so a rerun adds nothing. A member decides it through the shared claim/reject routes (`host/collabProposals.ts`): `workspace:write` in the org, then the tool's optional `mayDecide` (403 `collab_not_decider`, both verbs); approve re-checks the grant (revoked or expired gives 409 `collab_grant_ended`), CASes, then calls `apply` on the scope rebuilt from the grant; an `apply` that throws reopens the row, with its own 4xx passed through. Reject writes nothing and redacts the summary and payload. A collaborator's erasure cancels their pending proposals. A replay fork cannot re-hold: a collaborator run is not forkable (P2). Still to come in P3: the review-card fields, the `project-client-message` kind and the server-kept thread (D7). | `adr1099-p3-propose.test.ts` (8): nothing written before approval, a rerun adds nothing, approve applies exactly that item once and reject redacts, revoke refuses approve, a failing apply reopens, the decider rule, a 4xx pass-through, erasure cancels, malformed proposals refused |
| P3b (review card; this PR) | A `collab-proposal` card in the approvals inbox shows who sent it, by the FIRM's own name for them (the collaborator's `displayName`, stored on the proposal at hold as `collaboratorLabel`, erased with the collaborator, kept on reject because it is not their words); a medium risk chip ("Proposed by someone outside your workspace", "Approving records it in the project", and "Only <decider> can decide" when the tool names one); and `collabProposal: { groupKey, resourceKind, resourceId, toolId, deciderLabel? }` (ids and the firm's labels only, never the payload). The shared `ReviewCard` renders two rows from it, "Decided by" and "Part of", in four locales. | `adr1099-p3b-review-card.test.ts` (projection), `ReviewCard.test.tsx` (the two rows render for a collaborator proposal and not for a plain approval), `adr1099-p3-propose.test.ts` (the label is stored at hold and erased with the collaborator) |

> **P2 review (casavoga-c9, 2026-11-25, static, no must-fix) and what changed:**
> 1. *Scope-key stripping was shallow and case-exact.* A tool schema with
>    `filter: { projectId }` or `project_id` passed registration. Both checks now run at
>    every depth (properties, items, combinators, `$defs`) and in any spelling
>    (lower-case, `_`/`-` removed). Correction to the review: the model's input IS
>    validated against `inputSchema` before a tool runs (`runChatToolLoop`,
>    `agentDispatch.ts:1569`); stripping is defence on top of that.
> 2. *`mayGrantTo` never saw the audience*, so a builder could be minted `client`.
>    `GrantRecipient.audience` now carries it at mint and at renew.
> 3. *No fork/replay witness.* A member could fork a collaborator's run (the route had
>    no rule for it). `POST /runs/{id}:fork` now refuses it, 409
>    `collab_run_not_forkable` (`isCollaboratorTurnRun`), for replay and branch.
> 4. *Erasure.* A collaborator turn writes no run events, so its run holds ids only
>    (`collabPrincipal`, `grantId`, the resource), as do the `collab-turn.tool` audit
>    rows. A collaborator's erasure deletes the collaborator record and keeps the
>    revoked grants as the firm's record of what it shared (ADR 0958 P5); these rows
>    follow the same rule. When P3 keeps a thread, that thread holds the person's
>    words and gets an erase hook (P5).
> Nits taken: caps are claimed last (a turn refused for any other reason spends
> nothing) and the firm's cap before the grant's; a lost CAS race is 503 "busy", not
> the daily 429; the route no longer returns the firm's `runId`; the model test seam
> works only under vitest. Kept: lane `api-key` (the RFC 0165 §B.3 floor, as for
> sessions); non-text content read as empty (as in the widget); audience labels shown
> as slugs until a feature supplies display names; "no audience is the least view" is
> proven in P3, when the first projection reads it.

> **CLOSED 2026-11-26:** this item was closed by the P2 follow-up (#6268,
> `isCollaboratorOnlyAgent`, `a2aExposed: false`) before P4. P4 had nothing left to do for it.
>
> **Open item for P4 (found by `agent-allowlist-resolution`, TRAIN 526 follow-up):** the
> Project Guide is a pack agent, so it is LISTED to the firm's members too. In member
> chat its one tool, `openwop:client.project.overview`, does not resolve (client tools
> resolve only in the collaborator lane), so a member who opens it gets an agent with no
> tools whose prompt names one. No agent-manifest flag hides an agent from the member
> picker today. P4, which ships the portal UI, either adds that flag or scopes the
> listing. Until then the agent is listed to every member whatever the
> `projects.client-portal` switch says; opened there it can read nothing, because it
> has no tools in that lane.

### Implementation record: P3c (client threads)

Kept out of the phase table above so that P3b, P3c and P3d, merged in one train, never edit the same lines.

- **What shipped:** D7, corrected above. `features/projects/clientThread.ts`: the store `projects:client-thread` (tenant-indexed), one thread per (project, collaborator); `openwop:client.project.message-send` (propose, action `comment`, ≤ 2000 chars; the same words on the same grant in the same hour are one item, so a retry adds nothing while a later resend is a new message) whose `apply` adds the approved message once per approval; a member's reply joins at once. Routes (`clientThreadRoutes.ts`, behind `projects.client-portal`): `GET /projects/:id/client-threads` (read access), `POST /projects/:id/client-threads/:collaboratorId` (write access, only to a collaborator holding a live grant on this project), `GET /collab/grants/:grantId/messages` (the collaborator's own thread, via `checkGrantUse`, members shown as "the firm", no member ids). Erasure: a collaborator's erasure deletes their whole thread (the firm's replies in it were addressed to them); a member's DSAR anonymizes their replies; a project delete deletes its threads. Frontend: `ProjectClientMessages`, a section under Client access, one thread per person with a reply box (write access only), in four locales.
- **Witness:** `adr1099-p3c-client-thread.test.ts`: held until approved and rejected never joins, a reply reads as the firm, a builder reads none of the client's thread, replies only to a grant holder, both erasures, the switch off; `projectClientMessages.test.tsx`

### Open decision (2026-11-22): an explicit `audience` on a project grant

Raised by CasaVoga (CV-0245). A builder and a client are both grantees of the same
project, with the same `view`/`comment` shape, but they must not see the same rows:
a builder never sees costs, markup or the client's allowance position. P0c's
per-viewer projection already passes `{collaboratorId, grantId}`, so an adopter
could map collaborator → party on its side. The proposal is to make the party
explicit instead: an optional `audience` label on a `project` grant, chosen at
invite time from labels features register (CasaVoga: client, builder, architect),
passed to the projection and to every client-project tool, so a builder's grant
can never read rows meant for the client. Upstream stays party-agnostic. CasaVoga
prefers the explicit label. **Not built in P1; awaiting the user's decision.**

> **DECIDED 2026-11-23 (the user): yes, the explicit label, built in P2.** A grant
> without an `audience` gets the least-privileged view by default. That default holds
> wherever the label is read, so a missing or stale mapping can never widen what a
> builder sees. Labels are registered by features. Upstream knows none of them and
> only carries the label to the projection and to every client tool
> (`ClientToolScope.audience`). The collaborator kind is not enough: "architect" is
> neither kind, and the view is a per-project choice, not a property of the person.

### Decided (2026-11-23): who answers a client, and when the switch goes on

- **The agent is a feature-owned pack** (`feature.projects.agents`), not a core pack.
  The agent loader (`packs/agentLoader.ts`) reads `agents[]` from any local pack whose
  agent ids carry the pack's name. `scripts/sync-packs.sh` sweeps only `core.openwop.*`
  and `vendor.*`, so a `feature.*` pack is never removed. The agent is coupled to this
  host's `openwop:client.project.*` tools, so it is not a reusable registry agent. A
  core pack kept only in this repo would be deleted by a sync, the way
  `lead-concierge` would be. It is the first `feature.*` pack that declares an agent.

  > **CORRECTED 2026-11-24 (P2): the pack is `vendor.openwop-app.projects.agents`, not
  > `feature.projects.agents`.** The decision stands (a feature-owned pack, not a core
  > one); the name above was wrong. ADR 0763 renamed every `feature.*.agents` pack to
  > `vendor.openwop-app.<feature>.agents`, because `feature.*` is outside the spec's
  > pack-name scopes (PMC-6) and feature agent packs are mounted from the image
  > (`DEFAULT_LOCAL_PACK_PREFIXES`), not installed from the registry. So this is not
  > "the first `feature.*` pack that declares an agent": there are about sixty such
  > packs, all `vendor.openwop-app.*`. The sync point above was also stated loosely:
  > `sync-packs.sh` does sweep `vendor.*`, but its guard refuses a run that would delete
  > a vendored family canon does not carry, so the pack is not silently removed.
  > The agent id is `vendor.openwop-app.projects.agents.client-guide`. The kind names it
  > (`GrantResourceKind.turnAgentId`), and `projects` declares the pack in `requiredPacks`.

- **`projects.client-portal` stays off in production until P4 ships.** Until then a
  client sees only the name and the status, while an invite already creates real
  outside access. It may be turned on for one adopter's own test tenant on request.

### Implementation record: P5 (erasure, D8, and the adopter guide)

Kept in its own section, above P3d, so that it never edits the same lines as P4
(#6294), which appends its record at the end. Whichever of the two lands second
updates the status line at the top.

- **What shipped:** no eraser code was missing. Measured, not assumed: the
  answer-8 scope was already covered by the hooks P3a, P3c and P3d added.
  - the turn memory (`collaboratorTurnMemory` erase hook);
  - the client thread, the firm's replies included (`clientThread` `dropThread`);
  - held proposals, cancelled, and every proposal's summary, payload and
    `collaboratorLabel`, redacted (the `collab-proposal` approval redactor, run by
    `eraseApprovalSubject`);
  - grants, revoked and kept as the firm's record (ADR 0958 P5).

  What P5 adds is ONE witness across all of them, through the DSAR lane
  (`eraseSubject`), and the adopter guide,
  [`docs/client-portal-adopter-guide.md`](../client-portal-adopter-guide.md):
  client tools, the room interview, sections, erasure obligations for what an
  adopter's `apply` writes, and turning the switch on.
- **Witness:** `backend/typescript/test/adr1099-p5-erasure.test.ts`. A collaborator
  leaves a marker in an approved message, a pending message and their turn memory.
  After `eraseSubject(tenant, email:…)`:
  - no approval row, thread or turn memory holds it;
  - the pending proposal is no longer pending, and the approved one keeps its row;
  - their grant 404s;
  - a second collaborator on the same project keeps everything.

  Sabotage-witnessed (one at a time, each red): no thread hook, no memory hook, the
  redactor's text fields emptied, and a thread hook that drops the whole project.

### Implementation record: P3d (turn memory)

Kept out of the phase table above so that P3b, P3c and P3d, merged in one train, never edit the same lines.

- **What shipped:** The host keeps each collaborator's conversation with the agent (`host/collaboratorTurnMemory.ts`), one per grant, so the agent remembers the previous question. Shaped after the widget's visitor threads (ADR 1018 D2). Written ONLY by the host after a turn is answered (a failed turn leaves nothing); a client-sent history is still ignored, so a client can never author an assistant turn. Bounds: 2000 chars per stored message, the last 40 kept, the last 12 replayed with every collaborator message re-fenced, aged out after 30 days without a turn (kvAgeOut, default on). Tenant-indexed. The collaborator reads it back (`GET /collab/grants/:grantId/turns`, for the portal) or clears it (`DELETE`); their erasure deletes it. Not the client threads of P3c: those are messages to the firm, reviewed before they count. Also (casavoga-c9): a client tool's own typed 4xx refusal (`OpenwopError` 400–499, e.g. "That day has passed") now tells the person why: its code (a safe slug, else `refused`) and its message reach the model as `untrustedToolError`, the message fenced, because it is the adopter's text and can quote the collaborator. A 5xx or a raw `Error` keeps the generic sentence.
- **Witness:** `adr1099-p3d-turn-memory.test.ts`: the second turn carries the first exchange fenced, a client history ignored, a failed turn leaves nothing, read and clear by the collaborator only, one per grant, erasure deletes

### Implementation record: P4 (the portal page and D10, the section seam)

Asked for by CasaVoga (CV-0245 P4b: "Due from you" and the builder's dates as
sections of the portal page). The plan was reviewed by CasaVoga's session before
it was built, and its six notes are in it. Of the four upstream requests CasaVoga
drafted, two were already shipped (draft 3 in P3d; draft 4's label and decider rows
in P3b), and CasaVoga dropped draft 4's remainder (title, before/after). This
phase is the other two.

- **D9, the chat.** `features/collab/ProjectPortal.tsx` `PortalChat` renders the
  shared `chat/ConversationView` in a new **`outsider`** mode. Its transport is the
  P2 turn route plus the P3d history (`GET`/`DELETE …/turns`). It adds no new chat
  component and does not use `EmbeddedChatPanel`, because that needs a member session
  and BYOK, while this lane runs on the firm's credential. `outsider` turns off
  everything that would reach the viewer's OWN workspace: voice, the `/` workflow and
  `@` agent pickers and their sigil chips, attachments, the board sigil, the sign-in
  and own-key notice, and the needs-you tray (`ChatInput.plainText`). Its mount-time warm-up of the workflow list is skipped too: before that, the portal fetched the collaborator's own workflows, which the ADR 0661 live-fetch guard caught in the P4 test.
  `ConversationView.onRegenerate` is now optional (the feed already treated it so).
  `GET /collab/grants/:id` returns `chat: boolean` (the kind names a `turnAgentId`
  AND its switch is on), so the page shows the chat only where the turn route
  would answer.
  - Refused turns: a 429 shows the day's limit, a 503 says unavailable, a 404 says
    access ended. The unanswered line is removed, because the host remembers only
    answered exchanges.
  - "Start over" clears the history behind a confirm.
- **D10, sections, server.** `host/grantViewSections.ts`:
  `registerGrantViewSection({ kind, id: '<featureId>.<name>', featureId, order, read(scope) })`.
  `read` takes the scope and nothing else. The scope is built by
  `host/grantScope.ts` `clientScopeOf`, the ONE builder the turn lane's client tools
  now use too, so a section and a tool can never see different scopes.
  - Routes: `GET /host/openwop-app/collab/grants/:grantId/sections` (ids and order)
    and `…/sections/:sectionId`. Both pass `checkGrantUse` (`view`) and the kind's
    switch, else the uniform 404, so section ids never reach someone without a usable
    grant.
  - A shared budget of 120 per grant per minute (429), because the page re-reads on
    focus.
  - Output must be a JSON object of at most 64 KB (502, reason `section_too_large`).
  - A least view is closed to `{ available: false, message, code? }`. `code` was
    CasaVoga's ask, so a host or adopter can localise later. Nothing a reader puts
    beside it is sent.
  - A reader's typed 4xx passes its code (as `details.reason`) and its sentence.
    Anything else is a generic 502 (reason `section_unavailable`) with no
    internals.
  - Each read is audited as `collab-section.read`, ids and outcome only. Sections
    store nothing, so erasure is unaffected.
  - From CasaVoga's PR review:
    - An unexpected reader fault is logged (`collab_section_read_failed`, ids and
      the error only), so a broken adopter reader is visible to the operator.
    - An optional `enabledFor(tenantId)` hides a section the firm switched off: it
      is absent from the list, a read is 404, and a fault counts as off.
    - **The read budget fails OPEN on purpose.** A limiter outage lets reads
      through, and each read is still grant-checked, switch-checked and audited.
      Making it `closed` would turn a KV blip into a blank portal. Do not "fix"
      it.
- **D10, sections, frontend.** `FeatureLazyExtensions.portalSections`
  (`{ kind, id, titleKey, i18nNamespace, component }`), through the ADR 1031 seam,
  so an adopter's `src/adopter/features/*` ships its components lazily.
  - The page intersects the server's list with the registered components, in the
    server's order. A server id with no component is skipped, and a component the
    server does not list is never mounted.
  - Each section is read on its own and gets only its own data. The host renders
    loading, failure (with retry) and the least view the same for every section,
    without mounting the component for a least view.
  - Sections re-read after every answered turn, and on focus or visibility (at most
    every 15 s), because the firm approves answers elsewhere.
  - `PortalSectionFrame` is exported, pure, so an adopter's test can mount its
    component with fixture data in the host's frame.
  - Page order: header, project view, sections, chat. A skip link reaches the chat on
    a phone.
- **The adopter's half (the contract text the host cannot enforce):** `read` must
  answer from `scope.audience` (absent ⇒ the least view) and must never return
  another party's rows. A builder's grant must never receive a client's rows.
  The frontend registration carries no audience: which rows a person sees is
  decided on the server, per call.
- **Not in P4:** a section button that proposes without the model (a later phase,
  agreed with CasaVoga); the review card's title and before/after (dropped).
- **Witness:** `backend/typescript/test/adr1099-p4-sections.test.ts` (12; the 12th, `enabledFor` off or faulting, sabotage-witnessed red when the check is bypassed): the list
  in order and never another kind's; the scope from the grant with forged query
  fields ignored; a stranger and a revoked grant 404 on both routes, with the reader
  never called; the switch off; another kind's and an unknown section 404; the least
  view closed; over 64 KB; a typed 4xx passed and a raw fault generic; 429 at 121,
  with another grant unaffected; `chat` on the grant view; registration refusals.
  `frontend/react/src/features/collab/__tests__/projectPortal.test.tsx` (7): outsider
  mode and history; send, reply and sections re-read; a 429 turn; no chat when
  `chat` is false; only listed and registered sections, in order; the least view
  rendered by the host; one failing section not hiding the others.

