# ADR 0114 — Sandboxed code-execution node + artifact projection

**Status:** in-progress — **Phase 1 implemented** (2026-06-24): the capability-honest seam (the `ctx.runSandboxedCode` adapter method + the `feature.code-exec.nodes.run` node + the `code-exec` feature-package, toggle OFF). NO execution path yet — with no sandbox adapter wired the node returns `capability_not_provided` (honest-off). **Phase 2 implemented** (2026-06-24): the external Code-API sandbox adapter (`host/sandboxAdapter.ts`) backs `ctx.runSandboxedCode` ONLY when `OPENWOP_CODE_EXEC_ENDPOINT` is configured (else honest-off `capability_not_provided`, Phase 1); SSRF-guarded (deny private/loopback unless allow-private, https-pinned), wall-clock timeout, §D endpoint non-disclosure on errors. Wired into the executor ctx (conditional). **Phase 3 (HITL gate) implemented** (2026-06-24): the `feature.code-exec.nodes.run` node now `ctx.suspend({reason:'approval', kind:'code-exec'})` BEFORE execution — a human must approve; a declined approval returns a refused outcome (exitCode -1, `declined:true`) and NEVER executes. On a host with no interrupt primitive the gate is skipped (operator opted into a sandbox; toggle off by default). This makes Phase 2's real execution production-safe. **Phase 4a (artifact type) implemented** (2026-06-24): registered the `code.execution-result` artifact type (ADR 0055) with a schema (exitCode/stdout/stderr/timedOut/language/files) — code-exec output becomes a TYPED artifact that flows through the existing run-artifact producer + renders in the workbench. **Phase 4b (producer wiring) implemented** (2026-06-24): the code-exec node's success output now carries `artifact:{artifactTypeId:'code.execution-result', payload, contentTrust:'untrusted'}` — the result flows through the existing run-artifact producer (ADR 0083) into the workbench, content-trust UNTRUSTED (model/code-derived). **Phase 6 (agent pack) implemented** (2026-06-24): the `feature.code-exec.agents` pack — a **Code Interpreter** persona (`feature.code-exec.agents.default`) that drives the code-exec node through the EXISTING AI chat (ADR 0058 agent+nodes pattern; no new chat surface), with the node in its `toolAllowlist` + an honest-off / HITL-aware / untrusted-output system prompt. Declared in the feature's `requiredPacks`; surfaces in GET /v1/agents. **Phase 7 (language allowlist) implemented** (2026-06-24): `sandboxAdapter.allowedLanguages()` (`OPENWOP_CODE_EXEC_LANGUAGES`, default python/javascript/typescript/bash/ruby/go) gates the dispatch — an unlisted language is rejected with `validation_error` BEFORE any egress (defense-in-depth so a node can't smuggle an arbitrary runtime past the sandbox's own policy). **Phase 5 (spend governance) implemented** (2026-06-24) — ADR 0114 now COMPLETE (Phases 1–7): `host/codeExecBudget.ts` — a per-tenant DAILY exec-count budget (`OPENWOP_CODE_EXEC_MAX_PER_DAY`, default 100; 0/unset = uncapped); `createSandboxRunner(tenantId)` is now tenant-bound, checking the budget BEFORE dispatch (over ⇒ `resource_exhausted`, no execution, no charge) + recording AFTER a successful run. Wired in the executor (`createSandboxRunner(run.tenantId)`). **Date:** 2026-06-23
**Toggle:** `code-exec` · default **OFF** · `bucketUnit: tenant` (a paid, high-blast-radius execution surface — a B2B tenant capability, never per-user).
**Surface:** host-extension only — a `code-exec` feature-package shipping a **node pack** `feature.code-exec.nodes` that calls a **pluggable external sandbox** (a Code-API adapter), projects results into the **artifact workbench** (ADR 0069/0083), and is driven through the **existing chat** via an agent pack (ADR 0058). No new core route/nav edits. **No new wire contract by default** (see RFC verdict).
**Depends on / composes (all implemented — this is assembly):**
- **ADR 0001 (feature-package)** — `src/features/code-exec/`, default-OFF, wired by appending to `BACKEND_FEATURES`.
- **ADR 0055 (host artifact-type registry)** — execution outputs bind a validated `artifactTypeId`; produced files/stdout become typed artifacts (`host/artifactTypes.ts`).
- **ADR 0069 / 0083 (artifact workbench + run-output producer)** — stdout/stderr/result/files are persisted as run artifacts via the **existing producer** (`host/runArtifactStore.ts`, deterministic `${runId}:${nodeId}` key) and rendered in the workbench/Library. **No new artifact store.**
- **ADR 0079 (streaming)** — execution progress streams via the canonical `ai.message.chunk` run event; no new streaming event.
- **ADR 0051 (A2UI) / ADR 0102 (per-tool permission gate)** — execution requires an **HITL approval** before it runs (`core.openwop.hitl.approval-request` + the per-tool gate at `host/agentToolPermissions.ts`).
- **RFC 0076 / `host/webhookEgressGuard.ts` + `brokeredEgress.ts`** — the sandbox-adapter HTTP call rides the SSRF-guarded broker (the only egress the node makes).
- **ADR 0024 (Connections)** — the external sandbox endpoint + its API key are a brokered Connection credential (`features/connections/providerRegistry.ts`), not a raw env secret in node code.

