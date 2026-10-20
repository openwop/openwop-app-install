# ADR 0958 — Vendor and guest collaboration

Status: Proposed

Date: 2026-10-19. Program: Campaign Studio (ADRs 0941–0962), Tier 4 — agency scale.
Net-new feature planned with `/feature-refinement`; not a MyndHyve port.
Depends on: 0921 (agency = workspace, client = org), 0941 (canonical campaign),
0942 (the one gate). Consumed by: 0924 (client approver), 0947 (external proof
reviewers), 0957 (client portal), 0943 (Producer assigns vendor tasks).
Composes: 0006 and 0015 (RBAC, workspace as tenant), 0013, 0448 and 0887
(sharing, capability tokens, per-use re-check), 0311 (kanban stacks), 0353
(creative brief shared with an external designer), 0229 (media lineage).

## Context

Campaigns involve people who are not agency staff. A photographer delivers
product shots. A freelance copywriter takes a brief. A video house delivers
cuts. A client's brand manager reviews. Each needs to see exactly one campaign,
one brief or one asset request, and do one or two things (upload, comment,
mark ready, decide). Each must lose access when the work ends.

Workfront, Ziflow and Filestage have guest reviewers. GoHighLevel has no vendor
portal; agencies share Google Drive folders. None of them ties a vendor's
deliverable to provenance and rights, puts it behind a gate before it reaches a
live ad, and records it in a replayable run.

The brief's constraint: extend accessControl, sharing and capability tokens.
**No parallel identity system.**

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths are under `backend/typescript/src/` unless they start with `schemas/` or
`docs/`.

**Membership is the wrong tool for outsiders:**

- Four built-in roles (`host/accessControlService.ts:231-262`). Custom roles may
  carry only RFC 0049 protocol scopes (`isProtocolScope`, `:225`), so no role
  can say "this one asset".
- Entering a `ws:` workspace requires a root-org row, and the root row's scopes
  are tenant-wide (ADR 0921 G2). A vendor given a root `viewer` row could read
  every client's runs, contacts and pages through tenant-scoped routes.
- `Organization` is flat (`:322-332`); there is no sub-org to hide a vendor in.

**External-access precedents that exist and are reused:**

- **Sharing links (ADR 0013).** `ShareLink` (`features/sharing/sharingService.ts:57-80`)
  is hashed at rest (ADR 0448). The resolver table (`:100-125`, `:180`) has
  `creative_brief`, "a creative brief an external designer executes from",
  approved-only (`:180-200`, ADR 0353 P4). It also has `sign_request`, a
  system-minted visitor-lane link for an external signer (`:581-592`). E-sign
  mints through `createLink` (`features/crm/signService.ts:115-116`) and reads
  through `resolveActiveResource` (`features/crm/signRoutes.ts:108-109`).
- **The two-homes rule (ADR 0448 D3, `host/capabilityToken.ts:13-18`).** A
  link-shaped capability is a sharing resolver; a bearer secret is a
  feature-owned store on the helper. A hand-rolled token store is a
  review-blocking finding.
- **Per-use re-check (ADR 0887 D1).** A member-minted link re-checks its
  publisher on every read. Visitor-lane links skip that (`:591`), so any
  re-check they need must sit in the resolver.
- **Read ACL seams.** `host/subjectAccess.ts` (ADR 0054/0278) is a per-kind
  resolver registry with the rule "membership never grants write".
  `host/crmRecordVisibility.ts` has a single slot (`:42`).
- **Decide-by-email.** `host/emailApprovalDelivery.ts:1-18`: the interrupt lane
  is "guest-capable"; approval-store rows link out to the in-app inbox.
- **ADR 0924 D5 (Proposed, not built):** a `ClientApprover` store with its own
  hashed tokens. On `origin/main`, `approvalPolicy` is the literal `'agency'`
  (`features/campaign-ops/types.ts:25`, `clientService.ts:65`).

**Identity facts that constrain the design:**

- Principal ids (`oidc:<sub>`, `saml:<nameId>`, `scim:<userName>`) are not
  issuer-qualified. `User.userId` is unique per home tenant. Never alias a
  principal string across tenants (CONNWF-5e, ADR 0780 review).
- `resolveCallerUser(req).tenantId` is the caller's home tenant, not the
  workspace (ADR 0888).
- **The wire.** `interrupt.resolved.resolvedBy` is a `Subject`
  (`schemas/v2/run-event-payloads.schema.json:1438-1441`). `Subject.lane` has no
  token lane, `kind` is `user | agent | anonymous | workload`, and `tenant` "MUST
  equal the enclosing `owner.tenant`" (`schemas/subject.schema.json`, RFC 0165
  §B.2). An external person cannot be put on the wire as an agency run's
  resolver without an RFC.

