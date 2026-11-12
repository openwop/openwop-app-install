# ADR 1102 — Insights & Drafting: a draft the model can see, a gate in front of the mailbox, and runs that keep only their subject

**Status:** Accepted (architect pass folded in, 2026-11-11). Implementation on branch `fl2-91/insights`.
**Date:** 2026-11-11
**Extends:** ADR 0082 (the suite rebuilt on the engine), ADR 0599 / 0600 (feature 27, round 1), ADR 0677 (it.27). Toggle `insights-suite` is unchanged (registered default OFF, `bucketUnit: tenant`; prod stores `beta`).
**Composes:** ADR 0582 (gates that do not gate), ADR 0677 D2 (`core.email.draft` replay class), ADR 0025 / ADR 0787 D3 (schedule owner derived server-side), ADR 0815 D4 (`jobActors`), ADR 0464 + the subject-erasure census (`test/subject-erasure-feature-stores.test.ts`), RFC 0020 §D (untrusted fencing), ADR 0396 (settings panel registry).
**Decision source:** feature loop row 91. Grade: `docs/steward/workflows-assessment/2026-11-11-insights-row91.md` (`INS91-1..16`), read on `origin/main` `24183cc77b`. Prod read-only by the lead, 2026-11-11 (see Context).
**RFC verdict:** host-extension only, no new RFC. Every change is a pack node or chain (`feature.insights-suite.nodes`, the agents pack, the chain pack), an additive optional input on an in-process core node (`core.workday.query`), a host route under `/v1/host/openwop-app/*`, a subject eraser, or FE. No run-event field, capability, endpoint contract or scope changes.

## Context

Round 1 (ADR 0599/0600) made the nodes honest and the chains runnable, and proved it by executing all three chains end to end. That witness stubs the LLM node and ignores what it receives (`insights-chain-execution.test.ts:78-81`). It also asserts that each node *succeeded*, not what flowed between them. Read through the stub, the two people-facing chains do not do what they say.

**1. The recognition draft is written from an employee id** (`INS91-2`). `generate` (`core.ai.chatCompletion`) gets a portless edge from `retrieve` plus the declared inputs `subjectId` and `milestone`. The executor puts a portless edge's whole output map on `input` (`executor/scheduler.ts:401-413`), unwraps it, and spreads the declared inputs over it (`executor/nodeCtxInputs.ts:108-115`). `toMessages` then takes the first non-empty string as the whole user turn (`core.openwop.ai/index.mjs:83-97`). `retrieve` outputs no strings (`chunks`, `sources`, flags, numbers), so the user turn is `"subj-42"`. The exemplars and the milestone never reach the model. The Workday milestone rows reach nothing at all, because they are wired to `retrieve.milestoneRows`, a port `knowledge.retrieve` never reads.

**2. The draft is in the mailbox before anyone approves it, and the approver cannot see it** (`INS91-3`). The order is `generate → emailDraft → approve → notify`. `core.approvalGate` shows its *string* inputs as options (`bootstrap/nodes.ts:1137-1150`), and its input is `emailDraft`'s ids. ADR 0677 D2 left a branch fork free to re-run `core.email.draft` live, on the reasoning that `core.email.send` is safe *because an approval stands in front of it*. The draft has no gate in front of it, so every branch fork mints another draft.

**3. Every talent-prep run stores the workforce's performance reviews** (`INS91-1`). `pull` GETs `performanceReviews?limit=1000` with no filter. Every row lands in `node.completed.outputs` (`executor/executor.ts:1514-1522`, secret scrub only), in a run any `runs:read` member can open and every fork copies. `score` uses one subject's rows. `anniversary-draft`'s `milestones` does the same with service dates.

**4. The config door** takes the suite's acting identity from the body (`INS91-4`). Changing that identity orphans the previous job and trigger (`INS91-5`). The door arms an anniversary trigger whose chain can never be given its required params (`INS91-6`), and splits a list of business units into one silently analysed and the rest dropped (`INS91-10`). It persists `planSource` verbatim (`INS91-11`). Its one durable row is recorded DSAR debt that names this feature's owner as the one to decide (`INS91-8`). No screen reads or writes it (`INS91-9`).

