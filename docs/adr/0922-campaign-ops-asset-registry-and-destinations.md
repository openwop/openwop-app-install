# ADR 0922 — Campaign ops: asset registry and destinations

Status: Accepted — P0 implemented (#5015); P0b (email adapter) and later phases pending

Program: agency campaign operations (ADRs 0921–0928). PRD features **F3**
(asset registry), **F8** (first CMS destination) and **F11** (email draft
asset). Depends on ADR 0921 (client binding) and composes ADR 0905 (email
template versioning, being implemented by openwop-app-66).

## Context

A campaign keeps a list of its assets: for v1 one CMS landing page and one
unsent email draft. Each asset records where it lives, how it is reached, and
its last-known source version or content hash. Every later step (proposal,
approval, execution, read-back) needs one interface that can **read** an asset's
current content and version and **write** a change guarded by the version it was
read at.

**Owner decision (2026-10-18): the first CMS destination is this app's own CMS**
(`features/cms`), not an external Webflow or WordPress site. The owner's words:
"we have our own CMS". The PRD's F8 asked for one external CMS testable on
founder-controlled infrastructure; the in-app CMS is founder-controlled, carries
real version numbers and a guarded write, and needs no third-party account. An
external CMS moves to Later phases.

## Boundaries audit (state on `origin/main` at `38bdc1699`)

- **No asset registry exists.** `MarketingCampaign.assetIds` holds media-library
  ids only, with no destination, connection or version
  (`features/campaign-orchestration/types.ts:39-41`). The canvas `assets[]` is
  channel/format/headline text (`features/campaign-studio/artifactTypes.ts:49-58`).
  The launch UI links generically to `/cms` and `/email`
  (`frontend/react/src/features/campaign-orchestration/CampaignStudioPage.tsx:335-340`).
  ADR 0570 (Proposed, unbuilt) would link a plan's channel node to its target
  entity (`docs/adr/0570-campaign-plan-execution-linking.md:8-30`).
- **The single owner of a campaign is `campaign-orchestration`**
  (`DurableCollection('campaign-orchestration:campaign')`,
  `features/campaign-orchestration/campaignService.ts:25`). Campaign ops
  references a campaign by its id; it does not add a second campaign entity.
- **CMS — reused as the first destination:**
  - Pages carry an integer `version` bumped on every edit
    (`features/cms/cmsService.ts:205-211, 1270`); `transitionPage` does not bump
    it (`:1249-1250`).
  - `casPage` is the one precondition-honouring write; a miss is 409 with
    `currentVersion` (`:331-351`). `updatePage` takes `expectedVersion`
    (`:1257-1268`).
  - Immutable `PageVersion` snapshots are kept, up to 50 per page (`:1669-1718`).
  - Read verbs on the workflow surface: `getDraftPage`, `getPage`, and the
    version-pinned `updateSectionDraft` (`features/cms/surface.ts:57, 92-185,
    211, 243`).
  - **Pages have no content hash.** Campaign ops computes one (D3).
- **Email — composed through ADR 0905, not built here:**
  - Today `EmailTemplate` has no version or hash and `updateTemplate` is a blind
    CAS retry (`features/email/emailService.ts:35-41, 270-279`).
  - ADR 0905 P1 (#4922, unmerged at writing) adds `updateTemplate(…,
    {expectedVersion, actor})` refusing with `version_conflict`, immutable
    template-version rows, `getTemplateVersion` / `listTemplateVersions`,
    `templateVersionOf(t)` and `templateContentHash({subject, body, format})`
    (confirmed by openwop-app-66, 2026-10-17). `expectedVersion` is optional in
    that API; campaign ops always passes it.
  - ADR 0905 D2/D3 add `campaign.sendPin` and the statuses
    `draft|in_review|approved|sending|sent` (+`changes_requested`).
- **Connections:** first-party providers in the registry include no CMS
  (`features/connections/providerRegistry.ts:235-351`). The in-app destinations
  need no credential.

## Decision

### D1 — `CampaignAsset` registry

```ts
interface CampaignAsset {
  tenantId: string; orgId: string;          // ADR 0921: exactly one client
  assetId: string;                          // 'ast:<uuid>'
  campaignId?: string;                      // campaign-orchestration id, optional in v1
  destination: DestinationKind;             // 'openwop.cms.page' | 'openwop.email.template'
  locator: { pageId: string } | { templateId: string; campaignIds?: string[] };
  label: string;                            // "Webinar landing page"
  editableFields: FieldPath[];              // the fields a change set may touch (D4)
  connectionId?: string;                    // external destinations only (ADR 0921 D4)
  lastKnown?: { version: number; contentHash: string; readAt: string };
  synthetic?: true;
  createdAt: string; createdBy: string; updatedAt: string;
}
```

Stored in `DurableCollection('campaign-ops:asset')`, keyed `tenant::orgId::assetId`.

- **Add:** an operator links an existing CMS page or email template of the SAME
  org. The service reads the target through its owner and refuses a target whose
  `orgId` differs (`wrong_client`, uniform 404 shape). An asset belongs to
  exactly one client; the same page cannot be registered under two clients.
- **Refresh:** re-reads `lastKnown` through the adapter. This is the only writer
  of `lastKnown`.
- **No historical discovery in v1** (PRD non-goal).

### D2 — One `DestinationAdapter` seam

```ts
interface DestinationAdapter {
  kind: DestinationKind;
  read(asset, ctx): Promise<AssetSnapshot>;       // current fields + version + contentHash
  write(asset, edits, { expectedVersion, idempotencyKey, actor }, ctx)
    : Promise<WriteOutcome>;                       // 'written' | 'version_conflict' | 'refused' | 'unknown'
  locate?(asset, ctx): Promise<'present' | 'gone'>;
}
interface AssetSnapshot { version: number; contentHash: string; fields: Record<FieldPath, string>; state: AssetState; }
```

Adapters are registered by destination kind in a campaign-ops-owned registry
(the resolver-registry pattern, ADR 0013). The service is the only caller. A
destination with no registered adapter cannot be added. Future destinations
(external CMS, Mailchimp/HubSpot/Klaviyo drafts) are new adapters, not new
pipelines.

### D3 — `openwop.cms.page` adapter (F8 v1)

- `read` = `getDraftPage` through the CMS surface; `version` = page `version`;
  `contentHash` = sha256 of `canonicalJSON` over `{title, slug, sections}` (the
  same three fields a `PageVersion` snapshot holds). `state` carries
  `status`/`publishedVersion`.
- `write` = the version-pinned section update with `expectedVersion`; a CMS 409
  maps to `version_conflict`.
- **Publishing — one approval (owner decision, 2026-10-18).** A landing-page
  change is usually to a live page, so the step is "edit then publish". The
  approved change set **is** the page's publish approval, whether or not the
  tenant's CMS publish gate (contentApproval) is on. It counts only for the exact
  page state it was bound to:
  1. The adapter writes the edit with `expectedVersion = sourceVersion` and gets
     the new page version `V`.
  2. It re-reads the page and requires `contentHash(V) == targetContentHash` from
     the approved change set. Any other state (a human edit landed between the
     write and the publish) refuses the publish, and the step is `conflicted`
     (`newer_human_edit`).
  3. It publishes with `transitionPage(…, {expectedVersion: V})`, so the publish
     cannot carry a version other than `V`.
  4. With the gate ON, the publish is recorded on the CMS side as a resolved
     contentApproval pinned to `pageVersion: V`, with
     `satisfiedBy: {kind:'campaign-change-set', approvalId, changeSetHash}`, so
     the CMS review history shows who approved this version and through what.
     This is an additive field on the CMS approval row, written through
     contentApproval's own service (not a direct store write), and it is the one
     change P1 asks of the CMS owner.

  If the page version moved, the change-set approval does not authorize the
  publish, which is the rule ADR 0924 D2 already applies at approval time.

> **Corrected 2026-10-18 (P0 implementation).** Steps 3 and 4 of D3's
> publishing flow assumed a separate publish after the edit. The CMS has none for
> a live page: an in-place edit of a **published** page *is* a publish of the new
> content, and it runs the same publish blockers (ADR 0836 D9,
> `cmsService.ts` `updatePage`). So the adapter's whole write is one
> `updatePage(…, {expectedVersion})`, and a page keeps the status it had (a draft
> stays a draft). The page-version binding David approved still holds exactly:
> the write is guarded by `sourceVersion`, and ADR 0925's read-back compares the
> resulting content hash with the approved target. The CMS's own authority
> applies on the row the write swaps: `workspace:write` on a draft,
> `host:members:manage` on a live page; a refusal is the step reason
> `not_authorized`. The `satisfiedBy` record on the CMS approval row (D3 step 4)
> stays the P1 item for tenants with the CMS approval gate on.

### D4 — Constrained, field-addressed edits

`editableFields` names the fields a change may touch, e.g.
`sections[sec:…].data.date`, `sections[sec:…].data.href`, `subject`, `body`.
Section addressing is by the CMS's stable `sectionId` (`sec:<uuid>`,
`features/cms/cmsService.ts:98-99, 905`), never by array index. An edit is
`{field, before, after}` or a span edit `{field, find, replace}` where `find`
must occur exactly once in the source value. The adapter refuses an edit to a
field outside `editableFields`. This is what makes "change only the targeted
fields" checkable (ADR 0923 validates it; the adapter enforces it again).

### D5 — `openwop.email.template` adapter (F11 v1)

F11's "versioned email draft stored inside the product" **is an ADR 0905
template version**. Campaign ops adds no draft store.

- `read` = `getTemplate` + `templateVersionOf(t)` + `templateContentHash`.
- `write` = ADR 0905 `updateTemplate(…, {expectedVersion, actor})`; `version_conflict`
  maps through.
- **Already sent:** before writing, the adapter reads every campaign in
  `locator.campaignIds` (and every campaign referencing the template, through
  0905's in-use index). If any is `sending` or `sent`, the write is `refused` with
  reason `email_already_sent` and the message "This email has been sent. Sent
  emails are never changed; create a new draft." A sent email is never altered.
- **Sending stays with ADR 0905.** Campaign ops never sends (PRD non-goal). An
  edit to a template under 0905 review returns that campaign to draft, which is
  0905's rule and is correct here.
- **Mandatory version guard:** campaign ops always passes `expectedVersion`. If
  0905 later makes it mandatory for some callers, that is 0905's change.
- Drafts stay in a shape an external email-platform adapter can push later
  (subject, preheader, body, format).

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | In `features/campaign-ops/` (`assetService.ts`, `adapters/`). The CMS and email adapters call those features' services through their workflow/service surfaces, never their stores. |
| 2 | Toggle | `campaign-ops` (ADR 0921). The email adapter is registered only when `email` is on; an email asset on a tenant with `email` off is `refused` with `destination_unavailable`. |
| 3 | Workflow surface | `ctx.features.campaignOps.listAssets({orgId, campaignId?})`, `readAsset({orgId, assetId})`. |
| 4 | Node pack | `feature.campaign-ops.nodes.read-assets` (pure read). |
| 5 | Envelopes | None. |
| 6 | Agent pack | None here. |
| 7 | Public surface | None. |
| 8 | RBAC | Add/refresh/remove need `workspace:write` on the client org; list/read need `workspace:read` there. The adapters run with the acting operator's authority on the target's owner. |
| 9 | Replay / fork | Reads only here; writes are ADR 0925's side-effect nodes. |
| 10 | Frontend | An "Assets" panel per client in the campaign-ops page, using the shared CMS page picker and template picker. |

## RFC verdict

**Host extension, no RFC.** No wire field, no capability. The destination
adapters are host code over host-extension features.

## Phased plan

| Phase | Scope | Demo slice? |
|---|---|---|
| **P0** | `CampaignAsset` store + add/refresh/list/remove routes; adapter registry; CMS page adapter (read, write with `expectedVersion`, publish when the gate is off); content hash; `editableFields` enforcement; witnesses for `wrong_client` and `version_conflict` | **Yes** |
| **P0b** | Email template adapter on ADR 0905 P1 (needs #4922 merged); `email_already_sent` refusal witness | **Yes** (blocked on #4922) |
| P1 | CMS publish gate ON (D3 step 4): the `satisfiedBy` record on the CMS approval row | No (the demo tenant runs with the gate off; steps 1–3 are P0) |
| P2 | Asset pickers in the UI; campaign linkage to `campaign-orchestration` campaigns | Partly (the demo can register assets through the seeder) |
| Later | External CMS adapter (WordPress or Webflow) over the connections broker with a pinned per-client credential; external email-platform draft adapters | No |

**Fallback if #4922 has not merged by the demo:** the email adapter can ship
against today's `EmailTemplate` with a campaign-ops-computed hash and the
existing CAS, guarded by the hash rather than a version. This is a stopgap that
must be replaced by D5 once 0905 lands; it is called out so the demo does not
silently depend on an unmerged PR.

## Alternatives weighed

- **External CMS first (WordPress or Webflow).** The PRD's original ask.
  Deferred by the owner: the in-app CMS demonstrates the thesis with real
  versions on founder-controlled infrastructure and no account to create.
- **Extend `MarketingCampaign.assetIds`.** Rejected: it is a list of media ids
  whose consumers assume media; a destination-bearing asset is a different
  entity.
- **A campaign-ops draft-email store.** Rejected: ADR 0905 is the single owner of
  template versions.

## PRD-vs-architecture corrections

1. F8 "external CMS" → the in-app CMS (owner decision). The acceptance criterion
   "works against a real sandbox site, not mocks only" is met by the real CMS
   service in the scenario pack (ADR 0927).
2. F11 "a versioned email draft stored inside the product" → an ADR 0905
   template version; no second draft store.
3. F3 "last-known source version or content hash" → both: the destination's own
   version where it has one, plus a campaign-ops content hash (CMS pages have
   none of their own).

## Open questions

- [x] **Q1** When the CMS publish gate is ON, does the approved change set
      satisfy it? **Yes, one approval** (owner, 2026-10-18), bound to the exact
      page version and hash that is published (D3).
- [ ] **Q2** Does ADR 0905 expose a "campaigns referencing this template" index
      the adapter can read for `email_already_sent`? Confirm with
      openwop-app-66 when #4922 lands.
- [x] **Q3** Do CMS sections have stable ids? **Yes**: every `Section` carries a
      `sectionId` (`sec:<uuid>`) minted once and kept
      (`features/cms/cmsService.ts:98-99, 905`). Field paths use it.
- [ ] No `/architect` pass has been run on this ADR.

## Implementation record

| Phase | Commit / PR | Tests |
|---|---|---|
| P0 | #5015 (`feat(campaign-ops): client accounts, asset registry, CMS page adapter`) | `backend/typescript/test/campaign-ops-clients-assets.test.ts` |
