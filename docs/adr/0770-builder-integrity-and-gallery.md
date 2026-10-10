# ADR 0770 — Workflow builder integrity: never lose or overwrite a user's workflow

Status: Accepted — P1 implemented (feature-loop 2026-10 row 2); P2–P4 open

Feature-loop 2026-10 row 2 (workflow builder + chain gallery + `/` picker). Grade
evidence: `docs/steward/WORKFLOWS-ASSESSMENT.md` § "Workflow builder + chain gallery
+ `/` picker" (`WBWF-1..16`, opening grade **C+**). Composes ADR 0163 (chains as
editable templates), 0369 (transient lifecycle), 0440/0523/0524 (builder round-trip
and field preservation), 0474 (content-hashed revisions), 0481 (collab room lock),
0194 (per-tenant pack enablement), 0006 + 0627 D3 (tenant write scope).

## Context

The builder and gallery are the "chains" half of the chains-or-stacks doctrine. The
doctrine itself holds: every workflow the builder touches is a tenant-owned,
ownership-indexed definition from a request body or `expandChain`. What fails is the
unit's treatment of a workflow the user **already has**. Six Blockers, each re-read
at the cited line:

| id | What the user loses | Where |
|---|---|---|
| `WBWF-1` | Re-using a template whose chain declares sub-chains silently **replaces the edited child** with a fresh `params:{}` expansion, drops its rename, un-archives it, ignores a live collab room, and changes what every earlier parent run replays against | `coRegisterSubChains` `workflowChainPackLoader.ts:1843-1867` — the child id is deterministic per `(tenant, chain, version)` and `deps.register` is an unconditional overwrite |
| `WBWF-2` | A 201 for a definition that is not durable: another instance 404s a workflow the list shows | `registerWorkflow` is fire-and-forget (`workflowsRegistry.ts:41-52`); every write route uses it while `recordOwnership` is awaited |
| `WBWF-3` | A **viewer** in a shared workspace can create, overwrite, delete, archive, publish and roll back its workflows | no role check on any write route in `routes/workflows.ts` |
| `WBWF-4` | **Canvas layout and node names** reset on every reopen | `serialize.ts:309-326` omits `name`/`position`; the host validator's node rebuild (`workflowDefinitionValidation.ts:496-504`) would drop them anyway. Both are wire fields (`workflow-definition.schema.json` §WorkflowNode) |
| `WBWF-5` | A refused load (401/403/429/5xx) opens a **blank canvas under the real id**; the first autosave overwrites the definition | `backendStore.ts:191-194` + `BuilderTab.tsx:46` |
| `WBWF-6` | Two tabs or devices **overwrite each other's whole definition** | the save sends no base revision; the route has no compare |

Competitive frame (`WORKFLOW-ORCHESTRATION-COMPETITIVE-ASSESSMENT.md`,
`UX_UPGRADE-workflows-builder.md`): n8n, Make and Zapier all persist canvas layout,
refuse a stale save (n8n: "workflow was changed by someone else"), and give their
template galleries a text search. Ours has ~164 chains behind a category `<select>`.
Those three are table-stakes this ADR closes; auto-layout, canvas node search and a
run-with-inputs form stay follow-ups (§Phases).

## Boundaries audit

- **Write-scope gate:** `requireTenantScope(req, 'workspace:write')`
  (`features/featureRoute.ts:295`) is the existing tenant-level gate for non-normative
  `/v1/host/openwop-app/*` routes, enforced unconditionally (CRM-6, ADR 0627 D3). All
  the write routes here are host-extension; only `GET /v1/workflows/{id}` is
  normative (`spec/v1/rest-endpoints.md:33`) and it is a read. It is reused, not forked.
  It is not enough on its own: `assertTenantScope` recognises neither an `env-key`
  principal nor an `owk_` key (whose principal id is `apikey:<id>`, with no personal
  tenant or user id set — `middleware/auth.ts:942-956`). `credentialAuthority`
  (`host/protocolAuthorization.ts`, ADR 0601 C4) is the existing provenance
  classifier for exactly that, already composed the same way by `authorizeContent`
  (`features/cms/contentProtocolRoutes.ts:117-150`). D1 composes both.
- **Durable registration:** `registerWorkflowDurable` (`workflowsRegistry.ts:35`)
  already exists and is used by the propose lane and seeders. Reused.