**RFC verdict:** **default host-extension — NO new RFC.** The node rides the **already-implemented** `core.openwop.ai`-style provider-delegation pattern (`delegateProvider` in `packs/core.openwop.ai/index.mjs:290`) + the ADR 0055 artifact registry + the existing run/tool surface; nothing touches the openwop wire. **EVALUATE:** IF a deployer wants to **advertise a normative cross-host "code-execution" capability** in `/.well-known/openwop` (so a remote A2A agent knows it may emit executable code), OR introduce a **new normative artifact type** for execution results, **that** earns a new **openwop RFC ≥ Accepted first** (the same gate ADR 0055 cleared for `artifact.created`). Host-ext routes under `/v1/host/openwop-app/*` never need an RFC.

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9/§11 (gap **B4**, HIGH) — every major chat ships a code interpreter; OpenWOP has none. Cleanest competitor model: **LibreChat** `api/server/services/Files/Code/` (an external Code API, multi-language, per-session identity — the adapter pattern this ADR adopts). Also **Open WebUI** `utils/code_interpreter.py` (Jupyter + Pyodide) and **LobeHub** `packages/python-interpreter/` (a Pyodide worker). We deliberately take LibreChat's **external-sandbox-via-adapter** shape (isolation + multi-language) over an in-process WASM runtime (a security and resource-control liability inside the Cloud Run backend).

---

## Context — boundaries audit first (MANDATORY)

The naive build is "an executor that shells out to Python, captures stdout, and renders it." Every supporting concern already has a single owner here; re-implementing any is the `no-parallel-architecture` violation. Critically, **a near-identical delegation pattern already ships** — `core.openwop.ai`'s `imageGenerate`/`videoGenerate` nodes are thin `delegateProvider('callX')` shims to an optional host capability (`packs/core.openwop.ai/index.mjs:290–311`). The code-exec node is the same shape: a thin node delegating to a host sandbox adapter.

