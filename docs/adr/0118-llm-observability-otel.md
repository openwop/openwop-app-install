# ADR 0118 — LLM observability: OpenTelemetry + per-turn tracing (+ admin usage dashboard)

**Status:** in-progress — **Phase 1 (core) implemented** (2026-06-24): the LLM span primitive + the **no-prompt-bytes / no-credential allowlist enforcement** (`observability/llmSpans.ts`). `safeSpanAttributes` is the single enforcement point — only provider/model/token/latency metadata survives (prefixed `openwop.ai.`); prompt/response content + credential-shaped keys are dropped. `withLlmSpan` is a no-op pass-through when OTel is unconfigured (OTel-API tracer, never throws). **Phase 1b (path wiring) implemented** (2026-06-24): the two real-provider `dispatchChat` calls in `conversationExchange.dispatchReply` (BYOK-direct + compat) are wrapped in `withLlmSpan(PROVIDER_DISPATCH_SPAN, {provider, model})` — the allowlist drops prompt/key/baseUrl (§D-safe), and the span is a no-op pass-through when OTel is unconfigured. **Phase 2 (usage rollup) implemented** (2026-06-24): `features/usage-analytics/` — `recordUsage`/`getUsageRollup` (a per-(tenant,provider,model) cumulative token-usage cache, additive, ranked by total) + the admin route `GET /usage/orgs/:orgId/rollup` (authorizeOrgScope read, toggle `usage-analytics` OFF/tenant). The dispatch-path write-through is now **Phase 2b implemented** (2026-06-24): `conversationExchange.dispatchReply` fire-and-forgets `recordUsage(tenantId, {provider, model, inputTokens, outputTokens})` after the compat + BYOK dispatches (best-effort — a rollup failure never breaks the turn). So the rollup now populates from real dispatches. The remaining + the Langfuse sink + the FE dashboard (Phases 3–5) pending. **Date:** 2026-06-23
**Toggle:** `observability` · default **OFF** · `bucketUnit: tenant` (the admin **usage dashboard** is the toggled product surface). The OTel **span export** itself is NOT a feature toggle — it is env-gated infra (`OTEL_EXPORTER_OTLP_ENDPOINT`, already wired in `observability/tracer.ts`) so it is on the same code path under enforcement on/off.
**Surface:** host-extension `/v1/host/openwop-app/observability/*` (admin usage dashboard, non-normative) + the existing OTel span pipeline (`observability/tracer.ts`, `observability/costEmitter.ts`, `middleware/traceContext.ts`). No new wire contract.
**Depends on / composes (all implemented — this is assembly + enrichment, not new infra):**
- **`observability/tracer.ts`** — the OTel `NodeTracerProvider` + OTLP HTTP exporter already exist (`@opentelemetry/sdk-trace-node`, `BatchSpanProcessor`, env-gated on `OTEL_EXPORTER_OTLP_ENDPOINT`). This ADR adds per-turn/per-dispatch **span instrumentation**, not the SDK.
- **`observability/costEmitter.ts` (RFC 0026 / RFC 0084)** — `emitCost`/`sanitizeCostForOtel` already records `openwop.cost.*` token+USD attributes on the active span under the SDK-shared allowlist. The dashboard aggregates these; the spans reuse them.
- **`providers/usageEmitter.ts` (RFC 0026)** — the canonical `provider.usage` payload (input/output tokens, `costEstimateUsd`, `cacheHit`, `traceId`) already emitted per provider call before `node.completed`. The dashboard's time-series reads this run-event signal; spans annotate from it.
- **`middleware/traceContext.ts`** — W3C `traceparent` propagation already gives browser ↔ Cloud Run trace continuity. Per-turn spans become children of the caller's trace for free.
- **ADR 0029 (assistant-evals-health-indexing)** — the admin "health" snapshot + the `(entity, dimension)` secondary-index primitive in `hostExtPersistence`. The usage dashboard JOINS this admin surface and reuses the index primitive for its time-series reads; it does NOT fork a second metrics pipeline.
- **ADR 0088 (run-read-authz)** — `host/runAccess.loadReadableRun` is the run-read gate. Any dashboard drill-down to a single run's trace routes through it (tenant-scoped, 404-not-403).
- **ADR 0067 (conversation-run secret stripping)** + **ADR 0077 (data classification / PII log masking)** — the redaction contract spans MUST honor (see Privacy below).
- **`features/analytics/*` (ADR 0018)** — the existing public-beacon/reporting feature. This is the SEPARATE operational/cost lens (LLM tracing + spend), not page/event/conversion analytics; the two report different things and must not be collapsed.

