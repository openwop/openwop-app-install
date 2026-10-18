# ADR 0856 — A team ledger can narrow the tools agents use in its project's chats

Status: Accepted (maintainer decision 2026-10-07: yes, through a security review) — P0 review done; P1–P2 implemented, mission pre-fill included

- **Program:** ADR 0831 D6 ("per-conversation ledgers inherit the team ledger and
  can only narrow it"), rebuilt because D6 as written cannot be implemented.
- **Composes:** ADR 0831 (proposed deltas, owner accepts), ADR 0136 (mission
  ledgers), ADR 0132 (per-conversation capability scope, `intersectScopes`, the
  never-widen rule), ADR 0852 (project chat / bound channels).
- **Toggle:** `team-intent-ledger`.
- **RFC verdict:** host-only.

## 1. Context — why D6 cannot be built as written

An ADR 0136 mission ledger restricts **tool ids** (`allowed`, `forbidden`,
`requireApproval`, enforced by `resolveConversationToolGate`); the team ledger's
`inScope` / `outOfScope` are **prose**. There is nothing to intersect: "narrow
the team ledger's scope" has no operational meaning for a tool gate, and making a
model decide whether a tool call is "in scope" would put an LLM in an
authorization path.

## 2. Decision

### D1 — An optional tool policy on the team ledger

`toolPolicy?: { forbidden: string[]; requireApproval: string[] }` (tool ids or
prefixes, the ADR 0132 vocabulary, ≤ 50 each), changed ONLY through a proposed
delta the ledger owner accepts — like every other ledger field. No `allowed`
list: a team ledger can only take tools away or add a person in front of them,
never grant one.

### D2 — Enforced through the one tool gate, narrowing only

For a conversation that is a project's chat or bound to a project (ADR 0852 D5),
`resolveConversationToolGate` folds the project's CURRENT ledger tool policy in
with `intersectScopes`: `forbidden` and `requireApproval` are unions; nothing is
ever enabled by it. A mission ledger drafted in such a conversation is pre-filled
with the team ledger's goal and scope (text) and its tool policy (ids), and can
only narrow further. Refusals are the existing `agent.toolReturned{status:
'forbidden'}`; requires-approval is the existing gate.

### D3 — Security review before any code

This changes an authorization path, so P1 starts with an `/architect` review of:
the fold site (one, in `resolveConversationToolGate`); that a bound channel whose
project goes private stops applying the policy (ADR 0852 D5's inert rule) —
**fail-closed question for the review: does an inert binding drop the narrowing
(fail-open for tools) or keep the last policy?** The proposed answer is KEEP the
last-applied policy until the channel is unbound, because narrowing must never
silently lapse; and that no path lets a delta ENABLE a tool.

## 3. Phased implementation

| Phase | Scope | Exit |
|---|---|---|
| P0 | `/architect` review of D2/D3 | Findings resolved in this ADR |
| P1 | D1 field + delta validation + UI in the Ledger tab | A delta cannot add an allow; caps; owner-only accept |
| P2 | D2 fold + mission pre-fill | A forbidden tool is refused in the project chat and a bound channel; requires-approval gates; nothing is ever enabled; sabotage: the fold removed ⇒ the refusal test goes red |

## 4. P0 security review (2026-10-07) — findings, all adopted

1. **The fold goes through a SEAM, and the seam can only narrow.**
   `resolveConversationToolGate` is core; importing the team-ledger feature
   there would cross the ADR 0630 boundary. A core registry of conversation
   SCOPE CONTRIBUTORS returns `ConversationCapabilityScope | undefined`, and the
   gate folds every contribution with `intersectScopes` — which cannot widen
   (`disabled` and `requireApproval` are unions; `enabled` only intersects). A
   contributor's output never replaces the scope, so "narrow only" is
   structural, not a convention a contributor must honour.
2. **No allow list.** The policy has `forbidden` and `requireApproval` only; a
   delta carrying any other key is refused by `validatePatch`. Nothing in the
   ledger can enable a tool.
3. **The inert-binding question: KEEP the narrowing.** When a bound channel's
   project turns private, ADR 0852 D5 stops composing its ledger TEXT (the text
   would leak to members who cannot read the project). A tool restriction leaks
   nothing comparable and must not silently lapse, so the policy keeps applying
   while the channel stays bound. Deleting the project removes its policy (the
   binding then points at nothing); recorded, accepted.
4. **Which conversations.** A project's group chat (owner subject) and channels
   bound to it — the two places ADR 0852 says the project's talk happens —
   through the one gate both text chat and voice use. Workflow runs are NOT
   covered by this ADR (their tools are governed by their workflow definition);
   a follow-up if a run-level policy is wanted.
5. **Bounds.** ≤ 50 entries per list, each an ADR 0132 tool id or prefix
   (`[A-Za-z0-9:._*-]`, ≤ 128 chars), refused (never rewritten) otherwise.

## 5. Implementation record

| Phase | Branch | Evidence |
|---|---|---|
| P1–P2 | `feat/ledger-tool-policy` | `toolPolicy` field + strict validation (no allow list); the narrow-only seam `host/conversationScopeContributors.ts` folded by `intersectScopes` in `resolveConversationToolGate`; the ledger contributor for project chats + bound channels; Ledger tab shows and proposes it. Backend `adr0856-ledger-tool-policy.test.ts` (4), frontend +1. **Sabotage-witnessed:** the fold REPLACING instead of intersecting (drops the conversation's own narrowing), the fold removed, extra policy keys allowed, the form not proposing it. The mission-ledger pre-fill was recorded here as not done; it is the next row. |
| P2 (pre-fill) | `feat/mission-prefill` | The D2 mission PRE-FILL, drafting only: the gate above still enforces, and no second enforcement path was added. Seam `host/missionDraftInheritance.ts` (the ADR 0136 feature never imports the team ledger); the team ledger's provider in `toolPolicy.ts` composes per caller: nothing from a project the caller cannot read, and for a bound channel nothing unless the project is org-visible (the ADR 0852 D5 rule of the chat context). All three mission write paths (`POST …/draft`, `PUT`, the `draft-contract` agent tool) run one rule, `intent-ledger/inheritance.ts`: an ABSENT goal / `forbidden` / `requireApproval` takes the inherited value; a SUPPLIED list that drops an inherited id is REFUSED with a 400 that names the ids. The ledger validators refuse and never rewrite (XCH-TL-1), so this does too. Coverage uses the gate's own match: a covering prefix keeps an id, and forbidding a require-approval tool keeps it. `GET …/prefill` gives the form the goal, the scope text and the ids, and the Mission modal pre-fills the goal and shows them. The text is stored and shown as data, like a typed goal. The mission ledger has no scope field, so in-/out-of-scope reach the form but are not copied into the row. Backend `adr0856-mission-prefill.test.ts` (5, real HTTP), frontend +2. **Sabotage-witnessed:** defaults not applied; refusal removed; refusal removed from the agent tool only; caller-access check bypassed; bound-channel org-visible check removed; exact match in place of prefix coverage; provider unregistered. Frontend: goal not pre-filled; inherited region not shown. Each one reddened a test. |
