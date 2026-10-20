# ADR 0947 — Creative proofing and staged review

Status: Proposed

Date: 2026-10-19

Program: Campaign Studio (ADRs 0941–0962), Tier 1 — creative + pages. Depends on
**0942** (the ONE gate primitive, per-campaign stage policy, SLA/escalation),
**0946** (the `VariantSet` a review names), **0945** (fidelity verdicts in the
checklist), **0933** (content-rules findings and acknowledgment), **0924**
(version-bound decide checks). **Integrates with** (not depends on) **0958**
(external collaborators, Tier 4) for client and vendor reviewers. Consumed by
**0957** (client portal), **0960** (command center), **0961** (autopilot).
Net-new feature design, not a MyndHyve port.

## Context

David's ask includes "reviews and approvals, identified human roles for review
steps, active collaboration between humans, agents and sub-agents", and "as much
or as little HITL as each campaign needs".

- **Ziflow** and **Filestage** lead proofing: pins on images, timecoded notes on
  video, versions side by side, role-routed stages (internal → legal → client),
  and Ziflow ReviewAI runs a checklist with human override. They review **files**;
  they are not inside the workflow that produced the files.
- **Workfront / GenStudio** route approvals but sit beside the generation
  pipeline; **Klaviyo / Braze** have one approve button.
- Nobody routes role-based stages as **steps inside the agent run** that made the
  creative, with the AI checklist as a recorded node and the stage list set per
  campaign.

## Boundaries audit (state on `docs/campaign-studio-program` at `7ad955ce1`)

Paths are under `backend/typescript/src/` unless they start with `docs/`,
`packs/` or `frontend/`.

**Reused, not rebuilt:**

- **Comments (ADR 0021/0881).** One store, a static resolver registry `TARGETS`
  (`features/comments/commentsService.ts:123`) checking that the target is in the
  caller's org and its owning feature is on; @mentions, replies, resolve, agent
  attribution (`onBehalfOf`, `:53-78`); agent tools `openwop:comments.list` /
  `.post` (`features/comments/agentTools.ts:25-26`). Sub-anchors are encoded in
  `resourceId` as `id#sub` (chat messages, priority ideas, canvas threads, slides:
  `:147-228`).
- **Approvals.** One queue (`host/approvalService.ts:40-67`), quorum ledger keyed
  per reviewer (`host/reviewDecisionLedger.ts`), delegation/OOO (ADR 0198,
  `host/approvalDelegations.ts`), SLA rungs (`host/approvalSla.ts:34`, `:122`),
  escalation (`host/escalationNotify.ts`), self-approval check
  (`host/approvalSelfCheck.ts:32`), the gate typeId set
  (`host/approvalGateTypeIds.ts:20-28`).
- **Sequential stages are DAG composition, not a new primitive** — ADR 0198 §6,
  the `approvals.two-stage-sign-off` chain (`backend/typescript/test/workflow-chain-approvals.test.ts:29`, `:64`).
- **Version-bound decisions.** CMS refuses a stale review (`features/cms/contentApproval.ts:311`);
  ADR 0924 D2 re-checks hashes before the CAS; ADR 0933 D5 requires each
  `needs_review` finding to be acknowledged on the decision.
- **External approvers.** ADR 0924 D5 planned a per-approver hashed token bound
  to one package hash, re-checked on every use, with shared rate limits (ADR
  0934). ADR 0958 D3 replaces that store with grant-backed sharing links and
  keeps those semantics.
- **Immutable media versions.** AI edits write a new asset with `derivedFrom`
  and never mutate the source (`features/media/imageGenRoutes.ts:181-182`, `:249`).

**Gaps and duplication risks:**

| # | Finding | Evidence |
|---|---|---|
| R1 | Comments cannot target a media asset, a video, or a variant set: `ResourceType` is a closed list of seven | `commentsService.ts:48-49` |
| R2 | A comment has no geometry, time range or version: no region pin, no timecode, no "made on v2" | `commentsService.ts:53-78` |
| R3 | No comment-only permission: posting needs `workspace:write`, the same scope as editing | `features/comments/routes.ts:70`, `:92`, `:108`; ADR 0933 D8 |
| R4 | `comments` is OFF by default per tenant | `FEATURES.md:247` |
| R5 | Three review lanes already exist: the channel child workflow's `core.approvalGate` (`features/campaign-channels/channelWorkflows.ts:45-50`), CMS `contentApproval`, and the campaign-ops change set (ADR 0924). A fourth must not be added | as cited |
| R6 | SLA policy is per tenant, not per stage | `approvalSla.ts:65` (`getApprovalSlaPolicy(tenantId)`) |
| R7 | No AI pre-review exists; review sees findings only for campaign-ops text change sets (ADR 0933) | — |
| R8 | No compare view for images or video; CMS and brief diffs are text/field diffs | `frontend/react/src/features/creative-briefs/`, `features/cms/` |