- **Revision hash:** `revisionHashOf` (`host/definitionHash.ts:29`) already strips
  the host-owned `lifecycle`. The CAS compares this hash, and layout joins the strip
  list. No second hash.
- **Optimistic concurrency idiom:** `If-Match`/`ETag`, as in
  `features/navigation-settings/routes.ts:68` and `routes/workspace.ts:44`.
- **Collab:** ADR 0481's room lock (`workflowRoomLive`) stays the only writer while
  a room lives. It is unchanged.
- **Peer:** #4193 (ADR 0766) rewrites the gallery route (`workflows.ts:774-795`) and
  the loader's load path. This ADR edits neither region.

## Decision

**D1 — Every workflow write route requires `workspace:write` in the active tenant**
(`WBWF-3`): POST `/workflows`, DELETE, archive / unarchive / promote, rollback,
`from-chain`, and the workflow collab ticket (a room's derive registers the head, so
the ticket is a write), and the same-origin COOKIE upgrade of that socket, which
reached the room with no scope check (grade-code `WBCD-3`; gated in
`collabServer.ts` for a shared tenant). One helper, `requireWorkflowWrite(req)`, classifies the
caller by PROVENANCE with `credentialAuthority` — the classification
`authorizeContent` (`features/cms/contentProtocolRoutes.ts:117-150`) and the MCP lane
already use — never by the principal id string:
- wildcard operator → allowed;
- `tenant-owner` (a tenant-pinned env key) → allowed when the tenant-owner scope set
  holds `workspace:write`;
- `api-key` (`owk_`) → the key's DECLARED scopes must permit `workspace:write`
  (`keyDeclarationPermits`), and the ISSUER is the subject for the membership check;
- the caller's own personal workspace → the implicit owner (the key's issuer
  included: a key minted in its issuer's personal workspace carries that tenant);
- otherwise → the subject's tenant-wide scope union must include `workspace:write`
  (`assertTenantScope`), else **403 `forbidden_scope`** (the code the shared gate
  already throws).

The refusal runs after the id-shape check and **before** the ownership lookup — it
does not depend on the id, so it leaks nothing. Reads are unchanged. **Rollout
change, stated:** a member of a shared or SAML tenant who holds only viewer scopes
loses write access they have today; that is the fix. **Residual, stated:** the chat
`compose-and-run`/`propose` tools and the workflow-author persist lane also
register definitions; they run as the acting user through the agent-tool lane
(ADR 0104 grants) and are not HTTP write routes, so D1 does not reach them — filed
as P2 (`WBWF-17`).

**D2 — A write route answers only after the definition is durable** (`WBWF-2`).
Every write route registers through `registerWorkflowDurable`, which this ADR
CHANGES to write storage **before** the cache (today it sets the cache first,
`workflowsRegistry.ts:35-38`; no caller depends on that order), so a failed write
never leaves one instance serving a definition no other instance can resolve. A
storage failure propagates to a 5xx. `deleteRegisteredWorkflow` stays
fire-and-forget — a residual named here, not closed (a lost delete leaves a
resolvable-by-id definition with no ownership row, i.e. invisible and uneditable,
never a phantom in the list).

**D3 — `from-chain` stages, checks, then commits; an EDITED child is reused, never
overwritten** (`WBWF-1`, `-7`, `-8`).
1. **Stage.** Expand the parent and every sub-chain child (the whole flattened tree,
   grandchildren included) with no side effects: `coRegisterSubChains` keeps its
   deps interface; the route's `register`/`own` now *collect*.
2. **Check.** The ADR 0194 disabled-pack gate runs on the parent **and every child**
   before anything is written.
3. **Decide per child id** (per id across the flattened tree):
   - not owned by this tenant, or owned but its definition does not resolve → create
     (register + revision + ownership);
   - owned and resolves, and its head is still what the host minted
     (`revisionHashOf(head) === owned.mintedRevision`) → **refresh**: re-register
     the fresh expansion. This keeps today's only heal for a child minted by an older
     host (expansion output changes under a fixed chain version — the
     `childInputVars` backfill was one such change);
   - owned and resolves, and edited (hash differs, or a legacy child with no
     `mintedRevision`) → **reuse**: no register, no ownership rewrite, no revision.
     The user's edits, name, lifecycle (archived stays archived) and live room are
     untouched, and older parent runs keep replaying against the same definition.
   The decision and the write use ONE fresh read and an atomic swap; a lost swap
   is `reused` (grade-code `WBCD-2` — deciding from the cache and writing blind let
   an edit made elsewhere be replaced). A legacy child with no stamp is pristine
   only when its visible history is exactly one revision and that is the head
   (`WBCD-8`), else reused.
   `mintedRevision` is a new sticky `OwnershipMeta` field, written only by this mint
   lane (the `publishedRevision`/`authoredVia` precedent: omitted meta preserves it).
   `mintChildWorkflowId` is unchanged, so the id stays convergent (RFC 0133 §1.3:
   a repeat instantiation "converges", a shared child "is registered once").