| Concern | Existing owner (file:line) | How `code-exec` reuses it |
|---|---|---|
| Node-as-thin-provider-shim | `packs/core.openwop.ai/index.mjs:290` (`delegateProvider`) — node delegates to an optional `ctx.callX` host capability, throwing `HOST_CAPABILITY_MISSING` when absent | The `feature.code-exec.nodes.run` node is the same shim: delegates to a host `ctx.runSandboxedCode(...)` adapter; absent ⇒ `HOST_CAPABILITY_MISSING` (honest). |
| Persist run output (stdout/files) as durable artifacts | `host/runArtifactStore.ts` + the executor producer hook (ADR 0083) — deterministic `${runId}:${nodeId}` key, insert-only CAS, reference-resolution (base64→`media:`, text→capped inline) | Execution result/files are captured by the **existing** producer; binary files mint `media:` assets, text/JSON cap-inlined. **No new store.** |
| Typed artifact + validation | `host/artifactTypes.ts` (ADR 0055) — `validateArtifact`, served schemas | Result binds a validated `artifactTypeId` (e.g. `code.execution-result`); registered-only, capability-honest. |
| Workbench preview / Library | `chat/artifacts/ArtifactWorkbench` + `LibraryPage.tsx` (ADR 0069/0083) | stdout/stderr/result/files preview + open from chat/Library — **no new UI surface.** |
| Streaming execution progress | `ai.message.chunk` (`providers/dispatch.ts` onDelta, ADR 0079) | Live stdout streams via the canonical event; renderer already consumes it. |
| HITL approval before a side-effecting tool | `packs/core.openwop.hitl` (`approval-request` suspends via interrupt) + per-tool gate `host/agentToolPermissions.ts:88` + `host/agentDispatch.ts:845` (ADR 0102) | Execution is `safetyTier:'write'` + `approval:'always'`; the run **suspends** for human approval before the sandbox is invoked. |
| External-endpoint credential + SSRF-guarded egress | `host/brokeredEgress.ts:114` (`brokeredFetch`) + `host/webhookEgressGuard.ts` + Connections `providerRegistry.ts:41` (`apiHosts` pin) | The sandbox API call rides `brokeredFetch` (private-IP block, host pin, https-only, redirect re-validation); the sandbox key is a brokered Connection, not raw env. |
| Drive AI for the feature | The existing chat (`chat/EmbeddedChatPanel`, ADR 0073) + agent pack (ADR 0058) | A `feature.code-exec.agents` "Code Runner" persona scoped to `feature.code-exec.nodes.*`; deep-link `navigate('/?agent=<id>')`. **No new chat panel.** |
| Per-org spend ceiling | ADR 0106 `mediaBudget`/governance pattern (`aiProviders/mediaBudget.ts`) | A sandbox-minutes/calls ceiling SHOULD reuse the same governance-extension shape (OQ-3), not a forked budget. |

**Net new (small):** one host **sandbox adapter** seam (`ctx.runSandboxedCode` + a pluggable Code-API implementation), one node `feature.code-exec.nodes.run` (the `delegateProvider` shim) + its HITL-wrapped expose workflow, one validated `code.execution-result` artifact type, a `feature.code-exec.agents` persona, and the toggle. Everything downstream (persistence, preview, streaming, approval, egress, spend) is reuse.

---

## Decision

Ship a **`code-exec` feature-package** whose node pack runs model-generated code in an **isolated external sandbox** (Python first, multi-language behind the same adapter), gated by a **mandatory HITL approval**, and projects `stdout`/`stderr`/`result`/produced-files into the artifact workbench. Drive it through the **existing chat** via an agent pack — never a new chat panel.

### The sandbox adapter (the only genuinely new seam)

