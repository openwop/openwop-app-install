# ADR 0958 — Vendor and guest collaboration

Status: Accepted (P0–P3 and P5 implemented and deployed, rev `01066-x6w` at `e88758306`, 2026-10-28; Q2 decided and its ClamAV scanner built, the service itself not yet stood up; P4 (vendor cards) pending; the agency Collaborators panel built (#5341), see D7; `campaign-ops.external-collab` OFF everywhere)

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

> **Sequencing note (2026-10-19, agreed with a0).** ADR 0924 P1 (the client
> approval portal) is built BEFORE this ADR's P0. It uses a `campaign_approval`
> sharing resolver (resourceId `${changeSetId}:${approverId}`) with per-use
> re-checks and ADR 0934 limits, over a narrow approver record shaped like
> `ExternalCollaborator` (kind `client-stakeholder`, `orgId`, `email`, `status`).
> That record is the first `ExternalCollaborator` kind. This ADR's P0 adopts it with
> one migration and does not add a parallel record.
>
> **As built by a0 (commit a495f2ce6, `feat/campaign-ops-client-portal`):**
> - Approver: collection `campaign-ops:client-approver`, key `tenant::orgId::approverId`,
>   fields `{tenantId, orgId, approverId 'capr_<uuid>', kind:'client-stakeholder',
>   email (lowercased), displayName, status 'active'|'revoked', mode:'link-only',
>   createdBy/At, updatedAt, revokedAt/By}`.
> - Link: `campaign-ops:approval-link`, key `tenant::org::changeSetId::approverId`,
>   `{sentBy, sentAt}`; `sentBy` is the agency member the approved change is written under.
> - Token: a sharing `campaign_approval` link, resourceId `${changeSetId}:${approverId}`,
>   visitor lane, 7-day expiry, actor `system:campaign-ops-portal`.
> - Votes record `decidedBy = client-approver:<approverId>` (no email).
> - Under `client`, a member's approve is refused 403 `client_approval_required`
>   (reject still allowed). `client_and_agency` is not built yet (ADR 0942 D9's
>   per-party quorum).
>
> P0 maps each approver 1:1 to an `ExternalCollaborator` plus a `decide` grant on the
> change set, with `expiresAt` equal to the link's expiry. **Gap owned by this ADR:**
> there is no `boundUserId` (link-only mode), so signed-in client stakeholders are P0
> work here.

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

> **Correction (2026-10-20, P0 build, architect review).**
> - **Keys.** Collaborators (`extcollab:c`) and grants (`extcollab:g`) are keyed
>   by their unguessable id alone (`ccb_` / `cgr_` + uuid), not
>   `tenant::orgId::id`. A signed-in vendor's request names only a grant id, and
>   the tenant and org must come FROM THE GRANT (this section). A composite key
>   would force the request to carry the tenant. Every row still carries
>   `tenantId` + `orgId`, and every read asserts them, including grant against
>   collaborator, as defence against a corrupt row. A tenant index serves the
>   agency lists.
> - **The cross-agency `extcollab:bound` index** (`<boundUserId>::<collaboratorId>`,
>   ids only) is written at accept. Erasure reads it now, and the vendor's
>   "Shared with me" (P2) will too. The home tenant stores nothing about the
>   agency.
> - **IdP-verified exactly.** Accept requires `emailProvenance === 'idp'`. This is
>   stricter than `isEmailVouched` (org invitations, ADR 0833 D9), which also
>   takes `'admin'`. Here the vouching admin would be the vendor's own workspace
>   admin, possibly the vendor. Deliberate, not drift.
> - **Where it lives.** The host seam (`host/externalCollaborators.ts`) owns
>   records, grants, the kind registry, binding and the ONE per-use check
>   (`checkGrantUse`). It imports no feature (ADR 0001). Invite minting and accept
>   live in `features/campaign-ops/collaboration/routes.ts`, which mints the
>   `collab_invite` link through `createLink` on the visitor lane (the
>   `sign_request` precedent).
> - **The client account gate** is a registration
>   (`registerCollaborationOrgGate`; campaign-ops answers "client `active`").
>   When it is absent, every use is refused (fail closed). It is consulted at
>   invite, grant, and every use.
> - **No memoization in P0.** `checkGrantUse` reads everything live on every use.
>   The 30 s read memo this section allows is not taken until a measured need
>   exists.
> - **Single use.** Accepting binds by CAS from `{invited, unbound}`; a lost race
>   passes only for the same user. The link is purged after the bind, so a
>   failed attempt leaves it usable for a corrected retry. Revoking a
>   collaborator purges an unaccepted invite at once.
> - **Refusals.** Every refusal is the uniform 404 except two the person can fix:
>   an anonymous caller is told to sign in (401), and an email mismatch or an
>   unverified address is `invite_email_mismatch` (403, naming the remedy).
> - **Erasure.** P0 ships the userId-keyed eraser (a person erased in their home
>   tenant loses every binding in every agency). The email-keyed erasure an
>   agency runs for a never-accepted invite stays P5.

> **Correction (2026-10-20, P2 build).**
> - **Each kind is registered by its OWNING feature**, never by campaign-ops (ADR
>   0001): `creative-briefs` registers `creative-brief` (the approved-only
>   projection the `creative_brief` share link serves, so a demoted brief goes
>   dark), and `campaign-orchestration` registers `campaign` (name, objective,
>   channels, status; never the budget, kernel or assets). P2 grants only `view`
>   on both. The comment, upload and mark-ready actions arrive with the phases
>   that honour them.
> - **The kind registry gains `featureId` and `project`.** The owning feature's
>   toggle is checked against the GRANT's tenant on every use (the comments ADR
>   0881 D2 rule), and `project` is the closed view a collaborator gets.
> - **"Shared with me"** (`GET /collab/shared`) reads the bound index and passes
>   every candidate through `checkGrantUse`, so it never lists what the next
>   click would refuse. `GET /collab/grants/:grantId` is the one-item read. Both
>   return titles and the client's name, never an agency id.
> - **Frontend.** The pages live at `/collab`, `/collab/:grantId` and
>   `/collab/accept/:token`, on the workspace tier with no nav. They are gated on
>   none of the collaborator's own toggles. The `collab_invite` share link
>   redirects to the accept page (the `sign_request` dedicated-route precedent).

> **Correction (2026-10-26, integration onto main after ADR 0886/0887 and #5043).**
> P0 and P2 were written on 2026-10-20 against a base that predated the sharing
> re-check work. Integrating them onto `6e1b8df18` found one gap of the class that
> work closed, and fixed it in the same branch.
> - **The granter is re-checked on every use.** `checkGrantUse` checked the grant,
>   the collaborator, the binding, the owner toggle, the client and the resource,
>   but never the member who GRANTED it: a granter removed from the client,
>   demoted, gone from the shared workspace or disabled left every grant they made
>   working. That is the "grants checked once" defect ADR 0886 D3 (the present
>   remote) and ADR 0887 D1 (share links) closed. `checkGrantUse` now re-runs the
>   grant route's own authority for `grant.createdBy`: not disabled (the session
>   authority), still a member of a shared `ws:` workspace, still holding
>   `host:members:manage` on the agency root (an agency admin) or on the client org
>   (`authorizeClient`). `system:` actors are exempt. It is a live re-check, not a
>   revocation: restoring the granter restores the grant.
> - **Fail closed, uniformly.** A fault anywhere in the check (the session
>   authority, the role scan, a resource kind's `exists`, storage) refuses the use
>   with the same 404 a refusal gets, is logged (`extcollab_check_fault_refused`),
>   and is never remembered, so the next use retries. (ADR 0887 M1's "only a
>   403/404 darkens" is about not ADOPTING a link on a fault; here the safe
>   direction is to refuse.)
> - **What is memoized, and the worst case.** Disabled (granter and collaborator)
>   is read live on every use. Only the granter's PRESENT answer (membership +
>   scope) is memoized, never a deny and never a fault, for at most 30 s (the ADR
>   0887 H3 bound, which ADR 0887 D1 accepts for share links: "a removal or
>   demotion darkens a link within 30 s on every instance"). A removal or demotion
>   the host performs fires `onMemberAuthorityLost`, which drops that person's
>   entries at once on the instance that ran it. **Worst case:** another Cloud Run
>   instance, or an authority change that fires no hook (a custom-role or group
>   edit), keeps a stale allow for up to 30 s. This supersedes the P0 note "No
>   memoization in P0" for the granter-presence half only.
> - **The collaborator's own account is re-checked too.** A person disabled in
>   their home tenant (SCIM or admin) is refused on the next use on every lane, not
>   only when their session dies.
> - **Erasure of an agency member** now tombstones their id in grant
>   `createdBy`/`revokedBy` and collaborator `createdBy` to `erased` (the sharing
>   and kb value). A tombstoned granter is absent, so the grant goes dark, as an
>   erased publisher's link does.
> - **The invite stays system-minted** (`system:campaign-ops-collab`, now pinned in
>   the ADR 0887 visitor-mint call-site test). Accepting binds an identity and
>   grants nothing; every grant is minted by a member and carries the re-check.
> - **Sharing union.** `collab_invite` sits beside main's `campaign_approval`
>   (ADR 0924) in `RESOURCE_TYPES`, the resolver table and the owner list UI; the
>   `campaign-ops.external-collab` sub-toggle joins the portal and client-reports
>   sub-toggles in `campaign-ops` `extraToggleDefaults`. Nothing was duplicated.
>
> > **CORRECTED 2026-10-26 (P1 shipped).** Both items below are closed. (a) The
> > read-only prod count is **0** `campaign-ops:client-approver` rows, 0
> > `campaign-ops:approval-link` rows and 0 `extcollab:*` rows (no
> > `campaign-ops:*` rows at all; 75 `sharing:link` rows confirm the key prefix),
> > so no production data moves. Adopter deployments are covered anyway: pre-P1
> > rows are adopted on first read with their ids kept (below). (b) The D3
> > resolver exists: see § Implementation record, P1.
>
> - **P1 status (as written before P1).** #5043 (the ADR 0924 client portal) is merged, so P1 is no
>   longer blocked on it. P1 still needs (a) the prod row count of
>   `campaign-ops:client-approver` before the 1:1 migration, a read-only prod
>   query, and (b) the D3 link-only resolver: `checkGrantUse` already accepts
>   `via: {link: true}`, but no grant-backed sharing resource type exists yet, so
>   the portal's account-less approver link cannot move onto this layer until P1
>   adds it. The signed-in `client-stakeholder` path works today.

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

> **CORRECTED 2026-10-26 (P3, implementation + the `/architect` D5 pass).** Four
> parts of D5 as written changed when it was built. The rest stands.
>
> - **Pending files are not media assets at all.** D5 wrote pending bytes into
>   `features/media` with `intake.state` and asked every consumer to call
>   `isUsableMediaAsset`. That puts the guard at each reader, and a reader that
>   forgets it leaks the file. Instead a pending file's bytes live in
>   campaign-ops' own store (`campaign-ops:intake-bytes`), which no serve route
>   reads. It has no capability token, no library row, no lineage and no picker
>   entry until accept. So the public token route, the library list, get and
>   select, the media picker, a destination adapter's token lookup and the
>   creative pipelines cannot reach it: the file is absent from them, not
>   filtered out. `isUsableMediaAsset` is therefore not built. The one read of
>   pending bytes is the agency review download (`workspace:write`, the people
>   who may accept): always an attachment, a `sandbox` CSP, `nosniff`, never
>   cached. A collaborator has no route that returns bytes, pending or
>   accepted. Accept turns the bytes into an ordinary library asset
>   (`createAsset`), served by the one token route with the ADR 0818 headers.
> - **The writer's checks are narrower than "images, video, PDF".** The v1 types
>   are PNG, JPEG, GIF, WebP, PDF, MP4 and WebM, and each is proven by its
>   leading bytes: a mislabelled image is stored as what it is, and HTML or SVG
>   under any label is refused. A per-org cap (1 GiB awaiting review) sits beside
>   the per-grant one (50 live submissions, 200 MiB).
> - **The scan port fails closed.** `host/uploadScan.ts` ships with no scanner.
>   An `infected` verdict or a scanner fault refuses the upload and stores
>   nothing. With no scanner the type list above is the only guard, and a file
>   stored then is scanned at accept once a scanner exists. Q2 stays open.
>
> > **UPDATED 2026-10-26 (Q2 decided):** the scanner is a self-hosted ClamAV
> > (`host/uploadScanClamav.ts`, clamd `INSTREAM` over TCP, configured by
> > `OPENWOP_CLAMAV_HOST`/`_PORT`/`_TIMEOUT_MS`). "With no scanner the type list is
> > the only guard" is now true only under the development waiver
> > `OPENWOP_UPLOAD_SCAN_OPTIONAL=true`. Without it, an upload is refused
> > `503 scanner_required` and nothing is stored, and a file stored unscanned is
> > never accepted unscanned. The type allowlist stays exactly as narrow.
> - **Accept is a human act, governed by the ADR 0942 rule.** The route needs
>   `workspace:write` on the client org. With campaign autonomy on, the
>   campaign's `asset.accept-vendor` rule applies too: `blocked` refuses,
>   `approve` admits only an approver the rule names (resolved on the client
>   org), and `notify-after` sends its notice after. A rule needing more than
>   one approver, or a client approver, is refused (`autonomy_quorum_unsupported`)
>   rather than met by one click. **Owed:** the `asset-intake-accept`
>   PendingApproval kind that would collect such a quorum. No agent, node or
>   tool can accept (a census test pins it).
>
> **`/architect` pass on D5 (Q5), 2026-10-26.** Run adversarially on the
> implementation. It found no boundary duplication or route collision and
> judged the absence-based guard stronger than the per-consumer check. It
> raised five findings, all handled in P3:
>
> 1. HIGH: an accept that failed halfway left a usable library asset on an
>    intake that stayed `submitted`. Fixed: capacity is checked for the whole
>    intake before the first write, and a failure deletes every asset that
>    attempt created. An accept whose process DIES mid-way cannot run that
>    rollback, so reject and withdraw also remove any library asset whose
>    `suppliedBy.intakeId` names the intake (found in `/code-review`).
> 2. HIGH: the autonomy policy editor offered a rule for `asset.accept-vendor`
>    that the accept route ignored. Fixed as described above.
> 3. MEDIUM: an archived campaign still took uploads. Fixed: upload uses the
>    same "presentable now" projection as the vendor's grant page.
> 4. MEDIUM: no org-wide bound on bytes awaiting review. Fixed: 1 GiB per org.
> 5. LOW: intake rows block deleting the client org (the RI-7
>    refuse-while-populated rule). Accepted: it fails closed and orphans
>    nothing. P5's eraser and teardown own it, as they do collaborator rows.
>
> Kept as owed (not findings): the PendingApproval kind above, and the
> email-keyed DSAR eraser for intake rows (P5; the PII fields are declared).

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

  > **As built (2026-10-27, P5 expiry notices).** The job is an hourly tick, not
  > a daily one: `notifyExpiringGrants` claims each grant by CAS
  > (`expiryNoticeAt`) before it notifies, so how often it runs and on how many
  > instances does not matter. "The owner" is the member who granted it
  > (`createdBy`). It skips `system:` grants (the approval portal's links last 7
  > days from the start, so every one would be announced as it was made),
  > erased granters, revoked or already-expired grants, any tenant where
  > campaign-ops or `campaign-ops.external-collab` is off (the owning feature
  > passes that check in, and without it nothing is sent), and anything the
  > per-use check would refuse right now: the collaborator not active, the
  > resource's feature off, the client archived, or the granter no longer able
  > to grant. The notice
  > holds ids and the date only. The collaborator's name would sit in the
  > granter's inbox after that person's erasure.
- Create, accept, every write and every revoke call
  `appendAudit(tenant, 'governance.decision', {grantId, collaboratorId, action,
  resource})`. The entry holds ids only, no email.

  > **As built (2026-10-27, P5 audit review).** `GET …/clients/:orgId/collaborators/audit`
  > (agency, `host:members:manage` on the client) reads the chain newest first
  > through `listChainTail`: at most 1,000 entries, read 50 at a time in
  > parallel (5,000 serial point reads would have taken seconds on Cloud SQL
  > and held a pool connection; release review), and at most 200 events for
  > the client, with `truncated` when there is more. It is not a verification
  > and says none: a partial read proves nothing about the chain. The governance export
  > keeps the whole chain. The entry holds ids, so the route joins today's
  > names from the live rows. A person who was erased reads as removed, and
  > their events stay as the agency's record. The page is a "Collaborator
  > activity" section on the client in Operations, for agency admins only.
  > No actor is recorded. Member ids in an immutable chain would outlive that
  > member's erasure, so "who did it" stays out of scope. Owed, and not part
  > of this: the agency's Collaborators panel (invite, grant, suspend, revoke;
  > matrix row 10) has routes but no UI yet.
  >
  > **Built (2026-10-28, `feat/0958-collaborators-panel`): the agency's
  > Collaborators panel (matrix row 10).** A lazy section on the client in
  > Operations, for agency admins. Invite (the single-use link shown once, to
  > copy and send), give access to one campaign or approved brief for 7–180
  > days with only that kind's actions, take access back, suspend, reactivate,
  > and remove (behind a danger confirm). It calls the existing routes and adds
  > no authority. The one new read, `GET …/collaborators/grantable`, feeds the
  > picker from an optional `list` on each grant kind. It runs behind the same
  > `host:members:manage` check, never offers a `systemMintOnly` kind, and is a
  > convenience rather than the check: the grant route still decides. States
  > are shown as held: invite sent, active, suspended, and removed (collapsed),
  > with an expired or revoked grant not shown as access. An archived client
  > shows a warning, takes no invite, and offers no give-access or reactivate.
  > Link-only client approvers stay in the approvers panel.
- DSAR: a subject eraser keyed on the collaborator's email deletes the
  collaborator row, anonymizes `suppliedBy` on accepted assets (the asset and its
  rights record stay, which is the agency's legal basis), and revokes grants.
  >
  > **Who reads it.** `createdBy` is the grant route's `requireOrgScope` user,
  > the canonical home `userId`. A shared workspace's inbox reads by the member
  > row's subject, which the production path (personal sign-in, a member row
  > under that home `userId`, then a switch) makes the same string. A test
  > provisions a member exactly that way and reads the notice back through
  > `GET /notifications` in the workspace.
  >
  > **Cost, and what bounds it.** Each tick reads `grants.list()`, every
  > tenant's grants, hourly, on every instance (a superseded revision's too).
  > That is the reject-purge sweep's shape, and it is fine at today's size:
  > prod held no collaborator rows on 2026-10-27. It is still a cross-tenant
  > full scan that grows with use, the class `EVID-4`/`EVID-5` in
  > `docs/steward/TODO.md` trace hourly load to. When it is needed, the bound
  > is an expiry-day index (`extcollab:gexp:<yyyy-mm-dd>::<grantId>`, written
  > by `grantAccess`), so a tick reads only the next seven days' keys. Grants
  > are never extended, so the index never moves.

