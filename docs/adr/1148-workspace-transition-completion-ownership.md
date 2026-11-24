# ADR 1148 — Workspace transition completion ownership

Status: Accepted
Date: 2026-11-17
Architecture track: A — existing host frontend owners; no wire change.
Source implementation: Prepared and focused-native-qualified candidate; full gate, merge and deployment pending.
Native application qualification: 152 selected cases passed on 290207; full-gate attempts incomplete/red (see §1.1).
Decision scope: 8 production and 8 test owners, 102 literal candidate declarations; 17 edited paths including this ADR.

## 1. Reservation, adoption and evidence

ADR 1148 was allocated through the official metadata tool, not directory maxima. Root reports that warning-free official `--next` returned 1148. The physically read 2583 receipt records successful `--reserve workspace-transition-completion-ownership`, producing the 321-byte Proposed stub on `codex/campaign-workspace-auth-fixed-20261117`. Receipt SHA256 af76e1bb75d1f1b5a251dfb2195fd759d41e6891e987cd775e0e5e24e010da5f; stub SHA256 8ba922cbfeee58198d7b1c121e48f11b2a04d59b23060b361db055fe78a0520c. Reservation is visible locally and becomes peer-visible through the normal commit/push process. It is not design acceptance.

Root accepted this bounded host-frontend design on 2026-11-17 after independent Track A review2590 (review SHA256 5d6c750b06329306fb8806300ddcdfff8c4fd1b534021a29df5b72f56daa0166). The frozen Proposed draft and historical parents remain unchanged. The implementation is prepared as a portable diagnostic source commit; native qualification, normal merge and release remain pending. Do not mark this record implemented before the required actual commits and evidence.

The earlier diagnostic candidate used c1a6ede612aed213e80448ea382cb08be7b6250d and staged implementation/test tree `3cd3b0c58da4a9c2a5dda02a347d90bfe1eafbf1`. Main subsequently moved. Root rebound all56 selected context entries and the15 implementation/test preimages, then prepared the portable composition on c2dd3b13840d97510dfd6b02beac8670403fcce8. It retains100 literal declarations. This document changes the resulting tree; its exact tree/commit is recorded in the adoption receipt and native evidence must bind that composition. The architecture review hash-read the actual client, config and both callers, not the whole index.

Official numbering-helper executions are metadata evidence. They are not application imports, typechecks, tests, builds or a gate. All such native application qualification remains unrun. Earlier artifacts' inherited “Macguard VIOLATED/unreset” label has no controlling origin/reset condition established here and is not used to infer a permanent machine ban or to clear one. This drafting task itself authorizes only source/text work.


### 1.1 Dated correction — source and native evidence, 2026-11-17

The original design census above and original Appendix A remain historical. Commit `54181cb41349cba572b82935c5baa9bb655adb6c` carries the accepted repair/design. Follow-up `9e41d5e1588e77cfab0cf502657e558745d32f42` corrects two invalid busy-state test observations and adds two mounted raw201/no-active create successes. Candidate `290207e7cf01bb0639f22858acfe8d5dd22edbd0`, tree `97c5e3de8c95e94b1729c9315abdbac85bdd8785`, incorporates main569f. Its selected census is 8 production + 8 test owners = 16 implementation/test owners, plus this ADR = 17 edited paths; 102 candidate cases. The earlier 15-owner/100-declaration and execution-zero statements describe the prior source-only drafting scope, not this later qualification.

Actual isolated npm10.9.8 installs used Node22.23.4/ABI127; real better-sqlite3 and Chromium executable probes passed. Focused run2631 on exact290207 terminated0: 18 files, 152 passed/0 failed/0 pending, comprising102 candidate cases and50 existing auth/session/chat/dashboard neighbors. React act warnings are retained; no warning-free claim is made. The native assertions check the real mounted caller/client/config boundary, raw five-field201 without active, returned-ID enter and freshGET. Reload-helper invocation is a callback boundary, not a real browser reload, HTTP-cookie or cross-tab proof.