A host capability `ctx.runSandboxedCode({ language, source, files?, timeoutMs })` → `{ exitCode, stdout, stderr, result?, files: [{name, mediaRef|base64}] }`, with a **pluggable** implementation (the LibreChat Code-API adapter pattern):
- **default impl: an external Code API** reached via `brokeredFetch` (SSRF-guarded, host-pinned to the sandbox endpoint, credential brokered through Connections). The sandbox is the isolation boundary — the openwop-app backend never `exec`s code itself.
- The node `feature.code-exec.nodes.run` is a thin `delegateProvider('runSandboxedCode')` shim (mirrors `imageGenerate`); absent host impl ⇒ `HOST_CAPABILITY_MISSING` (capability-honest, exactly like today's `callImageGenerator`).

### Data model — no new store

No new persistence: an execution is a normal **executor run**; its outputs are persisted by the **existing** `host/runArtifactStore.ts` producer under the deterministic `${runId}:${nodeId}` key. The only new typed shape is a registered artifact type:

```
code.execution-result        // a registered host artifact type (ADR 0055)
  { language, exitCode, stdoutRef, stderrRef, durationMs,
    files: ArtifactRef[] }    // produced files → media: assets (reference-resolution, ADR 0083)
```

### Execution flow (HITL-gated)

`feature.code-exec.run` (the expose workflow): `propose-code → core.openwop.hitl.approval-request (suspends) → [resume:accept] → feature.code-exec.nodes.run → persist artifacts`.
1. The agent emits the code as the gate's previewable upstream output (ADR 0083 §P1 — the approval card shows exactly what will run).
2. The run **suspends** for human approval (no approval ⇒ no execution; `untrusted_content_blocks_approval` still blocks an untrusted-authored payload).
3. On accept, the node calls `ctx.runSandboxedCode(...)`; stdout streams via `ai.message.chunk`.
4. Outputs persist as artifacts (text capped-inline, files → `media:` assets), bound to `code.execution-result`, openable in the workbench/Library.

### RBAC & isolation (ADR 0006)

Org-scoped, fail-closed. Driving the node requires `workspace:write` in the run's org (`host/accessControlService.ts:125` EDITOR_SCOPES) **and** the per-tool gate must permit `feature.code-exec.nodes.run` for the tenant (ADR 0102). Artifact reads authorize per-record via `resolveEffectiveAccess` (`accessControlService.ts:975`); non-visible → uniform **404**, never 403 (IDOR-safe). The sandbox credential resolves from the run's tenant Connection — never from request input.

### Replay / fork safety

Execution output is **recorded as run artifacts**; on `:fork`/replay the recorded output is read **verbatim** and the code is **NOT re-executed** (determinism — re-running model-generated code is non-deterministic and a double side-effect/double-spend). This mirrors ADR 0083: the producer hook is gated `forkMode !== 'replay'`, the deterministic `${runId}:${nodeId}` key dedups retries, and `:fork` in `branch` mode legitimately mints new artifacts under the new runId. The execution result is non-deterministic state and therefore lives in the recorded artifact/event log (ADR 0055 replay rule), read verbatim.

### Security (the load-bearing concern — recommend `/architect` + `/nfr`)

This is the highest-blast-radius feature in the catalog. The invariants, to be hardened under a dedicated review:
- **Isolation in the sandbox, not the backend.** The openwop-app backend never executes untrusted code; the external sandbox is the trust boundary (per-session identity à la LibreChat).
- **No local FS / no network egress by default** from sandboxed code; resource caps (CPU/mem/wall-clock `timeoutMs`/output-size) enforced sandbox-side.
- **SSRF** on the adapter call: only `brokeredFetch` to the pinned sandbox host (`apiHosts`), private-IP block, https-only, redirect re-validation.
- **Secret hygiene:** code, stdout, and stderr are `stripSecretsFromPersisted`'d before storage (ADR 0083); the sandbox credential is brokered, never injected into the executed program.
- **Mandatory HITL** before any execution; untrusted-authored code cannot advance the approval (`untrusted_content_blocks_approval`).
- **Spend:** a per-org sandbox-call/minutes ceiling rides the ADR 0106 governance-extension shape.

**Recommendation:** run `/architect` (boundaries + replay/fork + the sandbox trust boundary) **and** `/nfr` (SSRF, resource caps, capability gating, secret redaction) before any implementation lands.

---

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (ADR 0001) | **Yes** — `src/features/code-exec/`, default-OFF, appended to `BACKEND_FEATURES`; zero core edits. |
| 2 | Toggle + admin UI | `code-exec` toggle, OFF, `bucketUnit: tenant`, category "Business Tools" (the podcasts/notebooks precedent). Admin enable in the existing feature-toggle panel. |
| 3 | Workflow surface (`ctx.<feature>`, ADR 0014) | Minimal/none — the node delegates to the host **sandbox adapter** (`ctx.runSandboxedCode`); a thin `ctx.features['code-exec']` read surface only if a config (allowed languages) needs reading. |
| 4 | Node pack | **`feature.code-exec.nodes`** — `run` (the `delegateProvider('runSandboxedCode')` shim), signed Ed25519 + SRI, declared in `requiredPacks`; `safetyTier:'write'`, `approval:'always'`. |
| 5 | AI-chat envelopes | None new — stdout streams via the canonical `ai.message.chunk` (ADR 0079); results render via the **existing** artifact preview/workbench cards (ADR 0069). |
| 6 | Agent pack | **`feature.code-exec.agents`** — a "Code Runner" persona, `toolAllowlist:["openwop:feature.code-exec.nodes.*"]`, driven through the existing chat (ADR 0058). |
| 7 | Public surface | None — execution is authenticated, org-scoped, HITL-gated; no anonymous route. |
| 8 | RBAC + isolation (ADR 0006) | `workspace:write` to run + per-tool gate (ADR 0102) to dispatch; artifact reads `resolveEffectiveAccess`, uniform-404 IDOR; sandbox credential from the run's tenant Connection. Fail-closed. |
| 9 | Replay / fork | Output recorded as artifacts; on replay/`:fork` read verbatim, **code never re-executed**. Deterministic `${runId}:${nodeId}` key; producer gated `forkMode !== 'replay'` (ADR 0083). |
| 10 | Frontend | No new chat panel/page — reuse `ArtifactWorkbench`/`ArtifactPreviewModal`/`LibraryPage` + the approval card "Open preview" (ADR 0083 §P1). Optional: a small "Run code" agent entry in the chat agent picker. |

---

## Phased plan

1. **Sandbox adapter seam + node (capability-honest, off).** Define `ctx.runSandboxedCode` on the executor adapter (`executor/types.ts`) and ship `feature.code-exec.nodes.run` as a `delegateProvider` shim. With no host impl wired, the node throws `HOST_CAPABILITY_MISSING` — advertised `supported:false` (mirrors today's `imageGeneration:{supported:false}` honesty at `routes/discovery.ts:471`). Tests: node shim + missing-capability error.
2. **External Code-API adapter implementation.** Wire the default sandbox impl over `brokeredFetch` (SSRF-guarded, host-pinned, Connection-brokered credential). Resource caps + timeout. Tests: adapter dispatch, SSRF rejection, timeout/oversize handling.
3. **HITL expose workflow + artifact projection.** The `propose → approval-request → run → persist` workflow; bind `code.execution-result` artifact type (ADR 0055); outputs flow through the existing producer (ADR 0083). Tests: suspend-before-execute, untrusted-blocks-approval, artifact persistence, replay-reads-verbatim.
4. **Agent pack + chat drive.** `feature.code-exec.agents` "Code Runner"; allowlist to the node; deep-link the existing chat. Streaming stdout via `ai.message.chunk`. Tests: agent allowlist, stream ordering.
5. **Spend governance.** A per-org sandbox-call/minutes ceiling on the ADR 0106 governance-extension shape (fail-closed when enabled).
6. **Multi-language + security hardening.** Add languages behind the same adapter; run `/architect` + `/nfr`; conformance for the capability gate if/when a normative capability is later advertised.
7. **Core-app extension surface.** All wiring is additive: the node pack + agent pack install at boot, the feature appends to `BACKEND_FEATURES`, and the sandbox adapter slots into the executor adapter map — no core route/nav/chat edits.

## Alternatives weighed

1. **In-process WASM/Pyodide runtime inside the backend** (Open WebUI/LobeHub model). Rejected for the default — running untrusted code inside the Cloud Run backend process is a resource-control and isolation liability; the LibreChat external-sandbox model is the cleaner trust boundary. _(Vindicated 2026-06-26: a trial Pyodide adapter was reverted in #904 — its `js` FFI is a full host escape that leaks fs/env **even with no network egress**, so it is NOT a safe "offline-demo" option. A sound in-process runtime must have no host FFI — Wasmtime/WASI — per ADR 0146 Phase 4.)_
2. **A bespoke "code chat" panel + its own output renderer.** Rejected — the explicit "one AI chat, never recreate" + "no parallel store" laws; reuse the chat, the artifact workbench, and the producer.
3. **Re-execute on replay/fork.** Rejected — non-deterministic and a double side-effect/double-spend; record-and-read-verbatim is the ADR 0083 invariant.
4. **Raw env secret + direct `fetch` to the sandbox.** Rejected — bypasses the SSRF broker and the Connections credential model; every external call rides `brokeredFetch`.

## Open questions

1. **OQ-1 — Which sandbox backend ships as the reference adapter?** A self-hostable open Code API vs a managed one; the adapter seam keeps it pluggable, but the demo deploy needs one default. **→ STILL OPEN (decision attempted and REFUTED).** [ADR 0146](./0146-code-exec-reference-sandbox.md) scoped an in-process Pyodide (Python→WASM) worker as the Cloud-Run-native default; it was implemented (#902) and then **REVERTED (#904)** after an architecture review proved Pyodide's `js` FFI is a full host escape (`import js` → `js.process.env`/`js.require("fs")`/`js.fetch`), so it does **not** enforce fs/network isolation — see the ⚠️ correction in ADR 0146. **CXE-2 therefore remains OPEN.** The *interim* posture is this ADR's external Code-API seam + the Phase-5 OPERATOR CONTRACT note above; the real resolution is a runtime with no host FFI — **Wasmtime/WASI** (ADR 0146 Phase 4) or the **external sandboxed host** — gated behind an adversarial escape-regression suite in CI.
2. **OQ-2 — File-input ergonomics.** Can the user/agent attach input files (a CSV) to an execution? Propose: reference existing `media:`/`document:` artifacts as sandbox inputs (reuse the artifact model), not a new upload path.
3. **OQ-3 — Spend unit of account.** Sandbox **wall-clock minutes** vs **call count** for the ADR 0106-style ceiling; lean minutes (closest to provider cost).
4. **OQ-4 — Per-session vs per-run sandbox identity.** LibreChat keeps a per-session sandbox (stateful across cells). Propose per-run ephemeral by default (replay-clean); a persistent-session mode is a follow-on with its own determinism caveats.
5. **OQ-5 — Normative capability advertisement.** Do we ever advertise `codeExecution:{supported}` cross-host (needs an openwop RFC), or keep it host-local forever? Default: host-local until a concrete cross-host A2A need appears.

## RFC verdict (Step 5)

**Default host-extension — NO new RFC.** The node rides the implemented `core.openwop.ai` delegation pattern + the ADR 0055 artifact registry + the existing run/tool/HITL surface; the adapter call is host-internal egress; routes are non-normative `/v1/host/openwop-app/*`. **EVALUATE:** a **new normative artifact type** for execution results advertised cross-host, or an advertised **`codeExecution` capability** so remote A2A agents may emit executable code, would each be a wire claim → a **new openwop RFC ≥ Accepted first** (the ADR 0055 precedent). Until then, advertise only what is wired (`supported:false` when no sandbox adapter is configured), exactly like `imageGeneration` today.

---

## Follow-up action — surfacing audit (2026-06-24)

**2026-06-26 hardening (grade-code Phase 5):** the SSRF guard was upgraded from a
registration-time host-string check to a **connect-time pinned dispatcher**
(`webhookEgressDispatcher()` + `redirect:'error'`) closing the DNS-rebind TOCTOU (`CXE-1`);
the daily exec-count budget record is now an atomic `compareAndSwap` (`CXE-3`); added a
per-process concurrency cap (`OPENWOP_CODE_EXEC_MAX_CONCURRENT`, default 8, fail-fast
`resource_exhausted`) (`CXE-4`), an stdin size cap (`CXE-5`), and structured
`code_exec_dispatched`/`code_exec_budget_exceeded` audit (`CXE-6`). **`CXE-2`
(no in-process CPU/mem enforcement) is a stated reference-host posture, not a defect:** the
sandbox is EXTERNAL by design (this ADR's adopted shape), so the host cannot enforce mem/CPU
of code it does not run — configuring `OPENWOP_CODE_EXEC_ENDPOINT` is the operator's assertion
that the endpoint enforces mem/CPU/time + filesystem/network isolation (OQ-1; the in-repo caps
+ HITL gate + the pin are abuse backstops, not a substitute). See `host/sandboxAdapter.ts`
§"OPERATOR CONTRACT".

**Audit verdict:** 🟠 backend + node pack + "Code Interpreter" agent persona are complete,
but the feature is **inert in the deployed demo** — the node returns `HOST_CAPABILITY_MISSING`
until an operator sets `OPENWOP_CODE_EXEC_ENDPOINT` (+ runs an external Code-API), and there
is no first-class "Run code" control: the only path is driving the agent in chat (agent-only,
per ADR 0058 — by design, not a defect).

**Seam-correct action (NOT a new UI — config + discoverability):**
1. **Operator config** — document `OPENWOP_CODE_EXEC_ENDPOINT` + the language allowlist /
   per-org budget envs in `DEPLOY.md`, and wire a sandbox endpoint on the demo so the
   capability lights up (advert flips `supported:true`). Until configured, the honest-off
   behavior is correct.
2. **Agent discoverability** — ensure the `feature.code-exec.agents` "Code Interpreter"
   persona is visible/deep-linkable in the agent picker so a user can find it.

**Boundary check:** agent-drive is the intended UX (ADR 0058) — do NOT add a bespoke
code-runner page. No new architecture; this is a deploy-config + discoverability follow-up.
