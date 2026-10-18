# ADR 0831 — Team intent ledger: one living record of what a project is for, read before agents act

Status: Accepted — P1–P4 implemented (P3 and P4 partial; P5 open)

- **Program:** ROADMAP § "Collaborative orchestration program", item 2.
- **Composes:** ADR 0136 (the per-conversation Intent Ledger; this is its
  team-scoped sibling, not a replacement), ADR 0046 (the project subject — the
  first thing a ledger binds to), ADR 0233 §C8 (decision records are
  `decision-record` Documents; the ledger REFERENCES them, never copies them),
  ADR 0099 / ADR 0604 (run-start contributors and the `derivedFromRun` freeze),
  ADR 0829 (the structured handoff record) is a future source of proposed deltas.
- **Toggle:** none — **always on since 2026-10-07** (maintainer decision). It
  shipped OFF behind `team-intent-ledger`, went default ON on 2026-10-06, and
  the toggle was then removed: a stored per-workspace setting could still hide
  the feature. A config row left under the old id is ignored. The feature no
  longer declares `dependsOn: documents` (an always-on dependent would lock
  `documents` on everywhere); the documents SERVICE it reads does not refuse
  when that toggle is off (ADR 0446 soft read). A run started while the ledger
  was OFF carries no stamp and a fork never adds one (ADR 0604).
- **RFC verdict:** host-only. The run stamp lives in free-form
  `run.metadata`; the read surface is under `/v1/host/openwop-app/`. The
  `openwop` ROADMAP's "Shared intent record" candidate is gated on THIS: 30
  days on two real projects with every bound run stamping the version it acted
  on, plus a second host asking to read it across hosts (§9).

## 1. Context

ADR 0136 gives ONE conversation a mission contract. Real work spans many
conversations, runs and people. Nothing records what a project is for *now*,
which decisions shaped it, and what changed — so agents work from whatever the
prompt happened to say, and a person joining has to reconstruct it.

### What exists (measured on `origin/main`, 2026-10-05)

| Need | Existing owner | Consequence |
|---|---|---|
| A thing to bind to | Projects are subjects (`features/projects/`, ADR 0046) with a board, memory and workflows | Bind to a subject reference; projects first |
| Decisions | `POST /strategy/:id/decisions` writes a `decision-record` Document (ADR 0233 §C8); needs the `documents` feature | Reference by `documentId`; never a second decision store |
| A per-run frozen stamp | `registerRunStartContributor` (ADR 0099), `derivedFromRun` (ADR 0604) | Freeze the ledger version at run creation; a fork keeps its source's stamp |
| Knowing which project a run is for | **Nothing.** No run carries a project, campaign or strategy reference, and a contributor sees only `{tenantId, agentId, derivedFromRun}` | An explicit binding is needed (D3) |

## 2. Decision

> **CORRECTED before P1 (maintainer decision, 2026-10-05): the ledger versions
> the project charter; it does not carry a second goal.** Discovery found that
> projects already have a `charter` (ADR 0054 D1: `goal`, `objectives`,
> `brief`, dates, `health`, `milestones`), edited directly through
> `PATCH /projects/:id`. A ledger with its own `intent` and `successCriteria`
> would give every project two goal statements that drift. So, for a project:
>
> - `charter.goal` IS the intent and `charter.objectives` ARE the success
>   criteria. The charter stays their only home.
> - The ledger holds what the charter lacks: `version`, the append-only delta
>   log, `decisionDocumentIds`, `openQuestions`, `inScope`, `outOfScope`, and
>   the `ownerSubject`.
> - A delta may patch `goal`/`objectives` (applied to the charter on accept)
>   as well as the ledger's own fields.
> - With the toggle ON and a ledger present, a direct charter edit that
>   changes `goal` or `objectives` is recorded as an owner-direct accepted
>   delta, so the version never silently skips a change.
> - Every accepted delta stores `resultState` (the full ledger-relevant state
>   after it), so "the state at version N" is a lookup, not a replay of patches
>   against a charter that has since moved.
> - Scopes other than `project` wait until a project has used it (open
>   question 3, answered).
>
> The D1 shape below is the original proposal, kept for the trail; the shape
> P1 implements is in §7.