Causal probes preserved separate actual negative results: disabling captured-target retirement caused3 fulfilled-versus-rejected failures; disabling committed caller-generation fencing caused1 completed-versus-caller-retired failure. Both mutations were restored exactly; final focused runs retained all cases. These do not establish unrelated backend, cache, realm or served behavior.

Canonical full preflight2643 terminatedRED on3 Tracegate tooling path-alias checks before application lanes. An unchanged one-variable control2647 showed logicalcwd3FAIL/14PASS versus physicalcwd17PASS. Physical-cwd full retry2648 was stopped by its own memory guard while preflight waited for peer suites (swap growth312.81MiB); it executed no application lanes and produced no gate/evidence verdict. Required/advisory browser, date sweep, canonical builds, complete types and full suites remain unqualified for this candidate. No current full green, PR, main merge or deployment is claimed.

Main refresh `d8c93fa7dea5d57d91b0f8a125e415bba4ad2cb1` incorporates fe77; its backend dependency changes need a real lockfile-based reinstall. The four-locale recovery follow-up is `18e8d957481161c1cd4420c3e435d4d90f3fb140`; neither this newer composition nor this documentation correction inherits the152-case run or full-gate evidence.

A separate UX review found the sticky transport-uncertain safety refusal lacked recovery instructions. The bounded follow-up adds localized manual reload-and-check guidance to the existing three error messages; it adds no automatic mutation retry, reset, reload action or new authority. Its final composition still needs focused confirmation and full exact-tree evidence.

These terminal receipts and full logs are retained in the private Campaign acceptance state (progress2633, full-preflight2643/2648, controls2647, reviews2654/2655). They are diagnostic evidence, not portable release artifacts. Newer source/main compositions require fresh evidence; Status remains Accepted until the integration/release phase and served regression are complete.

## 2. Context and existing owners

An awaited workspace mutation may finish after auth invalidation, another mutation, UI unmount or committed callback replacement. Checking only before the promise resolves does not fence the later caller. Blindly suppressing ordinary auth invalidation would preserve old proofs and callbacks. Copying the transition into each UI would give the two entry points different semantics.

The baseline already has one frontend auth notification owner (`client/config.ts`) and one tenancy facade (`client/workspaceClient.ts`). The latter already owns list/create/switch/create-and-enter and calls the existing host extension. Keep them. Workspace/member/role authority remains the existing backend accessControl/workspace/session layer (ADR0015); backend-authoritative decisions remain backend-owned (ADR0001). No new product feature, feature flag, route, registry, database, credential store, principal, role or wire model is introduced.

This is a direct fit for ARCHITECTURE.md:149, the existing seam for frontend work that outlives its starter: effect-owned mounted refs rearmed inside setup. It also preserves the existing core route and chrome seams (ARCHITECTURE.md:126–127) and the existing-owner/backend-authority rules (:37–52). It does not borrow the backend record-deletion registry's semantics or import backend internals into the SPA.

### 2.1 Exact bounded owner inventory

Paths below are relative to frontend/react/src. This is the selected source census, not an execution result.

| Production owner | Role |
| --- | --- |
| client/config.ts | Existing auth-event registration/delivery owner |
| client/workspaceClient.ts | Existing transition/read/result-completion facade |
| chrome/WorkspaceSwitcher.tsx | Existing sidebar caller |
| orgs/WorkspaceCreateSection.tsx | Existing create caller |
| i18n/locales/en/common.ts | Shared trusted notices |
| i18n/locales/es/common.ts | Shared trusted notices |
| i18n/locales/fr/common.ts | Shared trusted notices |
| i18n/locales/pt-BR/common.ts | Shared trusted notices |

