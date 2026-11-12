# ADR 1036 — Job search: subject and org truth

Status: implemented (2026-11-03; accepted after an adversarial `/architect` pass the same day)

Feature loop round 2, row 81. Extends the job-search vertical (ADRs 0539–0546); toggle
`job-search` unchanged. Findings: `docs/steward/workflows-assessment/2026-11-03-job-search-row81.md`.

## Context

The vertical holds one person's job search inside a workspace that may have several members.
ADR 0545 and DG-SEC-1 set the rule that a job search is sensitive inside a workspace: a peer
must not learn of a colleague's search, and an admin must never read an employee's salary
expectation. The row-81 grade (`origin/main` @ `0a3da6141`) found that rule kept by the
answer bank and the grants list, and broken by six other doors:

| Id | Door | What it does today |
|---|---|---|
| JS81WF-1 | `career.campaign` → `runCampaignPass` | Iterates **every** live grant in the tenant (`campaignRun.ts:252,263`) and returns each grant's id, campaign id and applied listings in the run output (`surface.ts:131-141`). The chain is same-id registered and gallery-visible, so any member can start it directly; the header's "no direct run-it-now route" (`campaignRun.ts:7-11`) is false. |
| JS81WF-2 | `ctx.features['job-search'].recordOutcome` | The ADR 0832 floor checks membership at `workspace:read` for every method (`featureSurfaces.ts:203`), so a read-only member's run moves deal stages. The header (`surface.ts:19-21`) claims the org "comes from the run's own scope"; `BundleScope` carries no org. |
| JS81WF-3 | `applyToListing` | Submits (`pipeline.ts:222`) then consumes the grant unit (`:233`), dropping the boolean, against `applyGrant.ts:301-305` ("consume BEFORE the work"). Two passes on a `maxSubmits:1` grant both send. Latent: no board has a submit lane. |
| JS81C-1 | `GET/DELETE …/attestations` | Lists every attestation in the TENANT (`routes.ts:211`, `token.ts:271`, documented as "the applicant's own list"); any writer revokes any. |
| JS81C-2 | `DELETE …/grants/:id`, `queue-campaign` | Revoke checks org, not person (`applyGrant.ts:422-428`); queue accepts any member's live grant (`provision.ts:117`). |
| JS81D-1 | subject erasure | The CRM eraser keeps deals as business records and does not touch them; job-search registers no deal eraser, so the applicant's application deals (`owner`/`createdBy` = them, "Title — Company") survive a DSAR. |
| JS81D-2 | steering | One row per tenant (`steering.ts:77-81`): any org's writer reads another member's career `goals` and overwrites the campaign policy; the eraser keys on `updatedBy`, so goals written by A and carried forward under B's edit survive A's erasure. |
| JS81WF-5 | `listings.read` tool | Skips the org gate its route applies (`agentTools.ts:66-72` vs `routes.ts:350`). |
| JS81WF-4 | career persona | Promises scoring, preparing, drafting and quoting postings; the agent holds two read tools and the listing tool returns no posting text. Steering `goals` claim to be agent context; nothing composes them. |

Production (read-only, 2026-11-03): toggle `beta`; 2 answer rows and 1 pipeline binding in one
tenant; 2 campaign cards; **0** listings, job deals, career runs, grants, attestations and
steering rows. Every defect above is latent in production today. There is no data to migrate.

## Boundaries audit

- **The person behind a run** already has one resolver: `scope.actingUserId`, else
  `scope.orgScopeSubject` (`accessControlService.ts:723` `runOrgScopeSubject`). Heartbeat runs
  carry neither (`heartbeatService.ts:326-348`); they do carry `run.metadata.heartbeat.cardId`,
  and the claimed card carries `lastRunId` = this run's id (ADR 0774 D2 `claimCardForRun`) and
  `createdBy` = the member who queued it. That pair is host-written and cannot be forged by a
  run starter: `lastRunId` is stamped by the claim CAS, not by the caller.