4. **Commit** new/refreshed children depth-first (durable register → revision →
   ownership), then the parent.
5. **No compensation delete.** A failure after a child committed leaves an owned,
   unreferenced child — today's accepted worst case. Deleting it is NOT safe: a
   concurrent request may have just reused it (architect H3).

The response keeps `subChainWorkflowIds` (the whole bound subtree, unchanged
semantics) and adds `reusedSubChainWorkflowIds` when any child was reused.

**D4 — Node `name` and `position` round-trip through the builder** (`WBWF-4`).
- The host validator's node rebuild preserves `name` (string, ≤ 256) and `position`
  (finite `{x, y}`), matching §WorkflowNode.
- Builder `serialize.ts` emits `position` always, and `name` **only when it differs
  from the catalog default label** — otherwise the first save of every existing
  workflow would move its hash (every node's name defaults to its catalog label,
  `deserialize.ts:172`).
- **Both** `revisionHashOf` and `definitionHashOf` strip `position` (a drag is not a
  content change: without the strip a drag mints a history row, flips
  `publishedBehindHead`, re-arms the evals gate, trips the CAS, shows the ADR 0473
  "edited" chip and makes `runStarter`'s approval pin refuse dispatch). A rename
  (`name`) IS content and stays hashed. No stored definition carries `position`
  today (the validator drops it), so no existing hash moves.
- **`expandChain` deliberately does NOT emit layout.** Chain packs do carry
  `name`/`position` on fragment nodes (e.g. `research/pack.json:29`); emitting them
  would move the hash of every chain-expanded and chain-backed definition, and every
  run's `definitionRevision` pin with it. The producer/ingest parity test
  (`node-field-contract-parity.test.ts`) changes from set-equality to "producer =
  ingest − {name, position}", with this sentence as its reason. A template opened for
  the first time is auto-laid-out once, then persists. Carrying pack layout into
  instantiation is P3.
- Rebuild sites audited for the allowlist-drop class: validator (extended), builder
  serialize (extended) / deserialize (already reads both), `expandChain`
  (deliberately excluded, above), `routes/workflowChainExpandSeam.ts` (conformance
  projection of the RFC 0013 shape — unchanged, layout is not part of it),
  `preserveDroppedFields` (node fields it restores are named; layout is not
  restored), the collab room (carries whole builder nodes, derive re-validates → now
  preserved).

**D5 — Opt-in optimistic concurrency on save, atomic across instances** (`WBWF-6`).
`POST /workflows` accepts `If-Match: "<revisionHash>"`. When present:
1. read the head FRESH from storage (`kvGet('wfreg:'+id)`) — never the per-instance
   registry cache, which never expires and would 409 a user's own save that landed
   on another instance (architect B2);
2. if a head exists and `revisionHashOf(head) !== If-Match` → **409 `conflict`**,
   `details: { reason: 'workflow_head_moved' }`, with the current head's revision in
   the `ETag` header;

   > **Correction (implementation, 2026-09-28).** This line first put
   > `headRevision` in `details`. Error details are entropy-scrubbed
   > (`middleware/sanitize.ts` `sanitizeDetails`), which redacts a 64-hex hash to
   > `<redacted:high-entropy>` — the field would have been present and always
   > wrong. Caught by the route test on its first run; the revision rides the
   > `ETag` instead.
3. `preserveDroppedFields` merges against that same fresh head;
4. commit with `Storage.kvCompareAndSwap(key, rawHead, next)` — atomic across
   instances — then refresh the cache. A lost swap is the same 409 **only if the
   content moved**: a lifecycle verb (archive/promote) re-registers the head with
   `revisionHashOf` unchanged, so a lost swap re-reads and retries (bounded) when
   the hash still matches (grade-code `WBCD-9`).

So the race IS closed for If-Match writers, not merely narrowed. Every 201 returns
`revision` = `revisionHashOf(defToPersist)` (post-merge — what is actually the head)
and an `ETag`. A new owner-gated read, `GET …/workflows/:id/head` → `{ revision, definition }`,
reads storage fresh; the builder's load uses it

> **Correction (grade-code `WBCD-1`).** The first cut returned only `{ revision }`
> and the builder took the CONTENT from `GET /v1/workflows/:id`, which is served
> from a per-instance cache that never expires. On an instance with a stale cache
> the canvas held v1 while the base was v2's hash, and the next save passed the
> precondition and overwrote v2 — the exact clobber D5 exists to stop. Now the
> content and its revision come from ONE fresh read, every fresh read refreshes
> this instance's cache, and a lost swap adopts the winner. Witness:
> `adr0770-builder-integrity.test.ts` "the head read is one FRESH read". (the revisions list's `isHead` is not
reliable — `recordRevision` swallows its own failures). Rollback also returns the new
`revision`, and the builder adopts it, so the user's own rollback never 409s their
next autosave.
- Absent header → today's last-writer-wins. Other lanes (chat compose,
  workflow-author, seeders, conformance) are unchanged.