> **Correction (2026-10-27, P5 eraser as built).** `suppliedBy` is NOT rewritten.
> D5 made it ids only (`collaboratorId`, `grantId`, `intakeId`) and write-once,
> and the person is not in those ids: the email and name live on the
> collaborator record, which the eraser deletes, so the ids then resolve to
> nothing. What did name the person on an accepted asset is text: the credit
> line inside `rightsNote`, and the asset's name while it is still the vendor's
> file name. `mediaService.eraseSupplierDetails` rewrites both, and only on an
> asset whose `suppliedBy.intakeId` matches. As built:
> - **One erase path per record** (`eraseCollaboratorRecord`) for both the P0
>   home-tenant erasure and the agency's own email-keyed erasure. It first runs
>   every registered `CollaboratorEraseHook`, so a feature's cleanup does not
>   depend on the order erasers run in. Then it revokes the grants (kept as the
>   agency's record of what was shared, `revokedBy: system:erasure`), deletes
>   the bound-index row and deletes the record.
> - **The agency half** matches the DSAR key's email forms (directly, or an
>   email the user resolver derived from a userId) against the agency's own
>   collaborator rows in `tenantId`, accepted or not. It never reads another
>   tenant, so it is not the cross-tenant write WF-TWIN-3 refused.
> - **campaign-ops' hook:** an ACCEPTED intake is kept with its licence, minus
>   the note, the credit and the vendor's file names (`supplierErasedAt` set),
>   and its library assets are redacted as above. An intake never accepted
>   (awaiting review, rejected, withdrawn) is deleted with its held bytes and
>   any asset a dead accept left; an accept in flight fails its re-read and
>   rolls itself back. The single-use invite link is purged.
> - **`/code-review` (invoked 2026-10-27) found two and both are fixed:**
>   (HIGH) the home-tenant half reaches records in OTHER tenants, whose legal
>   hold the DSAR's own check never saw, so under a hold there only access
>   ends (grants revoked, binding dropped) and the record and intake rows are
>   kept; (MEDIUM) deleting a pending intake could race an accept that had
>   already passed its re-read, losing the just-accepted asset, so the intake
>   is first CAS-closed to `withdrawn`. The race fix is stated, not witnessed
>   (it needs two writers timed between a read and a CAS). No CRITICAL: the
>   agency half reads only `tenantId`'s rows, no route or wire changed.
> - **Residual:** org teardown (`purgeCollaboratorsForOrg`) does not run the
>   hooks, so intake rows still block deleting a client org (the RI-7
>   refuse-while-populated rule, recorded at P3). That is the teardown half of
>   P5 and remains open.
>
> > **CLOSED 2026-10-27 (P5 teardown).** `purgeCollaboratorsForOrg` now runs a
> > second registry, `CollaboratorPurgeHook`, before it deletes each record.
> > Erase hooks keep the agency's record; purge hooks keep nothing, because the
> > org goes. campaign-ops registers `purgeCollaboratorRows`, which deletes every
> > intake of that collaborator in any state (an accepted one too, and a pending
> > one CAS-closed first, as on erasure) and its invite link. The one teardown
> > entry, `purgeCollaborationForOrg`, runs in this order: the portal's approver
> > links, then every collaborator, then any intake whose collaborator is already
> > gone. It replaces the demo teardown's approver-only `purgePortalForOrg` call.
> > Under a legal hold on the tenant it deletes nothing, so the org's deletion
> > stays refused. Files an accept put in the media library are that store's to
> > tear down; their `suppliedBy` ids then resolve to nothing. There is still no
> > client-delete route; `DELETE /orgs/:orgId` keeps refusing a populated org,
> > now with no collaboration rows left to count.

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
| P5 | Expiry notices, DSAR eraser, audit review page (+ org teardown) | Erasure keeps accepted assets with the supplier anonymized. **Met 2026-10-28** (deployed `e88758306`) |