- **The org floor** is ADR 0832's `FeatureSurfaceOrgPolicy.methodScopes`
  (`featureSurfaces.ts:61-77`); CRM declares its writers there (`crm/surface.ts:136-139`). No
  new seam.
- **Erasure** rides `registerSubjectEraser` (the answer-bank precedent, `answerBank.ts:270`) and
  CRM's `deleteDeal` (`crm/entities/deals.ts:528`), whose delete cascade already removes the
  job-search digests, drafts and follow-ups (`lifecycle/crmCascade.ts`). No change to the
  erasure machinery or its manifest format; the coverage test gains rows.
- **Tool access** reuses the applications tool's twin `resolveReadOrgScope`
  (`agentTools.ts:111`).

## Decision

> **Corrected before code (adversarial `/architect` pass, 2026-11-03).** The first draft
> anchored D1 on `card.createdBy` + `card.lastRunId`. Both halves failed review: `createdBy`
> is copied from the request body by the generic kanban routes (`routes/kanban.ts:634,716`),
> so any board writer can name a colleague; and the default `review`-autonomy lane starts the
> run from `approvalDecision.ts:756-773` with `metadata.approval` (not `.heartbeat`) and stamps
> `lastRunId` only after the start, so the check either always failed or raced. The draft also
> missed that application deal ids were `deal:<listingId>` — one deal per listing per org, not
> per person — which made D3's refund and D5's erasure act on a colleague's deal. Each is
> corrected below; the draft text is not kept.

**D1 — A campaign pass acts for exactly one person: the run's.** The subject is
`scope.actingUserId` when present (a member who starts the chain directly acts under their
own grant — the grant is the ADR 0541 authority object, so this is their consent, not a
bypass). Otherwise it is read from a **feature-owned queue row** (`job-search:campaign-queue`,
key `<tenantId>:<cardId>`) that only `queueCampaignCard` writes, insert-if-absent, with the
authenticated caller as `subjectId`. The card id comes from the run's host-written
`metadata.heartbeat.cardId` or `metadata.approval.cardId` — both stripped from caller-supplied
metadata (`runDispatch.ts` `stripCallerAttribution`). A fork resolves through its root
(`parentRunId`, bounded 64, same tenant). `orgScopeSubject` (the approver, on the approval
lane) is **never** the campaign subject. No subject ⇒ a typed `forbidden_scope`
(`reason: 'no_campaign_subject'`), never an empty success; that includes the kanban
trigger-column lane, which carries neither. The pass runs only that subject's grants and reads
that subject's steering. The node's report carries **counts only** (no grant id, no free-text
campaign id, no listing ids), because run output is tenant-readable. The `campaignRun.ts` and
`surface.ts` headers are corrected.

**D1b — Queuing is per person.** `queueCampaignCard` requires a live grant of the caller's, and
its dedupe matches a pending card whose queue row names the caller — B's request no longer
returns A's card.

**D2 — The surface declares its writer.** `JOB_SEARCH_SURFACE_POLICY = { methodScopes:
{ recordOutcome: 'workspace:write' } }`, registered via `surface.orgPolicy`. A system run with
no person stays tenant-trusted, the floor's rule for every surface. The false header is
replaced with what the floor does.

