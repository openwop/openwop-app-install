# ADR 1119 — The tool loop records the model's own calls before their results

Status: Accepted (2026-11-13). Implemented with this ADR.

Requested by casavoga-ab for the user, from casavoga-prod (CasaVoga #413). Host-internal: it
changes the text the shared tool loop sends a model, not the OpenWOP wire. No RFC.

## Context

`runChatToolLoop` (`host/agentDispatch.ts`) keeps the transcript as plain role/content messages.
After a round with tool calls it pushed an assistant message only when the round had text
(`if (out.content) …`), then one `Result of <tool>: …` user message per call. A round with calls and
no text left no trace of the calls.

So the next round read a user message carrying a result, and nothing showing the model had asked
for it. On casavoga-prod on 2026-11-13, three runs in a row:
1. A person approved a gated tool (`casavoga.dashboards:catalog.label-run`) and pressed Continue.
2. The agent called it in a text-less round, and the run started.
3. The agent then said it had made no call and the "pasted" result was unverified.

CasaVoga worked around it in its prompt. Any agent whose tool returns an id will hit the same thing.

## Decision

**D1 — Every round with calls records one assistant turn before the results.** The turn is the
round's text, if any, then one line per call naming the tool: `Called <tool>.` The whole turn passes
through `defangUntrustedFence`, as the text turn did. The result messages, `toModelToolResult`, and
the fencing of results are unchanged.

**The arguments are never written into the turn.** They can carry what a person typed. ADR 0470's
anonymous lead capture keeps a visitor's email out of every later round, and the model already has
the arguments from its own round.

> **CORRECTED 2026-11-14 (train 270, before merge):** the first version wrote
> `Called <tool> with <JSON arguments>.` Train 270's gate went red on
> `adr0470-lead-capture.test.ts`: round 2 then carried the visitor's email. My targeted run had
> chosen its files by grepping for the loop's entry points, and that test enters through
> `runAnonReadTurn`, so it was missed. The turn is now name-only, and
> `test/tool-call-turn-recorded.test.ts` pins that no argument value appears in it.

**D2 — Plain text, not native tool_use pairing.** The loop's message model is role/content for
every provider (`toChatMessages`). Native pairing would change every adapter and the replay record
shape. A plain turn fixes the defect at one site.

**D3 — Replay.** The turn is a pure function of the recorded model round, so a run recorded after
this change replays byte-identically. The ADR 1002 digest is over the messages, and
`test/tool-call-turn-recorded.test.ts` pins that two runs of the same rounds send the same bytes.

A run recorded BEFORE this change, then forked or replayed after it deploys:
- **Nothing already recorded changes.** Invocation records are written once and never rewritten,
  and a fork writes under its own key. Events before the fork point are copied from the source, not
  re-derived from messages, so they are unchanged.
- **A re-executed agent node is served its first model round.** That round's messages contain no
  tool round yet, so its digest matches the source record.
- **Its tool results are served too.** They are keyed by tool name, input and the per-node ordinal,
  never by the messages (`host/replayToolResults.ts` `toolCallKey`), and that round's calls are
  the source's own.
- **The next model round misses.** Its messages now carry the call turn the source never sent. It
  is dispatched live, the existing ADR 1002 miss path. So that node's final answer may differ from
  the source's.
- **If that live round asks for a tool the source never called,** the tool lane does not execute
  it: the node fails with `replay_source_missing`. So a diverged fork can change a node's text, but
  it can never repeat or invent a side effect.
- **A clarification checkpoint saved before the change** resumes with its stored transcript tail
  verbatim (`clarificationCheckpoint.ts`). Only turns after the resume take the new shape. A live run
  never reads the replay log, so nothing misses.

Accepted rather than versioned: a per-run shape stamp would keep the defect alive in every replay
of an old run, and add a branch to the loop forever, for a cost that only forks of pre-change runs
pay. If forks of old runs come to matter, the cheaper fix is a replay-lane fallback that retries a
miss with the pre-1119 digest, not a second transcript shape. Recorded here so a live call or a
`replay_source_missing` in such a fork is not read as a replay bug.

## Alternatives

- **A note in the result message** ("Result of the call you made to X"). Rejected: it still leaves
  the model's side of the exchange missing, and a text-less round still reads as user-authored.
- **A versioned transcript shape** (stamp runs, keep the old shape for old runs). Rejected in D3.

## Phases

| Phase | What | Tests / witnesses |
|---|---|---|
| P1 | D1 in `runChatToolLoop`; `toolCallTurn` helper | `test/tool-call-turn-recorded.test.ts`: an approved gated tool re-called in a text-less round puts the call turn before its result; text plus two calls is one turn in order; the same scripted rounds send byte-identical messages twice; no argument value (an email, a key, a nested phone, a name) appears in the turn. `xch-env-9-model-input-run-independent.test.ts` and `adr1002-managed-and-tools-round-replay.test.ts` stay green |
