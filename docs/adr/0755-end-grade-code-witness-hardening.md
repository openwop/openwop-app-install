# ADR 0755 — END-phase grade-code hardening of the RFC witness program

Status: implemented

> Renumbered 0753 → 0755 on 2026-09-26: a peer's RFC 0199 ADR claimed 0753 on a branch
> `--next` could not see when this one was reserved. Commits on this branch before the
> rebase cite "ADR 0753"; they mean this document.

Date: 2026-09-26. Program: `docs/steward/RFC-WITNESS-PROGRAM-2026-09.md` (END phase).
Grades: `docs/steward/CODEBASE-ASSESSMENT.md` § "RFC witness program (END pass)".

## Context

The RFC witness program merged eight PRs in three days: #4111 (fixture advert + seam
alias), #4115 + #4117 (ADR 0745 scopes, v2 toolCatalog, harness-issuer guard,
`approvals:respond`), #4118 (ADR 0746 getArtifact + A2A parts), #4121 (ADR 0749 A2UI
v0.9), #4123 (ADR 0751 fork at a suspended checkpoint), #4124 (ADR 0748 `/content/*`
+ extended locales) and #4128 (ADR 0747 Standard Webhooks). A `/grade-code` pass over
the code they changed graded five areas (B−, B+/B, C+/B+, C+, B+) and found **four
Blockers**:

1. **A `runs:read` key could still answer an approval gate** (WIT-AUTH-1). #4117 moved
   the run-scoped resolve route to `approvals:respond`, but `GET /v1/runs/{id}` and the
   host-extension interrupt list both projected the interrupt's resume token to any
   `runs:read` caller, and `POST /v1/interrupts/{token}` checks nothing but the token.
2. **An agent-authored v0.9 surface could freeze the viewer's tab** (WIT-A2UI-1): the
   renderer bounded cycles and depth, but `children` may repeat an id, so four
   components expanded to ~16.7M elements.
3. **A protocol content create could overwrite another org's live page** (WIT-CNT-1):
   the duplicate check filtered by org, the kernel row key has no org in it.