**D3 — Application deals are per person.** The pipeline mints
`deal:<sha256(subjectId)[0..16]>:<listingId>`. `createApplication` refuses an existing deal
created by someone else (`existed` is returned only for the caller's own deal), and the manual
`POST …/applications` maps that refusal to 409 rather than echoing a colleague's application.

**D4 — Spend before the send.**

> **Corrected after the independent `/grade-code` pass (2026-11-03).** As first written, the refund
> row was the only thing that voided a refused send's consumption, so a refund that lost its CAS
> races (or a crash between the board's answer and the refund) left an application the employer
> never received attestable as sent. The pipeline now writes a `job-search.submission.rejected` row
> naming `{grantId, dealId}` BEFORE the refund, and `sentConsumptions` voids on either row. The same
> pass found that a deal minted for a send that never went out (grant refused at the consume CAS, or
> board rejection) stayed in the first stage, "Applied"; it is now withdrawn through `deleteDeal`.
> D7's "no legacy fallback" was also refined: a legacy row is adopted by its LAST AUTHOR only (so a
> tightened policy does not silently loosen for them) and deleted on any erasure in the tenant.
> The takeover handles only PRE-EXISTING legacy rows: if one is erased before its author reads it,
> that author gets the default policy (filed `JS81D-4`; unreachable on this host, which held 0 such
> rows). The SPA has no preferences screen; steering is API-only (filed `JS81U-3`).

 The pipeline consumes the unit after the claim and the deal and
BEFORE `submit`; `false` ⇒ release the claim, `refused: 'grant-exhausted'`. Only an explicit
board rejection (`sent.ok === false`) refunds, through a new `refundSubmit(tenantId, grantId,
dealId, consumedAt, now)`: CAS-decrement `submitsUsed`, and `paceUsed` only when `paceHour` is
still the consumption's hour (otherwise the refund would add capacity to a later hour), then a
`job-search.grant.refunded` audit row naming `{grantId, dealId}`. A throwing `submit` is an
unknown outcome and the unit stays spent. The attestation readers (`buildClaimSet`,
`findAttestableApplication`) walk the hash-chained audit log in order and treat a consumption
as void when a refund for the same `(grantId, dealId)` follows it before any newer consumption.
The computer-use lane already consumes first and is unchanged.

**D5 — Attestations and grants are the person's own.** `GET …/attestations` lists the caller's
(`issuedBy`); `DELETE` requires `issuedBy === caller` (same 404 as not-found). The ADR 0820
admin export keeps the tenant-wide read under a distinct name (`listAllAttestations`) — it is
the admin-class portability door that already exports the workspace's applications.
`revokeApplyGrant` additionally requires the caller to be the grant's `subjectId` or
`grantedBy`.

**D6 — Erasure removes the person's applications.** A job-search subject eraser enumerates the
tenant's orgs (`collectPerOrg`) and each org's application pipeline (read-only lookup, which
also finds legacy name-bound pipelines), and deletes, via `deleteDeal`, the deals in that
pipeline whose `createdBy` is one of the subject's key forms — the applicant, not whoever the
deal was later reassigned to. The delete cascade removes digests, drafts and follow-ups. The
eraser is listed in `host/subjectEraserManifest.ts`; the CRM eraser never rewrites deal
`createdBy`, so order does not matter. The job-search pipeline exists to hold applications; a
deal in it is the applicant's application, which the CRM "keep the business record" rule does
not cover.

**D7 — Steering is per person.** Key `<tenantId>:<subjectId>`; the routes read and write the
caller's row; the pass reads the subject's. **No legacy fallback**: a tenant-keyed row would
leak one member's `roles`/`locations`/`goals` as everyone's defaults. Production holds 0 rows.
The eraser deletes the subject's row and any legacy tenant row that names them.

**D8 — The listings tool shares its route's gate**, via `resolveReadOrgScope` as the
applications tool does. Listings are tenant-wide data (one board feed per workspace); the org
gate proves membership, as on the route. Parity, not narrowing — stated, not implied.

**D9 — The persona says what it can do.** `career-agent.md`, both `pack.json` descriptions and
the roster description (`provision.ts:66`) are corrected to the two read tools and the
grant/campaign controls. The `steering.ts` "available to the agent as CONTEXT" claim is
corrected. Agents-pack version bump, `packPins.ts`, steward manifest.

**Applications stay workspace-visible (ADR 0546).** The applications list, funnel, follow-ups
and drafts remain org-scoped as ADR 0546 decided ("the WORKSPACE's applications"). This ADR
makes the AUTHORITY objects per person (grants, attestations, steering, campaign passes,
erasure). Lead decision 2026-11-03 (option A): overturning ADR 0546 is the user's call, not this row's.

**D10 — Say so.** Because applications are workspace-visible, the applications page states it
plainly, in all four locales, where a candidate adds an application: "Applications in this
workspace are visible to its members." A candidate should not learn it by surprise.

## Open question for the user

**Should a peer be able to see a colleague's applications?** DG-SEC-1 (`routes.ts`, grants list:
"a job search is sensitive inside a workspace") and ADR 0546 ("the WORKSPACE's applications")
disagree. Option A (shipped here): workspace-visible lists, per-person authority objects, a
disclosure. Option B: filter the applications list, funnel, follow-ups, drafts, the applications
tool and the surface's `listApplications` by applicant (`createdBy`) — about +600 changed lines
and FE copy. The coach-plus-candidate workspace favours A; a shared team workspace favours B.

