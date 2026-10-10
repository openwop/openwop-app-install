# ADR 0838 — Documents: the approved version is what publishes, one id owner, one read gate, and checked edits

Status: implemented (feature loop 2026-10 row 24, `feat/fl2-24-documents`; `/architect` pass before code; grade-ux and grade-code passes after — see the correction notes and the implementation record)

Feature loop 2026-10 row 24 (Documents & Templates). This ADR extends ADR 0053 (documents and
templates), 0056 (canvas materialization), 0057 (rendering), 0308 (deliverable tools), 0610 D3′
(project-owned documents are membership-scoped), 0643 (`KBC-4`, the by-id doors), 0069/0083
(the artifact projection), and 0832 (the surface org floor). There is no new toggle: `documents`
keeps its id, stays default ON, and keeps `bucketUnit: tenant`. This is host-extension work only;
nothing touches the wire.

## Context

The row-24 workflow grade (`docs/steward/WORKFLOWS-ASSESSMENT.md`, § Documents row 24, ids
`DOCWF2-`) measured round 1's B+ at `764883b6c` and found C+. Each finding below was re-read in
the code, and the two security headlines were witnessed RED on that baseline
(`test/adr0838-documents-store-integrity.test.ts`).

1. **A document id chosen by one caller overwrites another tenant's or org's document
   (`DOCWF2-1`).**
   - `documents:doc` is keyed by `documentId` alone (`documentsService.ts:180`).
   - `createDocument` short-circuits a replay only when `getDocument(tenant, org, id)` finds a
     row (`:329`). A row held by another tenant or org reads as absent, and the blind
     `docs.put` (`:352`) replaces it.
   - Who supplies ids:
     - the content-marketing demo seeder, with the SAME `doc:demo-cm-<slug>` in every tenant
       (`host/demoContentMarketingSeed.ts:263`). This is live: each tenant that seeds takes the
       previous tenant's ten documents.
     - the run surface's `createDocument({documentId})` and `createDraftDocument({idemBase})`
       (`surface.ts:59,79`).
     - chat-export, strategy and the deliverable tools, which hash their ids from run ids.
       Those are safe in practice but unguarded in principle.
2. **Approval gates the document, not the text it publishes (`DOCWF2-2`).**
   - Promoting a document to `approved` or `final` needs `host:members:manage`
     (`routes.ts:242`).
   - The public share serves `currentVersionId` (`documentsService.ts:686`).
   - Any `workspace:write` holder, run or agent can therefore add a version to an approved
     document and publish never-approved text on the open internet. The share resolver's
     promise "Draft SOW/RFP never leaks" (`sharingService.ts:335`) is false for every approved
     document.
3. **The run surface asks read tier for every writer (`DOCWF2-3`, the third instance of the
   `CMS2WF-2` generator).** `documents` registers no `orgPolicy` (`feature.ts:54`).
4. **The chat read tool skips the project-membership gate the HTTP door applies (`DOCWF2-9`,
   found while scoping D3).**
   - `openwop:documents.get` (`agentTools.ts:301-334`) checks only org `workspace:read`.
   - `GET …/documents/:id` also runs `assertOwnerReadable` (`routes.ts:199`).
   - An org viewer who is not a member of a private project can therefore ask any agent with
     the tool for that project's document and receive the full body.
   - The run surface's `getDocument`, `listDocuments` and `render` have the same gap for a run
     acting for such a viewer.
   - This is the ADR 0643 `KBC-4` class, one lane over: the guard sits on the HTTP exits and on
     the artifact projection's own copy (`host/artifactProjection.ts:248-262`), not on every exit.
5. **The current-version pointer can move backwards (`DOCWF2-4`).**
   - `addVersion` re-points the document with a blind put after its CAS insert (`:510-511`).
   - `updateDocument` is a read-then-put (`:360-388`).
6. **Agents can create but never revise (`DOCWF2-5`).**
   - Every agent write mints a new draft.
   - "Tighten section 3 of the SOW" produces a second document, and nothing makes the agent
     read the text it is changing.
   - The market bar (`docs/research/documents-best-in-class.md` §1.5 and §1.6 "generate-and-diff")
     is an edit checked against the version it was based on.