| Test owner | Literal declarations |
| --- | --- |
| client/__tests__/config.authEvents.test.ts | 33 |
| client/__tests__/workspaceClient.transition.test.ts | 36 |
| chrome/__tests__/WorkspaceSwitcher.authCompletion.test.tsx | 11 |
| orgs/__tests__/WorkspaceCreateSection.authCompletion.test.tsx | 14 |
| orgs/__tests__/workspaceCreateSection.test.tsx | 4 |
| chrome/__tests__/WorkspaceSwitcher.transportUncertainty.test.tsx | 1 |
| orgs/__tests__/WorkspaceCreateSection.transportUncertainty.test.tsx | 1 |
| orgs/__tests__/WorkspaceCreateSection.rawCreateAcknowledgement.test.tsx | 2 |

The unchanged reload helper, requestJson, v2Wire, useAuth and chat adapters are dependencies, not extra edited owners. The ADR is an additional documentation file; the current composition has 16 implementation/test owners plus this ADR (17 paths).

## 3. Decision

### 3.1 One current auth-event owner

Extend config's existing registration channel. Publish a frozen event identity as current before any hook/listener. Capture the registration-entry snapshot before the preparation hook. Delivery checks that each exact entry is still registered; active duplicate callbacks share one entry with no refcount or insertion-order change. Remove/re-add gets a new entry; an old disposer cannot delete it. New entries wait for a later/nested event.

Complete synchronous fan-out even when preparation or listeners throw, then raise a sanitized typed dispatch error. A nested newer event stays current when outer delivery resumes; never restore an old event. No async-listener settlement barrier is promised. Diagnostic causes remain untrusted diagnostics, never UI copy or a new wire payload. Existing token/header/refresher APIs stay in config.

### 3.2 Distinct lifetimes in the existing workspace facade

| Object | Meaning | Retirement / limit |
| --- | --- | --- |
| AuthChangeEvent | Current local observed invalidation identity | Published before notification; not UID/tenant authority |
| AuthRevision | Facade lifetime after the observed current event | Ordinary invalidation retires old scopes |
| ProofRevision | Auth/mutation/failure read lifetime | New owned intent or current failure invalidates earlier lifetime |
| Accepted target epoch | Private lifetime of an accepted canonical target | Contradiction creates a fresh epoch; old A cannot revive after ABA |
| Captured target record | Accepted target observed at request invocation | A retired capture may only coalesce its compatible immediate successor |
| AttemptHandle | One switch or create-and-enter claim | Settles only itself; stale work cannot release a newer claim |
| WorkspaceReadProof | Exact privately bound accepted GET projection | Copies/proxies are not issued proofs; no grant |
| CompletionRecord | Exact issued mutation-result eligibility | Private canonical target; one-shot eligible→consuming→consumed |
| UICompletion | Fresh context for one synchronous caller invocation | Expected ordinary event plus fresh global/caller checks |
| Caller life/configuration | Mounted/request/commit-published handler ownership | Unmount, newer request or committed configuration change retires old action |

Begin an owned switch/create-and-enter claim before its first fetch. Retire old proof/completion eligibility, recheck after header preparation and every awaited boundary, and settle only that exact attempt. Create-and-enter retains one claim across create then enter; a superseded create ACK cannot start enter. A known HTTP outcome and an unresolved dispatched transport are different. Unresolved dispatched transport leaves uncertainty in the continuously loaded realm, including through ordinary auth invalidation. A GET cannot prove remote settlement or force-clear uncertainty. The legacy create-only API remains a legacy operation, not an owned transition receipt.

A successful POST is transport acknowledgement, not ready read proof. The actual create route's 201 returns workspace identity/name/slug/roles/kind without an `active` field. The client must not fabricate an ACK tenant or treat a fixture's extra `active` field as route evidence. It uses the returned workspaceId to enter, checks the switch ACK target, then still requires a separate successful GET for read proof. A native positive against the real raw201/no-active boundary remains required.

Normalize a successful GET into a closed copied DTO: root, array, rows and roles are frozen, with exact private proof-object binding to the canonical projection. Public aliases/copies/mutation cannot rewrite that runtime acceptance. Role data is a rendered server projection, not a frontend grant. `isCurrentWorkspaceRead` is the actual predicate; public revision equality alone does not prove accepted-target currentness.

