# ADR 1006 — Run-lane clarification through a tool

Status: implemented — amends ADR 1001; merged state recorded in § Phase → commit

## Context

ADR 1001 built clarification twice. Chat asks through a tool
(`openwop:chat.ask-user`). A run asks through RFC 0021: the model writes a
fenced `clarification.request` block into its reply text, and the loop
extracts it, completes it with `completeModelEnvelope` and passes it to
`acceptEnvelope`.

RFC 0255 deletes the AI Envelope and RFC 0256 §E requires a run's tool loop to
raise a clarification through a tool. So the run lane must stop reading asks
out of text. Everything else ADR 1001 built is unaffected: the lift, the caps,
the checkpoint, the suspend, durable keys, the fork rules, the card.

Measured for this decision:

- **No stored run depends on the fence.** Census 2026-10-30, read-only: 0 of
  23,768 production runs carry the `openwop-app.agentClarification` stamp, and
  0 of 228 `invocation_log` rows hold a fenced kind. No compatibility reader is
  needed.
- **The acceptor gave this path no redaction.** The call passed no
  `byokCanaries`, so its redaction step never ran. Going around it loses
  nothing, and it means a model's question was never scrubbed.
- **Tool calls reach the transcript as text.** The loop pushes `Result of …`
  user messages and no `tool_use` blocks, so the ask has to be written into the
  transcript as text as well.

## Decision

### D1 — One tool, in both lanes

`openwop:chat.ask-user` is renamed `openwop:ask-user`. Its name, description and
schema live once, in `host/clarificationLift.ts` (`ASK_USER_TOOL`,
`askUserContract()`), generated from `CLARIFICATION_LIMITS`. The rename touches
no stored data that matters: the chat toggle is off and no pack lists the tool.
An allowlist override naming the old id would stop matching, which leaves the
tool off, the state it is already in.

### D2 — On a run, the loop handles the call

A run's tool results are served from the replay log (ADR 1002). If the ask went
through `executeTool`, a replay would get a recorded `{ok}` with no questions
and the run would have nothing to suspend on. So `runChatToolLoop` handles
`openwop:ask-user` itself when `opts.clarification` is set. The ask is then a
pure function of the recorded model round, and it spends no effect ordinal, as
the fenced ask did not. Ordinals in ADR 1001 D3.3 hold unchanged.

The chat lane keeps `executeTool` and its sink. Chat is out of the replay
contract (RFC 0256 §D).

### D3 — The host grants the tool, per run

The ask does not ride the agent's allowlist. `runToolLoop` appends it when the
run's frozen stamp allows asking (ADR 1001 D5), as the fence was open to any
agent in a stamped run. An agent that also lists it is filtered at the node, so
it is offered once. With no stamp it is not offered, and a forced call is
refused like any tool off the allowlist.

No firewall or permission gate applies. Asking a person has no effect, and who
may answer is decided at the node (ADR 1001 D4). Tool output earlier in the turn
still restricts the answerer.

### D4 — The cap and the repair move into the loop

`limits.clarificationRounds` was enforced by the acceptor and is now a check in
the loop, with the same `cap.breached{observed}` and `cap_breached` failure. A
refused ask is fed back once with the lift's own reason, as RFC 0256 §B
requires, then fails `clarification_ask_invalid` (was
`clarification_envelope_invalid`).

### D5 — A mixed round

Calls before the ask run normally. Calls after it do not run: they are recorded
`forbidden`, and the model is told so, because unlike a chat turn a run
continues after the answer and the model would otherwise assume they ran. A tool
held by the firewall earlier in the turn still escalates before the ask
(ADR 1001 A-H1).

### D6 — Text is never an ask

The clarification fence is deleted with `completeModelEnvelope`,
`isEnvelopeOnlyClarification` and the `clarification_not_enabled` failure. Text
shaped like the old fence is ordinary output, in every toggle state. The
`schema.request` fence stays until the host deletion (the next ADR in this
program).

A provider with no tool calling fails the turn with its typed
`host_capability_missing` (`aiProvidersHost.ts`), as it already did on the
stamped path, which meets RFC 0256 §E's "typed failure, not a guess". That is
from a code read; no test here drives a provider without tool calling.

### D7 — Scrub the question

`liftClarification` runs `scrubSecretShaped` over questions and choices, in both
lanes, so a key a model read from a tool result does not reach the card, the
event log or the inbox. It runs after the length check, because a long run
scrubs down to a short marker and would otherwise pass the cap. `resumeSchema`
is built from the scrubbed choices, so what a person picks still validates.

## Alternatives weighed

- **Keep the fence until the host deletion.** Rejected. It would ship a surface with no
  reader that a later PR deletes, and the port is what proves ADR 1001's lanes
  survive the deletion.
- **Route the run ask through `executeTool` and teach the replay guard about
  it.** Rejected. It makes a side-effect path carry something with no side
  effect, and spends an ordinal the fenced ask never did.
- **A separate tool per lane.** Rejected. It keeps two names for one behaviour,
  and RFC 0256 §E's behaviour is one thing.
- **Offer the tool through the allowlist.** Rejected. Every agent pack would
  need a new version for a capability that is the run's, not the agent's.

## Compatibility and rollout

Host-only; no wire change. `interrupt.requested`, the resume shape and
`cap.breached` are unchanged. Host failure codes change as stated in D4 and D6.
Both toggles stay off, so production behaviour does not move, apart from the
scrub, which only runs on an ask.

The system prompt changes, and it is in the semantic digest. A fork of a run
stamped before this ships would miss its record. The census found no such run.

## Phase → commit

| Phase | Commit | Witnesses |
|---|---|---|
| Port | `85fba5fa8` (#5413) | `adr1001-p1-clarification-run`, `-fork`, `adr1001-byok-replay-zero-live-calls`, `adr1001-review-fixes`, `clarification-lift`, `xch-env-9-*` |

The ADR 1001 tests were moved onto the tool first, so the port is judged by the
same cases that judged the fence: lane, fork, zero live calls on a BYOK replay
fork, cap, expiry, restricted answerer.

Sabotage-witnessed, each red then restored:

| Sabotage | Red case |
|---|---|
| offer dropped | a run stamped to ask offers the tool |
| offered with no stamp | a run born with the toggle off is not offered it |
| loop branch dropped | 10 cases across the lane tests |
| cap off by one | the advertised cap |
| no typed failure on the second refusal | one repair, then a typed failure |
| repair text not the validator's | one repair; the byte-identical transcript |
| later-call note dropped | the mixed round (both levels) |
| held approvals dropped | the firewall-held tool survives |
| tool output not untrusted | the restricted answerer; the mixed round |
| ask missing from the transcript | the mixed round |
| scrub dropped, question or choice | the scrub case |
| scrub moved before the length check | the caps case |
| schema cap drifts from the lift | the tool contract case |

The first run of these left two survivors, both real test gaps. The mock provider
ignores the offered tool list, and the loop handles a forced call anyway, so no
test could see a model never being offered the tool. Those assertions now sit at
the provider boundary, with a separate case for the sanitized name's round trip.

## Open items

- The host deletion removes `schema.request`, the acceptor and
  `envelopeProjection`'s lift caller.
- #5409 (approval trust) also touches `agentDispatch.ts`; whichever of the two
  lands second rebases onto the other.
- ADR 1001's enablement checklist still governs turning either toggle on.
