# ADR 0612 — WFAU-4: honest tool-return failures on the wire (RFC 0064 §E)

Status: implemented

## Context

`WFAU-4` (UX-ASSESSMENT), `WFAWF-10` (WORKFLOWS-ASSESSMENT) and the UX facet of
`WFAC-2` (CODEBASE-ASSESSMENT) are one Blocker seen from three lanes: **the
workflow-author — and any agent — cannot honestly surface a tool FAILURE on the
wire.** ADR 0596 (R1) closed the node-contract half but recorded that the wire
half "cannot be closed in a host PR": `agent.toolReturned` carried no populated
`error`, so a failed tool was schema-legal-indistinguishable from a
success-with-empty, and the browser rendered a failure as **"returned ok"**
(`chat/EnvelopeInspector.tsx` gated on a `tc.error` that was never populated;
`chat/AgentEventCards.tsx` shipped a complete error card at `:136-144` that never
received data).

The fields already existed in `schemas/run-event-payloads.schema.json`
(`_errorObject`, `status`, `durationMs`); nothing **mandated** their population on
failure. That mandate is a NORMATIVE prose change, not a schema change — so it
belongs in an RFC, and the host cannot honestly advertise the behaviour until the
wire shape is locked. The spec session (openwop-1) authored the **RFC 0064 §F
"Tool-failure honesty"** amendment (additive; no schema delta) — **merged as
openwop #1152, conformance suite `1.143.0`** — and locked its normative core
(numbered §E while under review, §F on merge):

> An `agent.toolReturned` that represents anything other than a successful result
> MUST carry a failure discriminator — `error` populated (`_errorObject`, and
> `status:'error'` when the host advertises `toolHooks.prePostEvents`), OR one of
> the gate statuses `forbidden`/`rate_limited`. A tool-return with `outcome`
> absent AND `error` absent AND `status ∈ {absent, ok}` MUST NOT represent a
> failure of any kind (execution error, timeout, unknown-tool, or
> capability-precondition). `error` and `outcome` stay mutually exclusive.
> `durationMs` is present iff the tool actually ran (absent for a
> capability-precondition gate, like `forbidden`/`rate_limited`).

This host advertises `toolHooks.prePostEvents`, so it owns the `status:'error'`
half of the discriminator.

## Decision

Populate `agent.toolReturned.error` at every **non-gate** failure site, honouring
§E end-to-end (wire → transport → card). No schema change; no new capability flag
(this makes an already-advertised capability more honest).

### Wire (backend)

`host/toolHooks.ts` — two shared helpers:
- `CAPABILITY_PRECONDITION_CODES = { host_capability_disabled, host_capability_missing }`
  — the two thrown codes that mean "gate, not run" (from `featureSurfaces.ts` and
  `AiProviderError`). A failure with one of these codes carries `error` +
  `status:'error'` but **no `durationMs`** (the tool never ran, like the gate
  statuses).
- `extractToolErrorCode(err)` — reads a structured `.code` (the feature-surface
  gate, `AiProviderError`, `OpenwopError`); falls back to `tool_execution_failed`
  for an unstructured throw. The code is a discriminator, never secret-bearing.

`host/agentDispatch.ts` (the real dispatch loop):
- The arguments-validation site emitted `status:'invalid_args'` — **never a valid
  wire enum member** (`ok|error|forbidden|rate_limited`). Now `status:'error'` +
  `error{code:'invalid_args', message}`, no `durationMs` (validation is
  pre-execution).
- The execution site emitted `status:'error'` with **no `error`** — the WFAU-4
  gap. Now the failure branch carries `error{code, message}` with `durationMs`
  present iff the code is not a capability-precondition. Success is unchanged
  (`status:'ok'` + `durationMs`).

**The code is DERIVED, not read from one field — the wiring the first cut got
wrong.** The sole production `executeTool` (`createAgentToolProvider`) *catches*
a thrown tool error internally and returns `{content, isError}`, so a naïve "read
`err.code` in the dispatcher's catch" is **dead code** — the throw never reaches
the dispatcher, and a capability-disabled tool would degrade to
`error.code:'tool_execution_failed'` with `durationMs` **falsely present** (an
adversarial-review catch; the first tests masked it with a throwing mock).
Two-part fix:
- `agentToolProvider.ts` preserves the thrown code: its catch returns
  `errorCode: extractToolErrorCode(err)` (so the `featureSurfaces`
  `host_capability_disabled` / `AiProviderError` `host_capability_missing` throw
  survives). `ExecuteAgentTool` gains `errorCode?`.
- `deriveToolErrorCode(execOut)` (`toolHooks.ts`) resolves the wire code:
  the swallowed-throw `errorCode` wins; else the code the tool *stringified into
  its `content` JSON* (`{code|error}`) is parsed out; else `tool_execution_failed`.
  `durationMs` is suppressed whenever the **derived** code is a
  capability-precondition — so both a thrown gate and a returned structured
  `host_capability_missing` are honest, while a returned `validation_error` (the
  tool ran) keeps its duration. Witnessed through real code by
  `agent-tool-provider.test.ts` (a >4000-char query throws `knowledge_query_too_long`
  → provider preserves it) — not a mock.

`host/connectionInjection.ts` (the `ctx.http.safeFetch` audit pair): the `'error'`
branch (a thrown fetch that is not an egress-policy refusal) now carries
`error{code, message}`; a `forbidden` egress refusal still carries no `error` (it
never left the host).

