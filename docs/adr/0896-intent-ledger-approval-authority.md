# ADR 0896 — intent ledger approval authority

Status: implemented (2026-10-15; Accepted after the adversarial `/architect` pass below — 2 Blockers + 4 High folded into D1–D8)

Feature loop round 2, row 49 (`intent-ledger`, `core:intentLedger`). Amends ADR 0136
(intent ledger) and composes ADR 0132 (conversation capability scope), ADR 0834 D3/D5
(tool authority, the one conversation tool gate) and ADR 0856 D2 (mission inheritance).
Host-extension only: no wire change, no RFC.

## Context

ADR 0136 ships a **mission contract**: a per-conversation record of what the agent may do
(goal, allowed, forbidden, requireApproval, success criteria, a relative TTL). A person
reviews a draft and approves it, and from then on `resolveConversationToolGate` folds it
into every chat turn and every voice tool call, never widening the agent's tools. The
chat agent can author the draft (`openwop:intent-ledger.draft-contract`, CFP A13), but
only a person approves it.

The first unit grade (`WORKFLOWS-ASSESSMENT.md` § row 49, `IL2WF-1..9`) found the
approval is not bound to what it approves. Seventeen probes in
`test/adr0896-intent-ledger-authority.test.ts` ran against `origin/main` `7f36f9f93`:
13 were RED, plus two floor probes added later.

| Probe | What happened on main |
|---|---|
| `IL2WF-1` | `POST …/approve` takes no body. The agent's draft tool rewrote the draft the owner was reading (dropping a `forbidden` entry), and the owner's click approved the rewritten text. |
| `IL2WF-2` | approve works from any status, so a revoked or expired mission is re-armed with no review |
| `IL2WF-3` | `intentLedger` is not a reserved run-metadata key; a caller-planted stamp survives `buildRunRecord`, along with its TTL anchor |
| `IL2WF-4` | a run stamped under mission A anchors mission B's TTL, so B expires when it is approved |
| `IL2WF-5` | a participant's `:fork` (the copied stamp) persisted `expired` onto the owner's live ledger, get→put |
| `IL2WF-6` | on an ownerless conversation, any visible member approved or revoked |
| `IL2WF-7` | the reckoning reported the newest stamped run of any approval as "the" contract |
| `IL2WF-8` | `intent-ledger.get` omitted `requireApproval` and the TTL |
| floors | a Viewer drafted and approved; a removed workspace member still revoked on a conversation they own (ADR 0136 §8 said "owner + `workspace:write`"; neither route nor tool checked it) |

The ledger can only **narrow** tools (`intersectScopes`), so none of this escalates past
the agent's ceiling. The harm is to the approval's meaning: the owner believes a
prohibition is in force that is not (`IL2WF-1`), a mission ends early or never
(`IL2WF-3..5`), and people who hold no authority over a conversation's tools decide
its mission (`IL2WF-6`, floors).

### Competitive reference