- The builder sends `If-Match` on autosave, the Run lane's register, and the debug
  lane's register (`builder/debugSession.ts` `runFromNode`). All three run through
  ONE write queue (`enqueueBuilderWrite`) and read the base inside their turn —
  overlapping, the second carried the base the first had just moved and the
  user's own save came back as a false conflict (grade-code `WBCD-5`).
  `ProposalBanner`'s persist still writes without a base (a residual, P4). On 409 the
  SyncFailureBanner offers **Reload latest** (discard mine) and **Keep mine**
  (resend without `If-Match` — a deliberate overwrite).
- Collab: when a room ends the builder drops its base, so the ADR 0481 catch-up sync
  is not refused against the room's own derive; the 201 re-arms it.
- CORS: `If-Match` joins `ALLOWED_REQUEST_HEADERS` (`middleware/cors.ts:68-80`) — the
  2026-08-06 `X-OpenWOP-Field-Contract` save outage is exactly this class; the ETag
  is exposed.

**D6 — The builder never opens a blank canvas over a workflow it failed to read**
(`WBWF-5`, `-12`, `-13`).
- A blank canvas is minted **only** on an authoritative not-found (the definition
  read returned null). A genuine offline error (`isOfflineError`,
  `client/config.ts:258` — imported, not edited) falls back to the local copy, and
  with no local copy renders an offline StateCard, never a blank. Anything else —
  any status, including the SDK's `invalid_json` from an HTML rewrite — throws a
  typed `LoadRefusedError`; `BuilderTab` renders a load-error StateCard with Retry.
  A loading card shows until the store holds the routed id, so workflow A's canvas is
  never editable while B loads.
- Switching workflows flushes a pending autosave for the old one instead of
  cancelling it. `pagehide` flushes too, as a best-effort keepalive `fetch`.
- Run is guarded by a ref set synchronously at the top of `onRun`.

**D7 — Run-scans filter at the source** (`WBWF-10`, `-11`). The promote green-run
probe and the removed-node disclosure pass `{ tenantId, workflowId }` to
`listRuns`, which already supports both.

**D8 — Gallery search and honest gallery states** (competitive upgrade).
- The template gallery gets a text search over label, description, category and
  chainId, composed with the category filter.
- A gallery load failure renders an error card with Retry instead of the "no
  templates installed" empty state (`listChainTemplates` returned `[]` on any error).
- Every "Use template" button carries an accessible name that includes the chain's
  label.
- The `/` picker matches the slug it displays, as well as the display name, and
  its composer textarea declares `role="combobox"` (a row-1 gap: the popup state
  attributes were on the implicit textbox role, where `aria-expanded` is invalid).

## RFC verdict

**Host-extension, no RFC.** Every changed route is under `/v1/host/openwop-app/*`.
`name`/`position` are existing §WorkflowNode fields; preserving them makes the host
*more* conformant to the schema it already validates against. `If-Match`/`ETag` on a
host-extension route is not a wire claim. No capability is advertised or changed.
Nothing here touches `scopes_supported`: `workspace:write` is enforced through the
tenant membership gate, not the RFC 0049 protocol lane.