Every `message` reaching an event is SR-1-redacted with `scrubSecretShaped`. The
6× `forbidden` gate emissions and the `evaluateToolHook` `rate_limited` path are
unchanged — already honest per §E.

### Rendering (frontend)

The card (`AgentEventCards.tsx:136-144`) already renders `error.code` +
`error.message` with per-code i18n fallback. The missing link was the transport:
- `conversationTransport.ts` `ToolActivity` now carries `error?:{code,message}`,
  mapped from `agent.toolReturned.error` (a malformed error with no string `code`
  is dropped — never a broken renderer).
- `chat/hooks/chatSession/lib.ts` prefers the wire `error` over the
  status-derived `{code:status}` it used to synthesise, falling back to the status
  code only for the `forbidden`/`rate_limited` gate statuses (which carry no
  `error`). Before §E every failure collapsed to the bare code `error` here.

### Conformance seam

The tool-hooks seam gains a `simulateToolError` arm (in `evaluateToolHook`): a
tool that PASSES the authz + rate-limit gates, RUNS, then throws → `status:'error'`
+ populated `error` (`_errorObject`, SR-1-redacted) + non-negative `durationMs`.
`ToolReturnedFields` gains `error?`; `ToolHookStatus` gains `'error'`. The gate
statuses (`forbidden`/`rate_limited`) still carry no `error` and no `durationMs`.

**Served at the CANONICAL conformance path, not just the vendor one.** The seam was
registered only at `/v1/host/openwop-app/toolhooks/invoke`, but the conformance
suite drives every `tool-hooks-*` scenario through the `/v1/host/sample/*`
namespace (`host-sample-test-seams.md`). At the vendor path the §F scenario would
404 → soft-skip → WFAU-4 an **unwitnessed** wire claim (an openwop-1 review catch).
The one handler is now registered at BOTH `/v1/host/sample/toolhooks/invoke`
(canonical) and the vendor alias. The whole `registerTestSeamRoutes` module is
gated on `OPENWOP_TEST_SEAM_ENABLED=true` (OFF by default; the harness sets it).
`toolhooks-seam-route.test.ts` boots the host and asserts BOTH paths serve the §F
shape (and the ok/forbidden cases) — a non-vacuous "reaches the seam, not a 404"
witness, so `OPENWOP_REQUIRE_BEHAVIOR=true` genuinely exercises it.

### Replay / fork

The `error` is recorded in the durable event and re-served **verbatim** on
replay/`:fork` (the event log is fixed history; `agentRunnerNode.ts:270` persists
`{ ...ev }` whole). SR-1 redaction is applied **at record time**, before append —
identical to how `durationMs` is already handled (`replay.md`). No value is
recomputed at replay.

## Wire governance

This is host work riding a **merged** RFC 0064 §F amendment (openwop #1152, suite
`1.143.0`; authored in `../openwop` by the spec session; additive; no schema
delta). The three-part bar in `CLAUDE.md` § "A spec change needs an RFC" is met:
the wire shape is locked (and merged), the RFC does not itself gate advertisement,
and this host honours the behaviour — witnessed by the §F conformance scenario via
the seam arm above. The
change is **additive** — it strictly increases wire honesty and breaks no consumer
(`intent-ledger` keys on `status:'ok'`; `anonymousActor` on `status:'forbidden'`;
both preserved). Two tests that pinned the wire-invalid `status:'invalid_args'`
literal were corrected in the same PR.

## Implementation record

| Concern | Site | Test |
|---|---|---|
| helpers | `host/toolHooks.ts` (`CAPABILITY_PRECONDITION_CODES`, `extractToolErrorCode`, `deriveToolErrorCode`) | `tool-hooks.test.ts` (classifier units) |
| validation failure | `host/agentDispatch.ts` (`invalid_args` → `error`+code) | `agent-dispatch-tool-error-surfacing.test.ts` + `agent-dispatch-tool-loop.test.ts` |
| execution failure | `host/agentDispatch.ts` (error branch, code `deriveToolErrorCode`, durationMs iff not capability-precondition) | `agent-dispatch-tool-error-surfacing.test.ts` |
| provider thrown-code preservation | `host/agentToolProvider.ts` (catch → `errorCode`) | `agent-tool-provider.test.ts` (real `knowledge_query_too_long` throw) |
| safeFetch failure | `host/connectionInjection.ts` | (covered by existing connection tests + the invariant) |
| conformance seam | `host/toolHooks.ts` (`simulateToolError` arm), `routes/testSeam.ts` (both `/sample/` + vendor paths) | `tool-hooks.test.ts` (§F error + gate⊥error) + `toolhooks-seam-route.test.ts` (booted host, both paths reachable) |
| transport carry-through | `chat/conversationTransport.ts`, `chat/hooks/chatSession/lib.ts` | `conversationTransport.test.ts` |

Born-red witness: on `origin/main` the execution site emitted no `error`, so
`error?.code` was `undefined` and the validation site emitted `status:'invalid_args'`
— the witness assertions cannot pass without this change.

## Consequences

`WFAU-4` / `WFAWF-10` / `WFAC-2`(UX facet) are closed **end-to-end**: a failed
tool now emits `error{code,message}` + `status:'error'` (or a gate status), the
transport carries it, and the existing card renders it — a real code + reason
instead of a failure shown as "ok". The last wire-gated residual of the 20-Blocker
steward program (GOAL #96) is retired.