The pattern this contract follows is the agent "plan approval" step: Claude Code plan
mode, Devin's plan review, and Cursor's plan-then-act agent. Two properties are common to
all three and missing here. First, **the approval binds to the plan shown**: if the plan
changes, you are asked again, never silently approved. Second, **the scope of the approval
is visible**: what the agent may and may not do, and for how long. The per-tool approval
already in this app (ADR 0834 D2, FW2-CD-2: `requestedAt` echoed, 409 on change) follows
the first property; the mission contract does not. `docs/research/2026-06-23-ai-chat-competitive-analysis.md`
records the sibling per-thread approval pattern (Jan's allow-once/always/deny modal).

## Decision

**D1 — Approve what you saw.** `IntentLedger` gains `revision: number` and `updatedAt`, both
written by every write: REST draft, PUT, the agent draft tool, approve, reject, the gate's
expiry and the DSAR eraser. A new row gets a random `ledgerId` (`il-<uuid>`, not
`il-${Date.now()}`), and a fresh draft over an existing row continues that row's revision,
so `(ledgerId, revision)` never repeats (no A-B-A, even after a purge). `POST …/approve`
and `POST …/reject` REQUIRE `{ ledgerId, revision, digest }` (*amended 2026-10-15, lead review:* `digest` is the server's sha256 over the canonical contract shown — goal, the three tool lists, criteria, TTL — returned with every ledger; a revision proves nothing changed since the read, the digest proves WHAT was read, the ADR 0894 G-A pattern. `ledgerId` because a revision alone could repeat on a row deleted and redrafted — IL2CD-11): any missing ⇒ 400 naming the three fields; any mismatch ⇒ 409
`ledger_changed`. Approve re-runs `assertKeepsInherited`, because the team ledger may have
tightened since the draft. Approve stamps `approvedAt` + `approvedBy`; draft and PUT clear
both. Every write is a `compareAndSwap` whose `expected` is the row EXACTLY as decoded,
never a normalised copy. A legacy row without `revision` reads as `0` on the way out
only, because a normalised `expected` would never byte-match. A lost CAS on draft or PUT
is 409.

The legal transitions (anything else is 409):

| From → to | Who |
|---|---|
| none / `draft` / `rejected` / `expired` → `draft` | an editor (REST draft, PUT, the agent draft tool) |
| `approved` → `draft` | **nobody** — revoke first (*review B1*: `/draft` used to replace an approved mission with no revision and no decider) |
| `draft` → `approved` | the decider (D2), with the revision |
| `draft` / `approved` → `rejected` | the decider (D2), with the revision |
| `approved` → `expired` | the gate (D5), by CAS |

**D2 — Who decides.** A decision (approve or reject) needs the principal the
conversation's tools act as: `toolAuthorityHolds(actor, meta.ownerUserId)`, the predicate
the per-tool approvals route already uses (ADR 0834 D3).
- **Ownerless conversations.** These are routine: `setConversationRun`, the capability-scope
  PUT, kickbot and legacy chats all create them. On one, the decider is a tenant
  **admin** (`host:members:manage`), the manager of last resort as in ADR 0879 D4.
  "Nobody" would make an approved mission permanent (*review H5*).
- **Writes need `workspace:write`.** Every ledger WRITE (draft, PUT, approve, reject) needs
  it in the tenant, through ONE predicate in both lanes (*review H3*):
  - the routes call `requireTenantScope(req, 'workspace:write')`;
  - the draft tool calls `assertTenantScope(scope.tenantId, scope.actingUserId, 'workspace:write', { personalTenant })`
    from the TOOL scope, which is the CRM precedent.

  This is ADR 0136 §8's promise and the ADR 0879 D1 Viewer rule, and it is what refuses a
  removed member.
- **GET** returns `viewer: { mayDecide, mayEdit }` from the same predicates, so the page
  stops offering controls the server refuses.
- **Project chats.** The decider is whoever OPENED the chat (`ownerUserId` is set on first
  open, `projects/routes.ts:523`), not the project's admins. That is the conversation's
  existing ownership model, stated here rather than changed.

**D4 — A stamp names its approval.**

*Corrected by review B2.* A chat run lives for the whole conversation (ADR 0067: one
suspended `openwop-app.conversation` run per session), and the old stamp was written once.
So "match the stamp or fall back" would leave every later approval in that conversation
unanchored. The stamp is therefore **per approval**:
- **The map.** `run.metadata.intentLedgerApprovals` is an append-only map keyed
  `${ledgerId}@${approvedAt}`. Each entry is `IntentLedgerStamp` plus `ledgerId` and
  `approvedAt`.
- **Writing it.** The gate adds the entry for the CURRENT approval if it is missing
  (`resolvedAt` = now) and never rewrites an existing one, so `:fork`, which copies the
  map verbatim, re-reads the same anchor.
- **The anchor** is that entry's `resolvedAt`.
- **Legacy.** A legacy approved row (no `approvedAt`) and a legacy single `intentLedger`
  stamp (no `ledgerId`) on the same conversation keep today's anchor (legacy-to-legacy
  match, *review M8*); otherwise an entry is minted.
- **The runless (voice) lane** anchors at `approvedAt ?? createdAt`, which precedes every
  run under that approval, so it can only end a mandate sooner.

**D3 — Reserve the stamp (both keys).** `intentLedger` AND `intentLedgerApprovals` join
`RESERVED_RUN_METADATA_KEYS`. Only the gate writes them, through `storage.updateRun`,
which is not a strip site. `:fork` copies them verbatim (`routes/runs.ts:2002`).

**D5 — Expiry is the approval's, and it is a CAS.**
- **The condition.** The gate persists `expired` only when the run's entry is for the
  current approval, the TTL from that entry has elapsed, and a CAS against the row the gate
  read succeeds. A lost CAS writes nothing, because the owner changed the mission in
  between.
- **No actor condition** (*corrected from the Proposed text*). Once the stamp is reserved
  (D3) and per approval (D4), the only way a run holds an entry is that the gate minted it
  at that run's turn, or a fork copied it from such a run. A copied anchor is the source
  run's own anchor, so the fork's expiry is the source's expiry at the same moment, which
  is not early. A fresh run mints a later anchor. So no run can end a mission sooner than
  the owner's own run would. An actor condition would add nothing, and on an ownerless
  conversation it would make expiry unreachable (*review H5*).
- *Amended 2026-10-15 (lead review):* expiry is persisted only by the run that MINTED
  the approval's entry (the entry records its `runId`). A `:fork` copies the entry, so
  it re-reads the same anchor and is out of mandate itself, but it never writes back to
  the live ledger; the minting run persists it on its next turn. A legacy stamp (no
  `runId`) is enforced per turn and never persisted (prod holds 0 such rows).
- *Amended again (delta grade-code M1):* once the APPROVAL's own clock is out
  (`approvedAt + TTL`, server-stamped, the earliest bound any lane uses) any run records
  the expiry: the mission is over for every lane by then. Without it, a conversation whose
  minting run stopped taking turns (the user moved to a branch-fork) kept a stored
  `approved` forever while every turn was out of mandate. A fork still never writes on
  the strength of its COPIED stamp alone.
- *Correction (grade-code IL2CD-10):* "no run can end a mission sooner than the owner's
  own run" overstated it — a participant's first turn after the approval can mint an
  anchor before the owner's next turn. The real bound is that every anchor is at or
  after `approvedAt`, so no run ends a mission before `approvedAt + TTL`.

**D6 — The reckoning is the current approval's.**
- `GET …/reckoning` returns `null` unless the ledger is `approved` or `expired`.
- It counts only runs holding the entry for the current approval, and only their tool
  events at or after that entry's `resolvedAt`, so a conversation-long run's earlier work
  is not credited to this mission.
- Goal, criteria, authorized tools and gated tools come from the ledger, never from a run
  (*review L10*).

**D7 — The agent reads the whole contract.** `intent-ledger.get` adds `requireApproval`,
`expiresAtRelMs` and `revision`. It stays `schemaCarrying` and fenced.

**D7b — The lifecycle writers keep the invariants** (*review H6*).
- The DSAR eraser redacts `approvedBy` by CAS and bumps the revision. A list-then-put
  could resurrect a revoked approved row.
- The retention purger measures age from `updatedAt ?? createdAt`, not `createdAt`, which
  the agent tool used to carry from the first draft. A mission edited or approved
  recently is therefore not purged out from under the gate.

**D8 — The page.** The SPA sends the revision it rendered. On a 409 it reloads and says the
contract changed since you looked, showing the new text before a second approve is
possible. Approve, Reject and Revoke render only when `viewer.mayDecide` is true;
otherwise a one-line note names the owner as the person who decides. Two lines become
visible: "no allowed tools ⇒ the agent may talk but not act" when `allowed` is empty, and
the TTL when it is set.

**D9 — Correct the replay claim.**
- `FEATURES.md` and four code comments (`types.ts`, `ledgerProjection.ts`,
  `ledgerStore.ts` ×2) say the ledger is "read verbatim on `:fork`". Enforcement is LIVE by
  design; only the TTL anchor is replayed from the stamp. Both are corrected.
- The honest consequence (*review L11*): a fork made after a revoke runs with FEWER
  restrictions than its source run did. Tighter-wins holds for a NEW revocation, not for
  a removed mission. That is the ADR 0132 replay correction, unchanged, and stated rather
  than implied.

**D10 — Callers outside this repo** (*review M9*).
- The OpenWOP CLI (`openwop-cli/src/cli/intentLedger.ts:23`) sends approve/reject with no
  body, so it gets 400 after D1. It is filed for `/update-cli` (`IL2-R4`).
- An SPA tab opened before the frontend deploy also sends no body. It fails CLOSED (400,
  nothing approved), which is accepted.

## Adversarial `/architect` review (pre-code, 2026-10-15)

Twelve findings on the Proposed text, all folded in above:

| # | Sev | Hit | Resolution |
|---|---|---|---|
| B1 | Blocker | D1/D2 | `/draft` over an approved mission replaced it ungated ⇒ the transition table (approved → draft is refused) |
| B2 | Blocker | D4–D6 | one conversation-long run, stamp written once ⇒ per-approval append-only map |
| H3 | High | D2 | route `callerHoldsTenantScope` vs tool `assertTenantScope` diverge ⇒ `requireTenantScope` + `assertTenantScope` (one predicate) |
| H4 | High | probes | probes ran in one shared tenant whose later logins hold no membership ⇒ fresh founded tenant per case, peers added as editors |
| H5 | High | D2/D5 | "nobody decides" on ownerless made approved missions permanent ⇒ tenant admin decides; D5 has no actor condition |
| H6 | High | D1 | eraser list→put and `createdAt`-aged purge ⇒ D7b |
| M7 | Medium | D1 | normalised `revision ?? 0` as CAS `expected` never matches ⇒ raw decoded row |
| M8 | Medium | D4 | legacy rows anchor at weeks-old `createdAt` ⇒ legacy-to-legacy match |
| M9 | Medium | D1 | the CLI + stale tabs ⇒ D10 |
| L10 | Low | D6 | expired reckoning hidden, tools read from stamp ⇒ D6 |
| L11 | Low | D9 | the same claim lives in four code comments; post-revoke fork honesty ⇒ D9 |
| L12 | Low | D1 | lost-CAS on draft/PUT unspecified ⇒ 409 |

Sound as written: D3 (no legitimate creator passes `intentLedger`; the fork copies without
stripping), D7, D2's identity derivation (`ownerUserId` and the decider use the same
`req.userId ?? principalId` key), CAS byte-equality on the decoded row.