## Alternatives weighed

- **Stamp `actingUserId` on heartbeat runs from the card creator.** Fixes D1 at the root for
  every agent, but changes the authority of every heartbeat run in the host (member-scoped
  narrowing, tool gates) — a shared-seam change outside a single-feature row. Rejected here;
  filed as a question for the heartbeat owner.
- **Hide `career.campaign` (`internal: true`) and refuse direct runs.** Leaves the cross-subject
  pass in place for the card lane (a card any member queued would still run everyone's grants).
  D1 fixes the cause; hiding would only hide it.
- **Keep the unit spent on board rejection (no refund).** Simpler, but then the attestation must
  still learn the send failed; a refund row serves both.
- **Anonymize application deals instead of deleting.** Leaves "Title — Company" history, which
  is the personal datum. Rejected.

## Deferred / filed (with reasons)

- `JS81D-3` retention for attestations, steering, parked questions, grants and claims: a
  retention period for personal data is a user decision; filed with a recommendation (expired
  grants and their claims 90 days after expiry; steering with the answer-bank window).
- `JS81WF-6` clearance/citizenship assumed met on the autopilot path: a product call (park the
  question vs. assume); latent until a submit lane exists. Filed.
- Making the persona's promised capabilities true (scoring/drafting tools) is product work.

## RFC verdict

Host-extension only. No wire facet changes: the surface policy, the routes under
`/v1/host/openwop-app/*` and the erasure seam are all host-internal.

## Phased plan

| Phase | Scope |
|---|---|
| P1 | D1 + D1b + D2 + D3 + D4 (workflow lane and the submit pipeline), surface/pipeline witnesses |
| P2 | D5 + D7 + D8 (doors), route-level witnesses; D10 disclosure (FE, 4 locales) |
| P3 | D6 erasure + manifest entry; D9 copy + pack bump |

## Implementation record

| Phase | Commit | Witness |
|---|---|---|
| P1–P3 (D1–D8) | `05f81cc36` | `test/adr1036-job-search-subject-truth.test.ts`, `test/adr1036-job-search-surface-floor.test.ts` |
| D9/D10 user-visible | `8222c2caa` | `test/career-agent-provision.test.ts` |
| `/grade-code` + `/grade-ux` fixes | `9b33b3e6f`, `83cb259ed` | the same two files; `frontend/react/src/features/job-search/__tests__/workspaceVisibility.test.tsx` |
| second-round fixes (canonical ids, `mine`, used-up grants) | `ba308403f`, `775c3e0e6` | `adr1036-*` (legacy-spelling cases); `__tests__/ownershipAndStatus.test.tsx` |

30 sabotages, each applied, run and reverted in one step, all red. No migrations: production held 0
job-search deals and 0 steering rows (read-only measurement, 2026-11-03), so the per-person deal id
and steering key change nothing that exists there.