## Decision

### D1 — A review names one subject at one hash

```ts
type ReviewSubject =
  | { kind: 'variant-set'; setId: string; hash: string }          // ADR 0946 — the default
  | { kind: 'media-asset'; assetId: string; contentHash: string }
  | { kind: 'cms-page'; pageId: string; pageVersion: number };
```

The campaign-ops change set keeps its own ADR 0924 lane; this ADR does not wrap
it (R5). A new subject version **closes every open stage gate** for the old hash
as `stale` (the ADR 0924 D2 shape) and the review restarts at the stage the
policy names (Q3). Annotations carry over, marked with the version they were made
on.

### D2 — Annotations are comments with an anchor (one store)

Extend the comments feature, not a new store:

- New resource types: `media_asset` (resolver: media org check; media is
  always-on) and `variant_set` (resolver: campaign-orchestration; `resourceId` =
  `${setId}#${memberId}` for one member, or `setId` for the set).
- An optional, closed-schema `anchor` on `Comment`:

```ts
anchor?: {
  subjectVersion: string;                               // the hash/contentHash annotated
  target:
    | { kind: 'region'; x: number; y: number; w: number; h: number }  // normalised 0–1
    | { kind: 'point'; x: number; y: number }
    | { kind: 'timecode'; startMs: number; endMs?: number; region?: { x: number; y: number; w: number; h: number } }
    | { kind: 'element'; sectionId: string; field?: string };          // a CMS page section
};
intent?: 'note' | 'change-request';                     // a change request blocks its stage (D3)
visibility?: 'internal' | 'shared';                     // the client sees `shared` only
```

- The anchor is validated against the subject (coordinates in range, timecode
  within duration, section exists in that page version); invalid → 400, never
  stored partially.
- Agents read annotations through the existing `openwop:comments.list` before
  revising (read-before-write) and reply through `openwop:comments.post` with
  `onBehalfOf`.
- **R3 is closed here, not deferred:** a `comments:write` protocol scope is added
  to `accessControl` (the follow-up ADR 0933 D8 recorded), so a reviewer role can
  annotate and decide without edit rights.

### D3 — Stages are a chain of 0942 gates

Chain pack `campaign-studio.creative-review` (`kind:"workflow-chain"`), composed
the ADR 0198 way — sequential gates in a DAG, no new primitive:

```
checklist(internal) → gate(internal) → checklist(compliance) → gate(compliance)
                    → gate(client) → mark-approved
```

- **The stage list comes from the campaign's autonomy policy (0942)**, frozen at
  run start through the run-start contributor seam (`host/runStartContext.ts`,
  ADR 0099) and read verbatim on `:fork`. A stage the policy marks `auto` is a
  pass-through node that records why it was skipped; `blocked` stops the run.
- Each stage gate is **0942's one gate primitive**, the
  `feature.campaign-orchestration.nodes.autonomy-gate` node (0942 D5), with
  `{stageId}` in its facts and the policy's `ApproverSpec` (role refs per ADR
  0075, quorum, SLA, escalation, delegation). It suspends on the interrupt lane;
  this ADR adds **no** approval kind. Per-stage SLA (R6) is 0942's to deliver.
- Each stage gate uses 0942's action class `creative.review` (interrupt lane;
  the gate node is the chokepoint, `mark-approved` records the pass; facts =
  `{stageId, subjectHash, findingsDigest}`), so a policy can say "client stage
  for paid ads only".
- A stage passes only when: the subject hash still matches; every open
  `change-request` annotation on that hash is resolved; every checklist item
  needing a human is confirmed or overridden (D4); the decider is not the person
  who generated or last edited a member (`approvalSelfCheck`).
- **Reject** sends the run back to the variant factory (0946) with the
  annotations as input; the agent revises and produces version N+1.

### D4 — AI checklist pre-review with human confirm/override

A node `feature.campaign-orchestration.nodes.review-checklist` (side-effect; its
model call is served on replay) builds `ChecklistItem[]` before each human stage:

- **Deterministic items** — the stored ADR 0933/0946 pre-flight findings and the
  ADR 0945 fidelity verdicts, recomputed against the stored `asOf`. A `block`
  finding stops the stage; no one can override it (0933 D5).