## Matrix

| # | Dimension | Answer |
|---|---|---|
| 1 | Feature-package | Core surface (`core:builder`, `core:workflows`), no package. No new module; edits in place. |
| 2 | Toggle | None. These are integrity fixes to always-on core surfaces; gating a data-loss fix behind a toggle would leave the loss the default. |
| 3 | Workflow surface | Unchanged. |
| 4 | Node pack | None. |
| 5 | AI chat / envelopes | None. The `/` picker slug match is a client filter. |
| 6 | Agent pack | None. |
| 7 | Public surface | None. |
| 8 | RBAC | D1: `workspace:write` on every write verb; IDOR guards unchanged (`getOwned` 404 posture). |
| 9 | Replay / fork | D3 is a replay **fix**: a re-instantiation no longer changes the child an older parent run replays against. D4 keeps the replay hash stable across drags. |
| 10 | Frontend | `builder/**`, `chat/lib/workflowMentions.ts`; four-locale i18n parity; no `src/client/**` edits (owned by the v2 migration). |

## Architect review (pre-code, 2026-09-28) — folded in

An adversarial `/architect` pass on the first draft found 2 Blockers, 4 High, 3
Medium; every one is folded into the decisions above:
- **B1** D1 as drafted (env-key allowance then `requireTenantScope`) refused every
  `owk_` key, including in its issuer's own workspace — the CLI calls these routes.
  → provenance classification via `credentialAuthority`.