4. **Carry item (a), the ADR 0745 residual:** an `owk_` key's declared scopes were not
   enforced on trigger subscriptions + ingest, webhooks (including the new
   secret-rotating route #4128 added), prompts, annotations, or the `/content/*` ops.

## Decisions

### D1 — which scope each residual route needs, and what `scopes_supported` lists

`/architect` options evaluation. Forces: RFC 0200 §A.3 (`scopes_supported` MUST list the
scopes the host enforces); ADR 0745's "one gate per route"; `PROTOCOL_SCOPES` is the
RFC 0049 **RBAC vocabulary** (what a role or custom role can carry, what
`capabilities.authorization.roles` advertises, the workload-identity closed world).

| Option | Cost now | Debt / forecloses |
|---|---|---|
| A. Add `runs:annotate`/`prompts:*`/`content:*` to `PROTOCOL_SCOPES` + roles | Changes the role catalog advert (a wire change), custom-role validation, workload identity | None, but a large blast radius for a key-lane defect |
| **B. Core scopes through `requireProtocolScope`; documented extension scopes through a key-lane-only gate** | Two small helpers | Membership authority on extension routes stays each route's own check |
| C. Gate only core-vocabulary routes | Smallest | Leaves `auth.md` §1 ("the server MUST verify the key carries the scope") false for keys on prompts/content/annotations |

**Chosen: B.** The dominant force is honesty of the key lane without widening the RBAC
vocabulary. The scopes come from `spec/v1/rest-endpoints.md` and `auth.md`
§"Documented extension scopes":

| Route | Scope | Gate |
|---|---|---|
| `/v1/webhooks` (list, register, rotate, delete, test) | `webhooks:manage` | `requireProtocolScope`, once, in `resolveWebhookTenant` (every handler resolves its tenant there first) |
| `/v1/trigger-subscriptions` (list, get, register, pause/resume) | `webhooks:manage` | `requireProtocolScope` |
| `…/trigger-subscriptions/{id}/ingest` + the two host-sample trigger seams | `runs:create` (they start runs) | `requireProtocolScope` |
| `/v1/prompts` reads + `:render` / writes | `prompts:read` / `prompts:write` | `requireKeyLaneScope` (via prompts.ts's `sendError` wrapper) |
| `POST` / `GET /v1/runs/{id}/annotations` | `runs:annotate` / `runs:read` | key lane / `requireProtocolScope` |
| `/v1/content/*` admin reads / writes | `content:read` / `content:write` | `requireKeyLaneScope` (+ the D4 membership fix) |

`webhooks:manage` joins `ENFORCED_PROTOCOL_SCOPES` (it is RBAC vocabulary and now gated
on both lanes); the five extension scopes are `KEY_LANE_EXTENSION_SCOPES`.
`scopes_supported` is `SCOPES_SUPPORTED` = both lists: every scope a caller can be
refused for. **Under `OPENWOP_AUTHORIZATION_ENFORCEMENT=true`**, `webhooks:manage` is an
admin scope in the built-in catalog, so a viewer/editor member can no longer manage
webhooks or trigger subscriptions — the spec's allocation, the same reasoning as
ADR 0745's `approvals:respond` follow-up. Enforcement is off by default and in
production; the `*` operator key bypasses as before.

The call-site parity test now scans `requireKeyLaneScope` and prompts.ts's wrapper too,
compares against `SCOPES_SUPPORTED`, and **strips comments first** (WIT-AUTH-5: the doc
comment ``requireProtocolScope(req, 'runs:read')`` in `runAccess.ts` kept `runs:read`
"gated" with every real call deleted). A sabotage leg pins the stripper.

### D2 — one reading of a key's declared scopes

`keyDeclarationPermits(declared, scope)` — empty or `'*'` permits, otherwise membership
— is shared by `requireProtocolScope`, `requireKeyLaneScope`, `holdsProtocolScope` and
the MCP lane's `resolveMcpAuthority` (WIT-AUTH-3: a `['*']` key was unnarrowed on
protocol routes and narrowed to **nothing** on MCP). The MCP reading moves toward the
protocol one, which only widens a key its holder explicitly minted "all".

### D3 — the resume token is projected only to a responder

`holdsProtocolScope(req, scope)` is the non-throwing twin of `requireProtocolScope` (same
checks, same order, no challenge). `GET /v1/runs/{id}` includes `interruptToken` +
`callbackUrl`, and the host-extension interrupt list includes `token`, only when it is
true for `approvals:respond` — and the snapshot never includes them on a `?streamToken`
read (WIT-AUTH-2: a stream grant is not an approval grant). The gate itself (`kind`,
`nodeId`, `data`) stays visible to readers. The pin route (a mutation) no longer honours
`?streamToken`.

### D4 — content admin ops authorize on the org they write into

(Content half; details in the ADR 0748 correction notes.) One `authorizeContent`: the
wildcard operator passes; no principal or an anonymous session is `401`; the caller's own
personal workspace passes; otherwise `assertOrgScope` on the root org the write lands in
(was the tenant-wide union — a sub-org admin who was a root viewer could publish root
pages; and an `anon:` session passed every scope as "its own workspace"). The duplicate
`pageId` check is tenant-wide, so a sibling org's page is a `409`, never overwritten.
`sec:`-prefixed section ids are refused; `Vary` is appended (`res.vary`) and covers
`Authorization`/`Cookie`; the unknown-field echo is capped. Proof is
`test/adr0755-content-authority.test.ts` on real members — the ADR 0748 scenario test runs
as the wildcard operator, which skips every one of these checks.

### D5 — the A2UI render budget, fork discriminator, artifact and webhook fixes

- **A2UI (ADR 0749):** `MAX_RENDER_NODES = 2048` (4 × the 512-component profile cap); a
  counting walk refuses an over-budget surface with the existing fail-closed unsafe
  notice, and the renderer's walks stop past it. The approval-resolve taint read is
  skipped where no admission path can record a v0.9 surface. The §C.12 block is now
  witnessed at the route and on the MCP claim path.
- **Fork (ADR 0751):** gate re-creation keys on `forkMode` (set only by `:fork`), not
  `parentRunId`, which sub-run children also carry; re-creation is logged
  (`fork_gate_recreated`).
- **Artifacts (ADR 0746):** `conformance.artifact.emit` is registered in the reference
  deploy and nameable by a tenant workflow; its rows now carry `announcedType` only,
  never a host `artifactTypeId`, so they cannot pose as a typed Library deliverable. The
  1:1 fallback agent turn gets a `speakerId`, so a `parts`-bearing turn validates against
  the closed v2 turn schema. "Announcing is not owning" now covers the Documents lane. 405
  carries `Allow: GET, HEAD`; the inline ceiling counts bytes; an untyped artifact omits
  `artifactType` rather than inventing `'unknown'`; each 404 logs its reason at debug.
- **Fixtures (ADR 0533/0634):** a withheld fixture is logged once with its blocking
  typeIds; the real node-pack probe is exercised against a temp `pack.json`.
- **Webhooks (ADR 0747):** a secret-open or signing failure is a counted failed attempt
  (`signing_failed:<Class>`) that backs off and dead-letters, not a leased poison row.
  Endpoint verification answers the caller one reason, `not_confirmed` (RFC 0201 §D.14
  mandates only the error code), so it is no longer a port/HTTP-liveness oracle; the fine
  reason stays in the log. `GET /webhooks` echoes the non-secret opt-in and overlap fields.

### D6 — a fork orphaned between its `201` and its dispatch recovers as the same fork (FORKINT-2)

Handed over from the END `/grade-data` pass. The `:fork` route inserts the fork, copies
the prefix, answers `201`, and only then dispatches with `resumeSnapshot` from a
`setImmediate`. A crash in that window left a `pending` fork that the orphan sweeper (and
the outbox lane) re-dispatched with NO `resumeSnapshot`. The copied prefix re-executed,
breaking ADR 0326 P3b, and an inherited gate ran its node again with a fresh `createdAt`,
which is a later deadline than the source's and breaks ADR 0751.

`/architect` on the options:
- (a) Dispatch before the `201`. Rejected: it only narrows the window.
- (b) A durable "fork intent" row. Rejected: it duplicates state the run already holds.
- **(c) Derive the dispatch from the persisted run.** Chosen, because everything needed is
  already durable. The checkpoint is the fork's own `schedulerSnapshot`: the route writes
  it at insert, and the executor only overwrites it with a *later* checkpoint at
  suspend/pause. The replay source is `parentRunId`.

`forkDispatchOptions(run)` in `executor/forkInterrupts.ts` is now the ONE derivation. The
route, the orphan lane and the outbox lane all call it, keyed on `forkMode` (a sub-run
child gets `{}`). Witness: the FORKINT-2 leg in `adr0751-fork-suspended-checkpoint.test.ts`
persists exactly what the route persists, dispatches nothing, and runs one sweep. It then
asserts that the gate did not re-execute and that the re-created gate keeps the source's
`createdAt`. Removing the helper from the sweeper makes the gate start twice (red).

The same pass's second finding, no unique index on an open `(run_id, node_id)`, is
`WIT-FORK-2` below. It stays unconstrained because legitimate multi-open rows per node
(loops) have not been ruled out, and a constraint over dirty data fails the migration.

### Declined, with evidence

- **WIT-A2UI-2 (run boundary as a trust floor):** `ai-envelope.md:694` reads that way,
  but corpus scenario `aiEnvelope.trustBoundaryPropagation.test.ts:100-120` pins the
  envelope's own `contentTrust` as winning. A host cannot satisfy both; this is a corpus
  question, not a host change.
- **WIT-AUTH-9 (scope before body validation on `POST /v1/runs`):** nothing leaks, and
  reordering changes the status a malformed request gets on every existing lane.

## Residuals (not closed here)

| ID | Why not now |
|---|---|
| WIT-AUTH-4 | The harness-issuer guard fires only on Cloud Run (`K_SERVICE`). Inverting it needs a local-only marker threaded through `release-conformance.sh` and every adopter's deploy — its own change with its own witness. |
| WIT-AUTH-6 | v1/v2 toolCatalog facets are hand-duplicated; a refactor with no behaviour change, left for a quieter PR. |
| WIT-AUTH-7 | `scopes_supported` names scopes the OIDC AS never mints; the corpus clarification ADR 0745 filed stands. |
| WIT-AUTH-10 | Issuer DNS names that resolve private pass the syntactic guard; operator misconfiguration only. |
| Content: `owk_` subject | An `owk_` key's subject is `apikey:<id>` with no membership, so it can never pass the content admin ops — fail-closed; creator resolution is a design change. |
| WIT-CNT-6 | Concurrent same-`pageId`/slug creates race: the kernel adapter has no create-only (CAS-on-absent) write. |
| WIT-CNT-8 | `GET /content/pages` pagination needs the protocol list convention. |
| WIT-CNT-10 / -11 | Org locale list on the protocol lane is an ADR 0748 choice; markdown escaping applies to every section type, not only `fields`. |
| WIT-A2UI-3 / -6 | No producer puts a v0.9 surface in `interrupt.data` yet; no justify-around/evenly utilities exist. |
| WIT-FORK-2 / -3 / -4 | Non-atomic gate re-creation needs a partial unique index (migration); a gate re-opened between `interrupt.resolved` and `node.completed` and the shared conversation idempotency space are ADR 0751 known limits. |
| WIT-ART-3 / -4 / -7 | Two access predicates over run-event rows (a run reader already sees node outputs); the linear announcement scan needs an `artifactId → seq` index; `parts` doubles text at rest. |
| WIT-FIX-1 / -2 | The probe says "declared", not "loadable"; `readdirSync` per discovery request needs a memo. |
| WIT-WH-3 / -8 / -10 | Expired previous secrets stay at rest (needs a sweep); the verification budget keys on tenant; KMS AAD is not subscription-bound (legacy-row fallback needed). |

## Code-review fold-in (2026-09-26)

`/code-review` of the branch found no CRITICAL/HIGH; the MEDIUMs were real and are fixed:

- **M1 — the webhook gate checked the wrong tenant.** `resolveWebhookTenant` resolved
  `webhooks:manage` in the caller's ACTIVE tenant, then ran the operation in an explicit
  shared-workspace `tenantId` checked only for membership: under enforcement, admin at
  home + viewer in the workspace managed the workspace's webhooks. New
  `requireProtocolScopeIn(req, tenantId, scope)` makes the membership decision in the
  target tenant (the personal-workspace escape applies only to the active one);
  `requireProtocolScope` is now that with `tenantOf(req)`. Witness:
  `test/adr0755-webhooks-target-tenant-scope.test.ts` (enforcement on; sabotage-proven).
- **M2 — the label walk escaped the budget pre-check.** `textOf` had no cycle guard, so a
  Button whose label child listed itself passed the pre-check, drained the shared budget,
  and every later sibling (the warning text) silently vanished while the Button stayed
  clickable. `textOf` now carries the same ancestor-path guard as `render` and
  `exceedsRenderBudget`, and the surface refuses itself if a walk ever ends over budget —
  never a partial surface. Witness: the self-referencing-label leg of
  `a2ui-v09-render-budget.test.tsx` (sabotage-proven).
- **L1:** prompts now check the key scope above the capability 501, like every other gate.
- **L2:** the SPA types `OpenInterrupt.token` optional; `RenderInterrupt` shows
  "you can see this step but can't respond" instead of cards whose submit must fail, and
  the run-conversation resume form refuses locally with the same copy (4 locales).
- **L3 (release note):** an existing `owk_` key that declared scopes now gets `403` on
  webhooks, trigger subscriptions, prompts, content admin and annotation POST unless it
  declared the matching scope. Keys are re-mintable; undeclared and `*` keys are unaffected.
- **L4 (recorded):** the approval-taint short-circuit reads "unreachable" from the seam
  flag, but any node's `ctx.emit('ui.a2ui-surface', …)` can append that event type. No
  in-tree pack emits a v0.9 recorded surface today; a producer that does must route
  through `admitA2uiSurface` (tracked with `WIT-A2UI-3`).
- **L5 (kept):** public content delivery varies on `Authorization, Cookie`. Signed-in
  callers get tenant content at the same URL, so a shared cache MUST NOT serve one to the
  other; the cost is weaker shared caching of the anonymous lane.

## Verification

Targeted suites, all green on the branch: the new
`adr0755-key-lane-scopes` (26, sabotage-proven: removing the webhook gate or the token
projection turns 6 legs red), `adr0755-content-authority`, `adr0755-a2ui-approval-taint-route`,
`adr0755-fallback-turn-speaker`, `adr0755-node-pack-probe`, `a2ui-v09-render-budget`, plus the
66 files that drive webhooks, trigger subscriptions, prompts, annotations, interrupts, PRM
or MCP authority (527 tests). The full `npm run ci` result is recorded in the PR.