#### 3.2.1 Captured observed target and compatible coalescing

At invocation, capture the current accepted-target record, if one exists, as well as the unchanged auth/proof/event scope and local request order. The actual workspaceClient.ts:300–318 and :460–501 implement this captured-lifetime boundary. Keep one opaque predecessor-epoch token in the current target record, not a chain of historical target records. Unchanged-target acceptance retains the epoch and predecessor.

| Request state | Admission rule |
| --- | --- |
| Auth/proof/event scope is no longer current, pending claim or uncertainty | Refuse under existing lifetime guards |
| No accepted target was observed at invocation | Retain existing auth/mutation and invocation/conflict guards |
| Captured epoch remains current | Apply existing invocation/conflict guards to the validated response |
| Capture retired; current predecessor equals captured epoch; actual payload names current target | May coalesce that immediate successor under existing order/conflict guards |
| Other retired capture, including backtrack, ABA or skipped target | Refuse before target assignment, completion retirement, publication, proof issuance or tenant-cache call |

The initial/no-observed-target case is deliberate: there is no accepted-target authority to capture. The existing positive where concurrent initial requests return A then newer B remains admissible. This policy does not claim server transaction ordering.

Once accepted A exists, a held B(q2) and later-invoked held A(q3) both capture A. If B is accepted, q3 must retire without warming or downgrading B, even though q3's order is later. If a genuinely fresh post-B A(q4) is accepted first, q3 still cannot join its new A epoch. By contrast, B/B requests launched under A can coalesce the immediately accepted B, including reverse completion. A fresh post-B A request captures B and may advance normally.

Keep the existing greatest accepted-order and contradictory-order watermarks as additional guards. They preserve same-target concurrency and protect older reads without treating every successful GET as a new global lifetime. The dominant correction is captured observed-target ownership; invocation order alone is insufficient.

A contradictory accepted target creates a new private epoch and ordinary snapshot object/notification even if public authRevision/proofRevision/ready fields remain equal. Subscribers must recheck the actual proof predicate. It does not add a public target field, wire revision, UID store or global cache barrier.

#### 3.2.2 Failure and malformed-response retirement

Before admission, an error belongs to the captured target, if any. After admission, it belongs to that request's own issued target. If that expected epoch has retired, reject as retired before failed-phase/revision publication. Thus later-invoked q3 transport failures and malformed payloads captured under old A cannot erase accepted B merely because q3 exceeds q2's invocation order. A genuinely current failure retains the existing failed/revision behavior.

Cache observations in the source fixture assert calls to the existing `rememberWireTenant` seam. They do not execute real v2Wire storage, downstream run binding, in-flight cache/reset behavior or global header integration. Legacy raw-list/global-cache authority is not qualified by this decision.

Ordinary own auth broadcasting still retires old attempts/proofs/completion authority. Only a newly minted UI-only context may carry the fresh post-event fence. Foreign/reentrant events, newer intent, contradiction, pending claims or uncertainty retire that context. No broad auth-event suppression or old-context revival is allowed.

### 3.3 Synchronous completion, not an async lease

Issue a fresh result object per successful transition and privately bind exact-object eligibility/canonical target. A spread copy, proxy, reused transport alias or replay does not gain a new completion.

The existing facade's synchronous completion operation captures caller functions, rechecks after accessor/guard/preparation reentry, performs the normal auth event and checks current global/caller ownership directly before one final invocation. A caller-only retirement may permit current mutation housekeeping but no UI callback. Failure metadata is fixed/sanitized; guard/failure callback throws are not relabelled success.

The boundary ends at invocation. It neither awaits nor cancels effects inside a callback, proves a browser reload happened, undoes dispatched requests nor grants committed chat/UID/backend authority. Guarded React updaters do not by themselves prove atomic commit across every queued/suspended/aborted render; native scheduling qualification remains required for stronger UI claims.

### 3.4 Thin callers and truthful copy