- **B2** the CAS compared against the never-invalidated per-instance cache (a
  user's own save 409s on another instance), and "storage has no CAS" was false —
  `kvCompareAndSwap` exists. → fresh read + atomic swap.
- **H1** emitting `name` unconditionally moved every hash; a drag would move
  `definitionHashOf`; the parity test forces `expandChain` to match. → name only
  when non-default, both hashes strip `position`, `expandChain` explicitly excluded.
- **H2** "an unedited child is byte-identical to a fresh expansion" was false, and
  blanket reuse froze stale children forever. → `mintedRevision` three-way decision.
- **H3** the compensation delete could remove a child a concurrent request reused.
  → dropped.
- **H4** `If-Match` was not in the CORS allow-list. → added.
- **M1** the collab ticket is a write lane D1 missed; the agent lanes are named as
  a residual. **M2** debug lane, rollback revision, unreliable `isHead` → head read.
  **M3** offline-with-no-local-copy still minted a blank. → offline state.

## Alternatives weighed

- **WBWF-1: mint a fresh child id per instantiation.** Rejected. It breaks RFC 0133
  §1.3's convergent `(tenant, chain, version)` keying that the tenant-scoping
  security property rests on, and it multiplies children in the list. Reuse keeps
  the keying and stops the overwrite.
- **WBWF-1: always reuse an owned child.** Rejected by the architect pass: expansion
  output changes under a fixed chain version, and re-instantiation is the only heal
  for a child minted by an older host. The `mintedRevision` three-way decision keeps
  the heal for pristine children and protects edited ones.
- **WBWF-4: a `metadata.builderLayout` side record.** Rejected. The wire already has
  per-node `position`/`name`, and a side record is a second home for the same fact.
- **WBWF-6: mandatory `If-Match`.** Rejected. Several host lanes POST definitions,
  and making it mandatory would break all of them in one PR. Opt-in lets the builder
  (the lane with concurrent editors) adopt it now.
- **WBWF-3: `requireProtocolScope`.** Rejected. It is dormant unless
  `OPENWOP_AUTHORIZATION_ENFORCEMENT=true`, and only an advertised scope may be
  passed to it. These are host-extension routes, where the unconditional tenant
  gate is the house pattern.

## Phases

| Phase | Scope | Status |
|---|---|---|
| **P1** (this PR) | D1–D8, plus the post-code folds: grade-code `WBCD-1..9` (except `-8`'s legacy-stamp edge noted above), grade-ux `WBUX-1/2/3/5/6/9`. Rollback + restore adopt the fresh head (`WBCD-4`). | implemented |
| P2 | `WBWF-17`: D1's write scope for the agent lanes (compose/propose, workflow-author persist). `WBWF-9`: DELETE refuses 409 `workflow_referenced_by` while an owned workflow's `core.subWorkflow` points at the id. `WBWF-15`: parent marker on co-registered children so the list and picker can group them. `WBWF-16`: a distinct error code per `SubChainError` | follow-up |
| P3 | Competitive: carry chain-pack node layout into instantiation (a hash-moving change for chain-backed defs — needs its own migration note); run-with-inputs form on the builder's Run (reuse `ui/RunInputsForm` when `variables`/`inputSchema` declare required inputs); graph auto-layout; canvas node search | follow-up |
| P4 | Builder hygiene from the grade: undo coalescing per field focus (BLD-7); `ProposalBanner` persist through the write queue with a base; the offline-fallback load carries no base, so its first online save is unchecked (`WBCD-13`); reopening the SAME id briefly shows the old canvas (`WBCD-12`); draft migration honouring `res.ok` (BLD-9) — **NOT the one-line fix it looks like**: a migration that re-runs until every POST lands re-POSTs every local copy, with no base, over the server head on every dashboard mount. It needs the If-Match lane first. UX: `WBUX-4` (Load latest on a deleted workflow, success announcement, focus), `WBUX-7` (focus after Retry / Clear), `WBUX-8` (gallery result-count announcement), `WBUX-10`, `WBUX-11` (a proactive read-only canvas for viewers — its own ADR) | follow-up |

## Open questions

1. **Keep mine** on a 409 is a deliberate overwrite. Should it name the other
   writer? The revision row carries `createdBy`, so yes in P2. P1 says "someone
   saved a newer version".
2. The `pagehide` flush is best-effort (keepalive bodies are capped near 64 KB).
   A large definition still relies on the local cache plus the next open. Is that
   acceptable? Assumed yes: the local cache is the durable fallback that the load
   path now reads only when offline.

## Implementation record (P1)

| Decision | Where | Witness |
|---|---|---|
| D1 write scope | `host/workflowWriteAuthority.ts`, every write verb in `routes/workflows.ts`, collab ticket + cookie upgrade | `adr0770-builder-integrity.test.ts` (viewer refused ×7 incl. an id that never existed; editor, tenant env key, `owk_` in a personal workspace allowed). Sabotage: removing the DELETE gate turns it red |
| D2 durable writes | `registerWorkflowDurable` (storage first) on every REST lane + the collab derive | route tests; ratchet `workflow-pin-site-ratchet.test.ts` now scans the CAS registrar too |
| D3 sub-chain children | `commitSubChainChild` | edited child reused, pristine refreshed, archived stays archived. Sabotage: forcing refresh turns it red |
| D4 layout | validator, `serialize.ts`, both hashes strip `position` | drag keeps the revision, rename moves it; `node-field-contract-parity.test.ts` pins the contract with the named producer exception. Sabotage: dropping `name` from the validator or the position strip turns it red |
| D5 CAS | `readRegisteredWorkflowFresh` / `registerWorkflowIfUnchanged` (`kvCompareAndSwap`), `/head`, CORS `If-Match` | stale base 409 + ETag, the atomic race (exactly one of two swaps lands), stale-instance-cache head read; frontend base adoption |
| D6 load honesty | `loadWorkflowWithHead`, `LoadRefusedError`/`LoadOfflineError`, BuilderTab states, flush on switch + `pagehide`, Run guard | `backendStore.loadWorkflow.test.ts`, `adr0770BuilderIntegrity.test.tsx`. Sabotage: cancel-instead-of-flush, unconditional `name`, blank-mint on refusal each turn it red |
| D7 run scans | `listRuns({ tenantId, workflowId })` | — (filter pass-through; covered by the existing promote/disclosure tests) |
| D8 gallery + picker | `WorkflowsDashboard.tsx`, `workflowMentions.ts` | `workflowMentions.test.ts` slug match |

**Blocker witnesses drive the real paths, each sabotaged red:** `WBCD-1` — a
genuinely stale instance cache vs fresh storage; `/head` heals it and the stale
base 409s (red when `/head` reads the cache). `WBCD-2` — a child edited on another
instance while this instance's cache holds the pristine mint; re-instantiation
reuses it (red when the decision reads the cache). `WBCD-3` — a viewer's
cookie-auth WS upgrade is refused 403 while the owner's opens
(`workflow-collab-canary.test.ts`; red with the gate disabled).
**Residual stated, not closed:** the read→swap race inside one request is
witnessed at the registry (two swaps on one raw, exactly one lands), not through
the route; the first write of a never-registered id is still last-writer-wins.
