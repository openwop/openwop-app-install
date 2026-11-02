# ADR 1003 — Context economy: the tool diet keeps every parameter, the transcript window holds still, the cache covers the conversation, and the user is told

Status: implemented (P1 = D1, D4, D6, D7 merged in #5384 `601f47241`; P2 = D2, D3, D5 in the P2 PR; flips fully on its merge)
Date: 2026-10-29
Feature loop round 2, row 65 (Context economy, `context-economy`)
Amends: ADR 0148 (context economy, Tier A), ADR 0720 (the `enabled` docstring)
Gap ids: `CE65WF-*`, `CE65U-*`, `CE65C-*` (new, this pass; recorded in
`docs/steward/workflows-assessment/2026-10-29-context-economy-1003.md`)

## Context

Round 1 claimed **A** for this feature (grade-code A−, UX A−, WF A "vacuous"). Re-measured on
`origin/main` @ `f382e70d1`, it is not A. The levers are small, pure and individually tested. What
is wrong is that two levers corrupt or defeat what they act on, a third does less than ADR 0148
says, and none of them can be seen working:

| lever | defect at HEAD | how measured |
|---|---|---|
| A3 tool diet | deletes real **parameters** named `title`, `examples`, `deprecated`, `$id`, because the annotation denylist is applied at every depth, including inside `properties` | probe: the `openwop:kanban.add-todo` schema comes out `{required:['title'], properties:{}}` |
| A1 transcript | a sliding window moves its first kept turn on every exchange once full, and the elision count goes into the **system** message, which also changes every exchange. The provider prefix cache misses on every turn | code read: `conversationExchange.ts:565-628`, `transcriptBudget.ts:79-97` |
| A2 provider cache | breakpoints on tools and system only. The conversation is never cached, so each round of the tool loop re-bills the whole growing log at full price | code read: `dispatchAnthropicTools.ts:134-157, 251-265`, `dispatch.ts:354-364` |
| guardrail 3 | "budgets are observable" is unimplemented. Nothing records what any lever did | grep: no log, metric or event for an omitted turn, a dropped memory item, or a schema byte saved |
| A6 transport | the gzip wrapper replaces `res.json` with `res.end`, which bypasses `res.send`. So every JSON GET loses its ETag freshness check and its automatic weak ETag. `*;q=0, gzip` is refused, and `res.json(undefined)` throws | code read: `middleware/jsonGzip.ts:51-77` |
| user | the user is never told the assistant stopped seeing earlier messages. Only the model is told | grep: no feed or receipt surface |
| docs | `contextEconomy.ts` claims a "per-agent sub-allowlist", a "rolling summary" and a "meta strip", and none exists. ADR 0148 A2 says caching "neutralizes most of the A1 transcript cost", but A2 caches no transcript. The round-1 UX grade (A−) rests on "consumed by the shared admin feature-toggles console", and that console has no consumer of the projection | grep, the frontend has no `env-governed` client |

**The A3 blast radius is wider than chat.** `add-todo` is the ADR 0311 work-intake tool, the
**stack** half of the chains-or-stacks doctrine. With the diet on, the model is told `title` is
required and is shown no `title`, so the stack's intake degrades. At least nine registered tool
or artifact schemas carry a `title` property (crm task, podcasts episode, interactive-artifacts,
claude-code `add-todo`, slides). The diet runs on both the managed chat loop
(`conversationToolLoop.ts:446`) and the BYOK tools round that workflow agent nodes use
(`aiProvidersHost.ts:1206, 1344`). Whether a given provider rejects `required` naming an absent
property with a 400 is **unmeasured**. Either way, the model loses the parameter's description.

**The A1 cost inversion is structural, and its size is unmeasured.** With no window, the history
only grows at its tail, so an automatic prefix cache (MiniMax and OpenAI, ADR 0148 OQ3) or an
explicit breakpoint reads most of it at about 0.1×. A sliding window re-bills all of it at full
price on every turn. At the defaults (24k chars ≈ 6k tokens), the window costs more than
unbounded history until that history passes roughly 60k tokens. MiniMax is the managed free
tier, so A1 as built makes the default lane more expensive in the regime most conversations
live in.

**Prod exposure (lead's read-only read, 2026-10-29).** Of 132 env vars on `openwop-app-backend`,
exactly one is a context-economy var: `OPENWOP_CONTEXT_ECONOMY_PROVIDER_CACHE=true`. The master,
`_TRANSCRIPT`, `_TOOL_DIET`, `_MEMORY` and `_TRANSPORT` are unset. **A per-lever var acts without
the master** (`contextEconomy.ts`: `lever = envBool(name) ?? master`, pinned by
`context-economy-caching.test.ts` "a per-lever override beats the master"), so **A2 is LIVE** on
every Anthropic lane and A1, A3, A4 and A6 are **off**. The D1 Blocker, the A1 cost inversion
and the gzip defects are therefore latent, and D1 is still a Blocker: flipping the lever would
corrupt default-on tool schemas.

Cache, measured (`managed_prompt_cache`, 7 days, 15 entries 10-23 to 10-27, all `openwop-free`,
the MiniMax automatic cache rather than A2): 12 tools rounds, 549,840 prompt tokens, 15,172 read
from cache (about 2.8%; per-round ratios 0.01–0.07 except one three-round run at about 0.97);
3 chat calls, 1,506 prompt, 384 cached. A small sample, but it is consistent with the tool loop
being billed almost uncached.

## D1 — The tool diet is schema-aware: it strips annotations, never names (`CE65C-1`, Blocker)

`compactValue` walks the schema as if every object key were a JSON-Schema keyword. Replace it
with a walk that knows which positions hold a **schema** and which hold a **name map** or a
**value**:

- In a schema object, drop the annotation keywords (`$schema`, `$id`, `title`, `examples`,
  `$comment`, `markdownDescription`, `deprecated`) and recurse into the subschema positions:
  `items`, `prefixItems`, `additionalItems`, `contains`, `not`, `if`/`then`/`else`,
  `additionalProperties`, `unevaluatedProperties`, `unevaluatedItems`, `propertyNames`, and each
  element of `allOf`/`anyOf`/`oneOf`.
- In a **name map** (`properties`, `patternProperties`, `$defs`, `definitions`,
  `dependentSchemas`), keep every key and recurse into each value as a schema.
- Copy every other keyword's value through **verbatim**, without recursing. That covers `enum`,
  `const`, `default`, `required`, `dependentRequired` and unknown vendor keywords. An `enum` of
  objects that carry a `title` key keeps it.

The function stays non-mutating and returns the input unchanged when the lever is off, so the
off path stays byte-identical. The replay digest (`toolsRoundDigest(req)`) is taken over the
logical request before compaction, so it stays independent of the toggle.

**Witnesses:** the `add-todo` shape keeps `title`. An `enum` of objects keeps its keys. A
**census** compacts every registered builtin and feature agent tool's `inputSchema` and asserts
that the set of property names at every path, and every `required` array, is identical before
and after. It runs a second time over every pack-declared tool schema
(`packs/**/schemas/*.input.json`), because pack tools reach the model through the BYOK round
too, and `vendor.myndhyve.chat` `sendMessage.input.json` carries a `title` property. That census
is what would have caught this. The old test checked only annotation
positions.

## D2 — The transcript window moves in steps, so the prefix holds still between them (`CE65C-2`)

`windowTranscript` keeps its two caps (`keepLastTurns`, `maxChars`). It then rounds the first
kept index **up** to a multiple of a step `S`, counted from turn 0 of the conversation, which is
stable as turns append. It always keeps at least the newest turn. Between steps, the kept prefix
and the elision count are byte-identical from one exchange to the next, so the system block and
the history prefix both cache. The window shrinks by at most `S − 1` turns below what the caps
allow. That is the price, and it is bounded. At the default `S` the model sees 10 to 20 turns
rather than 20, a quality trade-off on a lever that is off by default (M2).

**Scope of the benefit (B2).** A stable window keeps the HISTORY stable. It does not make the
system scaffold stable: `composeChatContext` puts query-seeded retrieval into the system message
(the agent knowledge block, `chatContext.ts:241-266`, seeded by this turn's text; twin borrowed
recall the same way). For an agent with a knowledge binding, the system changes every exchange,
and every byte after it misses, whatever the window does. D2 pays off across exchanges only for
agents without query-seeded blocks. Splitting the scaffold into a stable prefix and a volatile
suffix is OQ3.

- `S` defaults to `max(1, floor(keepLastTurns / 2))`, overridable with
  `OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT_STEP_TURNS`. `S = 1` reproduces today's behaviour exactly,
  which serves as the regression witness.
- The function stays pure and deterministic over `(turns, cfg, sizeOf)`, and the event log stays
  full-fidelity, so this remains a presentation-only transform. No ids enter model text (the
  marker carries counts only; ADR 1002).
- The marker stays in the system message. It changes only when the window steps, and at a step
  the history prefix misses anyway, so moving the marker elsewhere would buy nothing.

The voice-seed digest (`chatContext.ts loadWindowedTurns`) always windows, by design, because a
voice instructions block must be bounded. It uses the same function and gains the same
stability. The projection gains a `note` saying so (D7).

## D3 — The provider cache covers the tool loop's conversation (`CE65C-3`)

> **Revised by the pre-code `/architect` pass (B1, B2 below).** The first draft marked the last
> message on every request. That pays Anthropic's 1.25× write premium on the whole conversation
> each exchange, and for any agent whose system scaffold changes per exchange it is never read
> back. It would have raised cost on exactly the lane it meant to cut.

A new lever, `conversationCache` (`OPENWOP_CONTEXT_ECONOMY_CONVERSATION_CACHE`, defaulting to the
master like every other lever). When it is on, an Anthropic request marks its **last message**
(its last text or `tool_result` block gets `cache_control: ephemeral`), but **only on a tool-loop
round after the first**, that is, when the last message carries tool results. Within one
exchange, tools and system are byte-identical from round to round, so round `n+1` reads rounds
`1..n` at about 0.1×, and the premium is paid only on the increment. Breakpoints stay at three or
fewer (tools, system, last message), under Anthropic's four.

- Both Anthropic tool dispatchers apply it: `dispatchAnthropicToolsRound` (the chat loop in
  `conversationToolLoop` and the BYOK and managed rounds) and the multi-round
  `dispatchAnthropicWithTools` (workflow nodes, `bootstrap/nodes.ts`). Each body is built from a
  copy, so the caller's `messages` and `log` are never mutated.
- Plain chat (`dispatch.ts`, no tools) gets no message breakpoint. It has only round 0.
- Non-mutating, wire-invisible, outside the replay digest, as with A2 today.
- **Cross-exchange** history caching (marking round 0) is NOT done. It pays off only when the
  system scaffold is stable across exchanges, and today it often is not (B2). That is OQ3.

OpenAI and MiniMax need no code. Their automatic prefix cache hits within a tool loop already,
and across exchanges D2 is what lets it hit when the scaffold is stable.

## D4 — Every lever reports what it did (`CE65C-4`, ADR 0148 guardrail 3)

> **Revised at implementation (P1).** The draft said "one line per exchange" aggregating every
> lever. The levers run at three different depths (the exchange, the knowledge composition
> inside the shared context owner, and each tool round), so one line would need an
> exchange-scoped accumulator threaded through all of them. One line per lever ACTION carries
> the same counts and keeps each lever's report at its own site.

`context_economy_applied`, emitted by `logContextEconomyApplied` (`host/contextEconomy.ts`) only
when a lever changed what the model is sent:

| `lever` | where | counts |
|---|---|---|
| `transcript` | `conversationExchange.ts`, when turns were omitted | `transcriptKept`, `transcriptOmitted` |
| `memory` | `agentKnowledgeComposition.ts`, when the budget dropped items | `memoryKept`, `memoryDropped` |
| `tool_diet` | `dietToolSurface` (`providers/toolSchemaCompaction.ts`), the one funnel all three model-facing sites now call | `toolSchemasCompacted`, `toolSchemaBytesSaved` |

Counts and the lever enum only, plus the plain `tenantId` field in the same form as
`managed_prompt_cache`. No conversation, message, tool name or retrieved content. Cache tokens
are NOT added here: BYOK already reports them on the wire-legal `provider.usage`
(`cacheHit`/`cacheReadTokens`/`cacheWriteTokens`), and the managed tier logs
`managed_prompt_cache`. P2 adds the `windowStep` count when D2 lands.

## D5 — The user is told when earlier messages were not sent (`CE65U-1`)

When the window omitted turns, the exchange appends a host event
`openwop-app.conversation.context-budgeted` with payload `{ conversationId, omittedTurns }`
(plus `speakerId` when there is one), best-effort, beside the `context-degraded` and
`recall-used` events it copies (`conversationExchange.ts:386-399`). The SPA stamps
`meta.contextOmittedTurns` on that exchange's assistant turn, using the same re-stamp
bookkeeping as `degradedBlocks`, and the bubble shows one quiet line: "The assistant saw only the
most recent messages; {{count}} earlier ones weren't sent." The line is in all four locales and
has no action, so there is nothing to approve or dismiss. The event is not model input. The count
is the only datum it carries.

## D6 — Gzip keeps Express's conditional-GET path (`CE65C-5`)

The wrapper keeps `res.vary('Accept-Encoding')`. Below the threshold it calls the original
`res.json`. Above it, it sets `Content-Type` and `Content-Encoding` and hands the gzip buffer to
`res.send`, so Express's ETag generation and `req.fresh` → 304 still run. The ETag is computed
over the encoded bytes, which is correct for a representation that varies by encoding.
`res.json(undefined)` passes through to the original. `acceptsGzip` honours the most specific
match (`gzip;q=0` refuses even with `*`, and an explicit `gzip` is accepted even under
`*;q=0`). When the response already carries a **strong** ETag (a route's own revision tag, e.g.
roster), the wrapper weakens it (`W/"…"`) before compressing, because a strong validator must
differ between encodings (RFC 9110 §8.8.1) and Express's freshness check compares weakly, so a
client's revalidation still answers 304. `gzipSync` stays synchronous, and that is stated as a risk: a multi-MB JSON body costs
event-loop milliseconds when the lever is on.

## D7 — The docs say what the code does

- `contextEconomy.ts`: A3 is "annotation-stripping only", A1 is "deterministic last-k, no
  summary", A6 is "gzip of `res.json` only". The three absent behaviours are removed.
- ADR 0148: a correction note under A2 (it caches no transcript until D3) and under A1 (the
  window defeats prefix caching until D2), and the guardrail 3 status.
- The env-governed projection's lever entries gain a `note`: for the transcript lever, "the
  voice-seed digest is always bounded". That is additive to a superadmin-only host route.
- UX-ASSESSMENT: a correction on the round-1 A− premise (no console consumer exists).

## Pre-code `/architect` pass (2026-10-29) — fold-in

- **B1 (Blocker, cost) — D3 as first drafted raised cost.** Marking the last message on every
  request pays a 1.25× write on the whole conversation per exchange, and the read happens only if
  the next request has a byte-identical prefix. Fixed: D3 is its own lever and marks only tool-loop
  rounds after the first, where the prefix is guaranteed stable within the exchange.
- **B2 (Blocker, false premise) — "the system block caches between steps" is false for
  knowledge-bound agents.** The scaffold carries per-turn retrieval (`chatContext.ts:241-266`).
  Fixed: D2 and D3 state the scope of the benefit, cross-exchange marking is dropped, and the
  scaffold split is OQ3.
- **H1 (High, HTTP) — D6 would reuse a strong ETag across encodings.** Fixed: weaken it on the
  compressed path.
- **H2 (High, coverage) — D1's census saw only the builtin registry.** Pack tool schemas reach
  the model through the BYOK round and include a `title` property. Fixed: the census also walks
  `packs/**/schemas/*.input.json`.
- **M2 (Medium) — the default step halves the average window.** Recorded in D2. `S=1` keeps
  today's behaviour.
- **M3 (Medium, existing) — the A2 system breakpoint already pays a write premium per exchange for
  knowledge-bound agents** and is read back only inside the tool loop. No code change. D4 measures
  it, filed as `CE65C-6`.

## Refused / deferred

- **Rendering the projection in the admin console.** It is a read-only panel on a superadmin
  page. Worth doing, but it is not where the defects are. Filed as `CE65U-2`.
- **Cache-aware cost in the receipt.** `turnCostUsd` ignores cache tokens (Anthropic reads are
  disjoint from `inputTokens`; OpenAI and MiniMax cached tokens are a discounted subset). It
  crosses chat, runs and usage-analytics. Filed as `CE65U-3`.
- **LLM rolling summary** (ADR 0148 deferral): still deferred, for the same replay and verifier
  reasons.
- **Gemini `cachedContent`** (ADR 0148 OQ3): still unmapped.
- **Turning any lever on.** That is an operator decision, made after D4 has produced numbers.

## RFC verdict

None. Every decision changes host-internal request assembly, a host-namespaced
(`openwop-app.*`) best-effort event of the kind already emitted beside it, a superadmin
host-extension route, or docs. No capability is advertised, and `transcriptWindow` and
`contextBudget` stay unadvertised (`rfc0111-context-budget-non-advert.test.ts`).

## Implementation plan

**PR split (lead decision, 2026-10-29):** **P1** = phases 1, 4a (D4), 5, 6, so the Blocker
ships alone and fast with the instrument guardrail 4 needs. **P2** = phases 2, 3, 4b (D5), after
P1 merges. P2 conditions: the ADR 1002 invocation-log digest and `llmCacheKey` must be identical
with D3 on and off (a `cache_control` marker stays out of the digest preimage), a stepped window
must give identical digests across two runs of the same conversation, and
`xch-env-9-model-input-run-independent` stays green with a lever-on case. The D5 event passes the
event-payload admission and vendor-event registration the other `openwop-app.*` events use. The
entry-chunk size is reported before and after.

| phase | decision | files | witness |
|---|---|---|---|
| 1 | D1 | `providers/toolSchemaCompaction.ts` | `context-economy-tool-diet.test.ts` (add-todo, enum-of-objects), new census `context-economy-tool-diet-census.test.ts` |
| 2 | D2 | `host/transcriptBudget.ts` | `context-economy-transcript.test.ts` (step stability across appends; `S=1` equals old behaviour) |
| 3 | D3 | `host/contextEconomy.ts` (new lever), `providers/promptCaching.ts`, `dispatchAnthropicTools.ts`, `routes/featureToggles.ts` (lever row) | `context-economy-caching.test.ts` (no mark on round 0, mark on a tool-result round, ≤4 breakpoints, non-mutating, off path byte-identical) |
| 4a | D4 | `host/contextEconomy.ts`, `providers/toolSchemaCompaction.ts` (`dietToolSurface`), `host/conversationExchange.ts`, `host/agentKnowledgeComposition.ts`, `host/conversationToolLoop.ts`, `aiProviders/aiProvidersHost.ts` | `context-economy-observability.test.ts` |
| 4b | D5 | `host/conversationExchange.ts`, SPA `conversationTransport.ts`, `useTurnTransport.ts`, `MessageBubble.tsx`, 4 locales | exchange test through `createApp` (event, no ids in model input), SPA transport + bubble tests |
| 5 | D6 | `middleware/jsonGzip.ts` | `context-economy-transport.test.ts` (304 with gzip on, ETag present, `*;q=0, gzip`, `json(undefined)`) |
| 6 | D7 | docs + `routes/featureToggles.ts` (the voice `note`) | `env-governed-capabilities.test.ts` |

Every new guard is sabotage-witnessed: break it, see red, restore.

## P2 design notes (read before P2 code, 2026-10-29)

- **D3 cannot detect "a round after the first" from the request.** `dispatchAnthropicToolsRound`
  flattens every message to text (`contentToText`), so the chat loop's tool results arrive as
  plain user text and no `tool_result` block exists to key on. The round index has to come from
  the caller: an optional `cacheConversation` flag on `ToolsRoundRequest`, set by
  `conversationToolLoop` on rounds ≥ 1 and threaded through `AiToolCallRequest`, the BYOK round
  and the managed round. It is a dispatcher hint. `toolsRoundDigest` names its fields
  explicitly (provider, model, messages, tools, max tokens, web search), so a new request field
  is outside the ADR 1002 preimage unless someone adds it. P2 adds a test pinning that the digest
  is identical with the flag set and unset.
- **D5 needs no registry entry.** `openwop-app.*` event types are admitted by the v2 vendor
  grammar (`storage/eventEra.ts` `VENDOR_TYPE` + `registeredOrgs()`; at most three segments, and
  `openwop-app.conversation.context-budgeted` has three). `run-event-payload-conformance`
  tolerates types with no `$defs` entry. `context-degraded` and `recall-used` are registered
  nowhere else. P2 still adds the new type to a test that round-trips it through a major-2 read.

## P2 implementation record (2026-10-29, `feat/fl2-65-p2`)

> **Correction found by the D2 witness (on the real exchange).** The elision line in the system
> message read "N earlier turn(s) omitted; the M most recent are shown". M grows on every exchange
> between steps, so the stepped window alone still changed the system message every turn. The
> line now carries only N. Without this, D2 would have been a stable window behind an unstable
> prefix: the same failure one level up.

| decision | where | witness (sabotage → red) |
|---|---|---|
| D2 stepped window | `host/transcriptBudget.ts` (`stepTurns`, default `keepLastTurns/2`, `S=1` = old); marker carries N only (`conversationExchange.ts`) | `context-economy-transcript.test.ts` stepped block (no round-up → red); `context-economy-context-budgeted.test.ts` stable-system case on 8 real exchanges (no round-up, or the kept count back in the marker → red) |
| D3 conversation cache | new lever `conversationCache`; `promptCaching.ts` `withAnthropicMessageCache`; `dispatchAnthropicToolsRound` (lever AND `cacheConversation`), `dispatchAnthropicWithTools` (round > 0); hint set by `runChatToolLoop` on round > 0 and threaded through `AiToolCallRequest`, the BYOK and managed adapter rounds, `dispatchManagedToolsRound` and the chat's managed wrapper; projection row with a note | `context-economy-conversation-cache.test.ts` (hint ignored, lever ignored, first message marked, loop round ignored → red); `context-economy-conversation-cache-replay.test.ts` (hint in the `toolsRoundDigest` preimage → 4 red, both lanes; hint not set in the loop → 2 red; BYOK adapter drops it → 1 red); `xch-env-9` lever-ON case (master on: rounds identical across two runs; hint absent from round 1, present later) |
| D5 disclosure | `conversationExchange.ts` appends `openwop-app.conversation.context-budgeted` `{conversationId, omittedTurns, speakerId?}`; SPA `contextBudgetedFromEvent`, `useTurnTransport` stamp + re-stamp, `MessageBubble` note (`role="note"`), plural keys in 4 locales | backend: renamed type, a message id in the payload, a two-segment vendor grammar → red (the last on the direct vocabulary round trip; the debug-bundle read does not exercise the major-2 mapping, which the witness showed); frontend: note removed, guards removed, stamp removed, replayed event accepted → red |

| D2 voice seed (found by the P2 self-review) | `voiceSeedBudgetConfig()` (`transcriptBudget.ts`), used by `chatContext.ts` `loadWindowedTurns`: same caps, `stepTurns: 1`. Without it the voice seed inherited the default step and kept 10 to 20 turns rather than 20, for no benefit, since a seed is composed once | `context-economy-transcript.test.ts` voiceSeedBudgetConfig case (returning the stepped config → red) |

**Entry chunk (frontend `npm run build`, `check-bundle-budget`), measured twice:** on the
`5799de05a` base, before 128.5 kB gzip (464 B headroom) and after 128.5 kB (483 B). After the
rebase onto `02ca1d9b3`, main alone builds 128.9 kB (108 B headroom; main grew, not P2), and with
P2 it is 128.9 kB (128 B). P2 adds nothing to the entry chunk. The UI lives in the chat chunk.

## Open questions

1. **OQ1 — default step `S`.** `keepLastTurns/2` is a guess that trades 10 turns of context for
   cache stability. D4 produces the numbers to tune it.
2. **OQ2 — should the managed (MiniMax) lane get the window at all**, given automatic caching?
   Only D4's numbers on a lever-on deploy can answer that.
3. **OQ3 — split the system scaffold into a stable prefix and a volatile suffix** (persona, tools
   policy and date first; per-turn retrieval last, or moved next to the current user turn). This
   is what cross-exchange caching needs. It changes the composition owner shared with voice, and
   where trust-fenced retrieval sits relative to the instructions, so it needs its own ADR.
