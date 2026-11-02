# ADR 1010 — model text never becomes an executed tool

Status: implemented

## Context

RFC 0256 §A says text must not become an executed tool. `openAICompatibleToolsRound` broke that rule. When a round had no structured `tool_calls` and its text held `<invoke name="…">`, `parseInlineToolCalls` turned the text into tool calls, and it matched the emitted name loosely (suffix or sanitized form). The parser was added for a MiniMax-M habit of writing a call as text.

A model repeats what it reads. An `<invoke>` block in an email or a web page could reach this parser through the model's own answer.

Measured on `openwop-app-backend` for the 30 days to 2026-11-01, read-only:

| Log line | Count |
| --- | --- |
| `tools_round_outcome` (control) | 28 rounds, all `minimax`, 2026-10-09 to 2026-10-27 |
| `tools_round_outcome` with `invokeMarkupInRaw: true` | 0 |
| `inline_tool_call_detected` | 0 |
| `inline_tool_call_parsed` | 0 |

The denominator is small. Only this OpenAI-compatible lane writes these lines, so the table says nothing about Anthropic or Google rounds, which never reach the parser.

## Decision

1. Delete `parseInlineToolCalls`, its detection branch and the `inline_tool_call_detected` and `inline_tool_call_parsed` log lines. The detection line also logged up to 2,000 characters of model text, which the rest of this lane does not do.
2. A round's tool calls come only from the provider's structured field. A round whose text holds tool markup returns that text unchanged, with no tool calls.
3. Keep `invokeMarkupInRaw` in `tools_round_outcome`. It is a count with no content, and it is how a return of this habit would show up. Drop `inlineToolCalls`, which can now only be zero.

## Alternatives

- **Keep the parser for exact names only.** Rejected. The risk is the path from text to execution, not the loose match.
- **Move the parser into a MiniMax adapter.** Rejected in RFC 0256 (alternative 0).
- **Strip the markup from the visible text.** Rejected. The turn did nothing, and hiding the markup would make it look answered.

## Consequences

- If MiniMax writes a call as text again, the person sees the markup and the tool does not run. `invokeMarkupInRaw` counts it.
- `MiniMax-M` delimiter noise is no longer removed in that case, because only the parser removed it.
- No wire, pack or storage change.

## Implementation record

| Phase | Commit | Result | Witness |
| --- | --- | --- | --- |
| P1 | 0156ef78c, merged 172b071c9 (#5464) | `providers/dispatchProviderTools.ts`; `test/minimax-inline-tool-calls.test.ts` deleted with its subject | `test/minimax-tools-round.test.ts`, red with the parser restored |