## Implementation record

| Phase | Commit / PR | Tests |
|---|---|---|
| P0 | `feat/external-collab-0958-p0` (PR pending) | `test/adr0958-external-collaborators.test.ts` (9), each guard sabotage-witnessed (file header). **Witness 2:** a client-A grant never reaches a client-B resource, by id, as a crafted target or as a contained child; it cannot be granted one; a page inside the granted doc passes through `contains`; an ungranted action is refused. **Witness 3:** revoked, expired (`now` past `expiresAt`), suspended, and archived client are each refused on the next use, and reactivation restores access. **Witness 4:** two users in two home tenants with the same `scim:` principal; only the bound one passes and the other cannot take over the binding. **Accept:** binds once to the IdP-verified email and the link is then gone; refused for an anonymous caller (401), a different email, a `self` or `admin` provenance (403 `invite_email_mismatch`), a revoked invite and a disabled sub-toggle; the public invite never shows the email. **RBAC:** a client-org editor cannot invite. **Erasure:** the bound person's record is deleted in every agency. Classified in `subject-erasure-coverage` and the eraser manifest. |
| P1 | `feat/0958-p1` | **D3 link-only lane.** `checkGrantLink` (`host/externalCollaborators.ts`): a sharing link's resourceId is `${itemId}:${grantId}`; the grant must be live for the action on the item through `checkGrantUse` (D2 minus the binding) and belong to the link's tenant and org. **Each mode has one lane:** `via: {link}` refuses a signed-in collaborator and `via: {userId}` refuses a link-only one (before P1 a signed-in grant was accepted through the link lane, which would have dropped the account binding). **ADR 0924 rebuilt on it:** a client approver is a link-only `client-stakeholder` collaborator (`createLinkOnlyCollaborator`, active without a binding); each approval link mints a `view`+`decide` grant on the `change-set` kind (registered by campaign-ops with `systemMintOnly`, so the member grant route refuses it and does not offer it); revoking the approver revokes its grants; a re-send revokes the old grant. The ADR 0924 checks (portal toggles, client active with the `client` policy, change set in review, the sender re-checked at the decision) run on top, unchanged; the portal API keeps its shape (`approverId` = `collaboratorId`). **Adoption:** pre-P1 `campaign-ops:client-approver` rows are adopted on first read per tenant with their ids kept, so `client-approver:<id>` on approval rows still names the same person; their old links are not honoured and are re-sent. Prod held 0 such rows (above). | `test/adr0958-p1-link-only.test.ts` (8): **witness 6** (revoking the grant alone darkens the link for reading and deciding), re-send supersedes, the approver in the collaborators panel, the panel held to the last-approver rule (its revoke goes through the portal and kills the links), no member grants a change set, a census that only the member route and the portal call the grant mint (no pack names it), the lane split both ways plus a foreign org, and adoption keeping the id. Five guards sabotage-witnessed red; the `record.grantId` match stayed green because two earlier layers already kill a superseded link, and the header says so. `campaign-ops-client-portal.test.ts` (10) unchanged except the per-use case now edits the collaborator row. |
| P2 | `feat/external-collab-0958-p2` (PR pending; stacked on #5076) | `test/adr0958-collab-router.test.ts` (5), sabotage-witnessed: "Shared with me" lists usable grants with title and client name and no agency id; the approved brief is served, and a brief demoted to draft goes dark; a campaign shows only its working-brief fields; a revoked grant drops out at once; another user naming the grant gets 404; the owning feature off darkens the grant; **witness 1** (a collaborator session reaches nothing through eight agency routes, and none leaks the brief). Frontend `collabPages.test.tsx` (6); `npm run build` green (entry 128.6 kB, 359 B headroom: the route manifest, with lazy pages); `/ux-review` with a DESIGN.md §5 row. |
| P3 | `feat/0958-p3` | `test/adr0958-p3-intake.test.ts` (16), through `createApp` and real sessions. **Witness 5, by absence:** an upload mints no serve token (the byte store is unchanged) and appears in no library list, select or tenant-wide read; the vendor has no byte route; the agency review download is an attachment under a sandbox CSP, `nosniff`, never cached. Accept makes a served asset with `lineage.suppliedBy` and the rights summary, and the held bytes are gone. Also: SVG, HTML as an image or a video, a header-less PDF, a ZIP and text are refused and nothing is stored; rights are required; the scan port refuses infected and faults and scans at accept; another org's intake reads exactly like a missing one, and another tenant, a client-org viewer, a stranger, a view-only grant, another grant of the same person and a revoked grant are refused; reject keeps the bytes 30 days and the default-window sweep then purges them (not under a legal hold); withdraw deletes them at once; a concurrent second accept is refused; a halfway-failed accept leaves no asset, and rejecting after an accept that died mid-way removes the asset it left; the campaign's autonomy rule governs accept; an archived campaign takes no files; a patch cannot clear or forge `suppliedBy`. Eleven guards sabotage-witnessed red; claim-by-put instead of CAS stayed green and is stated, not claimed. Frontend: `collabPages.test.tsx` (+3: the "Send files" form and its outcome list), `clientIntakeSection.test.tsx` (4: the agency review section). |
| Integration | `feat/0958-collab-integration` (one PR superseding #5076 and #5081) | `test/adr0958-external-collaborators.test.ts` (18): nine new witnesses — the granter and bound-user re-check (lost scope then restored, left the shared workspace with the client-org row surviving, disabled granter, erased granter, disabled collaborator), a personal-workspace owner's grant still passes, a granter-authority fault refuses with the uniform 404 and is not memoized, a resource-kind fault is the same 404, and a host removal drops the memoized allow at once. Each guard sabotage-witnessed red. `adr0887-visitor-mint-actors` pins the invite's `system:` actor. |
| Q2 ClamAV scanner + scanner-required guard | `feat/0958-clamav` | `test/adr0958-clamav-scanner.test.ts` (5): the INSTREAM framing over a fake clamd (a payload over one chunk reassembles exactly, ending in a zero chunk); OK → clean, FOUND (EICAR) → infected; ERROR, an unrecognised reply, a silent close, no listener and a timeout → `error`; boot reads the env and refuses a malformed port or timeout. `adr0958-p3-intake` (+1): with no scanner and no waiver an upload is `503 scanner_required` and nothing is stored, and an unscanned file cannot be accepted. Six guards sabotage-witnessed red: unrecognised reply as clean, silent close as clean, no timeout, no terminating chunk, and the submit and accept guards. |
| P5 DSAR eraser | #5309 (`a52087693`) | `test/adr0958-p5-eraser.test.ts` (5), through `createApp`, real sessions and the real `eraseSubject` fan-out: the agency's email-keyed erasure of a never-accepted invite deletes the record, revokes its grant and kills the invite link; **the exit criterion:** an accepted file stays in the library with the supplier anonymized (rights summary without the credit, a neutral name, the intake kept with its licence but no note, credit or file names), while files never taken are deleted with their held bytes; the P0 home-tenant erasure takes the same intake path; the same email erased in another tenant, and another email here, touch nothing. A legal hold on the agency ends access but keeps the record and intake. Seven guards sabotage-witnessed red (no email half; deleting accepted intakes; keeping the credit; no asset redaction; no invite purge; matching every tenant; ignoring the agency's hold). `adr0958-external-collaborators.test.ts`: the home-tenant erasure now also counts the revoked grant (2 rows). |
| P5 teardown | #5332 (`803d265dd`) | `test/adr0958-p5-teardown.test.ts` (2), through `createApp`, real sessions and routes. `purgeCollaborationForOrg` leaves no collaborator, grant, intake (submitted, rejected and accepted) or held bytes in the org; the vendor's "Shared with me" is empty there and the never-accepted invite link is dead; the accepted file stays in the media library; the org's RI-7 count holds only rows outside collaboration; another org's collaborator and intake are untouched; a re-run is a no-op. A legal hold deletes nothing. Four guards sabotage-witnessed red: no purge-hook loop (seen by the invite link only, because the final org-wide intake sweep still catches the rows, as the header says), skipping accepted intakes, the old approver-only teardown, and no hold check. |
| P5 expiry notices | #5334 (`62bc1f5d0`) | `test/adr0958-p5-expiry-notices.test.ts` (6), through `createApp` and the real grant route, with the tick driven at a chosen clock. A grant ending in 5 days is announced to its granter once, and a second tick is silent. The notice has no name or email. A 30-day grant is silent until 7 days are left. Nothing is sent for a revoked grant, a suspended collaborator, an expired grant, or while the tenant's external-collab toggle is off (or no check is passed). A grant that was skipped while off is announced once it is back on. The granter reads it back through `GET /notifications` in the shared workspace, both through the test-login seam and as a member provisioned the production way (personal sign-in, member row under the home userId, switch), and another member does not see it. Five guards were sabotage-witnessed red: no CAS claim, a 30-day horizon, no collaborator-status check, the name in the title, and no toggle check. Re-spelling the recipient reds all three inbox cases. The tick (`collaboration/expiryNotices.ts`, hourly, unref'd, `OPENWOP_COLLAB_EXPIRY_NOTICE_MS`) is started from the collaboration routes. The scan is `grants.list()`, the same shape as the reject-purge sweep. |
| P5 audit review | #5336 (`e88758306`) | `test/adr0958-p5-audit-review.test.ts` (5), through `createApp`: invite, accept, a grant, a file sent and accepted, a grant revoke and a suspension come back newest first with the live name; another client's events do not appear; after erasure the events stay as a removed collaborator, with no email or name; a vendor and a client viewer (who can read the client's intakes) are refused, and it is dark with the toggle off; `listChainTail` is bounded and newest first, and its cost is pinned (1,000 reads per load at most, at most 50 in flight, more than one at a time). Six guards were sabotage-witnessed red: no org filter, oldest first, the payload passed whole, `workspace:read`, serial reads, and one `Promise.all` over the whole tail. Frontend: `clientCollabAuditSection.test.tsx` (5); two guards red (a failed read as empty; a raw action key). `npm run build` is green. |
| D2 MEDIUMs | #5333 (`c257bef5d`) | `test/adr0958-d2-mediums.test.ts` (5), through `createApp` and the real client route: archiving suspends the signed-in collaborator and un-archiving leaves the grant refused (and out of "Shared with me") until a reactivation; a binding whose index row went missing is found again after the same person's next accept, and another user still cannot bind or get an index row. Three interleavings are driven by wrapping `DurableCollection.compareAndSwap` (found by a Codex harness with injected storage, 2026-10-27): a write error on the suspension makes the archive fail and leaves the collaborator active, and a retry completes it; a bind that loses to the same user, suspended since, keeps the binding indexed and it is listed again after reactivation; a bind that exhausts its retries keeps the row when the same user won the last race. Five guards were sabotage-witnessed red: no suspend call in the route; no re-put on the same-user path; catching every suspension failure; deleting the row on any refused bind; deleting it unconditionally after the retries. |
| D7 archived invite | #5335 (`b4c5b01e3`) | `test/adr0958-archived-invite.test.ts` (1), through `createApp` and the real routes: an invite accepted while its client is archived gets the uniform 404 and binds nothing; after un-archive the same invite binds and the grant made before the archive works. This supersedes the LOW under open question 5 ("accept does not check the client's status"): an accept during an archive bound as `active`, and un-archiving brought the grant back with no member decision. The guard was sabotage-witnessed red. The `collab_invite` link is kept on archive, because accepting after an un-archive is the ordinary flow. |
| Collaborators panel (matrix row 10) | #5341 | `test/adr0958-collaborators-panel-grantable.test.ts` (3), through `createApp`: `GET …/collaborators/grantable` offers this client's live campaigns and approved briefs only, each with its kind's actions; never another client's, never a `systemMintOnly` kind; what it offers grants, and another client's brief is still refused by the grant route; a client viewer is refused and it is dark with the toggle off. Three guards were sabotage-witnessed red (the approved filter, the `systemMintOnly` skip with a test kind that lists, org scoping). Frontend `clientCollaboratorsPanel.test.tsx` (10): success and refusal for invite (the link shown once), give access, take back, suspend, reactivate and remove (danger confirm; cancel calls nothing); states as held; the archived client. Six guards red. **Live render (2026-10-28, local memory-store stack, packs not mounted, seeded locally):** light and dark both legible, with every state (active, invite sent, suspended, removed collapsed) and the archived client (warning, give-access and reactivate disabled, no invite form, the archived-suspended hint). The remove confirm opens with focus on Cancel, Tab stays inside it, Remove shows a visible focus ring, and Escape changes nothing. |

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
   **Decided (2026-10-26, David): no vendor account. A self-hosted ClamAV, required
   before any real tenant turns external collaborators on.**
   - **Built:**
     - the adapter `host/uploadScanClamav.ts` (clamd `INSTREAM` over TCP, no new dependency, fail-closed);
     - the code-level guard: outsider uploads are refused `scanner_required` with no scanner, unless the development waiver is set.
   - **Not built: the ClamAV service itself.** It is infrastructure, so it is a checklist for the user (§ Q2 operator checklist). `campaign-ops.external-collab` stays OFF everywhere until it is live.
3. **(David)** Should a client-stakeholder in signed-in mode (a standing portal,
   ADR 0957) be allowed, or should clients stay link-only? Proposed: allowed,
   opt-in per client.
4. Should vendors see each other's cards on a shared campaign? Proposed: no.
   Visibility is per `externalAssignee`, plus a grant-level `see-team` action
   later if asked.
5. **Done for D5 (2026-10-26, P3):** see the correction note under D5.
   **Done for D2 (2026-10-26):** an adversarial `/architect` pass read-only on the implementation.
   - **Binding and per-use checks: they hold.**
     - The bind is a CAS, with an IdP-asserted email.
     - Every use is re-checked live: grant, collaborator, toggles, client status, bound user, and the granter's membership and scope.
     - Tenant and org come from the grant, every miss is the uniform 404, and nothing checks once and caches.
   - **HIGH, fixed (#5290):** the DSAR eraser's cross-agency half ran in any tenant, so a workspace admin anywhere could revoke a stranger's bindings in every agency. It now runs only in the person's home tenant (`SessionSubjectState.homeTenantId`). Production held no external-collaborator rows, so nothing was wrongly erased.
   - **MEDIUM, recorded (pre-GA hardening):**
     - The bind CAS and its bound-index write are two writes, and nothing repairs a missing index row. Proposed fix: write the index first and re-put it on the same-user path.
     - Un-archiving a client restores every unexpired grant with no decision, which drifts from D7's "archiving suspends collaborators".
   - **Both MEDIUMs fixed (2026-10-27, `feat/0958-d2-mediums`):**
     - `bindCollaborator` writes the bound-index row before the CAS and re-puts it on the same-user path, so the next accept by the same person repairs a missing row. A caller deletes the row it wrote only when the record is provably not bound to it (bound to someone else, unbound, or gone); a record bound to the same user keeps its row whatever its status, because a same-user accept may have won the race and been suspended since. A stray row is harmless anyway, because every reader re-checks `boundUserId` on the record.
     - Archiving a client through the client route now calls `suspendCollaboratorsForOrg`, which suspends every active signed-in collaborator. Un-archiving restores none of them until an agency member reactivates each one. It fails closed: a suspension that cannot be written (anything but a record already revoked, suspended or gone) is thrown, so the archive call fails and is retried rather than reporting success over a grant that un-archiving would bring back. Link-only collaborators are left alone: archiving already revokes their links (ADR 0921 Q2).
6. **Asymmetry in the demo clear under a legal hold (raised 2026-10-27 at the P5 teardown review).** `purgeCollaborationForOrg` deletes nothing under a hold. `clearAgencyOpsDemo` still purges the same org's jobs, change sets, requests and assets, because those purges predate holds and never check one. Only the synthetic `org-copsdemo-*` clients reach it, and the org's deletion stays refused while collaboration rows remain, so nothing real is lost. Left as is. If the demo clear ever reaches real data, it should check the hold once, up front, for every purge.
   - **LOW, accepted:** accept refusals tell the token holder whether the invite is pending; a retried accept 404s; accept does not check the client's status (every use is refused anyway).
   Original text: No `/architect` pass has been run yet. Run it before Accepted, adversarially
   on D2 (binding) and D5 (inert pending assets).

## Planning rows

**ROADMAP (Campaign Studio program table):**
`| 0958 | **Vendor and guest collaboration** ([ADR 0958](docs/adr/0958-vendor-and-guest-collaboration.md)) | `campaign-ops.external-collab` | 0921, 0941, 0942, 0013, 0448, 0887, 0311, 0353; unblocks 0924 P1, 0947, 0957 | `feature.campaign-ops.nodes` | Host extension (conditional RFC flagged in §RFC verdict, not needed by this design) | 🔵 Proposed |`

**FEATURES "Future features":**
`- **Vendor and guest collaboration (ADR 0958, Proposed 2026-10-19)** — vendors, freelancers and client reviewers get per-campaign, per-asset grants with mandatory expiry, checked on every use, using their own login with no membership in the agency workspace, or a grant-backed sharing link for one-time reviews. Vendor uploads land as inert intake with a rights record and provenance until an agency member accepts them into the DAM; vendor briefs and tasks ride kanban stacks; every grant event is audited. One collaborator model replaces ADR 0924's planned separate token store. Toggle `campaign-ops.external-collab` (OFF, tenant). No RFC.`

## Q2 operator checklist — standing up the self-hosted ClamAV (for the user)

Do not turn `campaign-ops.external-collab` on for any real tenant until every box below
is ticked. Nothing here is done by a session: it is infrastructure, and it adds a
running cost.

- [ ] **Topology: a Cloud Run sidecar.** Recommended. Add a second container to
  `openwop-app-backend` from a maintained ClamAV image (e.g. `clamav/clamav`, pinned
  by digest). clamd listens on `127.0.0.1:3310`, inside the instance only.
  - Cloud Run cannot serve clamd's raw TCP protocol as a separate service, and clamd
    has no authentication. A sidecar keeps it on localhost with nothing exposed.
  - Alternative: a small private VM reached over Serverless VPC Access, with a
    firewall rule admitting only the connector.
- [ ] **Memory.** clamd holds its signature database in RAM, about 1–1.5 GB. Raise the
  service's memory and set `--cpu-boost`.
  - Keep `OPENWOP_PG_POOL_MAX × maxScale` within the Postgres budget: the sidecar
    does not change it, but a memory change re-deploys.
- [ ] **Startup.** freshclam must download signatures before clamd serves. Add a
  startup probe on the sidecar (clamd `PING` → `PONG`) and a container dependency, so
  the backend does not take traffic before the scanner is ready.
- [ ] **Signature updates.** Keep freshclam running in the sidecar (its default), or
  rebuild the image daily. Watch its logs for update failures.
- [ ] **Size.** Keep clamd's `StreamMaxLength` at or above 10M. The intake caps a
  request at 8 MiB.
- [ ] **Backend env**, via `scripts/update-env.sh`, never a bare
  `gcloud run services update`:
  - `OPENWOP_CLAMAV_HOST=127.0.0.1`
  - `OPENWOP_CLAMAV_PORT=3310`
  - optionally `OPENWOP_CLAMAV_TIMEOUT_MS`
  - Confirm `OPENWOP_UPLOAD_SCAN_OPTIONAL` is NOT set in production.
- [ ] **Verify on the deployed revision:**
  - The boot log shows `upload_scanner_registered` (kind `clamav`).
  - Upload the EICAR test string as a vendor through a test grant: expect `422 scan_infected`.
  - Upload a clean PNG: expect `201`, with the file's scan marked `clean`.
  - Stop the sidecar: expect `503 scan_unavailable`, fail closed.
- [ ] **Then, and only then,** turn on external collaborators per tenant.

