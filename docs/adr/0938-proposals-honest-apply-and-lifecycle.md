# ADR 0938 — Proposals: honest apply, a lifecycle that holds, and approve-what-you-see

Status: implemented (2026-10-19; Accepted after the adversarial `/architect` pass below — 2 Blockers + 3 High folded into D5, D6, D8, D9)

Feature loop round 2, row 53 (`proposals`, RFC 0096 reviewable learning). Amends ADR 0039
(the reference-host endpoints) and ADR 0736 (mutation authority). Host-extension only: no
wire change, no new RFC. It **withdraws** a capability advertisement this host could not honour.

## Context

`features/proposals` stores RFC 0096 proposals: inert drafts of an agent pack, a
workflow-chain pack, a prompt template or an automation, which a person reviews and then
applies, rejects or archives. One producer exists: accepting an ambient-work-graph pattern
mints `wg:<suggestionId>` (`kind: workflow-chain-pack`, artifact `{toolSequence, occurrences}`).
The chat agent reads the store through `openwop:proposals.list` before proposing again. There
is no FE surface; the CLI (`openwop proposals …`) drives it, gated on the advertisement.

The round-2 grade (`WORKFLOWS-ASSESSMENT.md` § row 53, `PROP2WF-1..10`) ran 15 probes through
the real routes (`test/proposals-r2-probes.test.ts`) on `origin/main` `b0ff69efa`. 14 were RED:

| Probe | What happened on main |
|---|---|
| PRB-1/2 | a rejected or archived proposal applied (200, `state: applied`) |
| PRB-3/4 | reject and archive rewrote an applied record |
| PRB-5 | revise reopened a rejected proposal as `revised` |
| PRB-6 | apply returned `installed:<kind>:<id>:<digest>` and set `applied`; nothing was installed anywhere |
| PRB-7 | apply took no body; a revise between the reviewer's read and the click was applied unseen; the read exposed no revision or digest to bind to |
| PRB-8 | `GET /proposals` wrote a demo proposal (citing a run `demo-run-1` that does not exist) into every workspace that listed |
| PRB-9 | a signed-in caller with no role in the workspace listed and read every proposal |
| PRB-10 | `?state=live` / `?kind=rule` returned an empty 200 |
| PRB-11 | the agent tool listed with no acting person, and for a person with no role |
| PRB-12 | `agents.proposals` advertised all four kinds as activatable |

RFC 0096 §C: `apply` "MUST route through the advertised `activation` mode … on success
installs the artifact via the relevant pack/registry path (RFC 0043) and sets `state:
applied`". §E.2 adds that under `approval-gate` the host "MUST NOT install the artifact unless
the gate is `granted`". This host has **no installer for any kind**, and its `approval-gate`
branch mints an approval nothing ever releases (`git grep reviewable-learning` finds only the
minting site). The round-1 grades (A / A−) checked the pin-site gate and the `packs:publish`
403 and never read what `apply` claims. The conformance behavioural leg only checks that an
unscoped apply is 403, so it passed throughout.

## Boundaries audit

- **Owner.** `features/proposals/*` is the only RFC 0096 store. ADR 0473 composed-workflow
  proposals (`host/workflowComposeTool.ts`) are a different lane — runnable drafts, hash-pinned
  review, real registration — and stay untouched. KickTodo coach proposals (ADR 0501) are
  unrelated.
- **Installers that exist.** Prompt templates: the in-memory `host/promptStore` is
  process-global (installing a tenant's proposal there would leak it to every tenant), and the
  prompt library (ADR 0116) is org-scoped and *references* templates, never stores one. Chain
  packs: the from-chain route (`routes/workflows.ts:1096`) instantiates a chain the host already
  loaded from a signed pack (ADR 0163 Ed25519 + SRI); there is no inline-manifest ingest, and
  adding one would be a second, unsigned pack-ingest door. Automations: the scheduler takes a
  workflow id, not an RFC 0052 job spec. Agent packs: the registry installer takes signed
  packs only. **No kind has an installer a proposal could use today.**
- **The producer's artifact.** `{toolSequence, occurrences}` is a list of agent tool *names*
  (`ambient-work-graph/runSignature.ts`), not node type ids and not an RFC 0013 manifest. No
  deterministic, non-LLM mapping from it to a chain exists, and synthesizing one at apply would
  break `proposal-no-resynthesis`. The real "turn this into a workflow" path is the Workflow
  Architect hand-off the accept route already returns (`draftSeed`).
- **Authority helpers.** `assertTenantScope` (`host/accessControlService.ts:2291`) is the
  feature-free tenant predicate that `requireTenantScope` wraps (ADR 0617 D2), so a route and a
  tool can share it. `DurableCollection.compareAndSwap` (`hostExtPersistence.ts:871`) is the
  real CAS.

## Decision

### D1 — Apply installs only through an installer; with none, it refuses

A module-level installer seam in the feature, `registerProposalInstaller(kind, install)`,
where `install(tenant, proposal)` returns `{ installedArtifactRef }` from a real write. `apply`
looks up the installer for the proposal's kind **after** every other check (scope, state,
binding). With no installer it answers **409 `proposal_not_installable`** (`details.kind`), the
row is unchanged, and no `installed:` string is produced anywhere. This host registers **no
installer** in this ADR (see D7 for why each kind is deferred), so every apply on this host is
refused honestly. `installedRefFor` (the hash that impersonated an install) is deleted.