- **Model items** — brief adherence, CTA clarity, claim support, tone against the
  brand — from a closed schema (`pass | concern`, evidence, member id, optional
  anchor). Invalid output is a typed failure with one repair. A model item is
  never `block`; `concern` becomes a `needs_review` item.
- **Checklist templates** are data per client org (Ziflow's configurable
  checklists): which model checks run at which stage.
- **The decision records every item:** `itemDecisions: {itemId: 'confirmed' |
  'overridden', reason?}`; an override needs a reason; an unhandled item → 409
  `checklist_incomplete` (the `findings_not_acknowledged` shape). Decisions land
  in the approval audit chain, so "who overrode which AI concern on which version"
  is a query.

### D5 — Version compare

The frontend compares any two versions of a subject: images side by side,
slider and onion-skin, with a client-side pixel-difference overlay; copy as a
text diff (the ADR 0923 D7 differ); pages as the CMS section diff; video with
synchronised scrubbing. Annotations from the older version show with their
status. The server supplies the version chain (VariantSet versions, media
`derivedFrom`, CMS `PageVersion`); no new version store.

### D6 — External reviewers

- **Clients** review as ADR 0958 external collaborators (kind
  `client-stakeholder`): ordinary users with a `decide` grant on the `proof`
  resource, or a grant-backed sharing link (ADR 0958 D3) for a one-time
  reviewer, bound to one review subject at one hash at one stage. There is no new
  principal kind and no separate token store (ADR 0924 D5's `ClientApprover`
  store is replaced, ADR 0941 corrections). The ADR 0924 D2 decide-time checks,
  ADR 0934 limits and the uniform 404 apply. The page shows only the `shared`
  annotations, the members under review and the checklist items the policy
  exposes.
- External annotations are written into the comments store with the author
  recorded as `{kind: 'external-collaborator', collaboratorId, grantId}`, the one
  author field for clients and vendors alike.
- Vendors (0958) may annotate internal stages when granted on that campaign.
- Until ADR 0958 lands, the client stage can only be decided in the inbox by an
  org member in the stage's role.

### D7 — Notifications

Stage entry, SLA rungs and escalations go through the existing notification
emitter, email and Teams approval delivery; mentions through comments. Nothing
new is added to delivery.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | Extends `comments` (anchor, two resource types, visibility, intent) and `campaign-orchestration` (checklist node, review chain, subject resolver). `comments:write` scope in `accessControl`. Public review page on ADR 0958's grant-backed sharing resolver (ADR 0924 D2 checks). |
| 2 | Toggle | No new top-level toggle. Anchors ride `comments` (OFF, tenant); the review chain rides `campaign-orchestration.variant-factory` (ADR 0946) and needs `campaign-orchestration.autonomy` (ADR 0942) for its gates. The chain's start check requires `comments`, `campaign-orchestration.variant-factory` and `campaign-orchestration.autonomy` ON (an AND-gate in code; `dependsOn` is feature-level, ADR 0194, so none is declared). The client page rides `campaign-ops-client-portal` (ADR 0924) on the ADR 0958 grant-backed link. |
| 3 | Workflow surface | `ctx.features.comments.{list, post}` gain `anchor`; `ctx.features.campaignOrchestration.review.{checklist, subjectStatus}`. No approve op on any surface: approval is a human act. |
| 4 | Node pack | `feature.campaign-orchestration.nodes.review-checklist` (side-effect), `mark-approved` (side-effect); chain pack `campaign-studio.creative-review`. |
| 5 | Envelopes | None. |
| 6 | Agent pack | No new agent; 0943's Compliance Reviewer pre-reviews the compliance stage, the Creative Director revises on reject. |
| 7 | Public surface | The ADR 0958 grant-backed sharing link (the ADR 0924 page semantics), extended to review subjects: tenant from the grant, uniform 404, rate limits, payload caps, per-use re-check. |
| 8 | RBAC | Annotate = `comments:write` on the org; decide = the stage's role refs + `approvals:respond`; proposer and last editor excluded; cross-org → 404. |
| 9 | Replay / fork | Stage list frozen at run start; checklist served from the log; a fork after a resolved gate does not re-ask; a stale hash closes gates. |
| 10 | Frontend | A proofing viewer (pins on images, timecoded pins on video, element pins on pages), a stage tracker, the checklist with confirm/override, the compare view; inside the `/campaign-studio` hub and linked from the inbox. 4-locale, keyboard-operable pins, light/dark. |

