# ADR 1099 — Project-scoped client collaboration

Status: Proposed (2026-11-11). `/architect` recommends option A′ (see Review);
awaiting the user's decision. Nothing is built.

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

A′ (recommended by the review; Status stays Proposed until the user accepts it).

| # | Decision |
|---|---|
| D1 | A grant kind may register its own `orgGate`. Kinds without one keep the single campaign-ops gate. No gate at all means refused. |
| D2 | The collaborator invite, accept, shared and grant routes move to a host module, gated per grant kind's owning feature. |
| D3 | A `project` grant kind (actions `view`, `comment`) behind a new sub-toggle `projects.client-portal` (tenant bucket, default **off**). |
| D4 | 0958 D1 is amended with the one exception worded in answer 2. |
| D5 | A host collaborator-turn lane: a run in the firm's tenant; principal `collab:<id>` with `principalKind` absent; `actingUserId` undefined; the firm's credential; caps per grant and per tenant. Its tools are only the registered client tools, compiled through the default-deny helper extracted from the anonymous actor. |
| D6 | `registerClientProjectTool`: the scope comes from the grant, and `checkGrantUse` runs before every call. `propose` tools are held as approvals and applied by their kind's recipe on approve. |
| D7 | A host approval kind, `project-client-message`, and a project client thread (an ADR 1090 project tab for members; the portal for the client). |
| D8 | The erasure scope in answer 8. |
| D9 | The portal UI reuses `chat/ConversationView` through a pluggable transport. |

## Phases and the witness each needs

| Phase | Ships | Witness (a route test unless noted) |
|---|---|---|
| P0 | D1 and D2, with no behaviour change | Every existing 0958 test still green. A kind with its own gate works for an org with no client account. A kind without one still refuses. Campaign kinds still need both campaign-ops toggles. |
| P1 | D3, D4, the firm's invite UI (a project tab) | The grant lifecycle: invite, accept, expiry, revoke, and the granter losing authority each give a uniform 404. A cross-org project gives 404. The toggle off refuses everything. |
| P2 | D5, plus the extraction refactor (the anonymous lane is unchanged) | The compiled tool list equals the registered client tools (no baseline). A model-supplied `projectId` is ignored. Revoking mid-conversation denies the next tool call. Run metadata never carries `principalKind: 'anonymous'`. Caps exhausted gives 429. The anonymous-actor suite is unchanged. |
| P3 | D6, D7 | A `propose` writes nothing before approval (sabotage: a direct write turns the test red). Reject applies nothing and redacts. Approve applies exactly once (CAS; a double approve is a no-op). A replay fork does not re-hold. |
| P4 | D9, the client portal page | Frontend: the portal renders `ConversationView` with the collab transport. No new chat component (the import-boundary check). |
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