## Alternatives considered

- **A content digest instead of a revision.** It binds to bytes, but it is costlier to
  compute on every read, and two different drafts with identical text would collide,
  which is harmless but makes a revision bump unobservable. A monotonic revision under CAS
  is the per-tool-approval precedent (`requestedAt`). Rejected.
- **Forbid the agent from redrafting while a draft is open.** That fixes the race for the
  agent but not for a second tab or a PUT. It also blocks the legitimate "revise the draft"
  turn. Rejected in favour of D1.
- **Change `allowed: []` to mean "no allowlist".** A goal-only mission approved from the
  form today removes every tool. Reinterpreting it would WIDEN every approved legacy
  mission in place. D8 makes the consequence visible instead; a tool picker is a follow-up
  (`IL2-R2`).
- **Let any visible member decide on an ownerless conversation (status quo).** An approval
  spends authority, and a visible member does not hold it (ADR 0834 D3). Refused: a tenant
  admin decides instead (D2). "Nobody decides" was also rejected, because it made an
  approved mission permanent (review H5).

## Evaluation matrix

| # | Concern | Answer |
|---|---|---|
| 1 | Feature-package (0001) | all changes inside `features/intent-ledger/` + the one core gate `host/conversationToolScope.ts` + the reserved-key list |
| 2 | Toggle / admin UI | always-on (unchanged); no new toggle |
| 3 | Workflows (chains or stacks) | none owned; nothing pinned |
| 4 | Node / agent packs | none; the two chat tools ride the ADR 0308 seam |
| 5 | AI-chat envelopes | none new; D7 widens a read tool's payload (fenced, schemaCarrying) |
| 6 | Model output → durable state | the draft tool still writes `draft` only; D1 makes the human gate bind to the reviewed revision |
| 7 | RBAC | D2: decisions need the tool-authority holder; writes need `workspace:write`; route and tool share the predicate |
| 8 | Replay / fork | D4/D5: the anchor is replayed only for its own approval; a fork never writes the live ledger |
| 9 | DSAR | `approvedAt` and `revision` are not personal; the `approvedBy` eraser is unchanged; `goal` stays the stated gap (`ledgerStore.ts`) |
| 10 | RFC gate | none: host-extension routes and run metadata only |