## Why this is our advantage

- **Stages are steps inside the run that made the creative** — the gate knows the
  agent, node, concept and fidelity verdict behind every member. Proofing tools see
  only files.
- **HITL per campaign:** the 0942 policy decides which stages exist, so one client
  gets three stages and another gets one, with the choice recorded.
- **Replay:** a reviewer, or a regulator, can replay the run to the stage and see
  what the checklist said, what was overridden and by whom.
- **Agency isolation (ADR 0921):** each client sees only its own shared notes, on
  a token bound to one hash.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | `media_asset` + `variant_set` resolvers; `anchor`, `intent`, `visibility` on comments; `comments:write` scope | Route tests: cross-org 404; invalid anchor 400; a commenter without `workspace:write` can annotate but not edit |
| P1 | Review chain + `review-checklist` node with deterministic items; stale-on-new-version | The chain loads via the chain loader; a new version closes open gates; a `block` finding cannot be overridden |
| P2 | Model checklist items with one repair; per-client checklist templates; itemDecisions on the audit chain | Eval: a seeded off-brief member draws a `concern`; unhandled item → 409 |
| P3 | Frontend proofing viewer + compare | `npm run build`; a11y check of pin controls |
| P4 | Client stage through ADR 0958 grant-backed links (after 0958 P1) | Public route tests: revoked/expired/superseded → same 404; client sees `shared` only |
| P5 | Signed-in client and vendor collaborators (after 0958 P2) | Same author field, no second write path |

## Alternatives weighed

- **A separate proofing store** (Ziflow-style). Rejected: it would split comments
  in two and lose mentions, notifications and agent tools.
- **One approval kind per stage.** Rejected: stages are DAG composition (ADR 0198);
  0942 owns the one gate primitive.
- **Embed anchors in `resourceId` (`asset#x,y,w,h`).** Rejected: unvalidated
  geometry in an id, and no version field.
- **AI checklist as the gate.** Rejected: model items are advisory; only
  deterministic findings block, and a human decides the rest.

## RFC verdict

**Host extension, no RFC.** Comments, chain packs, the gate primitive (0942) and
the grant-backed review page are host surfaces; nothing advertised. The stage
gates are 0942 interrupt-lane gates whose routing fields ride Accepted RFC 0104
unchanged.

## Open questions

1. **(David)** Default stage list for a new client: internal → compliance →
   client, or internal → client with compliance only for regulated categories?
2. **(David)** May a client see internal comments when an operator marks them
   `shared`, and may agents ever post `shared` comments? Proposed: operators only.
3. **(David)** After a rejected version is fixed, does review restart at stage one
   or at the rejecting stage? Proposed: at the rejecting stage when only members
   annotated there changed; otherwise stage one.
4. Should `change-request` annotations from a client block the stage, or only
   inform the operator? Proposed: block their own stage.
5. Video duration for timecode validation needs the asset's duration; video rows
   carry it from the job (ADR 0404) but uploads may not. Proposed: probe at
   upload when ADR 0945's frame work lands; until then accept and clamp.
6. Who owns the `comments:write` scope change in `accessControl`? Proposed: this
   ADR's P0, reviewed by the accessControl owner.

## Planning rows

**ROADMAP (Campaign Studio program table):**

| Order | Item | Toggle | Depends on | Pack slug | Wire / RFC gate | Status |
|---|---|---|---|---|---|---|
| T1-3 | **Creative proofing and staged review** ([ADR 0947](docs/adr/0947-creative-proofing-and-staged-review.md)) | `comments` + `campaign-orchestration.variant-factory` (no new toggle) | 0942, 0946, 0945, 0933, 0924, 0021, 0198; integrates with 0958 | `feature.campaign-orchestration.nodes`, chain `campaign-studio.creative-review` | Host extension | 🔵 Proposed |

**FEATURES "Future features":**

- **Creative proofing + staged review (ADR 0947, Proposed 2026-10-19)** —
  annotations pinned to image regions, video timecodes and page sections, stored
  as comments (new `media_asset` / `variant_set` targets, a version-stamped
  anchor, internal/shared visibility, a `comments:write` scope); role-routed
  stages (internal → compliance → client) as a chain of 0942 gates set per
  campaign and frozen at run start; an AI checklist node before each stage
  (deterministic findings block, model concerns need a human confirm or a
  reasoned override, every decision audited); version compare; clients review on
  ADR 0958 grant-backed links. No new toggle. Host-ext, no RFC.
