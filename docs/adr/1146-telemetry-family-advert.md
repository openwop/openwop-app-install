# ADR 1146 — The v2 `telemetry` family, behind a flag (RFC 0262)

Status: Accepted (implemented behind the default-off flag `OPENWOP_TELEMETRY_FAMILY`)

> **The flag stays OFF until D6 is deployed.** Before D6, spans carry the bare stored run id, and a collector filtering by the id the client was given finds nothing. The advertisement would then claim an export a client cannot use.

## Context

RFC 0262 (openwop, `Active`) adds the core family `telemetry`. Its presence is the
claim that the host exports OTLP traces as `spec/v2/core/telemetry.md` requires:

- an `openwop.run` span per run, carrying `openwop.run_id` and `openwop.workflow_id`;
- an `openwop.node.<typeId>` span per node execution, carrying `openwop.run_id`,
  `openwop.node_id`, `openwop.node_type` and `openwop.node_attempt`;
- a run created with a valid W3C `traceparent` emits its spans in that trace;
- no credential material or resolved secret in any span.

This host already emits both spans with those attributes (`executor.ts`, the run
span and the node span), exports OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is
set (`observability/tracer.ts`, ADR 0118), and allowlists span attributes
(`safeSpanAttributes`).

One rule was not met. The run span took the ACTIVE context. A new run executes
inside the `POST /runs` request, so its spans landed in the caller's trace by
accident of scheduling. A run that resumes under a later request does not: an
approval resolved with another trace, a sweeper re-dispatch, or another instance's
lease. Its later segment then exported into the resolver's trace, or a fresh one.

The user decided on 2026-11-16 that the v2 reference host is RFC 0262's witness.
The reason: a production cut can see the spans only if production's exporter
points at the suite's local collector, which is a production configuration
change. This host implements the family too ("Both"), but its advertisement is
not used as evidence. The release manager's condition is that the host must not
advertise RFC 0262 until it honours the behaviour.

## Decision

- **D1 — the predicate.** `telemetryFamilyEnabled()` is true only when
  `OPENWOP_TELEMETRY_FAMILY` is `true` or `1` AND `OTEL_EXPORTER_OTLP_ENDPOINT` is
  set, so an exporter is wired. An advertisement with no exporter would claim an
  export that never happens.
- **D2 — the record.** With the predicate true, v2 discovery carries
  `telemetry: {status: 'experimental', since, until, witness: 'witnessable-gated',
  otlp: {protocols: ['http/json']}}`. The exporter is
  `@opentelemetry/exporter-trace-otlp-http`, which sends OTLP/HTTP JSON.
  `genAiSemconv` is not claimed: the activity span carries `gen_ai.request.model`
  and `gen_ai.response.finish_reason`, not the full chat-call set.
- **D3 — the trace is the run's own.** Under the same predicate, the run span is
  parented on the context the run was created under (`metadata.traceContext`, the
  RFC 0207 reserved key, read by `runTraceContext`). Node spans nest under the run
  span as before, so every segment of a run lands in the creating trace. With the
  predicate false, nothing changes.
- **D4 — no secret in spans** is the existing allowlist; nothing new is added.
- **D5 — the GenAI mapping (`genAiSemconv` 1.37.0).** *Added 2026-11-17.* RFC 0262
  cannot go `Accepted` until its GenAI leg has been shown able to fail (RFC 0263 §C),
  and no host claimed the facet. Under the same predicate, the record advertises
  `genAiSemconv: "1.37.0"`, and each model-call span (`wrapInSpan`) carries
  `gen_ai.operation.name` (`chat`), `gen_ai.provider.name`, `gen_ai.request.model`
  and `gen_ai.usage.input_tokens` / `output_tokens`. Only operation, provider,
  model and token counts: `genAiSpanAttributes` takes no prompt, completion or
  system prompt, so none can reach a span, and the suite's no-secret leg covers
  the new attributes like every other. A test-seam-only switch,
  `OPENWOP_SABOTAGE_GENAI=drop-usage`, leaves the token counts off, the red run
  RFC 0263 §C asks for.
- **D6 — spans carry the WIRE run id.** *Added 2026-11-17.* The suite's own legs,
  run against this host, recorded every host leg `blocked`. The collector filters
  by the run id the client was given (`<tenant>/<opaque>`), and the run, node and
  activity spans carried the bare stored id. This file's first test hid it by
  stripping the tenant before comparing. Under the same predicate,
  `openwop.run_id` is now `toWireRunId(...)` (`spanRunId`); with the family off,
  the bare id stays.

## Alternatives

- **Parent the run span on the stored context always, flag or not.** That is
  arguably the right default, but it moves production traces with no switch.
  The release manager asked for default-off flags; D3 costs one call when the
  flag is retired.
- **Advertise whenever an endpoint is set.** Rejected: it would make the
  advertisement a side effect of observability config. The flag makes it a
  decision.

## Phases

| Phase | What | Test |
| --- | --- | --- |
| P1 | D1–D4 | `test/adr1146-telemetry-family.test.ts`: the real app and exporter against a capture listener. It covers the predicate, the discovery record, the run and node spans and their attributes, a created-with-`traceparent` run, and a run RESUMED under a different `traceparent` that still exports into its creating trace. Removing the D3 parent turns only that last case red. |
| P2 (D5) | `genAiSemconv` and the GenAI span attributes | The same file's D5 case runs the `conformance-callai-attempt-accounting` fixture: the model-call span carries the 1.37.0 set, and a distinctive prompt string appears on no span. The `drop-usage` sabotage turns only that case red. |

## Open questions

- Retire the flag once RFC 0262 is `Accepted` upstream on the reference host's
  witness, and make D3 the unconditional behaviour.