### D1 — The ledger entity

```ts
TeamLedger {
  ledgerId, tenantId,
  scope: { kind: 'project' | 'campaign' | 'strategy'; id: string },  // one ledger per scope
  ownerSubject: string,              // the named owner who accepts deltas
  version: number,                   // +1 per ACCEPTED delta; never decremented
  intent: string,                    // ≤ 1000 chars
  inScope: string[], outOfScope: string[],
  successCriteria: string[],
  openQuestions: string[],
  decisionDocumentIds: string[],     // ADR 0233 decision-record Documents, by reference
  createdAt, updatedAt,
}

TeamLedgerDelta {                    // append-only
  deltaId, ledgerId, tenantId,
  status: 'proposed' | 'accepted' | 'rejected',
  patch: Partial<Pick<TeamLedger, 'intent' | 'inScope' | 'outOfScope' |
                 'successCriteria' | 'openQuestions' | 'decisionDocumentIds'>>,
  why: string,                       // ≤ 500 chars
  author: { kind: 'user' | 'agent'; id: string },
  source?: { kind: 'run' | 'approval' | 'message' | 'handoff'; ref: string },
  baseVersion: number,               // the version the author was looking at
  resultVersion?: number,            // set when accepted
  decidedBy?: string, decidedAt?: string, createdAt,
}
```

All text is bounded and redacted at write (`scrubSecretShaped` + caps, the
`boundedStrings` helpers). Lists ≤ 50 items.

### D2 — Only the owner moves the version

- A person with `workspace:write` on the scope may **propose** a delta; an
  agent may only propose. Nobody writes the ledger directly.
- The **owner** accepts or rejects. Accepting applies the patch and bumps
  `version`; the delta records `resultVersion`.
- **Stale base:** a delta whose `baseVersion` is behind the ledger is still
  acceptable, but the accept call must say `rebased: true` and the UI shows
  what changed since. The version log stays linear because accepts are
  serialized (CAS on `version`).
- The owner may also write directly (an accepted delta authored and decided by
  the owner in one call), so a single-person project is not forced into a
  two-step ritual.

### D3 — Binding a run, and the stamp

- A run is bound by `run.metadata.ledgerScope = {kind, id}`, written by the
  code that creates it: a project's own workflows, a card run on the project's
  board, or an explicit caller value.
- `RunStartContext` gains a read-only `metadata` (the base being stamped). A
  `team-intent-ledger` contributor reads `ledgerScope`, resolves the scope's
  ledger and stamps `run.metadata.teamLedger = {ledgerId, version}`.
- `derivedFromRun` ⇒ the contributor contributes nothing (ADR 0604): a fork
  keeps the version its source acted on, in both directions.
- The binding is checked against the run's tenant; a scope in another tenant
  resolves to nothing (never a 403 that confirms it exists).

> **CORRECTED in P2 — the binding is DERIVED from host-written attribution, and
> checked; a caller-written `ledgerScope` is not honored.** `POST /v1/runs`
> spreads caller metadata into `run.metadata`, so an explicit `ledgerScope` key
> would let a caller bind their own run to a private project they cannot read,
> and the agent would then put that project's ledger in its prompt. P2 instead
> derives the project from `metadata.kanban.boardId` (the board's
> `ownerSubject`) or `metadata.schedule.ownerScope`, and stamps only when the
> run's acting user (host-stamped from the authenticated principal) can read the
> project. `teamLedger` is added to the reserved run-metadata keys
> (`host/runDispatch.ts`), because contributors never overwrite an existing key
> and a caller-supplied stamp would otherwise win.
>
> **Finding, not fixed here:** the same route does not reserve the attribution
> keys themselves (`heartbeat`, `schedule`, `kanban`, `approval`), so a caller can
> attach a forged attribution block and `recordRunAttribution` will index the run
> under any agent's roster id. That is pre-existing and affects other features;
> it is reported separately rather than changed inside this ADR.

