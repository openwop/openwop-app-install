# ADR 0589 — twin tenancy and borrowed-recall audience

Status: Accepted

Supplements (does not supersede) **ADR 0044** (twin cross-subject recall). Carries the
correction note ADR 0044 §Context needs. Related: **ADR 0508** (the org-scope
HOME-vs-ACTIVE family), **ADR 0015** (shared `ws:` workspaces), **ADR 0042** (personal
knowledge is home-tenant by design; GC-7 / #2805).

## Context

The 2026-08-20 three-lane steward assessment of feature 17 (Personal Knowledge & Memory /
digital twin) found one root defect three ways — `TWIN-2` = `TWIN-UX-2` = `WF-TWIN-1` — plus
a second, independent one, `TWIN-1` = `WF-TWIN-6`. Both are decisions, not patches, so they
were routed through the `/architect` options-evaluation mode before any code moved.

Two facts constrain everything below and were verified against `origin/main` rather than
assumed:

1. **The twin LINK is workspace-shaped; the owner's CORPUS is person-shaped.** The link hangs
   off a roster agent (`host/twinService.ts:67` → `getRosterEntry(tenantId, agentId)`), which
   lives in whatever workspace the agent was created in. The owner's memory notes are keyed
   `${tenantId}:${scope}:${id}` under `user.tenantId` (`features/profile-memory/routes.ts:52`),
   and the owner's `Profile` row — which holds `knowledge.collectionIds` — is keyed by
   `userId` **alone** with `tenantId` as a stamped fail-closed check
   (`features/profiles/profilesService.ts:121,315-318`). A `Profile` therefore exists in
   exactly ONE tenant: the person's home tenant. This is the ADR 0042 / GC-7 by-design
   scoping and is **not** re-litigated here.
2. **`resolveBorrowedRecall` is called with the DISPATCH (active) tenant on all three lanes** —
   `routes/agents.ts:328`, `host/agentRunnerNode.ts:166`, `host/chatContext.ts:249`. So any
   grant keyed under a home tenant can never authorize anything, independent of whether it can
   be issued.

## D1 — the tenancy unification

### Forces

- **Single source of truth for "may this agent recall this person".** One grant row, one tenant,
  one revocation.
- **The tenant a handler is AUTHORIZED in must be the tenant it READS AND WRITES in** — the
  ADR 0508 §Phase 2 rule, written into `features/featureRoute.ts:209-218`.
- **The corpus is home-tenant by design** and must stay so (GC-7). The prune-on-read at
  `profileKnowledgeService.ts:94-96` makes a naive widening of *that* service a data-loss
  machine.
- **`GEN-TWIN-1` ordering**: fix the derivation before relaxing anything that currently
  fail-closes, or mint undeletable PII in the wrong partition (ADR 0508's migration 19).

### Options scored

| | (a) both ACTIVE | (b) both HOME | (c) grant keyed under BOTH |
|---|---|---|---|
| Grant issuable in `ws:` | **yes** | no — `getRosterEntry(HOME, agentId)` is `null`, so the LINK itself cannot be created | yes |
| Grant reachable by `resolveBorrowedRecall` (reads ACTIVE) | **yes** | **never** | yes, via the ACTIVE copy |
| Single source of truth | **yes** | yes | **no — two rows, two revocation paths that drift** |
| Cost now | change 4 call sites in `features/twin/routes.ts` | rewrite the admin lane too | a fan-out write + a fan-out revoke + a reconciler |
| Debt left | the corpus read still needs its own answer (below) | dead feature | permanent |
| Reversibility | high (no rows move — see below) | n/a | low |

**(b) is not merely worse, it is non-viable**: the LINK is written through
`getRosterEntry(tenantId, agentId)`, so under HOME there is no agent to link to. **(c)** loses
the invariant the whole feature rests on. 

### Decision D1

**(a) — both halves read the ACTIVE tenant**, `tenantOf(req)`, with `user.userId` taken as the
SUBJECT only. This is literally the ADR 0508 precedent at `featureRoute.ts:209-218`.

**Sub-decision D1b — the corpus read.** The grant now resolves, but `borrowedRecall.ts` would
still compose an EMPTY corpus in a shared workspace (`WF-TWIN-4`), because it builds
`createSubjectMemoryPort(tenantId)` and `getProfile(tenantId, …)` from the dispatch tenant while
the corpus lives in the owner's home tenant. Reporting that as success is the fabrication shape.
We therefore **resolve the owner's HOME tenant explicitly, once, from the durable `User` record
(`getUser(link.userId).tenantId`) and read the corpus there.**

This is safe in the way the GC-7 ruling requires:

- The recall lane calls the **read-only** `profilesService.getProfile`, never
  `profileKnowledgeService.getProfileKnowledge` — so the prune-on-read write path is **not** on
  this lane, and widening here cannot destroy bindings. (Verified: `borrowedRecall.ts:49`.) The
  prune itself is separately hardened in this batch — it now prunes only when the collection
  listing is authoritative, never when the read failed (`TWIN-UX-10`).
- The read is authorized by the owner's own consent grant, resolved in the ACTIVE tenant. It is
  a person reaching their own corpus through an agent they authorized, not a tenant reaching
  another tenant's data — the CTI-1 concern ADR 0044 §"Cross-tenant twin" names is a *different*
  agent living in a *different* organization's tenant, which stays out of scope.

### Migration — and why there is none

ADR 0508's migration 19 exists because its equivalent 404 was removed **before** the derivation
was fixed, minting rows in a partition nothing could read or reclaim. **That cannot happen here,
and the reason is structural, not lucky:** the 404 at `twinService.ts:111-114` is inside
`grantTwin` itself, *before* the `grants.put`. Every write path was gated by it —
`grantTwin` is the only site that mints a row, `revokeByOwner` / `clearTwinGrantsForAgent` /
`eraseSubjectTwinGrants` only modify or delete existing ones. So **no grant row has ever been
written under a home tenant that differs from its agent's tenant**; in the single-tenant and
personal-workspace shapes, home *is* active and every existing key is already correct.

**We therefore do NOT remove or relax that 404.** It is a genuine authorization check ("you are
not the person this agent is linked to"), and the `GEN-TWIN-1` ordering constraint is satisfied
*vacuously* — the fix changes the CALLER's tenant derivation, so the guard keeps both its
meaning and its fail-closed position. This is a correction to the batch brief, which assumed the
404 had to be removed second.

`tenantOf` is nevertheless added to the `twin-grant` `DurableCollection`
(`twinService.ts:49`) in the same change, so an indexed reclaim/retention path exists at all
(`WF-TWIN-8`) — today it does not, which is what makes a mis-partitioned row unrecoverable
rather than merely wrong.

## D1c — the DSAR fan-out (`WF-TWIN-3`), with a corrected diagnosis

The tracker's `WF-TWIN-3` reads: *"a DSAR fan-out from a shared workspace erases none
of this feature's data and durably records `erasure_complete`."* Both halves were
checked. **Only the second half is a defect.**

**The first half is CORRECT behaviour and must stay.** A candidate fix — expand the
fan-out over the subject's HOME tenant, resolved from the `User` row — was built and
run. `test/pii-erasure-retention.test.ts:66` caught it immediately as a **cross-tenant
destructive escalation**: `subjectKey` is caller-supplied on
`DELETE /consent/orgs/:orgId/subjects/:subjectKey`, so any workspace admin could have
named any user id and wiped that person's personal-tenant data across every *other*
workspace they belong to. Tenant isolation (CTI-1) outranks fan-out completeness, and
the guard that stopped it was already in the suite. The expansion was reverted; the
`SubjectTenantResolver` seam it needed was deleted rather than left as dead code.

**The second half is the real defect, and it is fixed.** `failed === 0` was the entire
success test, and it is satisfied by a fan-out that matched nothing: every eraser is
individually correct and tenant-scoped, so handing them a tenant the data does not live
in makes each one a silent, honest no-op. Erasers may now report `rowsTouched`
(optional and additive — a non-reporting eraser is simply not counted), and a fan-out
where reporting erasers touched **zero** rows sets `foundNothing`. Consent then records
`reason: 'erasure_no_data_found'` instead of `'erasure_complete'`, and
`subject_erasure_zero_rows` logs. `outcome` stays `allow` — nothing was refused, and a
subject with genuinely no data is a real case. What is no longer possible is the
governance chain asserting a completed erasure over data nothing reached.

### A third defect, found only by building the witness

`eraseSubjectMemory` derived its memory scope from `subjectKeyForms(subjectKey).raw`,
which **strips a leading `user:`**. But a person's own memory is written with
`{kind:'user', id: user.userId}` (`features/profile-memory/routes.ts:33`) and
`User.userId` is *itself* `user:<hash>` (`usersService.userIdFor`), so the stored scope
is `user:user:<hash>` while the eraser scanned the `user:<hash>` prefix. The two
prefixes do not overlap. **Personal memory was therefore erased by no DSAR, in any
tenancy shape** — not a shared-workspace problem at all, and invisible to every
existing test because none wrote a note through the route and then erased it. The
eraser now walks every `subjectKeyForms` form (the same sanctioned over-set the other
erasers use), so neither the bare nor the prefixed writer convention can be missed.

## D2 — ADR 0044 §Audience

### The gap

`resolveBorrowedRecall` takes `(tenantId, agentId)`. There is no caller in the type, so there is
no per-caller authorization: **every member of the tenant who can address a granted twin agent
receives answers grounded in one named person's private memory.** The sibling leg in the same
`Promise.all` does re-resolve the caller (`chatContext.ts:197-200` → `resolveSubjectAccess(…,
callerUserId)`, `'none'` composes nothing).

### Forces

- **The consent actually obtained.** The grant UI says *"Allow {{persona}} to recall your
  memory / knowledge"* (`features/twin/i18n/en.ts:35-37`). It says nothing about who may then
  address that agent. Consent for a workspace-wide audience was never asked for and therefore
  was never given. This is the dominant force.
- **Blast radius of closing it: zero for anything that works today.** In a `ws:` workspace the
  grant is currently un-issuable (D1), so borrowed recall has never functioned there. In a
  personal workspace the tenant contains exactly one human, so caller *is* owner. Denying
  non-owner callers removes no working behaviour.
- **All three lanes can already carry an acting caller** — `chatContext` has `callerUserId`
  (`:67`), the ad-hoc lane has `req.userId`, and the runs lane has `ctx.actingUserId`, stamped
  on the run under the ADR 0324 scope-composer law (`agentRunnerNode.ts:113-123`). So the seam
  widening costs three call sites, not a new identity mechanism.

### Options scored

| | (1) owner-only, deny-by-default | (2) an `audience` scope on the grant | (3) interim gate + follow-up |
|---|---|---|---|
| Matches the consent obtained | **yes** | only if the default is `owner`, which *is* (1) | yes |
| New consent copy needed (×4 locales) | no | **yes** | no |
| Migration default for existing grants | none | a default of `workspace` re-grants consent nobody gave | none |
| Forecloses | nothing — (2) is additive on top | — | nothing |

### Decision D2

**(1) — deny by default.** Borrowed recall composes only when an acting caller is identified
**and** equals `link.userId`. An unattributed dispatch (no acting caller resolvable) is a
**denial**, not an allowance: its output lands in a workspace-visible run record, so it is the
same exposure with less information about it.

`BorrowedRecallResolver` widens to
`(tenantId, agentId, ctx?: { callerUserId?: string; runId?: string }) => …`. Both refusals emit a
named event (`twin_recall_denied_audience` with `reason: 'no_caller' | 'not_owner'`), because
`TWIN-6` records that this lane has *zero* structured logging and "why isn't my twin recalling?"
is currently undiagnosable. The same widening carries `runId` onto the audit row, which is what
ADR 0044 §5 always specified (`WF-TWIN-6`).

**Recorded follow-up (NOT in this batch):** an explicit `audience: 'owner' | 'workspace'` on the
grant, with the consent copy that would make a `workspace` audience honest. It is purely
additive on top of this decision — `owner` is today's behaviour.

## Consequences

- A grant is per-workspace. `GET /profiles/me/twin-grants` now lists the grants issued in the
  workspace the caller is *in*, not a home-tenant global list. That is the honest shape: the
  agent a grant names lives in that workspace.
- A twin agent addressed by someone other than its owner answers with no borrowed grounding, and
  says so in the logs rather than silently.
- Revocation semantics are unchanged and remain the corpus reference: live re-read, **no run
  stamp**, node re-executes on `:fork`. This batch *tightens* it (the grant is re-read inside the
  returned closure, per `TWIN-3`) and introduces no stamp.

## Correction note for ADR 0044

Added inline at ADR 0044 §"Open questions" — its stated premise *"First intra-tenant
cross-principal read"* and *"Cross-tenant twin … out of scope"* are falsified on any ADR 0015
shared-workspace host, where the agent's workspace and the owner's corpus tenant are different
tenants **by construction**. The original reasoning is left intact per the CLAUDE.md
correct-don't-rewrite rule.

## Implementation record

| Item | Where |
|---|---|
| D1 — link + grant both `tenantOf(req)` | `backend/typescript/src/features/twin/routes.ts` |
| D1b — owner corpus read under the owner's home tenant | `backend/typescript/src/features/twin/borrowedRecall.ts` |
| `tenantOf` on `twin-grant` | `backend/typescript/src/host/twinService.ts:49` |
| D2 — audience gate + `runId` on the audit row | `backend/typescript/src/host/twinRecallSurface.ts`, `borrowedRecall.ts`, the three call sites |
| Shared-workspace witness | `backend/typescript/test/twin-shared-workspace.test.ts` |
| Operator-principal ALLOW witness (`TWIN-5`) | `backend/typescript/test/twin-operator-scope.test.ts` |
| Degradation witnesses (`WF-TWIN-2`) | `backend/typescript/test/twin-borrowed-degradation.test.ts` |
| Prune guard (`TWIN-UX-10`) | `backend/typescript/test/profile-knowledge-prune-guard.test.ts` |

## Deferred, deliberately

- **The recall audit READER (`TWIN-UX-4` / `TWIN-7`).** The write side is complete
  — `runId`, the acting human as `principalId`, `agentId`, and a named
  `twin_recall_audit_failed` event. There is still no `GET
  /profiles/me/twin-recalls` and no "last recalled" on a grant card, so a grantor
  sees who MAY read, never who DID; and the row still fires only on
  `chunks.length > 0`. Scoping a per-grantor read out of the admin-tiered audit
  store is a design question of its own, and a half-built reader on a privacy
  surface is worse than an honest absence.
- **Listing LINKS on `/profile?tab=twin`.** Needs a new route: there is no
  "links naming me" query, because `agentProfile.twin` is keyed by agent.
- **A retention purger for revoked grants (`WF-TWIN-8`).** `tenantOf` is armed, so
  the indexed enumeration every purger needs now EXISTS. Choosing the window is a
  policy call, and `twinService.ts` documents the history as intentional.
- **An explicit `audience` scope on the grant.** Additive on top of §D2; needs new
  consent copy in four locales before a `workspace` audience could be honest.
- **Backend error messages by machine CODE (the durable `TWIN-UX-6` fix).**
  `apiErrorFrom` deliberately prefers the server's own prose, so the four-locale
  fallbacks render only on message-less failures and English server prose wins
  otherwise. Making every locale render its own prose means the backend emitting
  stable machine codes and the SPA carrying a per-code catalog — a backend-wide
  change, recorded here as follow-up rather than half-claimed.

### Review fold-in record (2026-08-20)

The adversarial review of this batch found the unlink lane's no-op honesty had
NOT landed despite the closeout claiming it (now: service returns whether a link
existed, route answers `200 {removed}`, no `twin.unlink` audit row on a no-op);
the consent receipt rendered green over a zero-row fan-out (`foundNothing` now a
distinct non-green state); and D1b's `?? tenantId` fallback reintroduced the
empty-as-success shape D1b exists to kill (now `closed('owner-unresolvable')`,
probe arm sabotage-proven). Plus: `resolutionFailed` on the toggle context so a
failed assignments read is not rendered as OFF on `?tab=twin`; the self-unlink
confirm sentence; busy state on the two remaining TWIN-UX-16 controls;
`erasureScope: 'this-tenant-only'` on the recorded governance decision; and the
same-turn revocation copy in four locales.