**RFC verdict:** **host-extension — NO new RFC.** OTel span instrumentation, an OTLP export toggle, an optional Langfuse sink, and an admin usage dashboard are all operational instrumentation over host-internal data. The `openwop.*` span/cost namespace is already governed by the accepted `observability.md` + RFC 0026/0084 (this rides them; mutating the cost-attribute allowlist would be the only thing that earns an RFC, and this ADR does not). Vendor span attributes stay under the host-vendor namespace per `observability.md`/`host-extensions.md`. Dashboard routes live under `/v1/host/openwop-app/*` and never touch the wire.

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9 backlog item **B8 — "LLM observability: OpenTelemetry + per-turn tracing"** (HIGH) and §11 roadmap Q3. Research verdict: PARTIAL — "Message feedback (ADR 0071), run telemetry, health indexing (ADR 0080). ABSENT: OTel/Langfuse tracing, eval/leaderboard." Competitor impl paths: LibreChat `packages/api/src/{telemetry,langfuse,rum}/` (OTel + Langfuse + RUM proxy — the most complete in the field); Open WebUI `utils/telemetry/` + `routers/analytics.py`; LobeHub `packages/{observability-otel,agent-tracing}/`. This ADR **folds** the §9 "general audit logging" + the Open-WebUI/AnythingLLM "usage-analytics dashboard" items into one observability surface.

---

## Context — boundaries audit first (MANDATORY)

The naive build is "add OpenTelemetry + a metrics store + a usage dashboard." Every one of those layers already has an owner in this host; standing up a parallel tracer, a second cost store, or a fresh metrics pipeline is the `no-parallel-architecture` violation. The corrected scope is **instrument the dispatch path + aggregate signals that already flow.**

| Concern | Existing owner (file:line) | How this ADR reuses it |
|---|---|---|
| OTel SDK + OTLP export | `observability/tracer.ts:25` `createTracer` (NodeTracerProvider, `BatchSpanProcessor`, env-gated `OTEL_EXPORTER_OTLP_ENDPOINT`) | Reused verbatim. Net-new is span *instrumentation at the turn/dispatch site*, not the SDK or exporter. |
| Per-call cost on a span | `observability/costEmitter.ts:48` `emitCost` → `sanitizeCostForOtel` (`openwop.cost.*`, SDK-shared allowlist) | The new per-turn span is the parent these cost attributes already attach to; the dashboard sums them. |
| Per-call token/usage signal | `providers/usageEmitter.ts` (RFC 0026 `provider.usage`: input/output tokens, `costEstimateUsd`, `cacheHit`, `traceId`, emitted before `node.completed`) | The dashboard time-series reads this run event; spans annotate from the same payload. No second token counter. |
| Trace continuity | `middleware/traceContext.ts:13` (W3C `traceparent` extract → active context) | Per-turn spans are children of the caller's trace automatically. |
| Run-read authorization | `host/runAccess.loadReadableRun` (ADR 0088) | Single-run trace drill-down routes through it (tenant gate, 404-not-403). |
| Admin metrics surface + index primitive | `features/assistant/health.ts` + `hostExtPersistence` `(entity,dimension)` index (ADR 0029) | The usage dashboard JOINS the admin health page and reuses the index primitive for time-series prefix reads. |
| Secret/PII redaction | `byok/textRedaction.ts` `sanitizeFreeText`, `middleware/sanitize.ts`, ADR 0067 + ADR 0077 | Spans carry ZERO prompt/response bytes; structured attrs only, allowlist-filtered. |
| Public-surface measurement | `features/analytics/*` (ADR 0018) | Left alone — a different lens (marketing/conversion vs LLM cost/latency). Not collapsed. |