### D4 — Read before act

An agent turn on a bound run receives the stamped version's snapshot: intent,
scope lines, success criteria, open questions, and the titles of the last five
decisions. It is fenced through `host/untrustedContent.ts`, because accepted
deltas can carry agent-proposed text. The snapshot is read **at the stamped
version** (from the delta log), never "latest", so replay builds the same
prompt.

### D5 — Write back (P3)

Resolved approvals and clarifications on a bound run, ADR 0829 structured handoff records,
and agent tool calls (`openwop:team-ledger.propose`) create **proposed** deltas
with a `source`. The owner sees them as a queue. Nothing is accepted
automatically.

> **CORRECTED in P3 — only the agent tool ships; the other three sources wait.**
> `openwop:team-ledger.propose` (with `openwop:team-ledger.get` for
> read-before-write) is the write-back path in P3. The automatic sources are
> deferred, each for a stated reason, not for size:
> - **Resolved approvals / clarifications.** A resolution is a yes/no or an
>   answer; turning it into a ledger patch needs a rule for WHICH field it
>   changes (a cleared open question? a new decision?), and a wrong automatic
>   proposal trains the owner to reject the queue. The design needs one real
>   project's resolutions to look at first.
> - **Structured handoff records.** The ADR for those is in PR #4439 and not
>   yet on `main`; this branch cannot read its types.
> - Meanwhile the chief of staff can propose the same change on any of those
>   occasions, with a reason a person can judge.
>
> **CORRECTED 2026-10-06 — handoff records ship as a source; approvals and
> clarifications still wait (the reason above stands).** ADR 0829 is on `main`.
> Only a record's OPEN QUESTIONS map: a note that raises a question the ledger
> does not hold proposes ONE delta adding it to `openQuestions`
> (`source.kind: 'handoff'`). `decisions` are free text and the ledger's
> decisions are `decision-record` references, `intent` is the work's intent not
> the project's, and `tried` has no field — so none of them propose. The
> proposer must hold WRITE on the project (a card note: its author; a run's
> record: the agent, backed by the run's acting user; no acting user ⇒ nothing).
> Idempotent on the origin ref; nothing auto-accepts. Core announces records
> through `host/handoff/handoffObservers.ts` at the three places one is written
> (`core.dispatch`, the confidence-floor escalation, a card assignment), so core
> never imports this feature.

### D6 — Per-conversation ledgers inherit

An ADR 0136 mission ledger on a conversation bound to a scope may only
**narrow** the team ledger's `inScope`/`outOfScope` (intersection, the 0132
never-widen rule). Deferred to P4; no change to ADR 0136 enforcement before then.

