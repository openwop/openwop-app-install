# ADR 0796 — A reply that announces an action and calls no tool gets one follow-up

Status: implemented (2026-10-01)

Relates to: ADR 0773 (Builder Pair Canvas, G-10b), ADR 0791 (scoped catalog read),
RFC 0064 (tool events). Host behaviour only: no wire change, no RFC.

## Context

The chat tool loop (`runChatToolLoop`, `host/agentDispatch.ts`) ends a turn when a
round returns no tool call. That is right for a final answer and wrong for one
shape: the model writes "First batch — add the trigger and the scoring step:"
and stops. The user reads a promise; nothing was done.

Measured on the managed tier (MiniMax-M3) in the ADR 0773 G-10b eval, three runs
on 2026-10-01. The per-round log added the same day (`tools_round_outcome`) shows
it is a model stop, not a parser or budget defect: `finish_reason: stop`, zero
structured and zero inline tool calls, raw length equal to visible length, 50–162
output tokens against a 16,384 budget. A prompt rule ("call first, talk after",
agent pack 1.3.4) did not remove it: the first-draft case failed the same way
with the rule in place.

## Decision

When a round returns no tool call, tools were offered, at least one round is
left, and the reply ends on a colon, the loop appends the reply and ONE
host-authored user message asking for the call (or a final answer), then
continues. At most once per turn. It emits `agent.reasoned` so the follow-up is
visible in the run's events.

The trigger is the trailing colon and nothing else. It is deliberately narrow:
a question, a sentence or a list is a real final answer and is left alone.

## Alternatives weighed

- **Prompt only.** Tried first; measured not to work on this model.
- **Classify intent with a second model call.** Costs a call on every final
  answer to catch a rare shape, and adds a non-deterministic judge to the loop.
- **Phrase matching ("let me", "I'll now").** Language-specific and matches
  honest final answers ("I'll leave the gate as it is.").
- **`tool_choice: required` on the next round.** Not portable across the
  providers this loop serves, and it forbids the legitimate "nothing more to do".

## Trade-offs

- A final answer that genuinely ends on a colon costs one extra round. The
  model is told it may simply give its final answer.
- The follow-up spends one of the turn's rounds (default 5), so it never fires
  on the last one.
- Replay: the decision is a pure function of the recorded reply text, so a
  replayed turn takes the same branch.
- The message is host-authored and trusted; the model's own reply is defanged
  before it re-enters the context, as on the `schema.request` branch.

## Implementation record

| Change | Witness |
|---|---|
| `endsOnAnnouncement`, `ANNOUNCED_WITHOUT_CALL_NUDGE`, the branch in `runChatToolLoop` | `test/announced-action-without-tool-call.test.ts` |

## Open questions

- [ ] Does it clear ADR 0773 G-10b cases 2 and 4 on the managed tier? Recorded
      in `docs/evals/builder-pair-architect.md` when measured.

> **Extended 2026-10-04 (ADR 0773 B.7).** A second follow-up shape now sits beside the trailing-colon one, keyed on STATE instead of wording: a tool result may carry `continueTurn` (a string = its work is unfinished; `null` = finished), and when the model then stops without a call the loop sends that text, at most `MAX_CONTINUATIONS` times per turn, each adding `CONTINUATION_ROUNDS` rounds up to a hard cap. The colon heuristic stays for turns with no such tool. Witness: `test/unfinished-plan-followup.test.ts` (disabling the branch reddens 3 of 5).
