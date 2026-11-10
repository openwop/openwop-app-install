# ADR 1014 — agent versions side by side

Status: Accepted (2026-10-31; the user accepted the Q1–Q3 recommendations and all phases)

The user decided on 2026-10-31 that an agent's deployment versions must be **real**:
the version a deployment chooses is the version whose code runs, and installing a
new agent pack must not put it live before it is promoted. This ADR is the host
work that makes ADR 1005's lifecycle mean what it says. It replaces ADR 1005 P3b
("mint a draft on pack install"), which on today's runtime would label code that
is already live as `draft`.

## Context

Measured on `origin/main` `31a7d37ca` (file:line under `backend/typescript/src`):

- **One version per agent, everywhere.**
  - Disk: `installPackFromRegistry` extracts to `<packDir>/<name>/` and `rmSync`s
    any previous version first (`packs/registryInstaller.ts:161`, `:344-348`). The
    install marker holds one `version`.
  - Registry: `executor/agentRegistry.ts:136` keys `inProcess` by `agentId` (or
    `user:<tenant>:<agentId>`). Last registration wins. `get` / `resolve` take no
    version.
  - Lookups: every path that runs an agent (`host/agentDispatch.ts:267`, `:916`;
    `host/agentRunnerNode.ts:406`; chat `host/chatContext.ts:191`;
    `host/agentVisibility.ts:34`; `executor/handoffGate.ts:62`; A2A, evals, voice,
    widget, channels) resolves by id alone.
- **The channel pin is recorded but not obeyed.** `executor.ts:715` resolves a
  channel-bound node's version and writes `resolvedAgentVersion` on
  `agent.invocation.started`, but `ctx.nodeAgent` keeps the authoring ref
  (`:887`), and the dispatcher runs the registered manifest. `AgentRef.version` is
  never read.
- **A false record is reachable today.** `resolveChannel`
  (`features/agent-deployments/service.ts:129`) can return a version from a stored
  row that is no longer installed (a pack upgraded after the agent had deployment
  rows). The run log then says it ran `1.0.0` while `1.1.0` ran. Production has not
  hit it (no real agent has rows; the certified cut uses the reserved conformance
  agent, whose node is `core.identity`), but it is one upgrade away.
- **Tools are global.** Agent packs ship no nodes (30 of 30 surveyed; one bridge
  pack has one). `toolAllowlist` names unversioned typeIds, resolved against the
  one node registry (`executor/nodeRegistry.ts:13`, one module per typeId).
- **User agents overwrite in place.** `packVersion: '0'`, a content-hash ETag, no
  history (`routes/userAgents.ts:270-300`, `:476`, `:688`).
- **Precedents.** The dev mount already parks a shadowed registry install as
  `<name>.registry-<version>/` and never loads it (`bootstrap/mountLocalPacks.ts:72`,
  `:286-296`). Revocations are already per `name@version`
  (`host/packRevocations.ts:43`). The chain loader compares versions and keeps one
  winner (`host/workflowChainPackLoader.ts:688-783`).

## Decision

### D1 — Keep prior agent-pack versions on disk

The live directory stays `<packDir>/<name>/` (the head), so every existing scan,
mount, trust check and tool keeps working unchanged. When an install replaces a
pack that holds agents, the outgoing version is first **moved** to
`<packDir>/.versions/<name>/<version>/` (with its marker and signature) instead of
deleted. Dot-prefixed, so no existing `readdirSync` scan sees it.

Retention: a version is kept while any tenant's deployment row names it, plus the
newest ten regardless (Q3). A prune runs after install and after a deployment
transition. Node packs, chain packs and other kinds are not archived (D6).