Both existing callers retain the actual mutation result and delegate completion once; neither broadcasts independently. Mounted life is created/rearmed in effect setup and retired in cleanup. Request-owned busy cleanup is housekeeping, separate from callback/name/notice authority.

Create publishes an opaque callback-configuration object only from layout commit. Each committed handler change creates a fresh object: A→B→the same A cannot re-arm A's old request. Unchanged-handler commits retain eligibility; a genuinely fresh request after returned A captures the new generation. No render publishes authority.

Both callers use the existing unchanged synchronous reload primitive, the shared Notice and common locale catalogs. Known ApiError401/403 gets trusted refusal copy; all other current mutation failures use trusted incomplete-change copy. Completion-refresh failure stays a separate message. Never display arbitrary Error.message/body/statusText/URL or diagnostic causes. All three notices allow partial creation/change and make no rollback or safe blind-retry promise. The tiny UI copy adapters classify presentation only; they do not duplicate server authorization.

## 4. Existing route/owner seam audit

This repair registers zero new routes, feature surfaces, navigation entries or durable entities. The established executable owner remains `backend/typescript/src/routes/workspaces.ts`: GET `/host/openwop-app/me/workspaces` (:68), POST `/host/openwop-app/workspaces` (:124), POST `/host/openwop-app/workspaces/:id/switch` (:148). The facade already used these URLs.

The previously fully read registerAllRoutes source mounts accessControl(:392), orgAddExisting(:394), then workspaces(:397) in the one ROUTE_MODULES list. registerSharedRootShell(:485) precedes the loop and registerBackendFeatures(:489) follows the core list. No competing organization/member/role/workspace system is created. ADR0001's backend-authority rule and ADR0015's workspace tenancy remain authoritative.

The visible route requires a subject, denies non-durable create and checks membership/existence before shared-workspace switch, then calls existing active-preference/session helpers. These are observed call sites, not qualification of imported middleware/services. The whole backend auth.ts acquisition2553 was refused before body for size; it is not read, chunked or inferred by this draft. No route-authz/cookie/IDOR/security-wide pass is asserted.

The contract/seam audit reuses the fully metered2557 ARCHITECTURE/CLAUDE/route/ADR sources, with Root-reported selected-owner equality through c1a6. The actual four edited frontend owner bodies were freshly read in this task. No fresh collision grep or whole-tree equivalence is claimed. No backend registrar changes are part of the 15-owner selection.

Correction to stale examples: executable routes and CLAUDE.md:657–661 use unversioned `/host/openwop-app/*` with protocol 2; retired `/v1/…` answers 410. The architect skill's older /v1 examples do not authorize resurrecting that namespace.

## 5. Compatibility and RFC decision

No new RFC is selected for this bounded host frontend change: no endpoint/payload contract, auth profile, capability advertisement, run/event/schedule/agent/workflow/credential wire field, protocol error semantic or replay stamp changes. Event identities, revisions, proofs and completion records remain process-local frontend metadata, not serialized credentials or protocol objects.

Future expected-tenant/backend/cross-host contracts or capability changes require their own actual protocol/authority review and applicable RFC process. This record grants no such extension. Existing role projection is not a capability grant.

Core tenancy remains the existing always-on owner. No new feature-package/toggle/FEATURES entry is needed for a repair to that shared seam. There is no new frontend-to-backend import, durable migration, dependency/lockfile, provider/key operation, publication or advertising spend. Existing locale and Notice/reload owners are reused.

## 6. Alternatives, trade-offs and dominant force

