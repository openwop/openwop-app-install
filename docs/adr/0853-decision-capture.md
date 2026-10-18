# ADR 0853 — Decision capture: decisions made in chat, meetings and approvals reach the team ledger, confirmed by a person

Status: Accepted (maintainer go, 2026-10-07: "proceed" on the collaborative-orchestration plan) — P1–P7 implemented; P3's eval merge gate MET on 2026-10-09

- **Program:** ROADMAP § "Collaborative orchestration program", item 3, plus the
  two write-back sources ADR 0831 D5 deferred (resolved approvals and
  clarifications).
- **Composes:** ADR 0831 (team ledger: proposed deltas, owner accepts), ADR 0852
  (a project's chat or a BOUND channel is where a project's talk happens), ADR
  0233 §C8 (decisions are `decision-record` Documents; the ledger references
  them), ADR 0126 (channels), ADR 0175 (inbound Slack / Discord / Telegram), ADR
  0075 (approvals and clarifications), ADR 0038 §C (`host/untrustedContent.ts`).
- **Toggle:** none — **always on** (maintainer decision 2026-10-07: these
  features are not behind a toggle; the team ledger lost its toggle in #4590).
  The automatic suggester's cost control is its per-workspace daily budget,
  `OPENWOP_DECISION_SUGGESTER_DAILY_CAP` (default 200; `0` stops it).
- **RFC verdict:** host-only. Nothing on the wire changes; `decidedBy` on an
  interrupt (D5) is host-internal.

## 1. Context

Most decisions are made in chat and meetings, not in tickets; if they never reach
the ledger, agents work from stale intent. Measured on `origin/main`
(2026-10-07):

| Need | Exists? |
|---|---|
| A decision store | `decision-record` Documents; created today only by `POST /strategy/:id/decisions` (strategy-linked) and a pack node. `Provenance` has no link to *where* a decision was made |
| A place a project talks | the project's group chat; a channel bound to a project (ADR 0852 D5) |
| Per-message actions | `MessageActions` in `chat/MessageBubble.tsx` (copy, react, edit, …) |
| A "this looks like a decision" classifier | **none** |
| Inbound Slack / Discord / Telegram as messages | **no** — they start or resume runs (`metadata.inbound`), they are not stored |
| A hook on an approval / clarification being resolved | **none** a feature can subscribe to; an interrupt records no `decidedBy`; a clarification's answer is only the raw resume value |
| Meeting-ops output | `tmpl.meeting-ops.*` are mock-AI placeholders with no structured output |

## 2. Decision

### D1 — One confirmation path: a SUGGESTION becomes a decision only when a person says so

Every automatic source (D3–D6) produces a **suggestion**, never a decision:
`team-ledger:suggestions` rows `{suggestionId, tenantId, projectId, text, source:
{kind:'message'|'inbound'|'approval'|'meeting', ref, link?}, suggestedBy, status:
'open'|'recorded'|'dismissed', createdAt}`, bounded and redacted at write, at most
50 open per project. They appear on the project's Ledger tab (and the bound
channel's pane) under "Possible decisions", each with **Record** and **Dismiss**.
**Record** runs D2; Dismiss closes it. Nothing is written to the ledger without a
person's click.

### D2 — "Record as decision"

`POST /team-ledger/projects/:id/decisions {title, decision, rationale?, source?,
accept?}` (write on the project): creates a `decision-record` Document in the
project's org with a new structured `provenance.source = {kind, ref, link?}` (the
message / approval / meeting it came from), then PROPOSES a ledger delta adding
it to `decisionDocumentIds` (`source.kind` = the origin's kind). When the caller
is the ledger OWNER and passes `accept: true`, the same call accepts it — the
ROADMAP's "within one confirmation step". The UI action sits on every message in
a project chat or a bound channel (`MessageActions`), prefilled from the message,
and on each suggestion.

### D3 — The suggester (bound channels and project chats only)

On a new human message in a project chat or bound channel, a cheap classification
call asks "is this a decision?" with the ledger's current goal and scope as
context. A yes posts a suggestion (D1) linked to the message. Guards:

- the message is fenced as untrusted content (`host/untrustedContent.ts`); the
  model's only output is `{isDecision, title, summary}` — it cannot write;
- once per message (idempotent on the message id); skipped for agent messages,
  edits, and messages under 20 characters;
- a per-workspace daily token budget (default set in P3, configurable), after
  which it stops for the day and says so in the pane;
- **merge gate:** an eval fixture of labelled messages; P3 does not merge until
  precision ≥ 0.8 at recall ≥ 0.5 (the numbers are this ADR's bar; a false
  positive costs a Dismiss, a miss costs the D2 click it would have saved);
- an LLM-exchange audit row (`docs/steward/LLM-EXCHANGE-AUDIT.md`).

### D4 — Inbound Slack / Discord / Telegram

Inbound messages are not stored, so they cannot carry a message action. A
connection may name a project (`connection.config.projectId`, owner-set, write on
the project). An inbound message on that connection whose text starts with
`decision:` creates a suggestion (D1) with `source.kind:'inbound'` and the
provider's permalink when it gives one. Nothing else inbound is read.

### D5 — Approvals and clarifications

- A core seam, `host/interruptResolutionObservers.ts`, fired from
  `resolveAndResume` (run interrupts) and `resolveApproval` (inbox approvals),
  fail-soft, carrying `{tenantId, runId?, kind, outcome, question?, answer?,
  decidedBy}`. `InterruptRecord` gains `resolvedBy` (host-internal).

> **CORRECTED in P4:** the seam fires from `resolveAndResume` only — after the
> winning claim and its `interrupt.resolved` row, on the three PERSON paths
> (quorum reject, reject, accept); never a lost claim, a timeout, a cascade or
> a timer. It carries `{runId, interruptId, kind, outcome, data, resumeValue,
> decidedBy?}`. `resolvedBy` is NOT persisted on `InterruptRecord` (that is a
> change to all three storage adapters for a field nothing reads yet); the
> seam carries `decidedBy` at resolution time. Inbox approvals
> (`resolveApproval`) are not covered yet.
- **A resolved approval on a run stamped with a ledger** creates a suggestion
  (D1) "Approved: <what>" / "Rejected: <what>" — an approval is a decision, but
  which field it changes is a person's call, so it stays a suggestion.
- **An answered clarification** whose question matches one of the ledger's open
  questions (case- and space-insensitive) PROPOSES a delta removing that
  question, `why` = "Answered: <answer>" (ADR 0831 D5's rule: the owner accepts).
  Any other clarification does nothing.

### D6 — Meeting notes

`tmpl.meeting-ops.action-extraction` gains a real extraction step with a
structured output `{actions[], decisions[]}`. When it runs on a project (stamped
run), each extracted decision becomes a suggestion (D1) with `source.kind:
'meeting'` and the run as its link. No live meeting bot (ROADMAP: out of scope).

> **CORRECTED in P6:** the shipped templates are not changed — they are
> model-free samples by design (`mock-ai`), and a real extraction step needs a
> provider/model binding the template layer does not have (no shipped workflow
> uses `core.ai.structuredOutput`). P6 is instead a CONTRACT through the one
> run-terminal seam: any project-stamped run whose final output carries
> `decisions` feeds them in as suggestions, so a user-built extraction plugs in.

### D7 — `Decision:` lines in a project's documents (added 2026-10-11)

D6 leaves meeting notes unhandled unless someone builds an extraction workflow,
and the meeting-ops templates are frozen replay archives (ADR 0775 P2,
maintainer decision 2026-10-10). The app has no meeting feature; notes live in
documents. So the D4 convention extends to them: in a document whose owner is a
PROJECT with a ledger, a line that starts with `Decision:` (after an optional
list marker, number or bold) and was not in the previous version becomes a
suggestion (D1) with `source.kind:'meeting'`, linked to the document and
suggested by whoever saved it. Deterministic and model-free: no eval gate, no
cost. A decision-record document never feeds itself. At most 20 new lines per
save; the ref is the document plus the line's hash, so re-adding a line is
idempotent. Delivered through a core seam (`host/documentVersionObservers.ts`,
fired by `addVersion` once per inserted version, fail-soft) so the documents
feature does not import the ledger. The keyword is English in every locale (the
Ledger tab says so in each language).

## 3. Consequences

- One path into the ledger's decisions, always through a person; automatic
  sources only make the person's job shorter.
- `decision-record` Documents gain a structured link to where they were made.
- The suggester is the program's first model call made without a person asking;
  D3's budget, merge gate and audit row exist because of that.

## 4. Phased implementation

| Phase | Scope | Exit |
|---|---|---|
| P1 | D2 route + `provenance.source` + the message action in project chats / bound channels | Route tests (write needed; owner `accept` accepts, a non-owner's `accept` only proposes; source stored); component test for the action; browser leg where the e2e lane allows (chat needs a provider — see ADR 0852 P3) |
| P2 | D1 suggestions store + the Ledger tab / pane list (Record, Dismiss) | Store bounds, the 50 cap, erasure; component tests |
| P3 | D3 suggester + budget + eval fixture + audit row | Eval meets the bar (merge gate); idempotent per message; agent messages skipped; budget stops it |
| P4 | D5 seam + `resolvedBy` + the two rules | Each rule creates exactly one suggestion / proposal; nothing auto-accepts; replay does not duplicate |
| P5 | D4 inbound `decision:` | Only the prefix, only a project-linked connection |
| P6 | D6 meeting extraction | Template output validates; each decision → one suggestion |
| P7 | D7 `Decision:` lines in project documents | One suggestion per new line; org-level docs, no-ledger projects and decision records file nothing; the cap counts new lines only |

## 5. Implementation record

| Phase | Branch | Evidence |
|---|---|---|
| P7 | `feat/meeting-decisions` | `host/documentVersionObservers.ts` (fired in `addVersion` after the pointer moves) + `features/team-intent-ledger/notesSource.ts`; a hint on the Ledger tab (4 locales). `adr0853-notes-decisions.test.ts` (4, real documents routes): a new line ⇒ one suggestion linked to the document, by its writer; only new lines; re-adding is idempotent; past-the-cap filing; org-level / no-ledger / decision-record ⇒ nothing; the parser. **Sabotage-witnessed:** decision records not excluded, no ledger check, the seam not called, no previous-version diff (the cap test). An org-level-document probe could not fail (no project resolves), so the `kind === 'project'` check is defense in depth, not witnessed |
| P1 | `feat/record-as-decision` | `POST …/decisions` + `provenance.source` + the message action. Backend `adr0853-record-decision.test.ts` (3), frontend `recordDecision.test.tsx` (5) + `recordDecisionButton.test.tsx` (2). **Sabotage-witnessed:** a non-owner's accept accepting (the route's owner check is the only guard: `acceptDelta` does not check), any link accepted, own messages losing the action. No browser leg (chat needs a configured provider; ADR 0852 P3) |
| P2 | `feat/decision-suggestions` | `team-ledger:suggestions`, the list / dismiss routes, record-from-suggestion, erasure + cascade, "Possible decisions" on the Ledger tab. Backend `adr0853-suggestions.test.ts` (4), frontend `decisionSuggestions.test.tsx` (3). **Sabotage-witnessed:** no 50 cap, no open-check before writing, Record not sending the suggestion id |
| P4 | `feat/resolution-sources` | The seam + the ledger subscriber. `adr0853-resolution-sources.test.ts` (3, real executor + `resolveAndResume`). **Sabotage-witnessed:** the accept path not announcing, no clarification dedupe |
| P5 | `feat/inbound-decisions` | `connection.projectId` (write on the project), the inbound seam inside the delivery dedup, `decision:` ⇒ suggestion. `adr0853-inbound-decisions.test.ts` (3, real `handleInboundEvent` with Slack signature + redelivery dedup). **Sabotage-witnessed:** any text accepted. My own test caught that Slack's handler passes the `event` object, not the raw callback. Not tested: the route's `projectId` check (the PUT needs a published workflow) |
| P6 | `feat/run-decisions` | The `decisions` output contract via `onAnyRunTerminal`. `adr0853-run-decisions.test.ts` (3, real executor + terminal fan-out). **Sabotage-witnessed:** not subscribed |
| P3 | `feat/decision-suggester` (#4558, merged 2026-10-10) | Enqueue in-request via `host/humanChatMessageObservers.ts` (channel posts, group-chat turns); classify on a bounded worker tick (never in-request — ADR 0699 D1) with one quick-class headless call, fenced, strict parse, daily budget; a yes files a suggestion. Toggle `decision-capture` (default ON) — **removed before merge** (always on, #4590's decision). `adr0853-decision-suggester.test.ts` (5, model injected). **Sabotage-witnessed:** unfenced input, no budget. **Gate MET 2026-10-09:** `scripts/eval-decision-suggester.mts` (30 labelled) on `claude-haiku-4-5-20251001`: precision 0.94, recall 1.00 (tp 15, fp 1, fn 0, tn 14) against ≥ 0.8 / ≥ 0.5, on two runs with the same score. The one false positive is a one-off reminder ("standup moved to 10am tomorrow only") |

> **Correction 2026-10-12 (grade-tests wave 29):** `adr0853-resolution-sources.test.ts` now runs 4
> cases, not 3: a Rejected-approval case was added for the path the test header promised but never ran.
