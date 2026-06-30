# ADR 0146 — Code-exec reference sandbox (in-process WASM default + external Code-API upgrade)

**Status:** **Implemented (Phases 4a/2/3/5) — 2026-06-26.** CXE-2 closes at **A** (sound in-process isolation); **A+ is gated on Phase 4b** (a hard memory cap, deferred — no drop-in native Wasmtime binding exists). _History:_ Phase 1 (Pyodide-in-worker) was implemented (#902) then **REVERTED (#904)** — an architecture review proved the Pyodide `js` FFI is a full host escape (⚠️ correction below); a feasibility spike (#908) then validated **CPython-WASI under Node's built-in `node:wasi`** as the sound replacement (no `js` FFI — the escape class is absent by construction; ~36 ms cold start; no native dependency on Cloud Run gen2), now built as **Phase 4a** (`host/wasiSandbox.ts` + the 19-test escape-suite gate). Resolves **ADR 0114 OQ-1**. The external sandboxed host remains the strong-isolation / polyglot upgrade; the Pyodide default is permanently withdrawn.
**Toggle:** rides the existing `code-exec` toggle (ADR 0114) · default **OFF** · `bucketUnit: tenant`. No new toggle.
**Surface:** host-extension only — a second **adapter behind the existing `ctx.runSandboxedCode` seam** (`host/sandboxAdapter.ts`). NOT a new feature-package, node, route, or store. No new wire contract by default (see RFC verdict).
**Decision:** **Option E** — ship an **in-process Pyodide (CPython→WASM) reference sandbox running in a worker thread** as the *default* `ctx.runSandboxedCode` adapter (Cloud-Run-native; enforces real memory / wall-clock / fs / network isolation in the deliverable), and **retain the external Code-API seam** (ADR 0114 Phase 2) as the documented strong-isolation / full-polyglot production upgrade. The host advertises only the **active adapter's** real language + isolation envelope.

> ### ⚠️ CORRECTION (2026-06-26) — the Pyodide variant of Option E is REFUTED; do not implement it
>
> Phase 1 was built (#902) and an architecture review then ran an adversarial escape suite against the real Pyodide-in-a-worker. **Pyodide's built-in `js` FFI module proxies the worker's entire Node global scope into the sandboxed Python — a complete host escape that defeats all three isolation claims above:**
> - `import js; js.process.env.<SECRET>` → **reads host environment secrets** (the `os.environ` isolation the tests checked is Emscripten's, separate and irrelevant)
> - `import js; js.require("fs").readFileSync("/etc/passwd")` → **host filesystem read** (on Linux/Cloud Run; only ENOENT'd on the macOS test box)
> - `import js; js.fetch("http://169.254.169.254/…")` → **network egress to the metadata server** (the socket-layer block is moot — `js.fetch` is real Node `fetch`)
> - `import js; js.globalThis.process` → full `process` (exit/spawn/binding)
>
> **Hardening by scrubbing globals does not save it:** deleting `Function`/`eval` breaks Pyodide itself; a surgical scrub of `process`/`require` keeps Python working but `js.fetch`, `js.WebAssembly`, and re-`import js` survive — and every Node release adds globals. This is security-by-enumeration over a growing, dynamic surface: **node:vm-class, not escape-proof** — the very property this ADR (§"`node:vm` is rejected") used to reject the alternatives.
>
> **Consequences:** the "in-process Pyodide enforces real isolation on Cloud Run" premise is false. Only the **wall-clock** guarantee (host `worker.terminate()`) actually held. CXE-2 is **not** closed by Pyodide. The sound in-process route is **Phase 4 — Wasmtime/WASI CPython with NO host FFI** (imports are explicit; there is no `js` bridge), or the **external sandboxed host** (Options A/C/D). Any future "closed" claim MUST be gated behind an adversarial escape-regression suite (`js.process`, `js.require`, `js.fetch`, re-import, `ctypes`, alternate FFI) that is part of CI — not a fs/`os.environ`-only test. Interim CXE-2 posture reverts to ADR 0114's external Code-API + the documented OPERATOR CONTRACT (collection stays at **A**, not A+).

---

## Why this exists

ADR 0114 shipped code-exec as a capability-honest seam that **delegates** all execution to an external Code-API (`OPENWOP_CODE_EXEC_ENDPOINT`). With no endpoint configured the node is honest-off (`capability_not_provided`), so:

1. The feature is **inert in the deployed demo** (`app.openwop.dev`) — there is no reference sandbox, so "Run code" never does anything out-of-box.
2. The host **enforces no resource limits itself** — CPU/memory/time/filesystem/network isolation are entirely the external sandbox's responsibility. The grade-code Phase-5 work added in-repo *abuse backstops* (a 120 s wall-clock, code/stdin/concurrency caps, a language allowlist, pinned-DNS SSRF egress, the HITL approval gate) and a documented **OPERATOR CONTRACT**, but those are not an isolation boundary.

CXE-2 asks the host to **ship a reference sandbox that enforces mem/CPU/time + filesystem/network isolation**, so the feature is functional and resource-bounded without an operator first standing up a separate execution host. This ADR picks that sandbox.

## Constraints that decide it

- **Deploy target = Cloud Run (gen2).** No `/dev/kvm`, no nested virtualization, no Docker-in-Docker. ⇒ **Firecracker microVMs, gVisor-in-a-nested-container, and Docker-per-exec cannot run in-process** on the demo; they require a separate host (a GKE node pool / a VM) running the Code-API.
- **The only thing that runs untrusted code *in-process* on Cloud Run with real enforced limits is a WASM runtime.** WebAssembly has **no ambient capabilities** — a module can do only what its imports grant — so with no filesystem preopens and no network import it is pure, bounded computation over its own linear memory. This is a real capability boundary, unlike `node:vm` (see `host/sandbox.ts`, which states `node:vm` "is not escape-proof … would still add a separate process / WASM / isolated-vm for hard memory").
- **The corpus already anticipates a WASM sandbox.** `conformance-fixtures/wasm-sandbox/` ships isolation fixtures (`isolation-global`, `misbehaving-{env,fs,memory,capability-gate}.wasm`) and RFC 0008 defines a thread/wasm-isolation model (`byok/ephemeralRunSecrets.ts:44` flags it "not implemented in this sample"). ADR 0114 itself foresaw this: it rejected in-process WASM/Pyodide *for the default* on resource-control grounds but noted "A Pyodide adapter MAY slot in behind `ctx.runSandboxedCode` later for offline/no-egress demos." This ADR implements that path, with the resource-control concern answered by WASM's hard memory cap + a host-owned worker-terminate (below).
- **Replay must not change.** Code-exec is an action node: ADR 0114 records each result as a `code.execution-result` artifact (`contentTrust: untrusted`) and replay/`:fork` **read the recorded artifact and never re-execute**. Any new adapter MUST run only on live execution and record verbatim.

## Options considered

| Option | In-proc on Cloud Run | Enforces mem/CPU/time itself | Isolation | Polyglot | Works out-of-box | Reversible |
|---|---|---|---|---|---|---|
| **A** — external Code-API only (status quo) | — (separate host) | ✗ (delegated) | strong (operator's) | ✓ | ✗ **inert** | ✓ |
| **B** — in-process WASM (Pyodide) in a worker | **✓** | **✓** | strong (WASM cap model) | ✗ (Python first) | **✓** | ✓ (drop adapter) |
| **C** — nsjail / bubblewrap (ns + seccomp) | ✗ (separate host) | ✓ | strong | ✓ | ✗ | ✓ |
| **D** — Firecracker microVM | ✗ (needs KVM host) | ✓ | strongest | ✓ | ✗ | ✓ |
| **E** — **B as default + A as configured upgrade** | **✓** | **✓** | strong → strongest | ✓ (via A) | **✓** | ✓ |

**Dominant force:** *runs in-process on Cloud Run*. It eliminates A/C/D as the **default** — each leaves the feature inert out-of-box. B is the only in-process option that enforces real limits, but B alone narrows the advertised capability to WASM-runnable languages. **E** ships B as the default (functional + enforced for the 80 % code-interpreter case — Python data/analysis) and keeps A as the operator's strong-isolation / native-polyglot upgrade. E reuses the **existing** `ctx.runSandboxedCode` seam (one adapter-resolution owner — no parallel executor), and advertises honestly per active adapter.

**Rejected:** A-only (leaves the feature inert — the CXE-2 complaint). B-only (over-narrows; loses the operator's polyglot/strong-isolation path). C/D as the default (can't run in-process on Cloud Run — they ARE the external Code-API in option A's clothing).

## Is WASM-in-a-worker a SOUND isolation boundary? (yes, with one honest caveat)

Unlike `node:vm` (shared JS heap → prototype-escape break), WebAssembly grants **no ambient capability** — only what the host imports provide:

| Dimension | Mechanism | Sound? |
|---|---|---|
| **Filesystem** | No WASI preopens + no host fs import ⇒ the module cannot open any path | ✓ (the `misbehaving-fs.wasm` fixture asserts this) |
| **Network / env** | No host network/env import ⇒ unreachable | ✓ (`misbehaving-{env}.wasm`) |
| **Memory** | Set `WebAssembly.Memory({ maximum })` ⇒ growth past the cap traps | ✓ hard-bounded (`misbehaving-memory.wasm`) |
| **Wall-clock** | Run in a **worker thread**; the **host** `worker.terminate()`s at `timeoutMs` | ✓ **escape-proof** — the host, not the sandboxed code, owns the worker lifecycle; an infinite loop cannot prevent termination |
| **CPU** | (Pyodide-on-V8) bounded *by* the wall-clock terminate; (Wasmtime path) deterministic **fuel / epoch** metering | ✓ for the threat (runaway loop is killed); see caveat |

**Honest caveat (record it):** Pyodide runs on V8's WASM, which has **no fuel/epoch metering**, so its CPU bound *is* the worker-terminate wall-clock — sound against a runaway loop, but not *deterministic* CPU accounting. If deterministic CPU fuel is required, the runtime must be **Wasmtime** (native, via a Node binding) with a WASM-compiled interpreter — that is a later phase, not Phase 1. Per-worker Pyodide footprint (~tens of MB) composes with the **already-shipped CXE-4 concurrency cap** to bound total memory.

## Replay & capability-advertisement (no traps, two rules)

- **Replay:** the WASM adapter slots in at the **same live-only seam point** as the external adapter; the recorded `stdout/stderr/exitCode/files` make replay/`:fork` deterministic regardless of what the code did. **Rule:** the adapter runs only on live execution and records verbatim (the seam already guarantees this). No new run-event non-determinism.
- **Advertise the active adapter's real envelope.** Pyodide ⇒ `languages: [python]`, `isolation: wasm-worker`; when `OPENWOP_CODE_EXEC_ENDPOINT` is set ⇒ the operator-declared polyglot/isolation tier. Do **not** statically advertise WASI languages the Pyodide default cannot run. The existing `allowedLanguages()` / `sandboxEndpoint()` resolution already does honest-off; the WASM adapter just makes the in-process default non-empty.

## RFC verdict

**Default host-extension — NO new RFC.** The WASM adapter is host work behind the **already-existing** `ctx.runSandboxedCode` seam (ADR 0114) — no new run/event/artifact shape, nothing touches the openwop wire. It SHOULD **conform to** RFC 0008's wasm-isolation model and pass the existing `conformance-fixtures/wasm-sandbox/misbehaving-*.wasm` cases. **EVALUATE:** IF the host introduces a **new advertised capability flag** (e.g. `host.codeExec.isolation = "wasm"` in `/.well-known/openwop`) so a remote A2A agent can discover the isolation tier, **that** flag earns a new openwop RFC ≥ Accepted first (the CLAUDE.md gate). **Lean:** ride the existing `code-exec` capability + `languages` advertisement; do not mint a new normative isolation flag unless RFC 0008 already defines one.

## Implementation plan (phased)

| Phase | Deliverable | Gate |
|---|---|---|
| ~~**1 — Pyodide-in-a-worker adapter**~~ **❌ REFUTED & REVERTED (#902→#904)** | _Was:_ a `host/wasmSandbox.ts` Pyodide-in-worker adapter. **The `js` FFI is a full host escape (see ⚠️ correction) — do not revive the Pyodide variant.** | — |
| **2 — Isolation conformance** | A test suite proving the invariants. **The reverted suite checked `os.environ`/`open()` only and passed while `js.process.env`/`js.require` leaked — it validated the wrong boundary.** Any future suite MUST be adversarial: `import js` → `process`/`require`/`fetch`, re-import, `ctypes`, alternate FFI, against the `conformance-fixtures/wasm-sandbox/misbehaving-*.wasm` model + a worker-terminate timeout test. | security review before any runtime ships |
| **3 — Honest advertisement** | `allowedLanguages()` reflects the active adapter (Pyodide ⇒ `[python]`); discovery/readiness reports the active runtime + isolation tier. | advertise-only-what-you-honor |
| **4a — `node:wasi` + CPython-WASI runtime (NEW primary path; spike-validated GO)** | Replace the refuted Pyodide path with **CPython compiled to `wasi-preview1`, run under Node's built-in `node:wasi`** in a worker thread. No `js` FFI exists; isolation is by construction (grant zero preopens / empty `env` / no sockets). Implement `host/wasiSandbox.ts` (`SandboxExecRequest → SandboxExecResult`: args/stdin in, captured stdout/stderr/exit out, host `worker.terminate()` wall-clock). Selection unchanged: external endpoint → opt-in WASI → honest-off. | the adversarial escape suite (Phase 2) green in CI **before** wiring; security review |
| **4b — native Wasmtime `StoreLimits` (hard memory cap → A+)** | `node:wasi` (V8) cannot hard-cap an export-memory module's growth, so 4a's memory bound is best-effort (worker `resourceLimits` + CXE-4 concurrency + wall-clock). A native Wasmtime binding adds a runtime-enforced memory ceiling (+ optional CPU fuel). Needs its own feasibility check (native addon builds on Cloud Run gen2's container — feasible, but a new native dep). | only for the hard memory trap / deterministic CPU; A+ mover |
| **5 — Docs + ADR 0114 correction note** | DEPLOY.md: the in-process WASI runtime (no separate host) vs the external Code-API upgrade; the inline correction note on ADR 0114 OQ-1 (✅ landed #906). | — |

### ✅ Phase-4 feasibility spike (2026-06-26) — GO

A throwaway spike (no merge) ran **CPython-3.12-WASI under `node:wasi`** (the VMware Wasm Labs `python-3.12.0.wasm`, generic wasi-preview1 build) on Node 22, with zero preopens / empty `env` / captured stdout-stderr. Measured:

| Property | Result | vs the refuted Pyodide path |
|---|---|---|
| **`import js` / host-FFI** | `ModuleNotFoundError: No module named 'js'` — **the bridge does not exist** | Pyodide exposed the full Node global scope |
| **fs** | `open("/etc/passwd")` → `FileNotFoundError` (no preopen) | bypassable via `js.require("fs")` |
| **env** | `os.environ` with `env:{}` → **empty (count 0)**; a host `ESCAPE_SECRET` was invisible | leaked via `js.process.env` |
| **network** | `socket.connect()` → `OSError` (wasi-p1 has no sockets) | bypassable via `js.fetch` |
| **subprocess / ctypes** | both `ModuleNotFoundError` / blocked | reachable via `js` |
| **cold start** | **~36 ms** median fresh-instantiate (78 ms first) | Pyodide ~1100 ms |
| **bundle** | **25 MB** `python.wasm`, server-side only (vendor like `schemas/`); no FE impact | Pyodide ~6 MB but unsound |
| **native dep** | **none** — pure `node:wasi` + a `.wasm`; runs on Cloud Run gen2 | n/a |
| **memory** | ⚠️ `bytearray(2_000_000_000)` **succeeded** — module exports its own memory, no external cap under V8 | same best-effort bound |

**Conclusion:** the escape *class* that sank Pyodide is **absent by construction** under `node:wasi` (no `js` module; only granted WASI syscalls/preopens). This is a sound boundary — unlike `node:vm` and Pyodide. The sole residual is **memory**: best-effort under `node:wasi` (worker `resourceLimits` + CXE-4 concurrency + wall-clock — an *availability* bound, not a confidentiality escape), with the hard trap deferred to **Phase 4b** (native Wasmtime `StoreLimits`). **Caveat:** `node:wasi` is flagged *experimental* in Node 22 — pin Node + gate on the escape suite.

### ✅ Implementation status (2026-06-26)

| Phase | Status | Evidence |
|---|---|---|
| 4a — `node:wasi` CPython runtime | ✅ implemented | `host/wasiSandbox.ts` (`runWasiSandboxedCode`); module compiled once in host + structured-clone-transferred to a fresh per-exec worker; `env:{}` + fresh `/tmp` scratch preopen + captured fds; host `worker.terminate()` wall-clock. Vendored via `scripts/sync-pythonwasm.sh` (SHA-256-pinned, gitignored). |
| 2 — Adversarial escape suite | ✅ implemented | `test/wasi-sandbox.test.ts` — 19 real-execution tests: `import js`/fs/env/socket/subprocess/ctypes all denied, `/tmp` scratch isolated per-exec, wall-clock terminate (exit 124), selection precedence + python-only advertisement. The suite fails LOUD if the asset is unsynced. |
| 3 — Honest advertisement | ✅ implemented | `allowedLanguages()` ⇒ `['python']` when WASI is the active executor (no external endpoint); `resolveSandboxExecutor()` honest-off when neither configured. |
| 4b — native Wasmtime hard memory cap | ⏸ **deferred (feasibility-gated)** | No maintained drop-in native binding exists (`wasmtime` npm = abandoned 2023 stub; `wasmedge` = stale 2021), and `node:wasi` can't cap an export-memory module externally. A hard cap = a custom Rust N-API Wasmtime addon cross-compiled for the Cloud Run image — a separate initiative with its own feasibility spike. Interim: 4a's operational memory bounds. **CXE-2 closes at A on 4a; A+ is gated on 4b.** |
| 5 — Docs | ✅ implemented | DEPLOY.md WASI note + this status table; ADR 0114 OQ-1 correction landed #906. |

**Selection (`resolveSandboxExecutor`):** external `OPENWOP_CODE_EXEC_ENDPOINT` wins → else WASI when **opted in AND the asset is present** (`OPENWOP_CODE_EXEC_RUNTIME=wasi`) → else honest-off. Opt-in + the `code-exec` toggle OFF-by-default + HITL ⇒ no deploy gains live execution without deliberately enabling it. Budget (CXE-6) + HITL wrap whichever executor resolves — WASI inherits them for free.

**Post-merge `/architect` hardening (2026-06-26).** An adversarial review probed the vectors the first suite assumed: WASI's capability model **denies `../` traversal + symlink escape out of the `/tmp` preopen** (`Capabilities insufficient` / `Operation not permitted`) and `/`-enumeration — confidentiality boundary confirmed sound. Three availability/hygiene gaps were then fixed: (1) **captured stdout/stderr is read-capped** (`OPENWOP_CODE_EXEC_MAX_OUTPUT_BYTES`, default 1 MB) so a huge print can't OOM the host on read-back; (2) **the stdout/stderr/stdin capture files moved OUTSIDE the preopen** (guest `/tmp` is now a clean empty subdir — the guest can't read its own stdin file or forge/truncate captured output); (3) the per-exec `node:wasi` `ExperimentalWarning` is suppressed (log-spam). Regression tests for traversal/symlink/enumeration + capture-invisibility + the output cap are in `test/wasi-sandbox.test.ts` (now 24 tests). Note: on Cloud Run `/tmp` is tmpfs (RAM), so guest scratch writes share the (best-effort) memory bound — the hard cap remains Phase 4b.

## Open questions / decisions

1. **OQ-1 — Default ON or stay OFF?** _Original lean (kept for the trail):_ keep OFF + the runtime opt-in (`OPENWOP_CODE_EXEC_RUNTIME=wasi`); let the demo opt in.
   - **→ REVERSED 2026-06-26 — ON BY DEFAULT.** The `code-exec` feature toggle was already retired/always-on (ADR 0134; `features/index.ts` `RETIRED_TOGGLE_IDS`), so the only remaining gate was the runtime opt-in. We now make the **in-process WASI runtime the default executor whenever its vendored asset is present** (no `OPENWOP_CODE_EXEC_RUNTIME=wasi` needed); an external endpoint still wins, and `OPENWOP_CODE_EXEC_RUNTIME=off` opts out. **Justified by the soundness result:** WASI isolation has no host-escape (confidentiality verified — `js`/fs/env/net/subprocess/ctypes + `../`-traversal/symlink all denied), so the worst a public, **HITL-approved** run can do is hit the *availability* bound (OOM/CPU on the instance — transient) or a tenant's daily budget. The asset guard keeps a host that never synced the wasm honest-off (no false advertisement). The hard memory cap remains the deferred Phase 4b — operators on a small instance should size it + keep `OPENWOP_CODE_EXEC_MAX_CONCURRENT` modest. **The per-exec HITL approval is retained as the load-bearing safety control** (it is not a "toggle").
2. **OQ-2 — Memory is best-effort under `node:wasi` (the load-bearing residual).** The CPython-WASI module *exports* its own memory with no maximum, and V8 can't cap it externally — a 2 GB alloc succeeds (spike), so a single exec can OOM the Cloud Run container. 4a MUST ship with operational mitigations as its gate: instance sized ≫ worst-case single-exec footprint, a low default concurrency cap (CXE-4), a short default wall-clock, and the HITL gate. **A *claim* of enforced memory requires Phase 4b** (native Wasmtime `StoreLimits` — a runtime-enforced ceiling). Until 4b, the collection is honest-**A** (sound isolation, ops-bounded memory), not A+.
3. **OQ-3 — Worker-blocking + writable scratch (validate in the first build PR).** `wasi.start()` is synchronous/blocking ⇒ it MUST run in a worker thread (the spike ran on the main thread — confirm worker behavior + that `worker.terminate()` kills a busy WASI run). Real code needs a writable `/tmp` (tempfile/matplotlib): grant a **fresh per-exec scratch preopen only** (an empty dir, never a host path), discarded on terminate — and read produced files back into the `code.execution-result` artifact `files[]`.
4. **OQ-4 — Packages.** CPython-WASI embeds the stdlib (no preopen needed — spike). No `micropip`/PyPI (no network by design). If third-party packages are ever needed, vendor pure-Python wheels onto the scratch path at build time; native-extension wheels won't load. Lean: stdlib-only for v1.
5. **OQ-5 — `node:wasi` is experimental (accepted risk).** It backs a security boundary and may change across Node majors (emits `ExperimentalWarning`). Pin the Node version, gate every release on the adversarial escape suite, and note Phase 4b (native Wasmtime) also reduces this exposure.
6. **OQ-6 — New advertised isolation flag?** Decide whether to advertise `isolation: wasi` (RFC-gated) or ride the existing `code-exec` capability silently. Lean: the latter (no new wire) until a cross-host consumer needs the tier.
7. **OQ-7 — Module map (naming).** Three sandbox-ish modules will coexist: `host/sandbox.ts` (`node:vm`, RFC 0035, wired only to `routes/testSeam.ts`), `host/sandboxAdapter.ts` (external code-exec), and the new `host/wasiSandbox.ts` (in-process code-exec). Keep them distinct in naming/comments; decide whether the `node:vm` test seam stays or retires.

## Consequences

- **Positive:** code-exec works out-of-box on Cloud Run with a SOUND in-process isolation boundary (no operator infra, no native dep, ~36 ms cold start); the feature stops being inert; the escape class that sank Pyodide is absent by construction; the external Code-API path remains for polyglot/strong-isolation at scale.
- **Negative / accepted:** the runtime is **Python-only** (CPython-WASI); non-Python needs the external endpoint or a second WASI guest. CPU is wall-clock-bounded, not fuel-metered. **Memory is best-effort under `node:wasi`** (the module exports its own memory; V8 can't cap it) — bounded operationally (instance sizing + CXE-4 concurrency + wall-clock + HITL) until **Phase 4b** (native Wasmtime `StoreLimits`) adds a runtime-enforced ceiling. A new server-side asset (`python.wasm`, ~25 MB, vendored like `schemas/`/`packs/`; **no FE bundle impact**). `node:wasi` is experimental — pinned + escape-suite-gated.
- **Reversible:** drop the WASI adapter and `resolveSandboxRunner()` falls back to external-or-honest-off (the ADR 0114 status quo). The seam is unchanged.