## Implementation plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1 + D2 (routes, store CAS, draft tool) | `adr0896-…` D1/D2/floors |
| P2 | D3 + D4 + D5 + D7b (reserved keys, per-approval stamp, gate, eraser, purger) | `adr0896-…` D3/D4/D5/D7b |
| P3 | D6 + D7 | `adr0896-…` D6/D7 |
| P4 | D8 SPA + i18n (4 locales) | `IntentLedgerModal.test.tsx` |
| P5 | D9 FEATURES.md + tracker | — |

## Prod exposure (read-only check, 2026-10-15, user-approved, run by the team lead)

`intent-ledger` is ALWAYS-ON (toggle removed at graduation, 2026-06-24), so every hole
above was reachable in prod. The read found **0** intent-ledger rows in `host_ext_kv`,
**0** keys matching `%intent%`, and **0** runs carrying an `intentLedger` stamp (the same
table returned other features' rows in that session, so the lookup works). Live but never
used: no prod data needs repair.

## Implementation record

| Phase | Commit | Witness |
|---|---|---|
| probes (RED on `7f36f9f93`) | `8cccf90db`, `b56aae78d` | 13 + 2 RED, controls green |
| P1–P5 | `6a9503d1e` | `adr0896-intent-ledger-authority.test.ts`, `intent-ledger-{route,agent-tools,projection}.test.ts`, `IntentLedgerModal.test.tsx` |
| witnesses | `ba9928b9e`, the IL2CD-5 test commit | reckoning anchor filter, eraser CAS, revoke attribution |
| grade-ux / grade-code closures | `c6b33a297` | IL2UX-1/2 (Highs), IL2CD-1/2/3/5; deck `?conversation=&agent=` test |

Sabotage: 20 backend reverts (one per fix) plus 2 frontend ones (the deck handler and the
decide gate); every one turned its witness red, restored from HEAD each time.

## Residue (filed, not fixed here)

- `IL2-R1` — a removed member still READS a conversation they own. Conversation
  visibility is owner-based for plain chats, which is host-wide and not this feature's
  predicate.
- `IL2-R2` — the draft form offers no tool picker, so a form-made mission allows no tools
  (now stated on the page, D8).
- `IL2-R5` — `IL2UX-6` (a status chip on the Mission button needs an entry-chunk read),
  `IL2UX-7` (tool display names), `IL2CD-4` (a bounded event read for the reckoning).
- `IL2-R4` — the CLI's `intent-ledger approve|reject` must GET the ledger first and send `{ledgerId, revision, digest}` (D10). User decision: done in openwop-cli after this merges; the deploy carrying this waits for the CLI release.
- `IL2-R3` — the reckoning scans the tenant's newest 200 runs (`RUN_SCAN_LIMIT`). A
  conversation whose runs are older reads as no-runs. That needs a conversation-indexed run
  query.

## Open questions

- [x] Should ownerless conversations stay decidable by any visible member? **No**: a
  tenant admin decides (D2, review H5).
- [x] Does empty `allowed` change meaning? **No** (it would widen approved rows); made
  visible instead (D8).