### D2 — The approval-gate branch is deleted

`OPENWOP_PROPOSALS_ACTIVATION` and `activationMode()` are removed. Nothing released the
approval, so the branch could never install and never transition; it only minted orphan
approvals. When a real installer lands, activation is re-decided with it (an RFC 0051 gate
needs a release handler that runs the installer — a design, not a flag).

### D3 — The advertisement is derived from the installer seam

`agentsCapability()` advertises `agents.proposals` only when `OPENWOP_PROPOSALS_ENABLED=true`
**and** at least one kind has an installer, with `artifactKinds` = exactly those kinds and
`activation: 'direct-rbac'`. Today that is never, so the block is absent on every deploy. The
CLI gates on the block and fails closed, which is the honest outcome. The conformance
behavioural leg then skips on the behaviour gate instead of passing on a 403 that proved
nothing about install. `duplicationDetection` stays `false`.

### D4 — A transition table and a revision CAS

| from \ action | revise | apply | reject | archive |
|---|---|---|---|---|
| `draft` | → `revised` | → `applied` (D1) | → `rejected` | → `archived` |
| `revised` | → `revised` | → `applied` (D1) | → `rejected` | → `archived` |
| `rejected` | 409 | 409 | 409 | → `archived` |
| `applied` | 409 | 409 | 409 | 409 |
| `archived` | 409 | 409 | 409 | 409 |

Refusals are **409 `proposal_state_conflict`** with `details: {state, action}`. Every write is a
`compareAndSwap` on the row read, with a per-row `revision` counter (absent ⇒ 0, bumped on
every write). A lost CAS is **409 `proposal_stale`**. Rejected → revise is refused because a
rejection is a decision about the content, and reopening it under the same id would let the
rejected thing return to the queue looking reviewed; a new proposal is the honest path.
Applied is terminal: an installed thing is removed through its installer's own surface, never
by relabelling the record.

### D5 — Apply binds to what the reviewer saw

`GET` (one and list) returns two derived fields per row: `revision` and `artifactDigest`
(`sha256`, hex, of `artifact` serialized with object keys sorted at every depth — a storage backend that reorders keys, as Postgres `jsonb` does, must not move the digest; A3). `POST …/apply` **requires**
`{revision: number, artifactDigest: string}`; either missing or mistyped is **400
`validation_error`**. A mismatch with the stored row is **409 `proposal_stale`** with the
current `revision`/`artifactDigest` in `details`, so a client can re-show and re-ask. PATCH,
reject and DELETE **accept** an optional `revision`, checked when present (409 on mismatch),
and always CAS internally. Reject is not binding-required: refusing unseen content is the safe
direction (the ADR 0592 CMS precedent).

### D6 — Reads are authorized, write nothing, and validate their input

- `ensureDemoProposal` is **deleted**, with its call in `GET /proposals`. A list never writes. Its only purpose was the conformance leg, which D3 retires honestly.
- One predicate, `assertCanReadProposals(tenant, subject, ctx)` →
  `assertTenantScope(tenant, subject, 'workspace:read', ctx)`. The routes call it with
  `callerSubject(req)` + `{personalTenant, wildcardOperator}` (the `requireTenantScope`
  threading); the tool calls it with `scope.actingUserId` + `{personalTenant:
  scope.personalTenant}` and returns `{proposals: []}` when it throws or there is no acting
  user. The tool stays `contentTrust: 'untrusted'`. (A5: the predicate judges one subject spelling, like `requireTenantScope` everywhere it is used; the ADR 0775 two-spelling union needs a request, which the tool lane does not have. The mutation gates (ADR 0736) already judge one spelling, so the feature stays consistent with itself.)
