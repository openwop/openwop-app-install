# ADR 0975 — The KickTodo operator's Factory path, end to end

**Status:** Accepted (2026-10-25, the owner: "make the full fix that is consistent with the
KickTodo app's strategy and industry best practices and works with the OpenWOP architecture")
— P1–P4 merged (train 222, 2026-10-25). P5 witnessed D1 and D4 on kicktodo.com and found a seventh
defect (D7, P6, merged train 226r). The P7 re-run then found an eighth, exposed when kicktodo-prod
turned authorization enforcement on (D8, P8); the Factory re-run follows P8's deploy.

## Context

ADR 0910 P4 is the production enactment of the KickTodo operator seat: activate, store the
Factory key, run the Challenge Factory, self-approve. On 2026-10-24/25 the owner and a
Claude session walked it on kicktodo.com (a white-label deploy of this app). Activation,
MFA step-up, the Factory key card and the D-23 binding removal all worked. The Factory
run did not, and the failure was not one defect but six, each hiding the next:

| # | Observed on kicktodo.com | Root cause |
|---|---|---|
| 1 | Factory refused `ai_credential_missing` (provider `anthropic`) while readiness said `factory.ready: true` | The pre-flight resolves the workspace's ADR 0110 headless default (`anthropic`, keyless) and consults the `kicktodo-factory:<provider>` key (ADR 0910 D8) only for THAT provider. Readiness only checked that some Factory key existed. |
| 2 | First real run failed at `extract-claims` | The chain's `core.web.search` searched `{{params.topic}}` verbatim. "The Daily Walk" returned only Bible-reading plans of that name; the extractor correctly found nothing to support. The seven framed research questions never reached the search. |
| 3 | The creator saw `internal_error: scheduler stalled` | `extract-claims` failed terminally; `releaseDownstream` skipped the rest; the `none_failed` fan-in `decompose` read "all upstreams skipped" as ready, the final sweep in `inspectDisposition` drops `ready` verdicts, the loop found nothing runnable, and the stall branch emitted a hard-coded `internal_error` that ignored `snapshot.nodeErrors`. |
| 4 | The Studio chat answered "No response from this advisor" | The managed chat model called `openwop:kicktodo.candidates` five times with identical arguments, hit the round cap, and the loop returned an empty `finalText` — an empty success. |
| 5 | Replies and approval cards never appeared in the Studio | The SSE stream goes cross-origin to `*.run.app` (CLAUDE.md: the CDN buffers SSE). With a fresh ID token the SPA sends `Bearer` only; the bearer lane resolves the caller's PERSONAL tenant (the active-workspace choice lives in the cookie, which does not cross origins), and `v2IdentityMiddleware` refuses the `host-kicktodo` run id: `403 id_tenant_mismatch`. Six identical retries, then silence. |
| 6 | The outline gate could not be approved: `403 forbidden_scope (approvals:respond)` | ADR 0910 D1 gives the operator `host:kicktodo:manage` + `host:byok:manage` only. `approvals:respond` is tenant-wide, so ADR 0910 rightly withheld it — and with it the Factory's own outline and lesson gates. |
| 7 | *(found by P5)* Every gate approved, then `submit` failed: the skeptic simulation blocked publication | `claimRefs` was optional in the plan's response schema; the model omitted it on all 21 days, `validatePlan` skipped the missing field, and the uncited plan reached the simulation after every lesson was built. See D7. |
| 8 | *(found by P7, 2026-10-26)* The Studio chat refused to start (`runs:create`) or continue (`approvals:respond`) for the operator | The operator role (ADR 0910 D1) is viewer + `host:kicktodo:manage` + `host:byok:manage`; a chat turn is a run of the conversation workflow. Hidden until kicktodo-prod set `OPENWOP_AUTHORIZATION_ENFORCEMENT=true` (~21:46Z): before that, membership scopes were never checked. The same pass found D1's entry-gate fallback dead under enforcement (it matched `forbidden_scope`; `refuseScope` throws `forbidden` + `requiredScope`). See D8. |
| 9 | *(found by P9, 2026-10-27)* The Studio chat showed `id_tenant_mismatch` after a turn that had succeeded | The SSE route bound event ids with `req.tenantId`. On the cross-origin stream (D5's `streamToken` plus a bearer, no cookie) that is the bearer's personal tenant, so a `host-kicktodo` run's ids came back as `u-<personal>/<id>`, and the SPA's poll fallback re-sent them. See D9. |
| 10 | *(found by P9, 2026-10-27)* Both Factory runs died at `fetch`: `unsupported Unicode escape sequence` | One fetched page contained U+0000; Postgres `jsonb` refuses it, so the `node.completed` append failed and the executor threw. D3's sharper query is what first reached such a page. See D10. |
| 11 | *(same)* The dead runs still read `running` | `startWorkflowRun`'s dispatch catch only logged; `POST /runs`' dispatcher already failed such a run closed. See D10. |

## Decision

### D1 — a run-scoped approval grant (fixes #6)

A feature may register, per workflow id, a predicate that admits a decider for approval
gates on runs of ITS OWN workflows (`host/runApprovalGrant.ts`). The interrupt node route's
two checks consult it only when the tenant-wide scope is missing: the entry gate
(`loadOwnedRunForDecision`, which keeps `loadOwnedRun`'s tenant check at `runs:read`) and the
approval floor (`requireInterruptDecider`). A gate's approver ACL, quorum rules and the
autonomy self-approval refusal all still apply after it. A grant that throws refuses.

KickTodo registers `factoryRunApprovalGrant` for the Factory and its lesson-batch child: the
caller STARTED the run (`isRunOwnedBy`) and holds KickTodo manage authority at decision time
(`hasKicktodoManageAuthority` — for an operator, only while the activation is live, matching
ADR 0910 D9's "authority is checked when each gated act happens").

**Alternatives weighed.**
- *Add `approvals:respond` to the operator role* — one line, but it lets a KickTodo
  operator answer EVERY approval in `host-kicktodo`, including participants' own plan
  decisions. That is the over-grant ADR 0910 D1 refused (least privilege; Microsoft Entra
  PIM and NIST SP 800-53 AC-6, the bar OQ4 set).
- *A standing admin role for the owner in `host-kicktodo`* — undoes the just-in-time design.
- *Resource-scoped grant (chosen)* — attribute-based: the run's workflow, the caller's
  relation to the run, and the feature's own authority. Nothing widens for any other run.

### D2 — the Factory key is the Factory's binding (fixes #1)

With no creator-named provider, a stored `kicktodo-factory:<provider>` key decides the
provider, ahead of the workspace's general headless default: the workspace default's
provider when it has a Factory key, else the key card's order (google, anthropic, openai),
else sorted. The model follows the default when the providers coincide, else the catalog
default; the credential is the Factory key by name (never the default's chat key). A
creator-named provider still wins. The rule lives once, in `features/kicktodoFactoryAi.ts`,
and readiness calls the SAME function plus a resolve of the chosen key, so "ready" now
means "a run will start". (The ADR 0910 D8 ratchet's allowlist moves from the readiness
service to that one module.)

### D3 — the research search query (fixes #2)

`research-frame@1.1.0` also emits `searchQuery`, built deterministically from the candidate
(topic + transformation, else audience; whitespace-collapsed; capped at 240 characters on a
word boundary). Both chains that research a candidate (`kicktodo-challenge-factory` 1.9.0,
`kicktodo-research` 1.1.0) wire `research-frame.searchQuery → search.query` through the
existing port-edge mechanism and drop the declared `query` (declared inputs override
edge-derived ones, so a leftover would win silently). `maxResults: 8` moves to `config`,
where `core.web.search` reads it — in `inputs` it was dead (the node used its default 5).
The run tool now passes the candidate's `transformation`. No chain-format change, no RFC.

*Not chosen:* searching all seven questions (needs a multi-query search or a fan-out node,
a larger change for a first fix); an embedded `{{params.topic}} {{params.transformation}}`
token (no audience fallback, and an empty param renders `''`, which ADR 0507 treats as
dangerous).

### D4 — a stalled run reports the node that failed (fixes #3) — P2

When the scheduler has nothing runnable after a terminal node failure, the run fails with
THAT node's `{code, message}` and `failedNodeId`/`deadLetterNodeId`, through the same
`emitTerminalFailure` the drained path uses. "scheduler stalled" stays only for a stall with
no node error. The `none_failed`-reads-skips-as-ready semantics (pinned by
`scheduler.test.ts`) are recorded here, not changed: making a failure-caused skip carry the
failure through joins is a scheduler semantics change with its own blast radius.

### D5 — the SSE stream always carries a stream token (fixes #5) — P3

`credentialedFetch` mints the same-origin `streamToken` (whose route sees the cookie and so
the active workspace) even when a bearer is attached, and re-mints on a 403 instead of
retrying the identical request. `v2IdentityMiddleware` already honours the token before the
tenant-mismatch refusal, and the events route re-checks it via `loadReadableRun`. Trusting a
client-sent workspace header on the bearer lane was rejected: it would need its own
membership check and changes how tenant identity is resolved.

### D6 — the chat tool loop refuses to spin, and never ends empty (fixes #4) — P4

An identical repeated tool call (same tool, same canonical arguments) in one turn is not
re-executed: the model gets its earlier result back with an instruction to use it, call a
different tool, or answer. A turn that exhausts its rounds with no text returns a typed
`tool_rounds_exhausted` error rather than an empty success (CLAUDE.md non-negotiable:
"invalid model output is a typed failure, never success-with-empty").

### D7 — a plan says what it cites, before the run builds anything (fixes #7) — P6

> **Added 2026-10-25, after P5.** The witness run got through every gate D1 opened, then failed
> at `submit`: "Simulation blocked publication — a participant persona could not complete the
> challenge (skeptic)". The skeptic's finding was that "the plan fails to cite any of the provided
> evidence claims across all 21 days". The dossier had 13 supported claims, and the plan's text
> plainly used them. Cause: `claimRefs` was OPTIONAL in `CHALLENGE_PLAN_JSON_SCHEMA`, the schema the
> plan-generate node sends as `responseSchema`. gemini-3.8-flash dropped it from every day, and
> `validatePlan` skips a missing field, so an uncited plan passed. Every lesson batch was then
> built and approved before the simulation could object. The lesson schema already required the
> same field.

`claimRefs` is now required on every plan day (an empty array stays legal). With supported
evidence in scope (`knownClaimIds` non-empty, which the Factory's surface always passes), a day
without the field is `claim-refs-missing`, and a plan citing none of it is
`plan-cites-no-evidence` (reported only when no other citation defect is). Both reach the
generator's one bounded repair (CLAUDE.md: invalid model output is a typed failure with one
error-fed repair), so a run either gets a cited plan or fails at `generate`, before any paid
lesson build. Without evidence in scope (the outline editor's apply, a run with no dossier)
neither rule applies.

*Not chosen:* requiring a citation on EVERY day. Recovery and setup days legitimately state no
fact, and the skeptic blocked on "no citations at all", not on uncited days.

### D8 — the operator may hold the Challenge Author chat, and only it (fixes #8) — P8

> **Added 2026-10-26, after P7.** Exposed, not regressed: no code changed between the 10-25 chat
> and the 10-26 refusal. kicktodo-prod switched authorization enforcement on at ~21:46Z (rev
> 00058-57h), and the two refusals followed within four minutes. Until then the operator's missing
> `runs:create` and `approvals:respond` were simply never asked. Enforcement is the correct
> posture, so the design is what has to change.

Three parts, each the narrowest that works:

1. **D1 repaired.** `grantMayStandIn` (`host/protocolAuthorization.ts`) recognises a scope refusal
   by its shape (403 + `requiredScope`, or `forbidden_scope`), not by one spelling, and a grant
   that admits withdraws the RFC 0200 `insufficient_scope` challenge `refuseScope` set. A narrowed
   `owk_` key is never widened: a grant stands in for a MEMBERSHIP miss only.
2. **A run-start grant** (`host/runStartGrant.ts`), the D1 shape for `POST /runs`: consulted only
   after the scope check refused; an admitted start is stamped under `openwop-app.startGrant`, a
   key `stripCallerAttribution` removes from caller metadata. KickTodo admits a conversation the
   caller opens with `metadata.agentScope` = the Challenge Author, when the caller holds KickTodo
   manage authority there (for an operator: only while the activation is live).
3. **A turn grant** on the conversation's `gate`, registered with D1's registry: the run carries
   KickTodo's stamp, the caller owns it, still holds manage authority, and the turn is addressed
   to the Challenge Author (or is a `close`). A `bypass` permission mode is refused, so the grant
   never widens what the agent may do without asking.

The SPA sends the agent a conversation opens with as `metadata.agentScope`; it grants nothing on
its own (a member with `runs:create` never reaches the grant).

*Not chosen:* adding `runs:create` / `approvals:respond` to the operator role (tenant-wide: every
workflow, every member's approvals — the over-grant ADR 0910 D1 refused); a standing editor role;
turning enforcement off (the posture is right; kicktodo-2b's user turned it off only until P8).

### D9 — a stream binds ids to its run's tenant (fixes #9) — P10

`routes/streams.ts` binds event and snapshot ids with `run.tenantId`, the run the route already
authorized, instead of `req.tenantId`. They agree on every lane except D5's cookie-less
cross-origin stream, where the request resolves the bearer's personal workspace. D5 fixed the
stream's admission and left its projection on the request's tenant. This is the other half.
### D10 — node output with a NUL is stored, and a dispatch that throws fails closed (fixes #10, #11) — P11

`jsonbParam` serializes with `nulSafe`, which stores U+0000 as U+FFFD (Postgres cannot hold the
former in `jsonb` or `text`). It is lossless for every other character and visible where it
happened; no stored row changes, because every such write failed before. The web-research text
extractor drops C0/DEL controls at the source, since no reader of page text wants them.
`startWorkflowRun`'s dispatch catch calls `failRunClosedOnDispatchError`, the same fail-closed path
`POST /runs` uses, so a run whose dispatch throws reads `failed` with its cause instead of
`running` forever.

> **Known gap (review of #5300, 2026-10-27).** `nulSafe` rewrites string VALUES only. An object
> KEY containing U+0000 (for example from a page's own JSON) would still be refused by `jsonb`.
> Today the extractor's control-character strip sits upstream of every page-text write, so no
> path is known to reach it; sanitizing keys as well is the follow-up if one appears.

## Phases

| Phase | Scope | PR | Status |
|---|---|---|---|
| P1 | D1 + D2 + D3 (host + KickTodo + packs) | #5196 (`a36ec007d`) | merged |
| P2 | D4 executor stall surfacing | #5197 (`37b8ff6d3`) | merged |
| P3 | D5 SPA stream token | #5198 (`b5c554252`) | merged |
| P4 | D6 tool-loop guard + typed exhaustion | #5199 (`fb1cbc6b1`) | merged |
| P5 | Re-run ADR 0910 P4 step 4 on kicktodo.com after the sync; record the witness | — | witnessed 2026-10-25 on `kicktodo-backend-00056-gvv` (`e1880fc12`): outline-approve and gate-0…3 → 200 for the run's starter without `approvals:respond` (D1); the run failed typed at `submit`, not "scheduler stalled" (D4); research returned 8 relevant sources, 13 supported claims, on the Factory's google key (D2, D3). Publication blocked by #7 → D7. |
| P6 | D7 plan citations required + typed | #5235 (`7e71d7c30`) | merged (train 226r); LIVE kicktodo 00057-82x |
| P7 | Fresh Factory run on kicktodo.com after P6's deploy and sync | — | blocked 2026-10-26 by #8 (`authorization.denied runs:create`, 21:50:06Z) → D8 |
| P8 | D8 operator Challenge Author chat + D1 entry-gate repair | #5289 (`887a37038`) | merged (train 239r) |
| P9 | Fresh Factory run on kicktodo.com; record the published challenge | — | 2026-10-27: run `f4925533` started (enforcement off; a duplicate `35cfbfac` was cancelled); found #9, then both died at `fetch` → #10/#11 |
| P10 | D9 stream ids bound to the run's tenant | #5299 (`999e9a986`) | merged (train 240r) |
| P11 | D10 NUL-safe jsonb + starter fail-closed | #5300 (`3bebf6eba`) | merged (train 240r) |

P1 changes chain packs, so the registry copies (`core.openwop.workflows.kicktodo-*`) must be
republished after merge (ADR 0370: the registry copy wins when its SemVer is newer).

> **CORRECTED 2026-10-25 (after merge): no republish is needed, and the sentence above was
> wrong.** A registry copy is installed only for a pack named in the service's
> `OPENWOP_INSTALL_PACKS`. MEASURED read-only: neither `openwop-app-backend` (57 pins) nor
> `kicktodo-backend` (17 pins) pins any KickTodo pack, and the registry holds no
> `feature.kicktodo.nodes` at all (its unpinned chain copies are 1.3.1 and 1.0.3). Both
> services load the image-vendored packs, so the deploy and the kicktodo sync are the ship
> step. Read the pin list before planning a publish.

## Open questions

- [ ] Should failure-caused skips carry the failure through `none_failed` joins (D4's
      recorded-not-changed semantics)? Needs its own ADR.
- [ ] Should the Factory search several framed questions (D3 alternative)?
- [ ] Should `nulSafe` also rewrite object keys (D10's known gap)?