**Asset and task facts:**

- `MediaAsset` (`features/media/mediaService.ts:71-95`) has `uploadedBy` and an
  optional `lineage` whose `generatedBy` vocabulary is closed (`'ai'` only) plus
  `rightsNote` (`:36-51`). There is no intake or quarantine state. Per-org and
  per-workspace byte caps exist (`:166-174`). No malware scanning exists
  anywhere (repo grep).
- Kanban: `taskAssign` takes `assigneeId`, a member subject
  (`host/kanbanSurface.ts:70, 139-165`). `openwop:kanban.add-todo`
  (`host/agentToolProvider.ts:399-449`).
- Audit: `appendAudit(tenantId, kind, payload)` (`host/auditChainService.ts:188`).

## Decision

### D1 — One collaborator record and one grant model, owned beside accessControl

There is no new principal kind and no membership row. A new host seam,
`host/externalCollaborators.ts`, is owned by the accessControl owner (ADR 0006's
single owner of identity and authority). Sharing, approvals and campaign ops all
consume it, so it cannot live in one feature.

```ts
interface ExternalCollaborator {          // hostext:extcollab:c, key tenant::orgId::collaboratorId
  tenantId: string; orgId: string;        // orgId = the client org; the ONLY isolation key
  collaboratorId: string;
  kind: 'vendor' | 'freelancer' | 'client-stakeholder';
  email: string; displayName: string; company?: string;   // PII, declared
  status: 'invited' | 'active' | 'suspended' | 'revoked';
  mode: 'signed-in' | 'link-only';
  boundUserId?: string;                   // canonical User.userId, set at accept (D2); never a principal string
  createdBy: string; createdAt: string; updatedAt: string;
}
interface CollaboratorGrant {             // hostext:extcollab:g, key tenant::orgId::grantId
  grantId: string; tenantId: string; orgId: string; collaboratorId: string;
  resource: { kind: GrantResourceKind; id: string };     // e.g. campaign, asset-request, creative-brief, proof, report
  actions: GrantAction[];                 // closed per kind: view | comment | upload | mark-ready | decide
  expiresAt: string;                      // REQUIRED; default 30 d, max 180 d
  status: 'active' | 'revoked' | 'expired';
  createdBy: string; createdAt: string; revokedAt?: string; revokedBy?: string;
}
```

- Features register resource kinds with
  `registerGrantResourceKind(kind, {exists, contains, actions, project})`.
  `exists` must be an **unfiltered** read, because a filtered read cannot decide
  existence. `contains(parentId, childId)` lets a `campaign` grant cover that
  campaign's asset requests without listing them. This is the resolver
  registry pattern of sharing and `subjectAccess`.
- Campaign Studio registers `campaign`, `asset-request`, `creative-brief`,
  `proof` (ADR 0947), `vendor-task` and `client-report` (ADR 0957).
- **Grants never become scopes, roles or memberships.** They never authorize a
  tenant-scoped route, `/v1/runs`, chat, agents, connections, BYOK, the CRM or
  media listing. A witness test lists those routes and asserts 404 for a
  collaborator session.

### D2 — Signed-in mode: their own account, the agency's grant

- A vendor signs in through the normal auth lanes into **their own home
  tenant**. They never get a row in the agency workspace.
- They reach agency resources only through `/v1/host/openwop-app/collab/*`.
  Each request: resolves the caller's canonical `userId`; loads the grant by id;
  requires `grant.collaborator.boundUserId === userId`; requires the
  collaborator `active`, the grant `active` and unexpired, and the client's
  `ClientAccount` `active`; requires `exists()` to be true and the action to be
  in `actions`; then derives tenant and org **from the grant**, never from the
  request. Writes re-check every time. Reads may memoize for 30 s (the ADR 0887
  TTL).
- **Accept.** The invite is a single-use, 7-day sharing link (`collab_invite`
  resolver). Accepting requires a signed-in caller whose home-tenant User row
  holds the invite email (normalized) with `emailProvenance: 'idp'`, which only
  an `email_verified` IdP claim can set (ADR 0622 D7, `middleware/auth.ts:140-146`).
  A mismatch or an unverified lane is refused `invite_email_mismatch`. Binding writes
  `boundUserId` by CAS (`null → userId`). It never matches principal strings.
- The vendor's home "Shared with me" view lists their active grants across
  agencies. It reads the grant index by `boundUserId`, so the home tenant stores
  nothing about the agency.