> **CORRECTED in P1 — the ledger depends on `documents`, so it is not core.**
> Decision references are validated through the documents service (they must
> be `decision-record` Documents in the project's org). The ADR 0439 dependency
> ratchet caught the undeclared import. Declaring `dependsOn: ['projects',
> 'documents']` is the honest fix, and because `documents` is in the sellable
> `studio` bundle (not core), the ledger is a standalone feature rather than core:
> a distribution without `documents` does not offer it. Hiding the import to keep
> it core was rejected.

## 3. Alternatives weighed

- **Extend ADR 0136's ledger to team scope.** Rejected: 0136 is a mission
  contract that *projects onto the capability scope* and gates tools. A team
  ledger is a shared statement of intent; giving it tool-gating authority would
  make every project member's edit a security change.
- **Store decisions inside the ledger.** Rejected: ADR 0233 already has the
  register, with approval provenance. Two stores drift.
- **Stamp "latest" at read time instead of a version at run start.** Rejected:
  replay and `:fork` would see a different intent than the original run did.
- **Infer the project from the agent or the board at run start.** Rejected for
  P1–P2: the contributor cannot see the board, and inference across several
  candidate scopes is guesswork. Explicit binding first; inference only where a
  creator already knows the scope.

## 4. Phased implementation

| Phase | Scope | Exit |
|---|---|---|
| P1 | `features/team-intent-ledger/`: toggle, store (`TeamLedger`, `TeamLedgerDelta`), REST (get by scope, create, propose, accept/reject, owner direct write, delta log), RBAC, tenant isolation, DSAR eraser | Route tests over real HTTP: OFF ⇒ 404; one ledger per scope; propose ≠ accept; only the owner accepts; CAS serializes accepts; cross-tenant ⇒ 404; DSAR erases authored text |
| P2 | `RunStartContext.metadata`; the contributor; `ledgerScope` on project-workflow and project-board runs; read-before-act snapshot at the stamped version | Stamp test; fork keeps the source stamp (real route); snapshot fenced and version-exact |
| P3 | Write-back sources (approvals, clarifications, ADR 0829 structured handoffs, the agent tool) as proposed deltas | Each source creates exactly one proposed delta; nothing auto-accepts |
| P4 | UI: ledger panel on the project page ("what changed since you last looked"), the owner's proposal queue; ADR 0136 inheritance | Component tests; `/ux-review` |
| P5 | Evidence for the protocol gate (§9) | **Instrumented 2026-10-07** (`features/team-intent-ledger/evidence.ts`, `host/usageEvidence.ts`): one usage row per (tenant, project) each time the P2 contributor stamps a run; `GET /host/openwop-app/team-ledger/evidence` (superadmin) reports which projects meet the same bar and whether two do. The other half, a second host asking to read it across hosts, is outside the app. Test: `test/collab-tripwire-evidence.test.ts` |

## 5. Security and privacy checklist

- [ ] Tenant: every read and write is tenant-checked; a foreign scope is a 404.
- [ ] Authority: proposing needs `workspace:write` on the scope; accepting needs ownership.
- [ ] Redaction and bounds on every text field at write.
- [ ] Prompt injection: the snapshot reaches a model only fenced (D4).
- [ ] DSAR: authored deltas' text and `why`, and `ownerSubject`, are erased or anonymized; the ledger row stays (it is shared).
- [ ] Replay: the stamp is frozen at creation; `derivedFromRun` respected; the snapshot is version-exact.

## 6. Open questions

1. Who owns a new ledger by default: the project's creator, or whoever creates the ledger?
   **P1 choice:** whoever creates the ledger (they must be able to edit the
   project). Ownership transfers with `POST …/owner`, only to someone who can
   edit the project, so the ledger can never be left with an owner who cannot
   accept anything.
2. Should accepting a delta notify the project's members, or only show in the panel?
3. Campaign and strategy scopes: same entity, or do they wait until a project has used it?
   **Answered:** they wait. P1 binds to projects only.

## 7. Implementation record

| Phase | Commit | Tests |
|---|---|---|
| P1 | `feat/team-intent-ledger` | `test/adr0831-team-ledger.test.ts` (9, real HTTP with real sign-ins): toggle OFF ⇒ 404; one ledger per project, creator owns it, version 1 holds the charter goal; propose ≠ accept, only the owner accepts, the accepted goal lands in the CHARTER and version 1 stays exact; a direct charter edit is one version and a ledger write is not echoed; a stale base needs `rebased`; viewer reads but cannot propose, a stranger gets 404, ownership moves only to a writer; unknown fields, empty `why` and a non-decision document are refused; two concurrent accepts produce versions 2 and 3 with both changes kept; DSAR redacts authored text and identity. **Sabotage-witnessed:** no compare-and-swap, a charter listener that ignores `origin`, and no owner check each go red. The first concurrency test (over HTTP) passed WITH compare-and-swap removed and was replaced by a service-level one that fails |

| P2 | `feat/team-intent-ledger-p2` (stacked on P1) | `test/adr0831-team-ledger-stamp.test.ts` (7, real app): a run on the project board is stamped with the current version, toggle OFF ⇒ none; a co-tenant viewer of a PRIVATE project gets no stamp even naming its board; a caller cannot pre-set `teamLedger` through `POST /v1/runs`; `:fork` over the real route keeps version 1 after the ledger moved to 2; a source born unstamped stays unstamped on a fork made with the toggle ON; the context block carries the state AT the stamped version (fenced), nothing when OFF or from another tenant; the live dispatch puts it before `Task:`. **Sabotage-witnessed:** ignoring `derivedFromRun`, dropping the acting-user access check, un-reserving the key, and reading the latest version each go red |

| P3 (partial) | `feat/team-intent-ledger-p3` (stacked on P2) | `test/adr0831-team-ledger-tools.test.ts` (5, real app): both tools registered; no acting user ⇒ typed failure on both; `get` returns the current state, a stranger and a toggle-OFF tenant get the same `not_found`; `propose` only proposes (version unchanged, author = agent, source = run) and the owner then accepts over HTTP; a viewer reads but `propose` is `forbidden`; invalid patches are typed errors. **Sabotage-witnessed:** a `get` without the access check, and a `propose` that accepts directly, each go red |

| P4 (partial) | `feat/team-intent-ledger-p3` | `frontend/react/src/features/projects/__tests__/projectLedgerTab.test.tsx` (6): no ledger ⇒ writers can start one, readers cannot; a failed load is said, never shown as "no ledger"; only the OWNER sees Accept/Reject; a stale accept asks, then accepts with `rebased`, and declining sends nothing more; propose sends only the changed lists and needs a reason; "changed since you last looked" lists only accepted changes after the viewer's last-seen version. **Sabotage-witnessed:** Accept shown to everyone, and propose sending every list, each go red. Full frontend build green. **Deferred:** D6 (ADR 0136 ledgers inheriting the team scope) — it changes how an existing, enforced mission ledger resolves, and needs its own review (`/ux-review` ran afterwards, #4474) |
| D1 (last seen, server-side) | `feat/ledger-seen-server` | "What changed since you last looked" kept its last-seen version in the browser (`localStorage`), so it did not follow a person across devices and nothing on the server could count what each person had not seen (item 4's re-sync checkpoint needs that). Now `team-ledger:seen` holds one row per (ledger, person); `GET` returns the caller's `seenVersion`; `POST …/seen {version}` is bounded to the ledger's real versions and never moves backward. The subject eraser deletes a person's rows; the project-delete cascade counts and deletes them. A pre-server browser value is carried up once and removed. Tests: `test/adr0831-team-ledger.test.ts` (+2) and `projectLedgerTab.test.tsx` (+1, one changed). **Sabotage-witnessed:** a seen version that moves backward goes red |
| P3 (handoff source) | `feat/ledger-handoff-source` | `test/adr0831-team-ledger-handoff-source.test.ts` (6, real app; the card leg over real HTTP): a card note with a new question ⇒ exactly one proposed delta as the person, version unchanged; the same ref again ⇒ none, a different ref ⇒ one; held or no questions ⇒ none; toggle OFF ⇒ none; a non-project board ⇒ none; a viewer ⇒ none; a run's record ⇒ proposed as the agent only with a writing acting user. **Sabotage-witnessed:** no write check, no ref dedupe, the observer unregistered, and the assign route never announcing each go red |
| B3 (chat context) | `feat/ledger-chat-context` | Chat turns never collected run context blocks, so an agent in the project's own room worked without the ledger. A core seam (`host/chatSubjectContextProviders.ts`) lets a feature add a block for a conversation's OWNER subject; the ledger registers one for project chats. Live per turn and per caller (the ADVB-1 shape), because a conversation is one long-lived run and a run-start stamp would go stale; the version shown is logged. `test/adr0831-team-ledger-chat-context.test.ts` (6, real composer): block at the current version; an accepted change shows on the next compose; nothing for toggle off, no ledger, a caller who cannot read a private project, or a conversation with no owner. **Sabotage-witnessed:** no caller access check, and the composer dropping the block, each go red |


> **Correction 2026-10-12 (grade-tests wave 29):** the rows above describe the tests as they
> landed, and several of their legs no longer exist. The ledger has had no toggle since `836a81994`
> (the "Toggle" line at the top), so every "toggle OFF" leg in P1, P2, P3 and B3 is gone, not merely untested; no case
> runs one. In P3 (partial), "both tools registered" is now "neither tool is on the default-on
> baseline (`DEFAULT_ON_AGENT_TOOL_IDS`)", and "invalid patches are typed errors" moved to
> `test/adr0831-team-ledger-grade.test.ts` (the XCH-TL-1 tripwire). B3 runs 5 cases, not 6.
> Each test file's header now names its current guards and the sabotages that red them; read
> those, not these rows, for what is witnessed today.

P4 files: `features/projects/{ProjectLedgerTab.tsx,teamLedgerClient.ts}`, the
project page's `ledger` tab (only with the toggle ON), four locales. The
"last seen version" marker is per-viewer browser storage, a convenience only.

> **CORRECTED after the XCH-TL-1 grade pass (B).** P3 shipped two defects in
> the propose path: `baseVersion` was optional and silently defaulted (the stale
> guard could be bypassed), and the validator rewrote model input while reporting
> success. Both are fixed: `baseVersion` is required everywhere, and every field is
> refused rather than rewritten. Details in `docs/steward/LLM-EXCHANGE-AUDIT.md`
> (`XCH-TL-1`).

P3 files: `features/team-intent-ledger/{access,agentTools}.ts` (the route now
uses the same `ledgerAccess` predicate), the chief-of-staff pack allowlist and
prompt, `host/toolResultTransform.ts` (`team-ledger.get` never compacted),
`test/schema-read-exemption-completeness.test.ts` (classified),
`docs/steward/LLM-EXCHANGE-AUDIT.md` (row + `XCH-TL-1`).

P2 files: `host/runStartContext.ts` (`metadata` on the context, read-only),
`host/runInsert.ts` (passes it), `host/runDispatch.ts` (`teamLedger` reserved),
`host/runContextProviders.ts` (a new read-side seam: a feature registers a
provider returning one already-fenced block per run), `host/agentRunnerNode.ts`
+ `host/agentDispatch.ts` (`contextBlocks`, placed before `Task:`),
`features/team-intent-ledger/{runStamp,runContext}.ts`. The ADR 0829
handoff note adds its own `handoffNote` to the same place; it can move onto
this seam later.

P1 files: `features/team-intent-ledger/{types,ledgerStore,routes,feature}.ts`;
`features/projects/projectsService.ts` (`onProjectCharterChanged`, the
`source` argument to `updateProject`, `parseCharter` exported);
`features/projects/routes.ts` (passes the actor).

The shape P1 implements: `TeamLedger { ledgerId, tenantId, scope: {kind:'project', id},
ownerSubject, version, openQuestions, inScope, outOfScope, decisionDocumentIds }`
plus `TeamLedgerDelta { …, patch, why, author, source?, baseVersion,
resultVersion?, resultState?, rebased?, decidedBy?, decidedAt? }`, where a
patch may carry `goal`/`objectives` (written to the charter) and the ledger's
own lists.

## 8. Relationship to items 3 and 4

Decision capture from channels (item 3) and drift detection (item 4) are
consumers: item 3 creates proposed deltas with `source.kind: 'message'`; item 4
compares outputs against a ledger version. Neither is in this ADR.

## 9. Protocol-gate evidence (for the `openwop` "Shared intent record" candidate)

- the two projects using it in production, and the date the stamp shape last changed;
- confirmation that every bound run carries `teamLedger.version`;
- the second host's request to read a ledger across hosts (link).