**Net new (small):** (1) per-turn / per-dispatch **span instrumentation** wrapping the chat-turn + provider-dispatch path (parent span `openwop.chat.turn`, child `openwop.provider.dispatch`, tool-call child spans); (2) an optional **Langfuse sink** as an additional `SpanProcessor` behind `OPENWOP_LANGFUSE_*` env; (3) a feature-package `observability` providing the **admin usage dashboard** (messages by model/user, token + USD cost, latency, time-series) reading recorded `provider.usage` run events + cost rows via the ADR 0029 index; (4) its read-only admin routes under `/v1/host/openwop-app/observability/*`.

---

## Decision

Ship two layers that share one truth (the OTel span tree) and add no parallel store:

1. **Per-turn tracing (infra, env-gated, always-on-path).** Instrument the chat-turn and provider-dispatch path with OpenTelemetry spans under the existing `observability/tracer.ts` provider. A turn opens a parent span `openwop.chat.turn`; each provider call is a child `openwop.provider.dispatch` (already where `emitCost`/`provider.usage` attach); each tool call is a child span carrying tool name, latency, and outcome. Export is env-gated by the **existing** `OTEL_EXPORTER_OTLP_ENDPOINT` (console exporter otherwise — boot-safe per the tracer's try/catch). An **optional Langfuse sink** is one additional `SpanProcessor` enabled by `OPENWOP_LANGFUSE_PUBLIC_KEY`/`_SECRET_KEY`/`_HOST` — same span tree, second destination, no second instrumentation.

2. **Admin usage dashboard (product, toggled).** A `features/observability/` feature-package (toggle `observability`, default OFF, `bucketUnit: tenant`) rendering an admin-only usage view: messages/tokens/USD **by model and by user**, latency distribution, cache-hit rate, and a time-series — aggregated from the already-recorded `provider.usage` run events + cost rows, read through the ADR 0029 `(entity, dimension)` index (e.g. `(usage, tenant:model)`, `(usage, tenant:user)`). Drill-down to a single run's trace routes through `loadReadableRun` (ADR 0088).

### Data model — no new event store; one read-side rollup

Spans are ephemeral (exported to the collector / Langfuse, not persisted by the host). The dashboard reads **already-recorded** signals:

```
UsageRollup                          // read-side aggregate (rebuildable; not a source of truth)
  key (entity='usage', dimension)    // dimensions: `${tenantId}:model:${model}`, `${tenantId}:user:${subjectRef}`, `${tenantId}:day:${yyyymmdd}`
  { tenantId, dimensionValue,
    messageCount, inputTokens, outputTokens,
    usdCost, cacheHits, p50LatencyMs, p95LatencyMs,
    windowStart, windowEnd }
```

`UsageRollup` is maintained write-through on `provider.usage` emission (the same hook `emitCost` already fires from) using the ADR 0029 index primitive — point `listByPrefix` reads, no cross-tenant scan, rebuildable from run events. It is a **cache of recorded data**, never authoritative; the source of truth is the run-event log + the cost spans.

### Privacy — spans MUST redact secrets + prompt/PII (call-out, non-negotiable)

This is the load-bearing invariant of the ADR. Tracing an LLM path is the single easiest place to leak credentials and PII into a third-party collector.

- **No prompt/response bytes on any span.** Spans carry STRUCTURED attributes only — model, provider, token counts, USD, latency, tool name, outcome, `runId`, `nodeId`, `traceId`. Never message content, system prompts, retrieved KB chunks, or tool I/O bodies. (LibreChat's `packages/api/src/crypto` PII/credential message filtering is the precedent; we already own the equivalent in `byok/textRedaction.ts`.)
- **BYOK secret stripping (ADR 0067).** Provider credentials are resolved server-side and never persisted into events; they MUST likewise never reach a span attribute. Any attribute value passes the `costEmitter` allowlist (`OPENWOP_COST_ATTRIBUTE_NAMES`, `sanitizeCostForOtel`) — non-allowlisted keys, including credential-shaped values smuggled under unfamiliar names, are dropped. This sanitizer is the existing, conformance-asserted gate; the new spans reuse it, they do not bypass it.
- **PII masking (ADR 0077).** Any free-text attribute (e.g. a tool name a user could craft, an error message) is `sanitizeFreeText`-scrubbed before it lands on a span, identical to log masking. The Confidential/PII classification of ADR 0077 applies to span attributes exactly as it applies to logs.
- **Optional opt-in body capture is explicitly out of scope for v1** (OQ-1) — if ever added it is a separate, per-tenant, default-OFF, governance-gated decision, not a default of this ADR.

### RBAC & isolation
The usage dashboard is **admin-gated** (`requireSuperadmin` for cross-tenant host operations, mirroring `features/assistant/routes.ts:295` health; tenant-admin `roles.includes('admin')` for a tenant's own usage). Reads are org/tenant-scoped; a non-admin gets a uniform **404** (no existence leak, the ADR 0088 / notifications posture). The toggle gates the feature's routes — off ⇒ the dashboard 404s and the panel self-hides. IDOR-safe: a tenant admin can only read their own tenant's rollups (prefix-scoped to `tenantId`).

### Replay / fork
Pure read-only. The dashboard aggregates **recorded** `provider.usage` events + cost spans; it never re-runs a model. `UsageRollup` is a rebuildable cache (drop + replay run events to reconstruct), so it carries no replay obligation. Spans are emitted from the live dispatch path; replaying a recorded run does not re-emit them (replay reads events verbatim, ADR 0067). No wire shape, no fork impact.

---

## Evaluation matrix

| # | Criterion | Verdict |
|---|---|---|
| 1 | Feature-package architecture (`src/features/observability/`, default OFF) | Yes — dashboard is a packaged feature; tracing is shared infra in `observability/`. |
| 2 | Toggle + admin UI (`bucketUnit: tenant`) | Yes — `observability` toggle OFF/tenant; admin-only dashboard. Export is env-gated infra (not a toggle). |
| 3 | Workflow + node packs | Optional — a `feature.observability.nodes` "query usage" tool could back an ops agent (ADR 0058), but v1 ships read routes only. No new node pack required. |
| 4 | AI-chat envelopes + agent packs | N/A for v1 (an "ops analyst" agent reading the usage surface is a clean follow-on via the ADR 0014 `ctx.features` read surface). |
| 5 | RBAC (admin, fail-closed, IDOR, uniform-404) | Yes — superadmin/tenant-admin gate, tenant-prefix scoping, uniform 404. |
| 6 | Replay / fork safety | Yes — read-only aggregation over recorded events; rollup is a rebuildable cache. |
| 7 | Privacy / secret-stripping (ADR 0067 + 0077) | Yes — structured attrs only, allowlist-filtered, free-text scrubbed; no prompt/PII bytes on spans. The ADR's central invariant. |
| 8 | Reuse-not-recreate | Yes — reuses `tracer.ts`, `costEmitter`, `usageEmitter`, `traceContext`, ADR 0029 index, `loadReadableRun`. Net-new is instrumentation + a rollup + a dashboard. |
| 9 | RFC gate honesty | Yes — host-ext, no wire change; rides accepted RFC 0026/0084 + `observability.md`; no capability advertised. |
| 10 | Composes existing seams (not parallel) | Yes — `analytics` (ADR 0018) left intact as a different lens; ADR 0029 health page joined, not forked. |

---

## Phased plan

1. **Per-turn span instrumentation.** Wrap the chat-turn + provider-dispatch path in `openwop.chat.turn` → `openwop.provider.dispatch` → tool-call child spans, attaching the structured (allowlist-filtered) attributes. Reuse `tracer.ts`'s provider + `traceContext` propagation. Tests: span tree shape, no-prompt-bytes assertion (extend the conformance OTel-collector pattern), credential-attribute-dropped.
2. **Optional Langfuse sink.** Add a Langfuse `SpanProcessor` behind `OPENWOP_LANGFUSE_*`; same span tree, second exporter. Boot-safe (the tracer's existing try/catch). Test: sink absent when env unset; no extra instrumentation path.
3. **`UsageRollup` write-through.** Maintain the rollup on `provider.usage` emission via the ADR 0029 index primitive (`(usage, tenant:model|user|day)`). Test: rollup matches a replayed run-event sum; rebuildable.
4. **`features/observability/` package + admin dashboard.** Routes `/v1/host/openwop-app/observability/usage*` (admin-gated, tenant-scoped, uniform-404); an admin React panel: by-model / by-user / time-series + latency + cache-hit, with single-run trace drill-down via `loadReadableRun`. Toggle `observability` OFF/tenant. Tests: RBAC fail-closed, IDOR 404, toggle-off 404 + self-hide.
5. **Core-app extension surface.** Expose `ctx.features.observability` (ADR 0014) as a thin read surface so a future ops/cost agent (ADR 0058) can query usage in chat without a second data path; document the env knobs (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OPENWOP_LANGFUSE_*`) in `DEPLOY.md`.

## Alternatives weighed
1. **A bespoke metrics pipeline + its own store.** Rejected — `tracer.ts` + `costEmitter` + `usageEmitter` + the ADR 0029 index already exist; a parallel pipeline is the `no-parallel-architecture` violation and would drift from the cost allowlist.
2. **Persist full spans (with prompts) in the host DB for the dashboard.** Rejected — a PII/credential liability (ADR 0067/0077) and a storage cost. The dashboard reads recorded usage signals; deep traces live in the collector/Langfuse where access is operator-controlled.
3. **Fold the dashboard into `features/analytics` (ADR 0018).** Rejected — analytics is public-surface page/event/conversion measurement; LLM cost/latency/tool-tracing is an operational lens with different RBAC (admin, not consent-beacon) and different data (run events, not beacons). Same-name collapse would blur ownership.
4. **Make OTel export a feature toggle.** Rejected — export is infra (env-gated, the OTel-standard `OTEL_EXPORTER_OTLP_ENDPOINT`), already wired; gating it behind a per-tenant toggle would fracture the always-on instrumentation path. Only the *dashboard* is a toggled product surface.

## Open questions
1. **OQ-1 — Opt-in body capture.** Some teams want prompt/response on traces for debugging. Out of scope for v1 (privacy default). If added: per-tenant, default-OFF, governance-gated (ADR 0028), with the ADR 0077 classification enforced — a future ADR.
2. **OQ-2 — RUM / browser-side spans.** LibreChat ships a RUM proxy. The `traceContext` middleware already accepts browser `traceparent`; a front-end RUM emitter is a follow-on (the trace continuity seam is ready).
3. **OQ-3 — Rollup window granularity + retention.** Daily buckets for v1; finer windows (hourly) and a retention policy ride ADR 0077's retention sweep. Decide the default window.
4. **OQ-4 — Cost-rate freshness.** `usageEmitter`'s `RATE_TABLE` is a static snapshot; the dashboard inherits its staleness. Surface "advisory estimate" honestly; a live rate feed is a follow-on.
5. **OQ-5 — Multi-instance rollup writes.** Write-through under scale-out needs the index primitive's idempotency (same posture as ADR 0029); confirm no double-count on concurrent `provider.usage` from two instances.

## RFC verdict (Step 5)
**Host-extension — NO new RFC.** Span instrumentation, an OTLP export toggle, an optional Langfuse sink, and an admin usage dashboard are operational instrumentation over host-internal data, riding the **accepted** RFC 0026 (`provider.usage`) + RFC 0084 (cost/budget) + `observability.md` (the `openwop.*` namespace + host-vendor-namespace rule). Nothing is advertised on `/.well-known/openwop`; dashboard routes are non-normative `/v1/host/openwop-app/*`. A new RFC is warranted only if a normative cross-host tracing/usage capability is later required, or if the cost-attribute allowlist is mutated (this ADR does neither).

> **Phase 3b (2026-06-24) — dashboard component:** `features/usage-analytics/UsageDashboardPage.tsx` (+ routes + i18n×4 + a component test), registered in `FRONTEND_FEATURES` under the Workspace nav (`featureId: usage-analytics`). Read-only per-(provider,model) token table over `fetchUsageRollup`; loading/empty/error/disabled states; gated on the toggle (no fetch when off — caught by the test). Passed /architect (GO), /code-review (1 LOW fix), /ux-review (DESIGN.md clear).

> **Phase 5 (cost estimate) implemented** (2026-06-24):** `getUsageRollupWithCost` enriches each rollup row with an estimated `costUsd`, computed from the ONE cost source — `usageEmitter.computeCostUsd` (the per-1M-token RATE_TABLE already used for the provider.usage event), now exported and reused (NOT a duplicate rate table; the admin route returns the enriched rollup). An unpriced model → 0 (honest, no fabricated cost). /architect GO (corrected mid-review: reuse usageEmitter, not the catalog — single cost source), /code-review clean (backend). 1 test (priced=12.5, unpriced=0). The FE dashboard Cost column (a small follow-on) pending.

> **Phase 3c (cost column) implemented** (2026-06-24):** the usage dashboard now shows an **Est. cost** column (localized currency) from the Phase-5 per-row `costUsd`; an unpriced model reads $0.00. A column addition to the already-reviewed `UsageDashboardPage` (PR #798) — reuses the route's `costUsd`, `f.currency` formatting. /architect (inline — column on the reviewed page, no new surface), /code-review + /ux-review clean (i18n×4, tabular currency, budget held at 163.8 kB). ADR 0118 is now complete through the dashboard (1, 1b, 2, 2b, 3a, 3b, 3c, 5).

> **Phase 4 (Langfuse sink) implemented** (2026-06-24):** the optional Langfuse sink is a SECOND OTLP exporter on the SAME span tree — NO new dependency (the OTel SDK + `OTLPTraceExporter` were already installed; Langfuse ingests OTLP at `/api/public/otel/v1/traces`). `langfuseSinkConfig(env)` resolves `{url, headers}` from `OPENWOP_LANGFUSE_HOST/PUBLIC_KEY/SECRET_KEY` (Basic-auth from HOST-SIDE keys — never on the wire; NO secret in the URL); when set, the tracer adds a `BatchSpanProcessor`. Absent env ⇒ no sink. Boot-safe (inside the tracer's try/catch). The spans carry only the Phase-1 allowlisted attributes (no prompt bytes, no credential), so the sink inherits the no-secret enforcement. So the 'dependency-gated' framing was wrong — it was an OTLP-config phase. /architect (inline — reuses the existing tracer + allowlist; env-gated host config; no wire surface), /code-review clean. 3 tests (URL + Basic auth; no-secret-in-URL; null when any key missing) + boot smoke. ADR 0118 is now substantially complete (instrumentation + usage rollup + cost + dashboard + Langfuse sink).


## § Follow-on — Agent Flight Recorder (innovation strategy, 2026-06-24)

The innovation strategy proposes **business-readable decision records** ("why did it do
that?"): options considered, selected option, **rejected alternatives**, rationale,
evidence references, policy references, cost, and intervention points. This **extends
THIS ADR + ADR 0068 (unified review)**: the run event log + `agent.reasoned`/`toolCalled`
already capture the technical trace; the flight recorder is a **redaction-aware
explainer projection** over those events (a `DecisionRecord` read-model + a "Why this
happened" panel), NOT a new capture path. Must redact hidden prompts / sensitive policy
detail. Host-extension, no new RFC.

---

## Correction — surfacing audit (2026-06-24)

This ADR's prose names a `features/observability/` package gated admin / `requireSuperadmin`.
**As-built it shipped as `features/usage-analytics/`**, route `/usage`, gated
**`workspace:read`** (`tier: 'workspace'`) — not admin-only. The OTel span export + Langfuse
sink are env-gated infra (no UI), as designed. The `/usage` dashboard is reachable and
usable; recording the as-built name + RBAC tier per the "correct, don't rewrite" rule.

**Decision to make explicit:** if admin-only gating is actually intended (the prose claims
it), that is a deliberate RBAC tightening — raise the route scope to a workspace-admin /
superadmin check. Otherwise update the prose to match `workspace:read`. **Flag for decision;
not blocking usability.**