### D3 — Link-only mode: per-item sharing links backed by a grant

For one-time reviewers (a client approver under ADR 0924, a proof reviewer under
ADR 0947, a report viewer under ADR 0957), each item is a **sharing resolver**
link (ADR 0448 D3), minted against a grant with `resourceId =
${itemId}:${grantId}` (the `sign_request` shape). The resolver's
`validate`/`load` re-run D2's checks minus `boundUserId`, because
system-minted visitor links skip the publisher re-check. Revoking the grant
darkens the link at its next use.

**Correction to ADR 0924 D5:** its bespoke `ClientApprover` token store would be
a third token home, which ADR 0448 D3 forbids. ADR 0924 P1 should build on this
ADR. The client approver is an `ExternalCollaborator` of kind
`client-stakeholder` with a `decide` grant on the change set. The ADR 0924 D2
decide-time checks and D5 page semantics are unchanged.

### D4 — External decisions never put an outsider on the wire

- Collaborators never start, read or resume runs.
- An action that needs a run (validating an intake, notifying the producer) is
  started by the service as host-trusted, with the client stamp (ADR 0921 D3; the ADR 0941 run tag when the action belongs to a campaign)
  and `run.metadata['openwop-app.collab'] = {grantId, collaboratorId}`, a
  reserved host key the client cannot set.
