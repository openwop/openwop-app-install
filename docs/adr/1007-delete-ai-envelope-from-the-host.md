# ADR 1007 — delete the AI Envelope from the host

Status: implemented (2026-10-31). Implements RFC 0255 on this host and pins suite 2.46.36.

## Context

RFC 0255 deleted the AI Envelope from v2. Model emissions are tool calls or structured outputs, and MCP and A2A stay at the boundaries. The user's rule for this program: we are the only users of the protocol, so delete rather than deprecate.

ADR 1006 moved the only live path, the run-lane clarification, onto `openwop:ask-user`. Everything left was the fenced `schema.request` loop, test seams and the advertisement.

## Decision

1. Delete `host/envelopeAcceptor.ts`, `envelopeNormalizers.ts`, `envelopeProjection.ts`, `a2uiSurfaceAdmission.ts`, `schemaRequestEnvelope.ts`, and the `schema.request` branch of `runChatToolLoop`. Delete the bundled envelope prompt templates, which taught a model a contract no longer served.
2. Keep the run event envelope, the error envelope, persisted `envelope.*` reliability events, `spec/v1/`, the `chat/a2ui` renderer and `interruptBridge`. `envelopeEventLog` stays: it backs test seams unrelated to the envelope.
3. Move `reasoning`, `tierOneSubsetCompliance` and `reliability` onto `aiProviders`, with the v2 hyphenated event names. Drop root `envelopes` and `supportedEnvelopes`, `limits.schemaRounds` and `limits.envelopesPerTurn`. `limits.maxToolRounds` and `maxRepairRounds` are not advertised; advertising them would add a promise this change does not need.
4. On exhaustion `dispatchStructured` emits `cap.breached` `kind: "schema"` after `envelope.retry-exhausted`. The spec requires it (`host-services.md` §Structured output) and this host never emitted it; `v2-provider-output-reliability` found the gap.
5. The attempt-accounting mock gains a `refusal` script kind.
6. Delete the vendored `vendor.myndhyve.ai`. Its registry source is deleted and its v2 versions are yanked (openwop-registry#103).
7. Withhold the three `conformance-interrupt-form*` fixtures until ADR 1013 implements RFC 0255 §E. Advertising them today would be false.

## Alternatives

- **Register `core.conformance.stream-text`.** Rejected. It was planned so that deleting the pack would not withhold `conformance-stream-text`, because a withheld fixture used to record `blocked`. Suite 2.46.36 records `inapplicable` when neither the fixture nor the mock is advertised, the scenario targets major 1 only, and this host has no `stream-text` mock. A node would be code whose only behaviour is to fail.
- **Keep `schema.request` for a release.** Rejected by the user's rule.

## Consequences

- `conformance-stream-text` is no longer advertised; its scenario is `inapplicable`.
- A stored workflow naming a node from the deleted pack fails `host_capability_missing`, as it already did on any host without the pack.
- The ADR 1002 fork witnesses that ran through `schema.request` are gone with it. `adr1002-*` and the ADR 1001 run tests keep the same guarantee on the tool path.
  > **Corrected 2026-10-31:** `xch-env-9-model-input-run-independent` is kept. It guards a general rule (no model request depends on the run), and #5424 added the ADR 1003 lever-on case to it, so this ADR's first cut was wrong to delete it. It now scripts the ask-repair, clarification and tool rounds instead of `schema.request`. The repair round also replaces the repair pin in the deleted `xch-env-9-replay-stable-echo`.
- The approval block over an untrusted surface (`untrusted_content_blocks_approval`, RFC 0209 §C.12, ADR 0755) goes with the surfaces, code included. It read `ui.a2ui-surface` events bound to an approval, and only the test seam could record one. The pinned suite still carries its scenarios (`a2ui-untrusted-blocks-approval`, `aiEnvelope.trustBoundaryPropagation`), so a cut must not count them as passing.
- `envelope_correlations` is still in the schema. ADR 1008 drops it in a later release.

## Implementation record

| Phase | Result | Witness |
| --- | --- | --- |
| Deletion + pin | #5416, merge `ba0d3893e` (train 324, 2026-10-31) | major-2 lane on 2.46.36: `v2-envelope-surfaces-absent`, `v2-capabilities-root-closed`, `v2-provider-output-reliability` |