> **CORRECTED 2026-10-31 (user decision, before P1 shipped) — in production the
> archive is a CACHE filled from the registry, not carried over.** Found by the
> coordinator's review of #5417: `openwop-app-backend` mounts **no volume**, and
> every Cloud Run instance boots an empty disk and installs exactly one pinned
> version per pack (`OPENWOP_INSTALL_PACKS`, e.g. `core.openwop.agents@1.0.2`). An
> archive-on-replace therefore never holds anything in production, and every older
> version a deployment named would read as unavailable. The user chose **"at startup
> + on promote"** over fetching inside a run:
> - `installLane.fetchArchivedVersion(name, version)` installs exactly that version
>   through the same signed, verified installer the boot lane uses (`destDir`
>   override, never the head) into a hidden temp dir, then renames it into
>   `.versions/<name>/<version>/`. It is single-flight per version per instance and
>   bounded (60 s). It never throws: a failure is logged and returns `false`.
> - It runs **in the background** at boot (every version any deployment row
>   names), after an applied transition (that agent's named versions), and when a
>   pin finds its version missing on this instance.
> - **A run never waits on the network.** A missing version fails the node at once,
>   typed (`agent_version_unavailable`, P0), and the background fetch makes the next
>   run succeed. A replay or fork keeps its recorded version and never falls back.
> - No new kind of egress: production already fetches signed packs from the same
>   registry at boot.
> - The archive-on-replace step (D1 above) stays for non-ephemeral hosts (dev,
>   self-hosted), and it is best-effort: a failed move falls back to today's replace
>   and never fails the install.
>
> Witnessed: one download for concurrent requests; a bad signature caches nothing;
> a refused or hung registry returns `false` (bounded) with no fallback; a failed
> archive still installs; a pinned X stays X when the channel moved to Y.

### D2 — The registry resolves `agentId@version`

`AgentRegistry` gains an optional `version` on `get` / `has` / `resolve`, and the
`AgentPackResolver` signature gains it too. Lookup order:

1. no version, or the head's `packVersion` → the head (today's behaviour);
2. else a cached `agentId@version` entry;
3. else load `<packDir>/.versions/<name>/<version>/pack.json` through the same
   `loadAgentsFromManifest` (same trust gate, same namespace check, same
   `name@version` revocation check), register under `agentId@version`, return it;
4. else `null`. A caller that asked for a version never falls back to the head.

### D3 — The pinned version reaches the dispatcher

`executor.ts` puts the resolved pin on the node context (`ctx.agentVersion`), and
`agentRunnerNode` → `RunAgentBinding` → `AgentDispatchRequest.version` carry it to
the registry lookup. A version that cannot be loaded fails the node closed:
`validation_error`, `details.reason: "agent_version_unavailable"`. Never a silent
run of other code under a recorded version.

### D4 — What runs when nothing names a version

Today an unbound invocation (chat, an agent-runner node with no channel, A2A, a
schedule, a widget) runs the head. With side-by-side versions that would make every
install go live at once, which is the thing the user ruled out. So:

- **An agent with no deployment rows** runs its head (today's behaviour, and
  ADR 1005 D2's synthesized baseline already says installed = serving).
- **An agent with deployment rows** runs what its `stable` channel resolves to,
  through the same resolver, with a deterministic draw key per invocation. An
  install of a new version then mints that version as a `draft` row and changes
  nothing that runs until it is promoted (this is what ADR 1005 P3b becomes).

One choke point implements it (`resolveServingVersion(tenant, agentId, drawKey)` in
`host/agentChannelPin.ts`), and every lookup in the Context list calls it. A test
ratchet pins the list, so a new lookup site cannot skip it.

### D5 — Record what ran

Every agent invocation records `agentPackName` + `agentPackVersion` on its
`agent.invocation.started` (or the run's own agent event where there is none
today: chat turns, evals, A2A). A fork's continuation re-resolves the **recorded**
version, not the live serving one, exactly as D5 of ADR 1005 does for channel pins.
Replay already reads recorded AI and tool results and is unchanged.

### D6 — Tools stay global (a stated limit)

An archived agent version runs against the **current** node and tool modules. Agent
packs ship no nodes today, and `toolAllowlist` names global typeIds, so freezing
tools per agent version would mean versioning the node registry too. That is a
separate decision. Here it is stated, not hidden: the deployment console (ADR 1005
P3c) shows "tools are shared across versions".

> **CORRECTED 2026-10-31 (before acceptance): a missing tool does NOT fail closed
> today.** The first draft said it did. `compileAgentTools`
> (`host/agentDispatch.ts:584`) intersects the allowlist with the available tools
> (`filterTools`), so a tool that no longer exists is **silently dropped** and the
> agent runs without it. For a pinned non-head version that is the dishonest state
> this ADR exists to remove, so D6 adds one guard: **a version-pinned dispatch
> refuses (`agent_version_unavailable`, `details.missingTools`) when any tool its
> own allowlist names is unavailable.** The head keeps today's behaviour.

What a version keeps and what it shares, measured on the 24 parked old-version
pairs in this machine's pack dir: **8 of 24 changed their `toolAllowlist`** between
versions. The allowlist is part of the agent manifest, so an archived version keeps
its own list, and that difference is preserved. **All 17 tool ids** the old versions
name still exist today. So the shared part is tool **implementations**, which
change only with node packs and host built-ins, and those already carry their own
version and replay guarantees (recorded AI and tool results; `nodePinMismatches`).

### D7 — User agents get revisions (last phase)

A user agent edit writes a new revision (`1`, `2`, …) instead of overwriting, keeps
the newest N, and its `packVersion` becomes the revision. With deployment rows, an
edit is a new draft (D4). Without rows, an edit is live at once (today's
behaviour). This needs a storage revision table, so it is the last phase.

### D8 — The text a person types into a user agent can be erased (2026-11-01, user decision)

Added after P5 shipped. The user ruled that a user agent's free text (prompt,
persona, label, description) gets an ADR 0464 erasure path. The text can name
anyone, and erasure cannot find a person inside prose by their opaque key (ADR
0464 §7, accepted residual 3), so the eraser works from authorship instead:

- **Who wrote it.** Each revision row records `authoredBy`, the session user of
  the create or edit that stored that content. A create now writes revision `0`
  at once, so the original text is attributed too. A catch-up snapshot (the
  pre-edit content of an agent that had no rows) has no author. So does every row
  written before D8. Neither is reached, and nothing is backfilled.
- **What erasure does.** `eraseSubjectUserAgentRevisions` DELETES each revision
  the subject authored, text and all, unless the agent is serving it: the head,
  or a revision a deployment row names. A serving revision keeps its text and its
  `authoredBy` becomes `[erased]`, because deleting it would break an agent the
  tenant still runs. When the pinned set cannot be read, every row counts as
  serving (redact, never delete a revision a deployment might serve).
  Known window (review, 2026-11-01): the serving set is read once per agent,
  before the walk. A deployment that pins revision N between that read and the
  delete can lose N, after which it fails closed (`agent_version_unavailable`).
  It is rare and only at DSAR time. A follow-up can re-read the pins just before
  each delete.
  > **Narrowed 2026-11-01 (follow-up).** The serving set is now read just before
  > each row, and again after a delete. A revision pinned between the two is put
  > back with `authoredBy: [erased]`. Only a pin made after that second read can
  > still lose its revision, and it fails closed as above. Pinned by the race case
  > in `test/adr1014-d8-user-agent-erasure.test.ts`, which pins revision `0` right
  > after the eraser's first read.
- **Not reached.** The live user-agent row (SQL) has no author field, and adding
  one needs a migration on both stores; its text is the same as the head
  revision, which is kept for the reason above. The tenant can still delete the
  agent, which purges every revision, and ADR 0284 teardown covers the rest.

The store moved from `REVIEWED_EXEMPT` to `ERASED` in
`test/subject-erasure-coverage.test.ts`, and the eraser joined the WF-CONS-2
manifest. Pinned by `test/adr1014-d8-user-agent-erasure.test.ts`. Sabotage
witnesses: dropping the author from the create, or from the edit, reds it.
So does deleting serving revisions.

## Review of P2–P5 (2026-10-31) — corrections and one flag-on blocker

An independent review of P2–P5 found eleven defects. All but one are fixed, with tests that each go red when their fix is removed:

- **H1:** the console tab's probe re-ran on every render, re-fetched in a loop and could not stay open. It now probes once per agent through a stable tab reference (`workspaceDeploymentsTab.test.tsx`).
- **H2:** after a restart, user agents registered as version `0` with their latest content, so a run could record `0` while revision 2 ran. Every registration path now uses `revisionForRecord`.
- **M1:** concurrent edits could attach a revision number to the wrong content. Numbering now follows the stored record (`alignHead`, before and after the record's own CAS).

  > **Correction (2026-11-04, TST-FIB-GC1): M1 was not fixed in two places.** (1) The
  > after-CAS `alignHead(updated, …)` numbered the CALLER's copy, not the stored record. A
  > forced race (edit A parked after its CAS while edit B saved) made head 3 = `a` while
  > the agent held `b`. The unforced `Promise.all` M1 test never produced that order. (2)
  > `alignHead` ignored a failed revision-row write, so a second aligner could point the
  > head at a row holding the first aligner's content. Now the route re-reads the stored
  > agent after its CAS and numbers and registers that. `alignHead` treats a taken row as
  > another aligner's step and finishes it, and re-reads the stored record on every retry
  > (`reload`). Both halves are pinned by a forced-race test that is red on `96cd0524a`
  > (`tst-fib-gc1-revision-race.test.ts`). Found by grade-tests w83 (1b).
- **M2:** a deleted user agent left its revisions, head and deployment rows behind. They are purged on delete, and the registry's cached revisions are evicted on every instance.
- **M3:** with the flag off, an edit of a deployed user agent could not be promoted. Drafts are now minted whatever the flag says, because minting changes nothing that runs. Only the newest edit is the draft: older edit drafts are superseded.
- **M4:** the D6 tool guard refused a caller's deliberate narrowing. It now asks whether the host knows the tool (`resolveTool`).
- **M5:** a refused serve degraded chat to the default prompt. Chat now returns a typed 409, and the responder node fails `agent_version_unavailable`.
- **L1:** the eval no longer emits `resolvedAgentVersion`, a channel-only field on the certified path.
- **L2:** integer revisions sort numerically.
- **Smaller items:** `01` is not revision 1, the first no-op edit mints nothing, an alias id still forwards the pin, and a numbering fault never fails the edit.

**M6 is not fixed, and it BLOCKS turning `OPENWOP_AGENT_VERSIONS` on.** With the flag on, a served (unpinned) version is drawn per invocation and is not recorded. So a fork or resume can redraw. Voice draws its prompt and its tools under different keys. The `/agents` dispatch route and eval trials pass no draw key. Eval and KickTodo provenance stamp the head while the served version runs. The fix is to resolve the served version once per run or session, record it, and pass it on as an explicit `version`. That is a prerequisite for the flag-on approval, not a follow-up.

> **CORRECTED 2026-11-01 — M6 is fixed** (`test/adr1014-m6-served-version-recorded.test.ts`, each case sabotage-witnessed red):
>
> - **Runs.** An unpinned agent in a run (an agent-runner node with no channel or version, the chat responder node) resolves `stable` ONCE per `(run, agent)` through `pinServedAgent` (`host/agentChannelPin.ts`, reached as `ctx.pinServedAgent`) and records it exactly like a channel pin: `agent.invocation.started` with `resolvedChannel: 'stable'` + `resolvedAgentVersion`, closed by `agent.invocation.completed`. A resume or a second node reuses this run's record, and a fork reuses its parent's, even after the deployment moved. An agent with no deployment rows records nothing and runs its head, as with the flag off. A served version this host cannot load fails the node `agent_version_unavailable`.
> - **Voice.** The tool declarations and the tool-call entitlement draw on the session's conversation, the same key `composeChatContext` uses for the prompt, so one call never pairs one version's prompt with another's tools.
> - **Evals.** An eval created without a named version, while versions are served, resolves the served version once at creation and records it (`metadata.eval.agentVersion` + `agentVersionServed: true`). Every trial and a resume dispatch exactly it, and the promotion gate holds that eval to it (`eval_of_another_version`), as for a named one.
> - **`POST /agents/{id}/dispatch`** draws once per dispatch (its own `agent-dispatch:` id), not on the agent id.
> - **KickTodo convene** stamps `specialistVersion` from, and confines the run to the allowlist of, the version the deployment serves. **Residual:** the convened specialist runs in a separate scheduled run, which records its own served version. In a canary split those two draws can differ, and that run's `agent.invocation.started` is the record of what ran.
>
> Still open and NOT part of M6: chat and A2A turns are not recorded per turn (they draw on the conversation id, which is stable while the deployment is); recording per turn needs an RFC.

## Alternatives considered

- **`<name>/<version>/` as the live layout.** Cleaner, but it moves every scan, the
  dev mount, the trust and revocation caches and the CLI's expectations at once. D1
  gets the same capability with the head where everything already looks.
- **Labels only (keep ADR 1005 as is).** Rejected by the user: a record that names
  a version the host is not running is the dishonest state this repo refuses
  elsewhere.
- **Load every installed version at boot.** Memory and boot time grow with history;
  D2 loads archived versions lazily, only when a deployment asks.
- **Version the node registry too.** Correct in the limit, and far larger. D6 states
  the gap instead.

## Implementation plan

| Phase | Scope | Gate |
| --- | --- | --- |
| P0 | `resolveChannel` refuses a version that is not installed (head or archive): the node fails `agent_version_unavailable` instead of recording a version that did not run. Closes the false-record gap now. | **done** (this PR): the check sits in the pin seam (`AgentChannelResolver.available`, `host/agentChannelPin.ts`), so a fresh, a reused and a fork-inherited pin are all checked; until P1 only the installed head is available. `test/adr1014-p0-version-unavailable.test.ts`, 3 cases, sabotage-witnessed |
| P1 | D1 archive-on-replace + retention prune; D2 versioned registry + resolver; tests on a real install of two versions | **done** (this PR): `packs/agentPackArchive.ts` (archive before the replace, prune newest 10 + row-named via `setArchivePinnedVersions`), `AgentRegistry.get/has/resolve(…, version)` + `registerVersion` + `setAgentArchiveResolver` (bootstrap loads `.versions/<name>/<version>/` with `archived: true`), P0's `available()` now admits an archived version. `test/adr1014-p1-agent-archive.test.ts` (real installer, signatures, trust) |
| P2 | D3 pin → dispatch; D5 recording on workflow nodes; fork re-resolves the recorded version | **done** (this PR): `ctx.agentVersion` (the pin's version, or the node's exact `agent.version`) → `agentRunnerNode` → `AgentDispatchRequest.version` → `registry.resolve(id, tenant, version)`; a version that cannot load is `AgentVersionUnavailableError` → node `agent_version_unavailable`; D6 guard (an ARCHIVED version whose own allowlist names a tool the host no longer offers refuses, `missingTools`; the head keeps `filterTools`). Workflow-node recording is the pin event P0 already checks; a fork reuses the recorded pin. An exact `agent.version` is now enforced too: before ADR 1005 P1 (10-30) registration dropped `agent` entirely, so no older workflow carries one, and none in `packs/` or `examples/` does (measured). `test/adr1014-p2-pin-dispatch.test.ts` + P0 file additions, sabotage-witnessed (dispatch ignores version; no D6; executor drops it; runner does not forward) |
| P3 | D4 serving resolution at every lookup site + the ratchet; install mints a `draft` row for an agent with rows | **done** (this PR), default OFF: `host/agentServing.ts` (`resolveServedAgent`, seam filled by the feature: no rows → head, `stable` → that version, rows with nothing on `stable` → refused, never the head; user agents keep their head until P5). Wired at the five prompt-executing sites (live dispatch, chat context, realtime voice, chat widget, chat-responder node); `drawKey` keeps one run/conversation on one canary side. Install hook mints a `draft` row in every tenant that deploys the agent (create-if-absent, flag-gated). Ratchet `test/adr1014-p3-serving.test.ts` pins the metadata-only reader list. Turning the flag on in prod is a separate user approval |
| P4 | D5 for chat, evals, A2A; the ADR 1005 P3c console shows versions | **P4a done** (this PR): an eval run names the version it tests (`configurable.agentVersion`, a host extension beside `baselineRunId`'s old spelling; 404 when not loadable), records the version it ran on every eval (`metadata.eval.agentVersion`, `resolvedAgentVersion` on its `agent.invocation.started`, a seated v2 field), and its trials dispatch exactly a named version. The ADR 1005 eval gate refuses a passed eval that NAMED another version (`eval_of_another_version`); an un-versioned eval still promotes, so the certified `v2-deployment-eval-gate` path is unchanged. Chat and A2A run the served version (P3) but do not yet record it per turn: their events have no seated version field, so that waits on an RFC. **P4b done** (this PR): the agent workspace's Deployments tab (`features/agent-deployments/`, lazy panel + lazy `agent-deployments` i18n namespace in en/es/fr/pt-BR): versions with state, channels and canary share; the transitions each state allows (rollback and deprecate confirm as destructive); a held transition reads as "sent for approval", never as applied (RFC 0254: the 202 record equals the prior apart from `transitionRunId`); the D12 policy editor (a fixed policy is read-only; writes need `host:org:manage`, the server's refusal is shown); viewers see but cannot act; the tab appears only where the list answers (404 ⇒ hidden). It states "tools are shared across versions" (D6). The emailed-link 403 page (ADR 1005 D13 follow-up) is not in this slice |
| P5 | D7 user-agent revisions | **done** (this PR), **no SQL migration**: revisions live in the host-extension KV (`host/userAgentRevisions.ts`, `DurableCollection`s `user-agent-revisions` + `user-agent-revision-heads`, tenant-partitioned). A never-edited agent has no rows and is version `0`, exactly as before, so every deployment row written before this still names the same content; its first content-changing edit snapshots the old content as `0` and writes `1`; a no-op edit mints nothing. The registry resolves a user agent's `agentId@revision` only within its owner tenant (the versioned key carries the tenant). With rows, an edit arrives as a `draft` (flag-gated, D7); serving (D4) now covers user agents. Retention: newest ten + every revision a row names |
| P6 | D8 erasure of user-agent text | **done** (this PR): `authoredBy` on revision rows, revision `0` written at create, `eraseSubjectUserAgentRevisions` in the host boot list; no SQL migration |

No wire change: `resolvedAgentVersion` already exists. `agentPackName` /
`agentPackVersion` on `agent.invocation.started` are new payload keys. The v2 def
is closed, so they ride `vendor.openwop-app` until an RFC seats them. That RFC is a
P2 follow-up, not a precondition.

## Questions settled (2026-10-31; the user accepted each recommendation)

- [x] **Q1, the default for unbound callers.** *Recommended: `stable`, fixed, no
  per-agent override yet.*
  - Precedent: Amazon Bedrock keeps edits in a mutable `DRAFT` reached only through
    a test alias, and an application calls an alias that points at an immutable
    version. Dialogflow CX sends an unspecified environment to the default one, and
    Google's own guidance is "always use versions for your production traffic"
    because a draft breaks easily. Both make the production pointer the default and
    keep the newest build off it. `stable` is that pointer here; `latest` would
    repeat Dialogflow's draft pitfall.
  - Blast radius: agents with no deployment rows keep running their head, so nothing
    changes for anyone not using deployments (all of production today).
  - Defer the override. A `defaultChannel` field fits ADR 1005 D12's policy later
    and adds nothing until someone needs a second production pointer.
- [x] **Q2, shared tools.** *Recommended: acceptable for production, with the D6
  guard.* The measurement above shows the per-version part that matters (which tools
  an agent may use) is already versioned with the manifest. Versioning tool
  implementations would mean versioning the node registry, a separate and much
  larger decision with its own replay story. The one real hazard, a silently dropped
  tool, is closed by D6's fail-closed guard. Bedrock is comparable: an agent version
  fixes its action-group definitions, while the Lambda behind it is pinned only if
  the operator points at a published Lambda version.
- [x] **Q3, retention.** *Recommended: keep every version a deployment row names,
  never pruned, plus the newest 10.*
  - A version a row names is a rollback or canary target, and deleting its code
    would make D2 refuse it, so those are never pruned.
  - 10 matches Helm's default `--history-max` (Flux uses 5). Dialogflow ES caps an
    agent at 1000 versions.
  - Cost is negligible: the 25 installed agent packs measure median 24 KB, max
    64 KB, so ten versions of every pack is about 16 MB worst case on disk. Archived
    versions load lazily (D2), so memory grows only with versions actually invoked.

Sources: [Bedrock — deploy an agent (versions, aliases, DRAFT/TSTALIASID)](https://docs.aws.amazon.com/bedrock/latest/userguide/deploy-agent.html) ·
[Bedrock action groups (Lambda version/qualifier)](https://docs.aws.amazon.com/cli/latest/reference/bedrock-agent/get-agent-action-group.html) ·
[Dialogflow CX versions and environments](https://cloud.google.com/dialogflow/cx/docs/concept/version) ·
[Dialogflow ES versions and environments](https://docs.cloud.google.com/dialogflow/docs/agents-versions) ·
[helm rollback (`--history-max`, default 10)](https://helm.sh/docs/v3/helm/helm_rollback) ·
[Flux HelmRelease maxHistory (default 5)](https://oneuptime.com/blog/post/2026-03-05-helmrelease-max-history-flux/view)