- `?state=` / `?kind=` outside the enums → **400** (`details.field`). The tool keeps ignoring
  an unknown filter value but says so (`ignoredFilters`) rather than silently widening.

### D7 — What each kind's installer would need (deferred, filed)

| Kind | Real install path | Why not in this ADR |
|---|---|---|
| `workflow-chain-pack` | validate an RFC 0013 manifest closed-world → `expandChain` → `registerWorkflowDurable` + `recordOwnership` (the from-chain lane, ADR 0770 stage-check-commit) | a second, unsigned chain ingest door; needs its own security decision (pack trust, disabled-pack choke, node allowlist). The only producer emits no manifest. |
| `prompt-template` | a tenant/org-scoped template store the prompt library can reference | the host store is process-global; no tenant-scoped template store exists |
| `automation` | an RFC 0052 job spec → the scheduler | the scheduler takes workflow ids; the spec → job mapping is undesigned |
| `agent-pack` | the signed-pack registry installer | proposals carry no signature; unsigned agent packs are out of policy |

Filed as `PROP2-R1` (installers, one ADR per kind when a producer emits that kind's real
artifact). `PROP2WF-9` (the producer's `kind` label) rides with it: an installer validates the
artifact closed-world, so the AWG skeleton would be refused 422 even under a chain installer.

### D8 — Existing rows (corrected by A1/A2)

No backfill writes. Two kinds of row already stored are false, and the reads stop serving
them as true:

- **The seeded demo row.** Every workspace that ever listed holds
  `demo-reviewable-learning`. Deleting the seeder (D6) stops new ones, but the old ones would
  keep reaching the agent as "learning history". So every read lane — list, get and the tool —
  excludes that one id (`DEMO_PROPOSAL_ID`, a constant). It stays in storage for the operator
  (OQ-1); it is never served.
- **Rows marked `applied` by the deleted hash path.** Their `activation.installedArtifactRef`
  starts with `installed:` and names nothing installed, and D4 makes `applied` terminal. The
  architect pass (A2) proposed presenting them `verified: false` and letting them be archived.
  **Prod measured 0 such rows** (§ Prod exposure), so that branch is not built. A self-hosted
  deploy that applied one keeps a terminal record carrying a false ref; this ADR is where that
  is recorded.

### D9 — The eraser writes by CAS too (A4)

`eraseSubjectProposals` replaced the row with a blind `put`. With D4's CAS writers beside it,
a revise landing between the eraser's scan and its put would be overwritten, and the reverse
order cannot happen only because the revise CASes. The eraser now CASes on the row it read,
bumps `revision`, and re-reads + retries once on a lost race (a person's erasure must not be
lost to a concurrent edit).

## Alternatives weighed

1. **Keep advertising, refuse apply.** Rejected: an advertisement whose activation never
   succeeds is a capability the host does not honour (CLAUDE.md "the host must actually honour
   the behaviour"); `OPENWOP_REQUIRE_BEHAVIOR` would rightly fail it.
2. **Ship a workflow-chain installer from the AWG skeleton.** Rejected: tool names are not
   node types, and building a chain from them needs synthesis at apply time — exactly what
   `proposal-no-resynthesis` forbids. An LLM-built draft belongs to the ADR 0473 lane.
3. **Keep `approval-gate`, add a release handler that flips `applied`.** Rejected: it would flip
   `applied` without installing anything, i.e. PRB-6 behind one more step.
4. **Keep the demo seeder for conformance non-vacuity.** Rejected: it fabricates a learning
   record (with a non-existent source run) in real workspaces, which the agent then reads as
   history; non-vacuity bought with fake data is the vacuity it was meant to cure.
5. **Optional apply binding.** Rejected (the row-49 lesson): an optional check protects only
   callers who already behave.

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D4 transitions + CAS + `revision`; D5 binding + derived fields; D1 installer seam + refusal; D2 deletion | PRB-1..7 |
| P2 | D6 reads: predicate, tool, filters, seeder deletion | PRB-8..11 |
| P3 | D3 derived advertisement; FEATURES.md row; ADR 0039/0736 correction notes | PRB-12, discovery tests |
| P4 | `/grade-ux` + `/grade-code`; sabotage each guard | the probe file |

## Implementation record

| Phase | Commit | Witness |
|---|---|---|
| P1–P3 (D1–D9) | `38caa1596` | `proposals-r2-probes.test.ts` PRB-1..12 (14 RED on `b0ff69efa`), `proposals-service.test.ts`, `proposals-erasure.test.ts` D9 race |
| Docs (FEATURES, ADR 0039/0736 notes, exchange audit) | the docs commit after it | — |
| `/grade-ux` (`PROP2UX-1`) | `c8b577324` | PRB-4 asserts the sentence |
| `/grade-code` (`PROP2CD-1..4`) | `6227d7b08` | `PROP2CD-1..4` probes |

21 sabotages (each guard reverted alone), all red.

## RFC verdict

Host-extension. RFC 0096 is Accepted and its shape is unchanged; this host stops advertising a
behaviour it did not implement. **Upstream note for `../openwop`:** RFC 0096's Accepted line
cites this host's `proposal-reviewable-learning` 7/7 as a witness. Only the 403 leg was
behavioural, and the "installed" ref behind it was a hash, not an install. The note is for the
maintainer; it does not change the RFC (MyndHyve is the other cited witness).

## Architect pass (2026-10-19, adversarial, before code)

| # | Sev | Finding | Folded into |
|---|---|---|---|
| A1 | **Blocker** | D8 left the seeded demo row in every workspace that listed, and the agent tool kept reading it as the workspace's learning history. "A list never writes" fixed the generator and left the output served. | D8: every read lane excludes `DEMO_PROPOSAL_ID` |
| A2 | **Blocker** | D4 makes `applied` terminal, so a row the deleted hash path marked `applied` (nothing installed) could never be corrected, and it would keep saying "applied". | D8 — then RESOLVED BY MEASUREMENT: prod holds 0 applied rows, so the branch is not built |
| A3 | High | "canonical JSON" was unspecified; `JSON.stringify` follows insertion order, which a `jsonb` round trip does not preserve, so the digest a reviewer saw could differ from the one apply computes for unchanged bytes. | D5: sorted-key serialization |
| A4 | High | The DSAR eraser blind-`put`s beside D4's CAS writers; a revise between its scan and its put is lost. | D9 |
| A5 | High | Withdrawing the advertisement turns the CLI's `proposals` group off on this host (it gates on the block), list and reject included. That is the honest result, but the ADR did not say it. | D3 already says the CLI fails closed; stated here as an accepted cost — the agent tool and the API remain |
| A6 | Medium | One subject spelling on the read predicate (see D6 note). | D6 note |
| A7 | Medium | Comments in `proposalsService.ts` (`createProposalFromAcceptedPattern`: "apply installs it verbatim") and the AWG accept route repeat the false install claim. | P1 rewrites both |
| A8 | Low | `apply` checks the binding before the installer lookup, so a stale caller learns `proposal_stale` before `proposal_not_installable`. Deliberate: the binding is the contract a future installer inherits, and testing it now keeps it from rotting. | D5 (no change) |

No boundary finding: no second store, no route collision (`grep -rn "/host/openwop-app/proposals"`
finds this feature only), and the ADR 0473 lane is untouched.

## Prod exposure

Read-only, by the lead, 2026-10-19 (serving revision `openwop-app-backend-01011-9qm`):

- `OPENWOP_PROPOSALS_ENABLED=true` in prod; `OPENWOP_PROPOSALS_ACTIVATION` unset. **So prod
  advertises `agents.proposals` with all four kinds and `direct-rbac` today**, and every apply
  would have reported an install that did not happen. D3 withdraws that advertisement on deploy.
- 4 proposal rows in 4 tenants, **all `demo-reviewable-learning` drafts** seeded by the list
  (PRB-8 live); 0 `wg:` rows, 0 other, 0 applied, 0 with `activation`.
- 0 approvals with roster/persona `reviewable-learning` (the dead approval-gate never ran).

No real user data is affected. The 4 demo rows stop being served on deploy (D8); deleting them
is a prod write for the operator (OQ-1).

**Behaviour change on deploy:** `/.well-known/openwop` stops advertising `agents.proposals`;
the CLI `proposals` group refuses on this host; `apply` answers 400/409 instead of 200;
`GET /proposals` needs `workspace:read` and stops seeding.

## Open questions

- [ ] OQ-1 — Delete the 4 `demo-reviewable-learning` rows in prod (measured)? A prod write for
  the operator/lead, not this ADR; they are no longer served after deploy (D8).
- [ ] OQ-2 — `PROP2-R1`: which kind gets a real installer first, and is its producer real?
- [ ] OQ-3 — RFC 0096 §D events (`proposal.created`/`activated`): only meaningful once
  something installs. Filed with `PROP2-R1`.
- [ ] OQ-4 — Archived-row GC (round-1 `PROPWF-2`) still open.
