# ADR 1011 — tool-turn admission and recovery

Status: Accepted; P1 implemented. P2 not built: a separate decision, to be designed from the shadow in its plan

## Context

RFC 0256 §B fixes the order a host admits a tool call in, and §D says what a host does with recorded tool results. On this host:

- `runChatToolLoop` never read `finishReason`, so a call the output limit cut off still ran.
- `safeParseArgs` turned malformed JSON into `{}`, so the same cut-off call ran with no arguments whenever its schema allowed that.
- Arguments were validated after the approval, permission and firewall gates, so a person could be asked to approve a call that would then be refused.
- `normalizeFinishReason` mapped Anthropic's `refusal` to `other`, so nothing treated it as a refusal.
- A sweeper re-dispatch runs the node again at the same attempt. Ordinals rewind and the live path never reads the log, so tools that already ran run again. ADR 1002 serves recorded results only on a replay fork.

Four places admit a provider's tool calls:

| Path | Read |
| --- | --- |
| `runChatToolLoop` (agent runner, chat, anonymous actor) | changed here, and its three managed and widget adapters with it (see below) |
| `dispatchMiniMaxWithTools` (chat node's bound workflows) | ran the calls of a round that ended on `length`; changed here |
| `dispatchAnthropicWithTools` (same node) | already stops unless `stop_reason` is `tool_use` |
| `core.openwop.ai` and `core.openwop.agents` packs | one round, no loop; calls are returned, not run |

## Decision

### P1 — admission (RFC 0256 §B)

1. **Completion first.** The loop reads `finishReason` before it uses anything from a round with tool calls.
   - `length`: no call in the round runs, because which call was cut cannot be told. The model gets one host-authored repair, and the next cut ends the turn with `envelope_truncation_unrecoverable`. The same failure applies when no round is left.
   - `content-filter`: no call runs, nothing is retried, the round's text is not kept, and the turn ends with `envelope_refusal`.
   - A refused round with no calls keeps today's answer, but it no longer gets the announcement or continuation follow-up.
2. **`refusal` normalizes to `content-filter`.** `callAI` already fails that class without a retry, so an Anthropic refusal now stops there too.
3. **Malformed arguments are marked.** The OpenAI-compatible and Responses rounds set `argumentsInvalid` on a call whose arguments are not a JSON object, and the loop refuses it as `invalid_args`. Blank and `null` stay a call with no arguments, because providers send those for a tool with none. The mark survives the model-round record, so a replay takes the same branch.
4. **Adapters pass both signals on.** The loop can only read what its adapter returns. `dispatchManagedToolsRound` returned no stop reason, and the managed chat, managed run-node and anonymous widget adapters rebuilt each call as `{id, name, input}`, which dropped the mark. All three now return `toolRoundResult(round)`. The 28 rounds measured in ADR 1010 all paired with a `managed_prompt_cache` line, so without this the rest of P1 would not have reached any measured round. The Responses round (`webSearch`) reports a cut through `status: incomplete`, so it now maps that to a stop reason, and an unknown incomplete reason reads as the output limit.
5. **Arguments before gates.** Validation moves to directly after the name checks, ahead of the compaction marker, approval, permission and firewall gates.
6. **Bound workflows.** `dispatchMiniMaxWithTools` stops on `length` and `content_filter`, as the Anthropic path already does.

RFC 0256's outcomes map to the existing events: `executed` is `ok`, `refused` and `held` are `forbidden`, `invalid` is `error`, `suppressed-repeat` is an `agent.reasoned` note, and `ended-turn` is the ask or `endTurn`. No wire change.

### P2 — same-attempt recovery (RFC 0256 §D)

Not built. P2 ships in shadow first: on a re-entry at the same attempt, log what recovery would serve and which call would be in doubt, and change nothing. The design below is a plan until that log has been read.

- Read the tool-round and tool-result records on a same-attempt re-entry, not only on a replay fork.
- Serve recorded rounds and results. The first unrecorded call of a recorded round is the only call in doubt: re-run it when `replayPolicy` permits, otherwise fail the node with `tool_outcome_unknown`.
- A new attempt reads nothing.
- A failed record write fails the node for a tool whose `replayPolicy` is not read-only. Today it logs a warning.
- A result over the size limit is recorded as a digest with a truncation marker, and reads as a miss. Today nothing is recorded.
- Advertise `toolHooks.turnReplay` only once both §D rows pass on a production tool loop.

## Alternatives

- **Run the calls in a truncated round that parse.** Rejected. A complete-looking last call may still be missing arguments.
- **Add new error codes.** Rejected. `envelope_truncation_unrecoverable` and `envelope_refusal` are registered v2 codes with the right meaning.
- **Validate after the gates and accept the extra approval card.** Rejected. RFC 0256 §B fixes the order, and a card for a call that cannot run wastes a person's attention.
- **Turn off the loop's repair for truncation.** Rejected. A model that batched too much can fix it with one retry.

## Consequences

- A truncated round spends one more model call on the repair.
- A round that used to run its calls after a `length` stop now ends in a repair or a typed failure. A managed reasoning round is the likely case, though `tools_round_outcome` shows only 28 rounds in 30 days, so its rate is unmeasured.
- Chat turns get P1. RFC 0256 §D leaves chat out of recovery, so P2 applies to run nodes only.
- Of the 28 measured rounds, 16 ended on `tool_calls` and 12 on `stop`. None ended on `length` or `content_filter`.
- Gemini's other safety reasons (`RECITATION`, `PROHIBITED_CONTENT` and similar) still normalize to `other`. Widening that list also changes `callAI` retries, so it is left to a separate change.
- The chat node's bound workflows still validate against a permissive schema. Their child run checks its own inputs.

## Implementation record

| Phase | Commit | Result | Witness |
| --- | --- | --- | --- |
| P1 | 85383b17a, 353fab36d, merged 172b071c9 (#5464) | `host/agentDispatch.ts`, `host/conversationToolLoop.ts`, `providers/dispatchProviderTools.ts`, `providers/dispatchMiniMaxTools.ts`, `providers/managedProvider.ts`, `aiProviders/aiProvidersHost.ts`, `features/chat-widget/publicGateway.ts`, `features/chat-widget/widgetCredential.ts` | `test/adr1011-tool-admission-order.test.ts`, `test/adr1011-managed-chat-signals.test.ts`, `test/managed-tools-round-workflow-adapter.test.ts`, `test/managed-provider.test.ts`, `test/adr1018-d8-widget-credential.test.ts`, each site sabotage-witnessed. The `publicGateway.ts` closure has a source ratchet, not a gateway drive |
| P2 | | not built | |