| Option | Cost / debt | Decision |
| --- | --- | --- |
| Existing config+tenancy facade with thin callers | Explicit local bookkeeping; stronger integrations remain separately qualified | Selected: one owner per concept |
| UI-only post-await tickets/broadcast logic in each component | Duplicates transition/auth semantics and cannot own proof retirement | Rejected |
| Suppress ordinary auth epochs during completion | Revives old scopes and masks foreign/reentrant invalidation | Rejected |
| New auth/workspace store, DOM protocol or persisted uncertainty | Parallel authority and stale cross-realm/storage obligations | Rejected |
| Treat ACK or arbitrary GET as remote settlement | Fabricates ready/cancellation/backend guarantees and hides partial mutation | Rejected |
| String-only target checks or invocation order alone | ABA revival or later-invoked pre-contradiction reads regain authority | Rejected by 2561/2565 counterexamples |
| Global lifetime bump on every read or target flip | Rejects compatible concurrent A/A or B/B already launched under A | Rejected |
| Captured epoch + immediate-successor coalescing + order guards | Constant current metadata and per-request capture; initial policy explicit | Selected |
| Unbounded target history | Adds storage/lifecycle cost without a needed invariant | Rejected |
| New backend expected-tenant contract now | A different authority/wire boundary not admitted here | Not selected; required for that stronger guarantee |

The dominant force is preserving the actual authority owners while fencing frontend continuations using observed evidence. Local metadata is accepted as the implementation cost; it does not become server identity authority. Listener fan-out remains proportional to registrations, target metadata is constant-size, and no polling/startup scan is added. The full bounded15-owner scope is retained; it is not trimmed for size.

## 7. Correction/history appendix to the decision

The original 5231-byte 2489 rationale is preserved verbatim in Appendix A. These explicit corrections preserve the reasoning trail:

- **Registration order2473→2487/2488:** entry snapshot must be captured after immutable E becomes current but before beforeNotify(E). Exact registration generations, duplicate/no-refcount semantics, remove/re-add and stale disposers resolve the conflicting snapshot-after-hook promise.
- **2515/C1:** function equality alone failed committed A→B→same-A ownership. Commit-issued opaque callback configuration retires old requests irreversibly; unchanged-handler and genuinely fresh returned-A controls remain. Render is not a commit receipt.
- **2515/C2:** lifetime guards do not sanitize Error.message. Both callers and all four common catalogs use trusted refusal/incomplete/refresh copy. Only the explicitly approved legacy failure-copy oracle was corrected/strengthened; its other three case bodies remain unchanged.
- **2530/T1/T2/R1:** valid-shaped B copy/proxy negatives precede original public-result mutation, with genuine matching B proof and exact-original canonical positive. Denials are not explained by a wrong target or consumed receipt.
- **2533:** two standalone real-client/caller transport witnesses cover CREATE POST rejection. Their positives, trusted notices, sticky uncertainty and isolation remain prospective; they are not universal switch/status/retry coverage.
- **2557→2561:** the earlier provisional architecture draft's no-new-algorithm recommendation was overturned by R1: contradictory accepted A/B proofs and held old A could coexist/warm. Backend/new-realm exclusions did not waive that local contradiction.
- **2563→2565:** target epochs/order watermarks fixed issued-proof ABA and earlier-invoked stale reads, but later-invoked q3 captured under A could still backtrack/join new A. Invocation-only policy was insufficient.
- **2568→2572:** request capture plus compatible immediate-successor coalescing and captured/own-issued error guards address both R1 source findings in the independently reviewed after-image. 2572 found no new bounded source blocker; all native causality/adoption remained pending.
- **2583→this record:** the prior provisional number was never a reservation. Official tool allocation is now 1148; only this new final-number artifact uses it as current identity. Historical files and their actual paths/hashes stay unchanged.
- **Counts:** final source census is 8 production + 7 tests = 15 owners and 33 + 36 + 14 + 11 + 4 + 1 + 1 = 100 declarations, executed 0. Earlier 75/85/95 and local 29/31/33/36 counts overlap and are not added.
- **Evidence history:** frozen 2515 still delivered zero response patches for its actual 9 pairs/all 11 planned patches. Later full-body selection and2533's two new-file patches did not retrospectively complete it. Frozen2537's null ledger digest remains historical; 2540 separately acquired b771c3791fa8675dce286a463a36fa8d468eadbc190cd457491de4837f95f323.
- **Resource/authority history:** historical Macguard labels remain historical source statements, not a proven permanent ban or reset condition. This task performs no guard action. The official metadata receipt and native application execution counts are separate evidence.