7. **Version history is a list of labels.**
   - The detail page lists version numbers and dates (`DocumentDetailPage.tsx:321-330`). A user
     cannot see an old version, compare it, or restore it.
   - §1.5 lists "version history w/ named versions + per-editor diff + non-destructive restore"
     as table stakes.
   - A diff projection already exists: `GET /artifacts/:id/diff` (`artifactRoutes.ts`,
     `host/artifactProjection.ts` `diffArtifact`) and `chat/artifacts/ArtifactDiffView.tsx`.
     The documents page does not use it.

## Boundaries audit

- **Single owners.** `documentsService` owns `documents:doc`, `documents:version` and
  `documents:template`. `sharingService` owns links and only calls `publicDocumentView`.
  `artifactProjection` owns the read/diff projection and stores nothing. Nothing in this ADR adds
  a store; D2 adds one field to `DocumentRecord`.
- **Diff and compare.** We reuse `diffArtifact` and `ArtifactDiffView`, not a second diff.
- **Read gate.**
  - Today there are three copies: `routes.ts:503` `assertOwnerReadable`, `artifactProjection.ts:257`,
    and the list filter at `routes.ts:100`.
  - D3 makes ONE predicate the owner and routes every exit through it.
- **Surface floor.** `FeatureSurfaceOrgPolicy.methodScopes` (`host/featureSurfaces.ts:69`) is the
  seam CMS and CRM used.
- **Routes.** The only new route segment is `POST …/documents/:id/versions` gaining an optional
  `baseVersionId`. No new path, so nothing can shadow.
- **Tools.** One new chat tool, `openwop:documents.revise`, registered beside the five existing
  ones (`agentTools.ts:41-46`) and allowlisted in the documents agent pack only. Per CLAUDE.md
  it is NOT added to the ADR 0315 default-on baseline.

## Decision

### D1 — one id owner: `createDocument` never writes over a row it does not own