- External decisions resolve **host approval rows** (ADR 0924's kind, ADR
  0947's proof stages). Where an approval row stands for a run-step gate, the
  ADR 0942 bridge resolves the interrupt with `resolvedBy` set to the host's
  subject, the RFC 0183 timeout precedent, and puts the attribution in host
  metadata and the audit chain. No external `Subject` is emitted, so RFC
  0165 §B.2 holds.

### D5 — Vendor asset intake into the DAM, with provenance

```ts
interface AssetIntake {                   // campaign-ops:intake, key tenant::orgId::intakeId
  intakeId: string; tenantId: string; orgId: string; campaignId: string;
  requestId?: string; grantId: string; collaboratorId: string;
  files: Array<{ mediaAssetId: string; contentHash: string; contentType: string; bytes: number }>;
  rights: { license: 'work-for-hire' | 'licensed-perpetual' | 'licensed-term' | 'client-owned' | 'stock';
            termEndsAt?: string; credit?: string; modelReleases: boolean; attestedAt: string };
  status: 'submitted' | 'accepted' | 'rejected' | 'withdrawn';
  reviewedBy?: string; reviewedAt?: string; reason?: string;
}
```

- **Upload path.** `POST /collab/:grantId/intake` (needs the `upload` action).
  It checks a content-type allowlist (v1: images, video, PDF; no archives or
  executables), the existing byte caps, a per-grant quota, and `contentHash`
  dedupe. It then writes to `features/media` under the client org with
  `intake: {state: 'pending', intakeId}` and lineage
  `{suppliedBy: {kind: 'vendor', collaboratorId, grantId}, rightsNote}`.
- **One lineage record, owned by ADR 0945 D4.** The asset lineage record is
  media's `MediaAssetLineage`; ADR 0945 D4 owns its schema. Its `grounding` facet
  holds AI provenance (model, prompt hash, source asset ids). Its `suppliedBy`
  facet, which this ADR writes, holds the supplier, and `rightsNote` holds the
  accepted rights summary. `AssetIntake.rights` is the intake form, not a second
  rights record on the asset.
- **Scan hook.** `host/uploadScan.ts` is a port with a "not configured"
  default. When no scanner is configured, the types the allowlist excludes stay
  refused (fail closed). It is never a silent pass.
- **Pending assets are inert.** Destination adapters (ADR 0922), creative
  pipelines (ADR 0945/0946), public serve tokens and the media picker refuse
  `intake.state !== 'accepted'`. The check is one helper
  (`isUsableMediaAsset`) at the read seam those consumers share, so it is not
  repeated per consumer.
- **Accept** is an agency act: `workspace:write` on the client org, ADR 0942
  action class `asset.accept-vendor` (ADR 0942 D1; default `approve`; PendingApproval kind `asset-intake-accept`, added by this ADR). It runs a CAS
  `pending → accepted`, an audit entry and a `host.campaign.asset.accepted`
  event. **Reject** keeps the bytes for 30 days and then purges them through the
  retention seam.

### D6 — Vendor briefs and tasks ride kanban stacks

- **Brief.** A `creative-brief` grant serves the approved brief through the
  existing `creative_brief` projection (approved-only stays).
- **Tasks.** Cards on the client campaign's board (ADR 0311 stack) carry
  `externalAssignee: collaboratorId`. They do **not** use `assigneeId`, which
  member-only paths (workload, notifications, WIP) trust as a member subject.
  The collab router shows only cards whose `externalAssignee` is the caller's
  collaborator id and whose board is covered by an active grant. Actions:
  comment, attach intake, `mark-ready`. Mark-ready moves the card to the
  agency's review column and never to done.
- The Producer agent (ADR 0943) creates vendor cards with `kanban.add-todo`
  plus `feature.campaign-ops.nodes.assign-vendor-task` (side-effect, ledgered,
  needs an active grant, ADR 0942 class `vendor.engage`, ADR 0942 D1). An agent can never
  mint a grant. Inviting is a human act.

### D7 — Revocation, expiry, audit, erasure

- Revoking a collaborator revokes all their grants. Archiving a client
  suspends its collaborators (ADR 0921 Q2's rule, applied to every kind).
- Grants expire by `expiresAt`. Expiry is evaluated when a grant is used, so no
  sweeper decides access. A daily job only notifies the owner 7 days before.
- Create, accept, every write and every revoke call
  `appendAudit(tenant, 'governance.decision', {grantId, collaboratorId, action,
  resource})`. The entry holds ids only, no email.
- DSAR: a subject eraser keyed on the collaborator's email deletes the
  collaborator row, anonymizes `suppliedBy` on accepted assets (the asset and its
  rights record stay, which is the agency's legal basis), and revokes grants.

### D8 — Isolation witnesses (route-level, `createApp` + cookie jar)

1. A collaborator session gets 404 on every tenant-scoped and `/v1/runs` route
   in the agency workspace.
2. A grant for client A cannot read a client-B campaign by id: the result is
   the uniform 404, including a crafted `orgId` in the path.
3. A revoked grant, an expired grant, a suspended collaborator and an archived
   client are each refused on the next request, including the write that was
   in flight.
4. User X from IdP A and user Y from IdP B with the same `scim:jsmith`
   principal: only the `boundUserId` holder passes.
5. A pending intake asset is refused by a destination adapter, by the media
   picker and by a public serve token.
6. A grant-backed link goes dark after the grant is revoked (D3); no agent
   tool can create a grant.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | `host/externalCollaborators.ts` (owned with accessControl) for records, grants and the kind registry. `features/campaign-ops/collaboration/` for the collab router, intake and vendor cards. `features/sharing/` gains `collab_invite` and grant-backed resolvers. `features/media/` gains the intake state and `isUsableMediaAsset`. |
| 2 | Toggle | Sub-toggle `campaign-ops.external-collab` (default OFF, `bucketUnit: 'tenant'`), an `extraToggleDefaults` entry of `campaign-ops` (ADR 0941 D5 toggle rule; no `dependsOn`, AND-gated in code with `campaign-ops`). The client-stakeholder link-only mode used by ADR 0924 stays under `campaign-ops-client-portal`. |
| 3 | Workflow surface | `ctx.features.campaignOps.assignVendorTask`, `listIntake`, `acceptIntake`. No `createGrant`. |
| 4 | Node pack | `feature.campaign-ops.nodes` gains `assign-vendor-task` and `request-assets` (both side-effect, ledgered) and `intake-status` (read). |
| 5 | AI chat and envelopes | None. Agents may draft an invite message for a person to send. |
| 6 | Agent pack | Producer (ADR 0943) uses the two nodes. Its prompt states "you cannot invite or grant access", and that line is test-pinned. |
| 7 | Public surface | `collab_invite` and grant-backed sharing resolvers (uniform 404, ADR 0934 shared limits on decision and upload POSTs, no caching per ADR 0887). The collab router requires a session but is outside workspace membership. Upload size, type and quota caps apply. |
| 8 | RBAC | Inviting and granting need `host:members:manage` on the client org. Accepting intake needs `workspace:write` on the client org plus the ADR 0942 gate. A grant is checked on every use. Tenant and org come from the grant. |
| 9 | Replay / fork | Grants are host state outside runs. Vendor-triggered runs carry the reserved collab key. Forks re-check grants live and never replay a revoked grant's write. |
| 10 | Frontend | Agency side: a Collaborators panel per client (invite, grants, expiry, revoke, audit). Vendor side: a minimal "Shared with me" home plus a scoped workspace page (brief, cards, upload with rights form). No app nav and no chat for collaborators. Four locales. |

## Why this is our advantage

- **Governed outsiders in an agent workflow.** A vendor upload is an intake that
  an agent can triage but only a gate can accept. Every step is audited and
  replayable. Ziflow and Workfront gate review. They do not tie the deliverable's
  rights record to the run that later puts it in an ad.
- **Provenance that survives.** "Which human or model produced this pixel, under
  which licence, accepted by whom, from which grant" stays on the asset.
  ADR 0945 can then refuse unlicensed source imagery.
- **Isolation without a parallel identity.** One login for the vendor, no
  membership in the agency. GHL agencies hand out sub-account logins.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | `host/externalCollaborators.ts` (records, grants, kind registry, per-use check), `collab_invite` resolver, accept with verified-email binding | Witnesses 2, 3, 4 |
| P1 | Link-only mode resolvers; ADR 0924 P1 rebuilt on it (client-stakeholder `decide`) | Witness 6; ADR 0924 D2 checks unchanged |
| P2 | Collab router, campaign/brief kinds, vendor home | Witness 1 |
| P3 | Intake (upload, rights, scan port, `isUsableMediaAsset`), accept gate, lineage `suppliedBy` (with ADR 0945) | Witness 5; reject purge after 30 d |
| P4 | Vendor cards (`externalAssignee`), `assign-vendor-task`, `request-assets` | Producer agent assigns; vendor marks ready; card never auto-closes |
| P5 | Expiry notices, DSAR eraser, audit review page | Erasure keeps accepted assets with the supplier anonymized |

## Alternatives weighed

- **Org membership with a restricted custom role.** Rejected. Custom roles hold
  protocol scopes only, and a `ws:` membership needs a tenant-wide root row
  (ADR 0921 G2).
- **A new `guest` principal kind.** Rejected. It amends RFC 0048 (the identity
  model) and the RFC 0165 `Subject.kind` enum, a wire change, for something the
  host can do with ordinary users plus grants.
- **Links only, with no accounts.** Rejected as the only mode. A vendor working
  for weeks across several briefs needs one identity, MFA from their own IdP,
  and a single place to see their work. Kept for one-time reviewers (D3).
- **A bespoke token store per feature (ADR 0924 D5 as written).** Rejected by
  ADR 0448 D3. One home for links.

## RFC verdict

**Host extension, no RFC, provided D4 holds.** Collaborators are ordinary `user`
principals of their own home tenant. Grants are host state. Every route is under
`/v1/host/openwop-app/*`.

**FLAG (conditional RFC):** if product later wants an external person to
resolve a run interrupt **as themselves on the wire** (`resolvedBy` naming them),
that needs an openwop RFC amending RFC 0165 §B (a `Subject` whose `tenant`
differs from the run owner's, or a delegated or capability lane) and touching
RFC 0048. Author it with `/prd` before any host work. This ADR deliberately does
not need it.

## Open questions

1. **(David)** Grant lifetime defaults: 30 days for vendors and 7 days for
   link-only reviewers (proposed). Should clients be able to set "never expire"?
   Proposed: no; 180 days maximum, renewable.
2. **(David)** Is a virus or malware scanner worth a vendor account (for
   example a Cloud Storage scanning service)? Until then the allowlist excludes
   archives and executables, and the scan port ships "not configured".
3. **(David)** Should a client-stakeholder in signed-in mode (a standing portal,
   ADR 0957) be allowed, or should clients stay link-only? Proposed: allowed,
   opt-in per client.
4. Should vendors see each other's cards on a shared campaign? Proposed: no.
   Visibility is per `externalAssignee`, plus a grant-level `see-team` action
   later if asked.
5. No `/architect` pass has been run yet. Run it before Accepted, adversarially
   on D2 (binding) and D5 (inert pending assets).

## Planning rows

**ROADMAP (Campaign Studio program table):**
`| 0958 | **Vendor and guest collaboration** ([ADR 0958](docs/adr/0958-vendor-and-guest-collaboration.md)) | `campaign-ops.external-collab` | 0921, 0941, 0942, 0013, 0448, 0887, 0311, 0353; unblocks 0924 P1, 0947, 0957 | `feature.campaign-ops.nodes` | Host extension (conditional RFC flagged in §RFC verdict, not needed by this design) | 🔵 Proposed |`

**FEATURES "Future features":**
`- **Vendor and guest collaboration (ADR 0958, Proposed 2026-10-19)** — vendors, freelancers and client reviewers get per-campaign, per-asset grants with mandatory expiry, checked on every use, using their own login with no membership in the agency workspace, or a grant-backed sharing link for one-time reviews. Vendor uploads land as inert intake with a rights record and provenance until an agency member accepts them into the DAM; vendor briefs and tasks ride kanban stacks; every grant event is audited. One collaborator model replaces ADR 0924's planned separate token store. Toggle `campaign-ops.external-collab` (OFF, tenant). No RFC.`