## 8. Architectural assessment, qualification and falsification

The selected design fits the existing owners and extension seams. Independent source review2572 and architecture review2590 support the bounded design acceptance recorded in section1. Acceptance proves no native correctness and does not remove the ordinary code/UX/NFR/gate/release requirements.

Falsifying evidence includes: a retired captured A backtracking/joining ABA; compatible same-target reads being rejected; an initial/no-target positive lost; stale errors downgrading ready state; copied/proxy results gaining completion; ordinary invalidation suppressed; old committed configuration regaining UI action; stale work releasing another claim; normal auth clearing uncertainty; lost exports; duplicate owner/route; or untrusted error text reaching Notice. Such findings require repair, not weaker tests.

Excluded stronger claims remain explicit: settled UID/bootstrap, chat/catalog/Deck/Session/persistence/ACK adoption, committed routing/history/manual Assistant/neutral/storage, global wire-cache lifecycle, backend auth/cookie/already-dispatched requests, other tabs and reload/new-realm settlement. Transient uncertainty disappears in a new realm; no remote cancellation/settlement follows. React guard/updater structure alone is not proof of every queued/suspended/aborted commit order.

## 9. Implementation phases and evidence still required

| Phase | Dependency / evidence | Current status |
| --- | --- | --- |
|0 — Decision record | Official reservation, independent architecture review, Root acceptance recorded |1148 officially reserved; independent2590 supports bounded design; Root accepted. Native qualification remains pending |
|1 — Exact source candidate | Current preimages/absence/modes, selected16 implementation/test owners plus ADR, actual tree/diff |Prepared commits54181/9e41/290207; current census17 paths,102 cases; any follow-up changes the qualified tree |
|2 — Native setup and focused qualification | Real isolated checkout/dependencies, module/jsdom/i18n/isolation/types/canonical build |Real installs and focused152/0 on290207; complete types/canonical build/full suites not yet qualified |
|3 — Behavioral sensitivity | Real102 candidate-case controls, causal negatives, meaningful sabotage, raw201/no-active positive |Actual focused and two causal-probe results recorded in§1.1; HTTP+cookie/cross-realm claims remain separate |
|4 — Integration and release | Independent code/UX/NFR, exact-tree full gate/evidence, required/advisory browser accounting, normal train; separate backend/frontend verification |Pending; no merge/deploy/readiness from this ADR |

Do not count a selected/declaration total as execution. Record actual terminal results, exact-tree evidence, commits and served regression before “implemented.” No second full gate is invented by this drafting task.

Open checklist:
- [x] Official number and Proposed reservation obtained (2583 receipt; local visibility caveat recorded).
- [x] Independent architecture review2590 and Root bounded design acceptance; Status Accepted. Native qualification remains pending.
- [x] Apply reviewed ADR and rebind the source candidate290207/tree97c5; later compositions need a fresh binding.
- [ ] Native setup/types/build and causal positive/negative/sabotage evidence, including actual no-active201.
- [ ] Required exact-tree gate/evidence plus advisory browser result disposition.
- [ ] Four-locale/accessibility/visual review and relevant delayed React qualification.
- [ ] Separately qualify stronger UID/chat/global-cache/backend/realm contracts where requested.
- [ ] Record actual commits, deployment and served tests before Status implemented.

## Appendix A — original2489 rationale, unchanged historical text

This is the entire frozen 5231-byte companion, SHA256 5bd9d071a8fd862b4cccaf9d219cb9590b14a78bd077092ce2fdce30537a9af6. Its Proposed status/counts are historical; §§1,3,7–9 above are explicit corrections, not retroactive rewriting.