**5. The Talent agent is told it reads HR data, scoped to reporting lines** (`INS91-7`). Its tools are `talent-score` and `knowledge.search`. ADR 0600 §8 fixed this class for the Financial prompt and pinned it with `PROBE-IS-11`. Talent got neither.

**Prod (the lead, read-only, 2026-11-11):** toggle `beta` with 0 tenant overrides. 1 config (no cron, anniversary off, more than one business unit). 0 `insights-weekly` jobs, 0 anniversary subscriptions. **0 runs of any of the three chains, ever.** 0 events mentioning performance data. 0 agent conversations. So every defect is latent. No stored row needs migration, purge or backfill. The one config row keeps its shape (D5 reads it as-is).

## Decision

### D1 — A run keeps only its subject's HR rows (`INS91-1`)

`core.workday.query` gains one **optional** input, `workerId`. When it is a non-empty string, the node keeps only the rows for which `String(row.subjectId ?? row.workerId ?? row.employeeId ?? row.id ?? '').trim() === workerId`. That is **the identical expression** `talent-score` uses (`index.mjs:242`), so the filter and the scorer cannot disagree about which row is whose. *(Architect M9: the first draft said "any of the four equals", a different rule under which a review row whose own `id` collided with the subject would pass the filter and be ignored by the scorer.)* A parity leg pins the two. The filtering happens **before** the node returns, so only matching rows are ever persisted. Outputs gain `scannedCount` (rows fetched) beside `rowCount` (rows kept), so a filter that matched nothing reads as "fetched N, kept 0", not as an empty source.

- `talent-prep` binds `pull.inputs.workerId = {{params.subjectId}}`.
- `anniversary-draft` makes `subjectId` **required** (chain 1.3.0) and binds `milestones.inputs.workerId` the same way. A recognition draft without a subject was never meaningful (D2 refuses it anyway), and the trigger lane cannot supply one either way (D6).
- Absent `workerId`, the behaviour is byte-identical, for every other caller.
- *(CORRECTED by the round-2 and round-3 code re-grades.)* A blank `{{params.subjectId}}` reached the node as `''`, and an omitted one as `undefined`. Both read as "no filter", and chain params are not validated at launch (`host/variablesRuntime.ts`; ADR 0504 deliberately ships no run-start refusal). So the whole workforce was fetched and persisted before `talent-score` refused. Both chains now set `config.requireWorkerId: true`, and the node then refuses an absent or blank id with `worker_id_required` **before any fetch**. The `minLength`/`pattern` added to the `subjectId` params are documentation for the builder form, not enforcement.

This is additive to an in-process node with no manifest (ADR 0677 D2 records why `core.workday.query` has none). No pack bump for the node, and no wire change.

**Not decided here:** filtering at the source with a Workday query parameter. That would also stop the fetch. Workday's REST filter shape varies by resource and tenant, and nothing here can test it. Filed as `INS91-17`. The persisted record is the exposure that matters, and D1 closes it.

### D2 — The model is handed a brief it can draft from (`INS91-2`)

A new pure node, `feature.insights-suite.nodes.recognition-brief` (node pack 1.3.0, `role:"pure"`, `cacheable`), builds the one user turn the draft step needs:

- **Inputs:** `subjectId` (required), `milestone` (optional param), `milestoneRows` (the Workday rows, already filtered by D1), `exemplars` (`retrieve.chunks`).
- **Milestone:** the supplied `milestone` wins. Otherwise it is read from the subject's row: a `milestone` string, or a numeric `serviceYears`. Both are values the row states. *(Architect B2: the first draft also turned `serviceDate` into whole years, which needs a clock the node does not have. A replay after the anniversary would build a different brief. A row with only a date is `insufficient_data`, and the message says to supply `milestone`.)*
- **Exemplars:** the `content` of each chunk, capped at 5 chunks and 1,500 characters each.
- **Fails closed:** `subject_required` with no subject; `insufficient_data` with no milestone from either source; `insufficient_data` with zero exemplars. The persona is "in their voice", and with no exemplars the honest answer is "add some", not a generic message.
- **Untrusted fencing:** every exemplar and every row-derived value goes inside ONE `BEGIN UNTRUSTED CONTENT … END UNTRUSTED CONTENT` block, in the exact shape of `fenceUntrustedBlock` (`host/untrustedContent.ts:165-171`). Every value is defanged first with **both** host matchers (`defangUntrustedFence` and `defangAngleFence`), so a chunk containing `END UNTRUSTED CONTENT` or `</UNTRUSTED>` (in any full-width, entity or zero-width spelling) cannot close the fence early. A pack cannot import the host module, so the node carries a copy. That copy is **test-pinned byte-for-byte** to the host functions over the host's own adversarial corpus, plus a leg asserting `hasUntrustedFenceMarker` is false inside the fence for every attack string. CLAUDE.md's "generated from its SSoT or test-pinned" applies here to the fence, not only to schema text. The word fence also leaves `applyUntrustedMarkers`' `<UNTRUSTED>` wrap free to apply on an untrusted-boundary run (`core.openwop.ai/index.mjs:103` skips a message that already contains `<UNTRUSTED>`). *(Architect B3: the first draft hand-rolled `<UNTRUSTED>` tags with no defang. That is breakable from inside, and it opted the message out of the run-level wrap.)*
- **Taint (ADR 1009):** when the brief consumes any exemplar or row, it calls `await ctx.markUntrustedContext?.()`. The approval that follows is shaped by tenant- and third-party-authored text, so the capability-token link lane must not decide it (`host/approvalTrust.ts:28-45`). The node is `role:"pure"` **without** `cacheable`: it is cheap, deterministic compute, and re-running on a fork re-marks the fork's run. *(Architect H6.)*
- **Outputs:** `prompt` (the string), plus `subjectId`, `milestone`, `milestoneSource` (`supplied` or `rows`) and `exemplarCount`, so the run says what the draft rested on.
- **Not a chat tool.** It is not added to `PROJECTABLE_COMPUTE_NODE_TYPE_IDS` or `BUILTIN_AGENT_TOOLS`, and no agent allowlists it. It is chain-internal.

Chain edges: `milestones.rows → brief.milestoneRows`, `retrieve.chunks → brief.exemplars`, `brief.prompt → generate.prompt`. `generate` drops its declared `subjectId` and `milestone` inputs. `prompt` is the first port `toMessages` reads, so the user turn is the brief by construction. The dead `retrieve.milestoneRows` edge goes. `retrieve` keeps only its `query` input.

### D3 — The human approves the text, and only then is the mailbox written (`INS91-3`)

New order: `… generate → approve → emailDraft → notify`.

- `generate.content → approve.draft` (a string port, so the card shows the draft text inline through `GateEvidence`).
- **An empty draft is refused before the gate.** `chatCompletion` returns `content:''` on an empty completion. A shown-nothing approval followed by an empty mailbox draft is the defect class this ADR closes, so `generate.content` is not wired straight to the gate. Instead the brief node's twin, `feature.insights-suite.nodes.draft-check` (pure; one input `draft`; `insufficient_data` when it is blank after trim, else `{draft}`), sits between them: `generate.content → check.draft`, `check.draft → approve.draft`, `check.draft → emailDraft.body`. *(Architect Low.)*
- `generate.content → emailDraft.body` stays as the data edge. A portless `approve → emailDraft` edge makes the draft wait for the decision. A reject fails the run at the gate (`routes/interrupts.ts:1952-1974`, `approval_rejected`), so a rejected draft never reaches the mailbox.
- `emailDraft → notify` as before.
- The gate prompt changes to "Approve this recognition draft. On approval it is saved as a DRAFT in your mailbox; nothing is sent."

This closes ADR 0677 D2's open half **for forks taken before the gate**: such a branch fork meets the gate before the mailbox, the same argument that made `core.email.send` safe. A fork whose `fromSeq` falls after `approve` completed carries the approval as history (`executor/forkInterrupts.ts:1-28`), and re-mints a draft of the already-approved text. Stated, not fixed: it duplicates content a human approved, the same posture ADR 0677 adopted for `send`. *(Architect H7: the first draft said "a branch fork now meets the gate", which is true only of the earlier fork.)* `core.email.draft` keeps `sideEffecting:true`. **Not done:** carrying an edited text from the card into the draft. The card's `content` lands on the gate's `output` object, and edges cannot select a nested field. Editing in the mailbox stays the path, and the prompt says so.

### D4 — The suite runs as the person who configured it, really (`INS91-4`)