- When a caller supplies `documentId`, read the raw row by id.
  - If it exists in the same (tenant, org), return it. This is the replay convergence callers
    rely on.
  - If it exists in a different tenant or org, throw `409 conflict` ("document id already in
    use"). The message carries no tenant or org data.
- The insert is `docs.compareAndSwap(null, doc)`. On a lost race, re-read and apply the same
  two-way rule. Random ids take the same CAS path.
- Every caller goes through `createDocument`, so this one change covers the surface, the tools,
  chat-export, strategy, priority-matrix and the seeder.
- **The seeder generator is fixed at the source.**
  - Ids become `doc:demo-cm-<h>-<slug>`, where `h` is a short stable hash of `tenantId:orgId`.
  - The skip check accepts both the legacy and the new id for this tenant, so a tenant that still
    holds its legacy rows does not get duplicates.
  - A tenant whose rows were taken simply reseeds under the new ids.
  - Rows that already moved are NOT migrated. Doing so would need prod data surgery, which the
    orchestrator sizes first (Open question 1).

### D2 — the approved version is what publishes

- New optional field `DocumentRecord.approvedVersionId`.
- **Pin.** Any `updateDocument` that sets `status` to `approved` or `final` pins
  `approvedVersionId = currentVersionId` of the row it compare-and-swaps.
  - This includes re-sending the same shareable status. "Approve the latest draft" is just
    approving again, still under the route's `host:members:manage`.
  - Approving a document with no version is `409` (nothing to publish).
- **Unpin.** Moving to `draft` or `in-review` clears the pin. The subject eraser's owner-demotion
  clears it too.
- **Serve.** `publicDocumentView` serves `approvedVersionId`'s content and `renderedMediaToken`.
  The projection gains `version` so the public page can say which version it shows.
- **Legacy rows (approved before this ADR, no pin) keep working; they do not go dark.**
  - `publicDocumentView` falls back to `currentVersionId` only while the row has no pin.
  - `addVersion` on a shareable row with no pin first pins the CURRENT version, in the same
    compare-and-swap that advances the pointer. The text that was public at deploy therefore
    stays public, and nothing written after deploy can publish without approval.
  - The residue: a legacy row whose CURRENT version was itself written after approval (before
    this ADR) keeps serving that text. That is today's exposure, unchanged and not widened.
    Open question 2 sizes it.
- **Retention.** The retention purger never deletes the approved version (the purger keeps
  `current ∪ approved`).
- **Exits checked for "approved content":** the share resolver (`validate`/`load`/`card`) is the
  only public exit. Authenticated readers keep reading the current version, which is correct:
  they are editors.

### D3 — one read gate on every exit, and writers at write tier on the surface

- **The predicate.** `canReadDocument(tenantId, doc, subject)` in `documentsService.ts`. It
  answers the existing D3′ rule: no `ownerSubject`, or a `null` resolver answer, means the org gate
  stands; otherwise READ is required.
- **Callers:**
  - every HTTP door that currently calls the local `assertOwnerReadable`, which becomes a thin
    wrapper;
  - the list filter;
  - `openwop:documents.get` — the hole;
  - `openwop:documents.revise` (D5);
  - `artifactProjection.authorizeDocument`, whose copy is deleted;
  - the run surface's `getDocument`, `listDocuments`, `addVersion` and `render`, whenever the run
    has a person (`actingUserId ?? orgScopeSubject`). The ADR 0832 rule applies: a run with no
    person stays tenant-trusted.
- **Ratchet.** A source scan over `features/documents/**` and `host/artifactProjection.ts`: every
  module that imports `getVersion` from the documents service must also import `canReadDocument`.
  Its sabotage witness is removing the import from `agentTools.ts`.
- **Surface writers.** `orgPolicy.methodScopes` names `createDocument`, `createDraftDocument`,
  `addVersion` and `render` at `workspace:write` (`render` writes a library asset, and its door is
  write). A closed-world partition test classifies every surface method as a read or a writer,
  so a new writer cannot ship at the read default. This mirrors ADR 0837 D2.

### D4 — the pointer only moves forward, and PATCH is a CAS

- `addVersion`'s pointer update becomes a compare-and-swap retry loop that sets
  `currentVersionId` only if the new version number is higher than the stored pointer's. It never
  regresses, and it merges into the FRESH row, so a concurrent title or status change survives.
- `updateDocument` becomes a CAS retry loop on the row it validated. The status-transition check
  and the D2 pin are evaluated against that same row.
- The witness uses a deterministic interleave: a storage hook that pauses one writer between its
  read and its swap. `Promise.all` over the in-memory store serialises and proves nothing.

### D5 — `openwop:documents.revise`: an agent edit checked against what it read

- **Input:** `{ documentId, baseVersionId, content, note? }`.
- **Gate:** toggle, then acting user, then `workspace:write` in the document's org, then
  `canReadDocument`. Every refusal is the uniform `not_found` the get tool uses.
- **Precondition:** `baseVersionId` must equal the document's `currentVersionId`.
  - Enforced ATOMICALLY by inserting `${documentId}:${baseVersion+1}` with insert-only-if-absent
    and NOT retrying at n+1. A concurrent writer therefore makes the revise fail; it never lands
    on top of text the model did not read.
  - On failure the tool returns a typed `stale_base` error carrying the current version id and
    telling the model to call `openwop:documents.get` again. That is the one bounded repair the
    loop already feeds.
- **Why `baseVersionId`:** it is returned ONLY by `documents.get`, which now includes
  `currentVersionId` and `version`. So read-before-write is structural, not prompted.
- **Idempotency:** a run-scoped call keys the version on a hash of
  `(runId, toolId, documentId, baseVersionId, content)`, so an exact retry returns the version
  it already wrote.
- **Approved documents** may be revised. D2 keeps the published text until an approver
  re-approves, and the tool result says so ("published version stays vN until re-approved").
- **Same precondition over HTTP:** `POST …/versions` accepts the same optional `baseVersionId`.
  The detail page sends it, so two people saving at once get a `409 stale_base` and a "someone
  saved a newer version" notice instead of a silent overwrite.
- **Packs:**
  - `vendor.openwop-app.documents.agents` 1.0.3 → 1.1.0: document-author allowlists `revise`
    and its prompt names the read-then-revise order.
  - `document-reviewer`'s description is corrected; it claims list-grounding it has no tool for
    (`DOCWF2-8`).
  - `requiredPacks` pin bumped.
  - The prompt↔tool-id parity test covers the new id.

### D6 — version history you can use (frontend)

- Each row of the history list gains three actions:
  - **View**: read-only markdown preview of that version.
  - **Compare with current**: the existing `ArtifactDiffView`, fed by
    `GET /artifacts/document:<id>/diff?from=&to=`.
  - **Restore**: non-destructive. It saves the old content as a NEW version with
    `baseVersionId = current`, so history is never rewritten.
- A **"Published: vN"** chip shows when a pin exists. When `approvedVersionId ≠ currentVersionId`,
  a notice reads "The shared link shows vN. Approve the latest version to publish it."
- Lazy-loaded (the entry-chunk budget is ~300 bytes), four locales, token-only styles.

## Alternatives weighed

- **D1: tenant-qualify the storage key** (`${tenantId}:${documentId}`). This is the deeper
  structural fix, but it re-keys every row and every `documentId:n` version key, and every
  by-id lookup (`locate`, the artifact projection, launch-studio) would need a tenant-prefixed
  scan. Rejected for now: one owner-checked CAS writer closes the hole at the only write site.
  Recorded so a future store migration takes it.
- **D2: demote to `in-review` on any new version.** This is simpler, but every edit to a live
  SOW would make its public link go dark. Pinning matches Confluence and Docs ("the published
  version stays until you publish again"). Rejected.
- **D2: fail closed for legacy approved rows.** Every published document would go dark at
  deploy. Rejected for the write-time grandfather pin.
- **D5: a `documents.update` tool with no precondition.** This is the lost-update and
  write-without-reading shape that CLAUDE.md's "agents read before they write" forbids. Rejected.
- **D6: build a documents-specific diff.** This is the parallel-architecture shape. Rejected for
  the existing projection and view.

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | All within `features/documents/**`, plus one host edit (`artifactProjection` calls the feature's predicate; this import edge already exists) and the seeder. No core route or nav edits. |
| 2 | Toggle | `documents` unchanged (ON, tenant). |
| 3 | `ctx.documents` | Writers at write tier (D3), and person-scoped reads (D3). No new methods. |
| 4 | Node pack | `feature.documents.nodes` unchanged at 1.3.2, apart from the prose fix in `DOCWF2-6`. If that fix ships it is a patch bump, 1.3.3, listed in the ready message. |
| 5 | Envelopes | None. The tool lane carries the work (CLAUDE.md three lanes). |
| 6 | Agent pack | `vendor.openwop-app.documents.agents` 1.1.0 (D5). |
| 7 | Public surface | The share projection serves the pinned version (D2). No new public path. |
| 8 | RBAC | One read predicate on every exit (D3). Write tier on surface writers (D3). Approval stays `host:members:manage`. Revise needs `workspace:write` plus read. |
| 9 | Replay / fork | Revise is id-deterministic per run (D5). The D1 CAS keeps replay convergence. The pin is data, not run state. |
| 10 | Frontend | D6. Lazy chunk, four locales. |

**RFC verdict:** host-extension only. No run-event field, capability, or endpoint contract
changes.

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1, D2, D4 in the service, plus the seeder | `adr0838-documents-store-integrity.test.ts` (RED on `764883b6c`) |
| P2 | D3 predicate, all exits, `methodScopes` and partition | `adr0838-documents-read-gate.test.ts` (tool and surface leak RED first) |
| P3 | D5 tool, pack 1.1.0, and HTTP `baseVersionId` | `adr0838-documents-revise.test.ts` |
| P4 | D6 frontend | `DocumentDetailPage` tests |

## Open questions

1. **Prod reach of `DOCWF2-1`.** How many `doc:demo-cm-*` rows, in which tenants, and with
   versions in more than one tenant? This decides whether a one-off repair is owed. It needs the
   orchestrator's read-only queries; asked 2026-10-06.
2. **Prod reach of `DOCWF2-2`.** How many approved or final documents have more than one version,
   so that the public text may differ from what was approved? This is the size of the legacy
   residue the grandfather pin cannot know about.
3. **Product decision for the user:** an edit to an approved document no longer changes the
   public page until someone with `host:members:manage` re-approves. Before this ADR, it changed
   at once. Default: adopt, because it is the security fix.

## Architect pass (2026-10-06, before code) — corrections to the decision text

Track A. Each finding was checked against the code at `764883b6c`. The decisions above stand
as amended by these notes; the original text is kept so the reasoning trail survives.

**A1 (Blocker, authz / approve-what-you-see) — D2 as written pins a version the approver never
saw.**
- "pins `currentVersionId` of the row it compare-and-swaps" means: open the document, read v3,
  and while you read, a writer saves v4. Your Approve then publishes v4.
- That is the exact failure ADR 0473's `expectedDefinitionHash` exists to stop.
- **Correction.** PATCH accepts an optional `approvedVersionId`, and the detail page always sends
  the version on screen.
  - When it is supplied, the server pins THAT version. It must be a version of this document,
    else `400`. It need not be the latest, which also gives approvers "publish v3", a rollback of
    the public text.
  - When it is absent (API clients from before this ADR), the server pins the current version as
    D2 said. That is no worse than today and is recorded as the API's default.

**A2 (Blocker, data integrity) — D4's "the pointer only moves forward" is false while other blind
writers exist.** Besides `addVersion` and `updateDocument`, `docs.put` is called by
`clearPromotedCanvasRefs` (`documentsService.ts:301`) and by the subject eraser
(`erasure.ts:97`, which has its own `DurableCollection` over the same `documents:doc` keys). Either
can land a stale row over a concurrent pointer advance or a D2 pin.
- **Correction.**
  - Every `documents:doc` writer after insert is a CAS retry loop, through ONE helper
    `mutateDocument(id, fn)` in the service. The eraser imports it rather than writing through its
    own collection.
  - A source ratchet forbids `docs.put(` / a second `'documents:doc'` collection outside
    `createDocument`'s insert.

**A3 (~~Blocker~~ → Improvement, authz at the exit; CORRECTED during implementation) — the share MINT publishes text the minter cannot read.**

> **CORRECTED 2026-10-06 (implementation).** Mint needs `workspace:write`, and `projectsService.levelFor` gives `'write'` to every `workspace:write` holder before it looks at visibility. So with the shipped resolver, the gate refuses only a document whose owning project has been deleted, the same population the `DOCWF-4` decision describes. It is still implemented, so the mint stays consistent with every other exit and a future stricter resolver applies to it automatically, but it is NOT a reachable Blocker. The reachable exit Blocker of this class was `documents.get` (`DOCWF2-9`).

- The `document` resolver's `validate` ignores the `caller` that `createShareLink` passes
  (`sharingService.ts:341` vs `:781`).
- So an org writer who is not a member of a private project can mint a public link to that
  project's approved document, publishing content the GET door 404s for them.
- This is the same class as D3 and the same fix: `validate` calls `canReadDocument` with the
  minter. Add it to D3's exit list, and witness it RED first.

**A4 (Improvement, consistency with the recorded `DOCWF-4` decision) — D3 must not gate the
surface `addVersion` on owner READ.**
- `routes.ts:205-235` records why the HTTP write doors are deliberately NOT owner-gated: the only
  refusable population is documents whose owning project was deleted, and gating would strand them.
- Gating the run lane's `addVersion` would contradict that decision for no reachable attacker.
- **Correction.**
  - The surface gates READS (`getDocument`, `listDocuments`, `render`, whose output is a durable
    token of the body) on `canReadDocument`.
  - `addVersion` and `createDocument` take only the write tier.
  - `documents.revise` still gates on read, because it is the read-then-write tool and its base
    came from a gated read.

**A5 (Improvement, residue) — collided legacy rows leave orphan versions.**
- Where `DOCWF2-1` already fired, the losing tenant's version rows (`doc:demo-cm-<slug>:1`, …)
  stay under its tenant id with no parent it can see.
- They are reachable by nothing. Tenant teardown purges them by `tenantId`, and the retention
  purger ages them out as non-current.
- A `revise` on the winner's row can meet a foreign version at `n+1` and refuse forever. That is
  acceptable: `addVersion` still advances, and the count is Open question 1.

**Checked and holding:**
- D1's 409 does not leak a usable oracle, because every legitimate id is a random UUID or a hash
  that includes a run id or tenant id.
- ~~D2's public exit is ONLY the share resolver (`publicDocumentView` has one caller).~~ **FALSIFIED by grade-code (`DOC2CD-1`).** The CRM e-sign document target sent a document's CURRENT text to an outside signer, re-read on every view, and it skipped the read gate. It is fixed: the requester is read-gated and the request pins `target.versionId`. The podcast public transcript is a third public exit (`DOC2CD-4`, filed against podcasts). The lesson: "one caller of the projection" was a fact about a FUNCTION, not about the exits. The ratchet now scans every importer of the service.
- The launch-studio resolver returns title and status, never content.
- The D5 precondition is atomic, because `${documentId}:${n}` is insert-only-if-absent.
- `artifactProjection` already imports the documents service, so D3 adds no new edge.

## Corrections from the grade passes (2026-10-06)

- **D5 compared the base with the POINTER (`DOC2CD-2`).** A version row is inserted before the
  pointer moves, so a pointer can lag its newest row. A check against the pointer refused every
  checked save forever. The base is now checked against the NEWEST row, and a lagging pointer is
  healed forward first.
- **D2's no-version default (`DOC2CD-3`).** Re-sending a shareable status (approved → final) with
  no version pinned the current version, so finalising silently published newer text. Now a
  document that is already published keeps its pin unless a version is named. "Approve latest"
  names it.
- **Approving an empty document is refused (`409 no_content`).** This was not in D2's text. It
  follows from "approval pins a version". It is a user-visible change, listed below.

## Product decisions for the user to confirm

1. An edit to an approved/final document no longer changes its public share page until someone
   with `host:members:manage` approves again ("Approve latest version"). Before, it changed at
   once.
2. Approving or finalising a document with no saved content is refused.
3. Finalising an approved document keeps the version that was approved; it does not publish newer
   drafts.
4. The detail page no longer offers status moves the server refuses, or writes to a member
   without write access (read-only editor + notice).
5. A CRM e-sign request on a document is read-gated for the requester. The signer page shows the
   exact version that was requested, never text saved afterwards. Signing still re-reads the live
   document, so an edit since the request still voids the signature (`content_changed`), as the
   e-sign design intends.
6. Saves are checked: two people saving the same document at once get "Someone saved a newer
   version", where before the second save silently became the newer version.

## Implementation record

| Phase | Decision | Commit | Witness |
|---|---|---|---|
| P1 | D1, D2, D4, the seeder | `fix(documents): one id owner, approved-version pin, forward-only CAS pointer` | `adr0838-documents-store-integrity.test.ts` (D1 and D2 RED on `764883b6c`); `demo-content-marketing-seed.test.ts` two-tenant case RED |
| P2–P3 | D3, D5 | `fix(documents): one read gate on every exit, surface writers at write tier, checked documents.revise` | `adr0838-documents-read-gate.test.ts` (each gate sabotaged RED) |
| P3 | D5 packs | `feat(documents): documents.revise in the author pack, prose + census fixes` | census tables, `agent-prompt-tool-ids` |
| P4 | D6 | `feat(documents): version history view/compare/restore, checked saves, approve-what-you-see` | `documentVersionHistory.test.tsx` |
| grade-ux | `DOC2UX-1..8` | `fix(documents): grade-ux row 24 — announced errors/saves, …` | same file |
| grade-code | `DOC2CD-1` | `fix(crm): e-sign document target is read-gated and pins the requested version` | read-gate e-sign case + widened ratchet (both sabotaged RED) |
| grade-code | `DOC2CD-2`, `-3` | `fix(documents): checked saves compare against the newest version …` / `finalising keeps the published version` | store-integrity H2 + final-pin cases (sabotaged RED) |

Commits are cited by subject, because the shas move on rebase (the ADR 0826 lesson).

**Packs changed:**

- `vendor.openwop-app.documents.agents` 1.0.3 → 1.1.0
- `feature.documents.nodes` 1.3.2 → 1.3.3 (prose only)

Both pins are bumped in `documents/feature.ts`, and `packs/.steward-manifest.json` is regenerated.