```markdown
# Proposed ADR correction and staged ownership note — workspace lifecycle completion

Status: Proposed. No free ADR number has been claimed. This is an inert design/implementation companion for phase 2489, not a repository ADR or an implemented record.

## Decision being proposed

Keep auth event delivery in the existing config.ts owner and workspace attempt/proof/completion lifetimes in workspaceClient.ts. Use one immutable current event per delivery and exact registration-entry generations. Capture the entry snapshot after publishing E but before beforeNotify(E); only exact still-registered snapshot entries receive E. Active duplicate callbacks retain Set-like deduplication/no refcount and insertion order. New entries created during preparation/delivery wait for another event. Remove/re-add gets a fresh identity, and an old disposer cannot remove it. Complete synchronous fan-out before raising a sanitized aggregate. A nested newer event never gets replaced by an outer event on return.

Successful mutation results keep their public payload shape but receive private exact-object one-shot eligibility. A fresh shallow returned result prevents transport-object reuse from rebinding an older alias. Completion is a synchronous owner-local operation, not pre-fulfilment validation of a future await continuation. Its own ordinary auth event retires old proofs and creates a separate UI-only context; foreign events, supersession and pending/uncertain changes retire that context. Caller guards and preparation are rechecked before the final direct synchronous invocation. The callback/reload invocation is the boundary; its later behavior is not leased or cancellable by this client.

Use mounted/request/committed-handler ownership in the two existing callers and the unchanged existing reloadIntoSession function for native reload. Use one shared neutral common notice in all four current catalogs. A failure notice must not suggest a failed/rolled-back remote mutation or safe blind retry when completion is uncertain.

## Correction notes to the staged rationale

- A mutation attempt, a config auth event, a workspace accepted read proof and a UI invocation context have distinct lifetimes. An own broadcast does not preserve old chat proof authority.
- A public accepted result, including a copied or mutated alias, is not its own runtime proof. The client keeps a private canonical closed DTO/exact-object binding. Read proof is still not settled Firebase UID or chat header/history proof.
- Snapshot-before-hook is required. Snapshot-after-hook plus a promise that new registrations wait for another event is inconsistent. Callback identity alone is insufficient for remove/re-add and stale disposer semantics.
- An await-return or a pre-fulfilment check cannot fence caller reentry. The actual post-await action goes through the synchronous completion owner. Getter/guard/preparation reentry is rechecked; an already invoked final action cannot be retroactively cancelled.
- Reload starts a new realm and loses local uncertainty. It does not prove a prior remote mutation settled, nor bind a server request tenant. No persisted auth store or backend protocol is introduced to hide that gap.
- The eight edited production owners are sufficient only for this bounded source proposal, not the Campaign Studio feature. Existing settled-UID/global-cache/chat/ACK/backend/realm integration remains open.

## Alternatives weighed

A second auth event store, DOM event protocol or caller-local broadcast registry duplicates authority and was rejected. Broadly suppressing auth epochs during normal completion would preserve old callbacks/proofs and was rejected. Returning a completion boolean before actual invocation, treating raw POST tenant fields as proof, or replacing the existing reload helper with a test-only production seam was rejected. An async revalidation read is not an atomic guard over a later continuation. Backend/cross-realm authority is left explicit rather than invented without contract review.

## Stage and ownership

2489 proposes config.ts, workspaceClient.ts, WorkspaceSwitcher.tsx, WorkspaceCreateSection.tsx and common catalogs en/es/fr/pt-BR. The unchanged reload helper, requestJson, v2Wire, useAuth and every chat adapter remain outside edited ownership. Five test source owners include the existing CreateSection setup-only adaptation; 75 declarations are prospective and zero were executed. Current workspaceClient before4350 bytes is distinct from staged2463 after16106 bytes. Source lineage and selected2c83 metadata are in pair-index.json and manifest.json.

## Required next decisions and evidence

Independent source/code/UX review; real config and caller fixture setup/type checks; causal RED/GREEN and negative controls; settled UID and catalog/Deck/Session/persistence/ACK integration; global cache fencing; backend request-cookie/already-dispatched/cross-realm settlement analysis where a stronger claim is needed; exact current composition gate/evidence; separate backend/frontend deploy and served regression. Translation review is also pending. No phase is recorded as shipped, and there is no accepted ADR, RFC change, commit, PR or deployment from these artifacts.
```
