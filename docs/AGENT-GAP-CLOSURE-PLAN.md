# Agent Gap-Closure Plan (audited)

Status: **active** · Last updated: 2026-06-07

This plan closes the gaps found by comparing `deep-research-report.md` (the SOTA
8-layer agent reference architecture) against the **openwop spec**
(`../openwop/`) and the **reference app** (this repo). Each item is tagged
**spec** (protocol change in `../openwop/`) or **app** (implementation-only in
this repo). Where an app change needs a spec change, the dependency edge is
named.

## Headline finding

openwop's *protocol* is comprehensive. The agent *implementation* has a hollow
core: live manifest dispatch (`backend/typescript/src/host/agentDispatch.ts`)
computed a tool allowlist and then **dropped it** before the model call, and the
RFC 0061 "stateful agent loop"
(`backend/typescript/src/host/agentLoop.ts`) is a counter simulation with no
model/tool call. Almost every gap is **app work against an already-complete
spec**.

## Audit outcome — 4 of 7 candidate spec gaps dissolved

| Candidate | Verdict | Evidence |
|---|---|---|
| S1 verifier/critic + convergence | **GENUINE — additive RFC** | No verifier primitive anywhere; report's planner-actor-critic is absent at spec+app |
| S2 multimodal perception input | **GENUINE — additive RFC or explicit out-of-scope** | `callAI`/`ai-envelope` are text+structured only; no vision/audio/doc input wire-shape |
| S3 memory write path | **DISSOLVED** | Specified + host-internal by design: RFC 0004 four-op `MemoryAdapter`, RFC 0080 §A `writable`; portable `GET /v1/memory` explicitly rejected (RFC 0080 §B / Alt 2) |
| S4 tool-arg validation MUST | **DOWNGRADED** | Already MUST + SECURITY invariant `mcp-server-untrusted-args` + test for the MCP path (`mcp-integration.md:180`, `RFCS/0020:76`). At most a tiny additive clarification to restate it for http/native transports in RFC 0064. NOT a safety-fix. |
| S5 agent capability negotiation | **GENUINE — additive RFC (reframed)** | No `requiresCapabilities[]` on `agent-manifest.schema.json` (`additionalProperties:false`); generalize the RFC 0072 §C `degraded[]` / RFC 0080 §C degraded-projection precedent |
| S6 managed credential tier | **DISSOLVED** | Already specified: `aiProviders.byok:[]` ⇒ platform-managed (`capabilities.schema.json:687`), `secrets.resolution:"host-managed"` (:400), RFC 0079 `issuer:"host"` |
| S7 promote RFC 0040 | **DISSOLVED** | RFC 0040 already `Accepted` (2026-05-24); cross-host causation shipped in conformance 1.5.0; app gates it behind `OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_3` |

**Net spec program = S1, S2, S5 (+ optional S4 clarification).**
> Side note: the live multi-agent-roadmap promotion target is **RFC 0041 (Phase 4,
> replay-determinism)**, still `Active` — not 0040. Out of original scope; flag
> if wanted.

## GROUP 1 — Spec changes (`../openwop/`)

Order per RFC: prose → schema → OpenAPI/AsyncAPI → conformance → SDK → hosts →
CHANGELOG/INTEROP-MATRIX.

- **S1 — Verifier/critic + convergence** (additive RFC; likely execution-model
  v6). New `agent.verified { agentId, target, verdict: pass|fail|revise,
  criteria?, confidence? }`; add `successCriteria?` to the orchestrator
  `terminate` decision (RFC 0006); `capabilities.multiAgent.verifier`; SECURITY
  invariant `verifier-no-content-leak`. **Unblocks A6, A10.**
- **S2 — Multimodal perception** (decision gate). Either (a) extend
  `callAI` `messages[].content` to a typed parts array (`text|image|audio|document`)
  + `capabilities.aiProviders.input.modalities[]`, or (b) document multimodal
  *input* as out-of-scope in `ROADMAP.md`. Recommend (a). Untrusted media inherits
  the `<UNTRUSTED>` trust boundary. **Unblocks A9.**
- **S5 — Agent capability negotiation** (additive RFC). Add
  `requiresCapabilities[]` to `agent-manifest.schema.json`; dispatch surfaces
  unmet requirements via the RFC 0072/0080 degraded projection on
  `GET /v1/agents`. **Unblocks A11.**
- **S4 — (optional) arg-validation clarification.** Extend the MCP arg-validation
  MUST to http/native transports in RFC 0064. Low priority.

## GROUP 2 — App changes (this repo)

### Wave 0 — no spec dependency (start now)
- **A1** — tool-exec loop in live dispatch (`host/agentDispatch.ts`): attach
  resolved tools, bounded observe→act loop via injected `callAIWithTools` +
  `executeTool`, emit RFC 0002/0064 events, validate args vs `inputSchema`.
  *Highest leverage.*
- **A2** — reuse/generalize `providers/dispatchAnthropicTools.ts`. (dep: A1)
- **A3** — multi-provider tool-calling (OpenAI/Google) + non-MCP arg validation;
  flip `aiProviders.toolCalling.providers`.
- **A4** — live agent memory read+write via host-internal four-op `MemoryAdapter`
  (RFC 0004). *Spec dep deleted by audit (S3).* 
- **A5** — real vector/embeddings behind `host.db.vector`/`host.sql`; flip
  honest `embeddings:false`.
- **A7** — durable infra: approval CAS, durable heartbeat/queue, A2A server.
- **A8** — real eval grader behind `evalSuiteEnabled` (RFC 0081 intent) +
  feedback→prompt-update path.
- **A12** — managed credential tier (provision + advertise `byok:[]`).
  *Spec dep deleted by audit (S6).*
- **A13** — real sandbox honoring RFC 0035 failure modes.

### Wave 1+ — spec-dependent
- **A6** real agent loop in executor (dep A1; S1) · **A10** verifier-in-loop
  (dep S1) · **A9** multimodal input (dep S2) · **A11** capability negotiation
  (dep S5).

## Dependency graph

```
S1 verifier ──► A6 (+A1), A10
S2 perception ─► A9
S5 agent-cap ──► A11
(S4 optional) ─► A3 arg-validation (app can proceed regardless)

Wave 0 (no spec dep): A1→A2, A3, A4, A5, A7, A8, A12, A13
```