- **Derived, never supplied.** `PUT /config` sets `principalUserId = callerSubject(req)` (the shared `host/requestSubject.ts:17` helper, replacing the route's local copy). A body `principalUserId` that is present and is **not** one of the caller's spellings (`callerOwnerSpellings`, `features/featureRoute.ts:286`) is refused `403 forbidden` with `{reason:'forbidden_principal'}`.
- **Never an anonymous session.** The route refuses a caller whose personal or active tenant is an `anon:` sandbox (`isAnonTenantId`, `host/requestSubject.ts:69`). An anon principal passes `requireActingSubject` and must not own a weekly job. *(CORRECTED during implementation: the first fold said `isDurableCaller`, which also refuses an API-key operator. The core scheduler's shared-workspace lane accepts that caller, and refusing it here would make this door stricter than the one it mirrors, for no named harm.)*
- **"Runs as" made true.** The job also carries `metadata.actingUserId = principalUserId`. That is what the shared-workspace scheduler lane stamps (`routes/scheduler.ts:409-412`), what the Connections resolver keys per-user credentials off, and what `jobActors` already lists for the removal and erasure cascade (`schedulingService.ts:446-454`). *(Architect B4: the first draft claimed "the suite runs as the person who configured it" while the job set only `ownerUserId`, which reaches the run as attribution and nothing else. It also cited `:286-289`, which is the `owner:'me'` lane; the shared-workspace lane is `:409-412`.)*
- **Take-over is explicit.** When the stored principal is not the caller, a save is refused `409 conflict` with `{reason:'principal_conflict', principalUserId}` unless the body says `takeOver: true`. With one admin, the stored principal is the caller, so the common case pays no extra round trip. *(Architect M14: the first draft's open question assumed the opposite, and its answer would have let a second admin fixing a cron typo silently take over a colleague's schedule.)*
- **The generic scheduler is no longer a second door.** A fire gate is registered with `reservedJobIdPrefix: 'insights-weekly:'` and `managedBy: {id:'insights-suite', …}` (ADR 0908 D2 / ADR 0985 D3, the `goals` and `campaign-ops` precedent). The generic route then refuses to mint, retarget, re-enable or re-own a job under that prefix. That also closes the squat vector `insightsSuiteService.ts:113-121` records. The gate's `owns` matches `jobId` prefix **and** `featureId === 'insights-suite'`, both server-written. Its `gate` returns `null`, because the fire-time feature check is already `featureId`. *(Architect H5.)*

### D5 — A save leaves exactly one job and one trigger (`INS91-5`, `INS91-10`, `INS91-11`)

- **Stateless reconcile by prefix.** After arming the intended ids, `applyConfig` lists the tenant's jobs (`listJobs(tenantId)`) and subscriptions (`listSubscriptions(tenantId)`), and deletes every `insights-weekly:${tenantId}:` job and every `insights-anniversary:${tenantId}:` subscription **except** the intended id (`deleteSubscription` exists, `triggerBridgeService.ts:396`). Nothing is diffed against the stored row, so a save that fails part-way heals on the retry, and any legacy orphan is cleaned on the next save. A failure is thrown, not swallowed. *(Architect B1: the first draft diffed the prior row against the new one after `configs.put`, so a throw left the new principal stored and the retry saw no difference. The orphan became permanent, the exact defect this decision exists to close.)*
- **One business unit.** The config's `businessUnits: string[]` becomes `businessUnit?: string`, because the schedule could only ever run one. The one stored row is read with `businessUnits[0]` as the fallback, so it keeps meaning what it meant. The response returns the new shape. A body `businessUnits` with more than one entry is refused `400`, not truncated. One job per BU was weighed and rejected: it multiplies BigQuery spend and approval gates per tenant, and nobody asked for it (prod: 0 runs).
- **Closed-world body.** Accepted keys: `scheduleCron`, `scheduleTimezone`, `planSource`, `businessUnit`, `businessUnits` (legacy, at most one entry; both together is a `400`), `anniversaryTriggerEnabled`, `takeOver`, plus the GET echo keys `tenantId`, `principalUserId` and `updatedAt`. The echo keys are ignored; `principalUserId` is checked per D4. So a GET→edit→PUT round trip is accepted. `planSource` must be an object with only optional string `projectId` (a BigQuery project-id shape: `^[a-z][a-z0-9-]{4,61}[a-z0-9]$` or a legacy `domain:` form, ≤ 200) and `dataset` (≤ 200). `businessUnit` is ≤ 120 characters. Any other key is a `400` naming it, the ADR 0600 §6 closed-world rule. *(Architect M15.)*

### D6 — The anniversary trigger is not armed while its chain cannot run (`INS91-6`)

`anniversaryTriggerEnabled: true` is refused `400` with `reason:'trigger_lane_unrunnable'`. **The refusal lives in `applyConfig`**, the one choke point every writer passes (ADR 0582). The route only maps it, and the arming branch is deleted rather than left unreachable. The service-level cases that witnessed arming (`insights-suite-trigger`, `-telemetry`, `-toggle-and-resource`) are rewritten to witness the refusal and the pause. *(Architect M12.)* The message names the cause: the trigger cannot supply `subjectId`, `workdayBaseUrl` or `recipient` (`ISWF-6b`), and a trigger-fired run has no acting user to notify. `false` and absent still pause any existing subscription (prod: 0 exist). This is the ADR 0599 §6 rule ("refuse to arm a schedule that provably cannot run") applied to the second lane it was never applied to. When `ISWF-6b` lands, this refusal is the one line to remove, and `INS91-6`'s witness is the test that must flip.

### D7 — The Talent prompt says what the agent can do (`INS91-7`)

`talent.md` and the pack description drop "reads talent data", "direct reports and two levels down" and "retrieved development-plan evidence". The agent scores ratings the human supplies, can search the knowledge base for notes the human has put there, and says when it has neither. Agents pack 1.2.0. A new `PROBE-IS-13` holds the Talent prompt to a closed world over HR-read terms, the `PROBE-IS-11` mechanism. *(CORRECTED during implementation: the first fold said `PROBE-IS-11` would cover all three prompts. The Communication prompt was read by hand and is clean (its one tool exists, and it disclaims sending), so no probe was added for it. That is stated rather than implied.)*

### D8 — Erasing the principal erases the suite (`INS91-8`, `INS91-15`)

`registerSubjectEraser(eraseInsightsSuiteSubject)`, registered from `insightsSuiteService.ts` (imported at boot through the feature), with its edge in `host/subjectEraserManifest.ts`. The fan-out is per tenant, so it is a point read, `configs.get(tenantId)`. When the row's `principalUserId` is one of the subject's spellings (the forms the scheduler eraser builds, including the home-tenant `legacyPrincipalOf` alias, `schedulingService.ts:1078-1089`), it deletes every `insights-weekly:${tenantId}:` job, **deletes** every `insights-anniversary:${tenantId}:` subscription (and with it the raw-id key and its delivery rows), and deletes the config row. It returns a `SubjectEraseReport` with `rowsTouched`. *(Architect M10.)* **Delete, not re-point.** The suite is scoped to a person (whose inbox, whose schedule), and handing it to another person is a decision only a human makes. Re-saving the config recreates it as the saver (D4). The census moves `insights:config` from `RECORDED_DEBT` to covered: the `:1683-1684` assertions flip, and `DEBT_CEILING` drops 6 → 5 (`:742`). The module's "no store for a DSAR to reach" note is corrected. *(CORRECTED: the first draft said `triggerbridge:sub` has no delete and filed `INS91-18`. `deleteSubscription` exists (`triggerBridgeService.ts:396`), so the raw-id key is erased here and `INS91-18` is withdrawn.)*

### D9 — The red-team reviewer sees the figures (`INS91-12`)

`variance-compute` gains a deterministic `summary` string output: one line per evaluated metric (actual, plan, delta, %), then the flagged metrics, then the missing and uncomparable ones. That makes it node 1.3.0 inside pack 1.3.0, and the chain's `@1.2.0` pin moves to `@1.3.0` (`pack.json:55`). The edge becomes `compute.summary → redteam.summary`, so the gate shows that text as its one option. The tenant-wide notification stays title-only: the figures are for the reviewer, not the whole workspace's bell.

### D10 — A place to configure it (`INS91-9`)

A **Settings → AI → "Insights & Drafting"** panel in the existing lazy settings page (ADR 0396 registry). It loads only when the `insights-suite` toggle is visible for the tenant: the registry gains an optional `featureId`, and `SettingsPage` filters on `useFeatureVisible`. Per the registry's own rule, the shell owns none of the panel's data (`settingsPanels.ts:1-7`): the component, its client and its strings live in a new `frontend/react/src/features/insights-suite/` with its own lazily loaded `insights-suite` i18n namespace. The registry holds one lazy import and one `titleKey`. *(Architect M13: `/settings` is the personal-settings shell, and it is still the right home for a person's own schedule. With D4 the suite IS a person's own schedule, run as them. The panel's component belongs to the feature, not to the shell.)* *(CORRECTED during implementation, at the release manager's measurement: a NEW feature i18n namespace adds an entry to the eager namespace-loader glob map, which costs entry-chunk bytes, and the entry has about 300 B of headroom. So the panel's copy lives in the settings shell's EXISTING lazy namespace under `insights_*`, and the component moved beside it (`features/settings-shell/InsightsSuitePanel.tsx`). This is because `namespaceSplit.test.ts` forbids a feature component from using another feature's namespace. The data client stays the feature's (`features/insights-suite/insightsSuiteClient.ts`). This trades the M13 ownership rule for the byte budget, and says so.)*

- **Fields:** cron (with the timezone), BigQuery project, business unit.
- **States:** "Runs as you", or "Runs as <someone else>; saving takes it over" when the stored principal is not the caller.
- **The anniversary trigger:** shown disabled, with D6's reason.
- **Errors:** the route's field errors are shown on the fields (the BudgetPanel pattern).
- **Not workspace-writers:** read-only view.

No new route, nothing in the entry chunk, and all four locales. The surrounding records change with it: FEATURES.md:277 and :803 drop "no feature page", and `manual-tests/suites.ts:1137-1158` drops `hasPage:false`. Its INS-03 steps expected the draft in the mailbox before approval, and a draft to exist after a reject. Both are rewritten to the D3 order.

### D11 — The witness reads what flowed (`INS91-14`)

The chain-execution probe's AI stub records the messages it receives. The anniversary case asserts:
- the user turn contains the milestone and an exemplar, inside `<UNTRUSTED>`;
- the approval interrupt is raised **before** any broker call to a draft URL;
- a reject leaves zero draft calls.

The talent case asserts the persisted `pull` output holds only the subject's rows. The weekly case asserts the gate's option carries the variance figures. Each is sabotage-checked against the pre-change chain.

## Alternatives weighed

- **D1: drop `pull.rows` from the persisted event** (an output-retention flag). Rejected. It is a core executor seam with replay consequences (a fork needs the outputs to resume), it is far larger than one input, and it leaves the over-fetch in memory anyway.
- **D2: give `chatCompletion` a template or `messages` builder.** Rejected. It is a core pack change for every chain. Mixed-text `{{params}}` does interpolate (`nodeCtxInputs.ts:63`), but the exemplars arrive over an edge, not as params, and they need fencing. A feature-owned pure node is the existing shape (`variance-compute`, `talent-score`).
- **D3: keep the order and add a second gate.** Rejected. A gate after the write still cannot un-write it.
- **D4: keep the body field, but require the caller to be that user or an owner.** Rejected. An owner scheduling runs as a named colleague is the impersonation itself, and the scheduler draws no owner exception.
- **D2: an in-process TypeScript node that imports `host/untrustedContent.ts` directly** (architect B3's first option). Rejected. It would be a programmatically-registered node with no manifest, which ADR 0677 records as the `ISU-4` class: invisible to the required-config census and to the palette. A pack node whose fence copy is byte-pinned to the host keeps one source of behaviour and a manifest.
- **D6: build `ISWF-6b` now.** Rejected. It is the RFC 0099 envelope→bag bridge, cross-cutting by ADR 0677's own split, and prod has no subscriptions to serve.

## Phased plan

| Phase | Scope | Rows |
|---|---|---|
| P1 — chains + nodes | D1 (`core.workday.query` `workerId`), D2 (`recognition-brief`, fence copy + parity), D3 (reorder + `draft-check`), D9 (`summary`); node pack 1.3.0, chain pack 1.4.0 (all three chains bump); `sideEffectFloor.generated.ts` + steward manifest regenerated; witness legs D11 | `INS91-1`, `-2`, `-3`, `-12`, `-14` |
| P2 — config door | D4 (derived principal, durable caller, `actingUserId`, take-over, fire gate), D5, D6, D8; route + service + eraser + manifest edge + census update | `INS91-4`, `-5`, `-6`, `-8`, `-10`, `-11`, `-15` |
| P3 — agent | D7; agents pack 1.2.0; `PROBE-IS-11` over three prompts | `INS91-7` |
| P4 — UX | D10 panel | `INS91-9` |

Filed, not built: `INS91-13` (pinned provider and model; read the run resolver first), `INS91-16` (`ISC-9b`), `INS91-17` (source-side Workday filter), `INS91-19` (a fork taken after the gate re-mints an approved draft, D3).

Filed after the independent re-grades (each a reason, not an omission):
- `INS91-21` (UX, Medium) — the variance summary is English in every locale. It is model-free, replay-stable text written by a pack node; localizing it means a client renderer over the structured `variances`, which the gate card does not have today.
- `INS91-22` (UX, Low) — `ui/confirm.tsx`'s no-host fallback shows only the title. A shared-helper change with callers app-wide; the host is mounted in the app.
- `INS91-23` (code, Low) — the 409 and `GET` carry the other member's raw principal id. The panel does not show it; a display name needs a user lookup this door does not do.
- `INS91-24` (code, Low) — two members taking over in the same instant can end with the row naming one and only the other's job armed. A CAS on the row (or a per-tenant lock over arm, write and reconcile) closes it; prod has one config.
- `INS91-25` (UX, Low) — the gate's `optionLabels` show in the full view, not the inline card header.
- `INS91-26` (UX, Low) — the day list starts on Monday in every locale.

**Tenant copies.** A tenant that instantiated a chain through `…/workflows/from-chain` holds an independent, builder-editable copy that keeps the old wiring. Copies are tenant-owned and are not rewritten by a pack bump; that is the from-chain contract. The lead's prod read counts the ownership index (Q9). At 0 there is nothing to do. Above 0, the disposition is a notice, not a rewrite: filed as `INS91-20`. *(Architect H8.)* **Measured (the lead, Q9): 0 tenant copies.** The 5 Q9b rows are host-tenant `workflow:revision` rows, the platform's own chain revisions. That matters most for D1: `requireWorkerId` reaches only fresh expansions, so a copy made before this change would keep reading the whole workforce. There are none. (Round-4 code re-grade.)

`INS91-29` (Low, round-4 code re-grade) — `requireWorkerId` is a config key `core.workday.query` reads but no schema declares, because the node has no manifest (`ISU-4`). If the builder or catalog ever gains a closed-world config schema for that node, the key must be added there or it will be stripped (the validator-allowlist class).

## Open questions

1. **ANSWERED by the architect pass:** a save by a non-principal is refused `409` unless `takeOver:true` (D4). The first leaning ("the refusal adds a round trip for the common one-admin case") was false: with one admin, the stored principal is the caller.
2. D2: refuse with zero exemplars, or draft with `voiceGrounded:false`? **Decided:** refuse, because the persona's promise is voice. The message tells the user to add exemplars to the knowledge base.

## Architect pass (2026-11-11, before code)

An independent adversarial `/architect` pass (Track A, read-only) found **4 Blockers, 4 High, 8 Medium and 5 Low** in the first draft. All are folded in above, each with a correction note where the decision changed:

| # | Finding | Disposition |
|---|---|---|
| B1 | D5's diff-against-stored-row teardown made an orphan permanent on a throw | D5 → stateless reconcile by prefix |
| B2 | D2's `serviceDate` → years needs a clock in a pure node | dropped; `milestone` / `serviceYears` only |
| B3 | D2's hand-rolled `<UNTRUSTED>` fence was breakable and opted out of the run wrap | word fence, both host defangs, byte-pinned copy |
| B4 | D4's "runs as" was false (`ownerUserId` is attribution only); wrong line cited | `metadata.actingUserId` stamped; durable caller required |
| H5 | the generic scheduler could re-own, resume or squat the job | reserved-prefix fire gate + `managedBy` |
| H6 | ADR 1009 taint not set for a gate shaped by KB and Workday text | brief calls `markUntrustedContext`, not cacheable |
| H7 | D3's fork claim overstated | scoped to pre-gate forks; `INS91-19` filed |
| H8 | tenant `from-chain` copies keep the old wiring | Q9 + `INS91-20` |
| M9 | D1's match rule ≠ `talent-score`'s | identical expression + parity leg |
| M10 | D8 missed the manifest edge, census ceiling, point read, alias forms, report | all added |
| M11 | the new node's tool status was undecided | not a chat tool; not projected |
| M12 | D6's refusal location was unstated | in `applyConfig`; arming cases rewritten |
| M13 | panel data belonged to the shell | feature-owned component + namespace; FEATURES + manual tests updated |
| M14 | open question 1 reasoned from a false premise | 409 + `takeOver` |
| M15 | closed-world key set unstated | spelled out, GET round trip accepted |
| M16 | string-compared identities | `callerOwnerSpellings`; derived job ids |
| Low ×5 | error code, `{{params}}` claim, version pin, empty draft, local `actingUserOf` | all taken (the empty draft as `draft-check`) |

The pass **verified** the INS91-2 premise (the turn is `subjectId`), D3's mechanics (`all_success` waits for both edges; reject and timeout fail the run; the injected `input` key is ignored by `parseEmailConfig`; one string port renders inline), that D1 is additive (no input allowlist pins `core.workday.query`), D6's premise, the eraser API, D10's lazy loading, the output-role map, and that `pack-surface-arg-parity` does not touch this pack. It **also found that this ADR said `triggerbridge:sub` has no delete**, which was my error: it does (`:396`).

## Implementation record

Branch `fl2-91/insights`. Verified with targeted vitest only (the release manager gates in trains); runs are listed in the PR.

| Phase | Decision | Code | Witness |
|---|---|---|---|
| P1 | D1 | `bootstrap/nodes.ts` `core.workday.query` `inputs.workerId` + `scannedCount`; chains bind it | `insights-chain-execution` PROBE-IS-12 "keeps ONLY the subject's review rows" |
| P1 | D2 | `packs/feature.insights-suite.nodes` 1.3.0 `recognition-brief` + the fence copy; chain `brief.prompt → generate.prompt` | `insights-recognition-brief.test.ts` (byte parity over the host attack spellings; fail-closed; no clock; taint) + PROBE-IS-12 "handed the fenced brief" |
| P1 | D3 | `draft-check`; `check → approve → emailDraft → notify` | PROBE-IS-12 "approves the TEXT before anything reaches a mailbox", "empty completion is refused"; `insights-suite-governance` order assertions (CORRECTED: the old assertion pinned the defect) |
| P1 | D9 | `variance-compute` `summary`; `compute.summary → redteam.summary` | PROBE-IS-12 "shown the figures"; PROBE-IS-11 (the Financial prompt enumerates `summary`) |
| P2 | D4 | `routes.ts` derived principal, `forbidden_principal`, `principal_conflict` + `takeOver`, anon refusal; job `metadata.actingUserId`; reserved-prefix fire gate (`feature.ts`) | `insights-suite-config-door.test.ts` D4 cases + the generic-scheduler 409; `insights-suite-cron` "runs AS its principal" |
| P2 | D5 | `reconcileTenantRows` (stateless, by prefix); closed-world body; one business unit | config-door D5 cases |
| P2 | D6 | refusal in `applyConfig`; legacy rows paused (own) or deleted (others) | `insights-suite-trigger.test.ts` (rewritten); config-door D6 |
| P2 | D8 | `eraseInsightsSuiteSubject` + manifest edge; census debt 6 → 5 | `subject-erasure-feature-stores` COS-1 case (flipped); `subject-eraser-manifest` |
| P3 | D7 | Talent prompt + description; agents pack 1.2.0 | `insights-agent-tools` PROBE-IS-13 |
| P4 | D10 | `frontend/react/src/features/insights-suite/` panel + client + 4 locales; settings registry `featureId` | `InsightsSuitePanel.test.tsx` |

Records updated: FEATURES.md (both rows), `manual-tests/suites.ts` (INS-01, INS-03 rewritten for the new order, INS-04 new), `docs/steward/LLM-EXCHANGE-AUDIT.md` (`XCH-IS-2`, `XCH-IS-3`).
