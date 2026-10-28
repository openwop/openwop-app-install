# ADR 0995 — Code execution: the node gate that never ran, and the sandbox bounds that were stated but not enforced

Status: implemented (#5346, merged `9ed40639d`, live on rev `01069-9m5`, 2026-10-28)
Date: 2026-10-28
Feature loop round 2, row 62 (Code execution, `code-exec`). Builds on ADR 0114 (the node and
the `ctx.runSandboxedCode` seam), ADR 0146 (the in-process CPython-WASI runtime), ADR 0686
(fork re-execution), ADR 0820 §8.2 (the toggle) and ADR 0150/0834 (the chat safe-mode gate).

## Baseline (measured on `origin/main` `5bc6ba89b`, before any change)

Round-1 grades were WF B / UX B / CODE B. Every one of them is a claim, and this pass
re-measured them. Red probes: `backend/typescript/test/fl2-62-code-exec-probes.test.ts`.

| Lens | Round 1 | Round 2 baseline | Why |
|---|---|---|---|
| WF | B | **C** | The workflow node's approval gate cannot be passed: the canonical approve reads as a decline (D1). |
| UX | B | **D** | The approval card is handed an object where both cards render a string, and it never shows the code (D2). |
| CODE | B | **C** | The WASI runtime's memory and disk are unbounded, a timeout leaks the scratch dir, the external adapters' output is uncapped, a far-end timeout is never charged, and a tenantless runner skips the toggle and budget (D3–D7). |

**Production exposure, measured read-only:** the serving backend has no
`OPENWOP_CODE_EXEC_*` / `OPENWOP_E2B_*` env, and the source zip of the latest build
(`gcloud builds list` → `services/openwop-app-backend/1793158135…zip`) holds only
`backend/typescript/vendor/.gitkeep`, no `python-3.12.0.wasm`. So prod resolves no sandbox
executor and code execution is honest-off there. None of the sandbox findings below is
exploitable on `app.openwop.dev` today. They are live for any operator who ships the asset
or configures an endpoint, and for prod the first time a deploy runs from a checkout where
`npm run ci` synced the asset (D8).

## D1 (Blocker) — approving a code-exec gate never executes the code

`packs/feature.code-exec.nodes/index.mjs:62` treats the run as approved only when the resume
value is `{decision:'approved'}` or `{approved:true}`. No resolver produces either. Both
approval cards resolve with the interrupt.md canonical `{action:'approve', comment?}`
(`routes/interrupts.ts:584` validates exactly that key). So every approval through the real
UI returns `{declined:true, stderr:'execution declined by approver'}`. The unit test that
"proves" the gate (`test/code-exec-node.test.ts:45`) fakes `{decision:'approved'}`, a shape
nothing in the app emits.

The node also passes no `actions`, so `validateResumeValue` returns early and any resume
value is accepted. And with no `ctx.suspend` it runs ungated.

**Decision.**
- The node reads the canonical shape: approved iff `action` is `approve` or `accept`
  (the same equivalence `resumeActionSpelling` admits). The legacy `{decision}` /
  `{approved:true}` shapes are dropped. They were never produced, so no in-flight run
  depends on them.
- The suspend declares `actions: ['approve', 'reject']`, so the cards offer only those two and
  `POST /runs/:id/interrupts/:node` validates the resume value. (Correction, code review M3: the
  token route `POST /interrupts/:token` does not call `validateResumeValue`. Nothing runs
  unapproved through it, because the node itself accepts only `approve`/`accept`, but the
  validation is per-route, not universal.)
- The approval is bound to the code it approved (code review H2b): the suspend's `resumeKey` is
  `code-exec:` + a hash of language, stdin and code. On resume the node re-reads its inputs, and
  an unpinned run resolves its definition at head, so the code could change after the gate was
  raised. A changed program misses the seeded resolution and asks again.
- No `ctx.suspend` ⇒ throw `capability_not_provided` (fail closed). This executor always
  binds `suspend`, so nothing here changes in this host. A host without the interrupt
  primitive no longer runs code unapproved.

## D2 (Blocker) — the approver is shown an object, and never the code

The node suspends with `prompt: {title, body}`. Both approval cards render `data.prompt` as
a React text child (`chat/registry/defaultCards.tsx:166`, `interrupts/ApprovalCard.tsx:109`).
An object there is a render error, so the gate card throws. Even if it rendered, the body
says "Approve running this python snippet (12 chars)". The approver approves code they
cannot see, which is the approve-what-you-see rule ADR 0600 §2 exists to enforce.

**Decision.**
- `data.prompt` is a string.
- The suspend carries a `codeExec` evidence block: `{language, code, stdinPreview?}`.
  `code` is the exact source the runner will receive; stdin is shown truncated to 2 000
  characters with its full length.
- `GateEvidence` (the ONE shared evidence component, ADR 0600 §2) renders that block, the
  same way it renders the ADR 0894 `browserAction` block: a localized heading, the language,
  and the code in a `<pre>`. `hasGateEvidence` counts it, so both cards show it inline.
- The evidence is node-authored data, so the card renders it as text only (no markdown, no
  links).
- Stated residual (code review H2a): interrupt data is persisted through
  `stripSecretsFromPersisted`, so a credential-shaped string inside the code reaches the card as
  `<<redacted:credential-shape>>` while the runner receives the original. The approver sees that
  a secret is there, not its value. Persisting it unredacted would be the larger defect.

## D3 (High) — WASI guest memory has no ceiling

`python-3.12.0.wasm` declares its memory as `min 160 pages, no max` (memory section, flags
`0`). `maxOldGenerationSizeMb` bounds the worker's JS heap, not wasm linear memory, so a guest
can grow to the wasm32 limit of 4 GiB. The production instance has 1 GiB.

**Decision.** Rewrite the module's memory limits before compiling it: flags `1`, the original
minimum, and a maximum of `OPENWOP_CODE_EXEC_WASI_MEM_MB × 16` pages (default **256 MB**),
and cap concurrent WASI executions at `OPENWOP_CODE_EXEC_WASI_MAX_CONCURRENT` (default 2, AR-1).
`memory.grow` past the maximum returns −1, so CPython raises `MemoryError` inside the guest.
The rewrite is a pure function of the bytes and the cap. It refuses when the binary has no
memory section or imports its memory. A module's own smaller maximum is kept, and the cap is
clamped to the wasm32 limit of 65 536 pages (code review M1/LOW). A refused or uncompilable
binary surfaces as the pre-dispatch `capability_not_provided`, so the reservation is released,
and the failure is cached.

## D4 (High) — WASI scratch and captured output can fill the host's tmpfs, and a timeout leaks them

The guest's `/tmp` and the captured stdout/stderr files live under `os.tmpdir()`. On Cloud
Run gen2 that is RAM. Nothing bounds what is written there; only the read-back is capped.
And the scratch dir is created and removed inside the worker. On a wall-clock kill the
worker is terminated before its cleanup runs, so every timed-out execution leaves its
directory, and whatever the guest wrote, behind until the instance recycles.

**Decision.** The host creates the scratch dir, passes its path to the worker, and removes
it in the one `cleanup` that every exit path calls. While the worker runs, a host watchdog
measures the dir every 100 ms. Past `OPENWOP_CODE_EXEC_MAX_SCRATCH_MB` (default **64 MB**)
or 2 000 entries, it terminates the worker and returns `exitCode 1`,
`stderr: 'sandbox_disk_limit'`.

Code review additions:
- **H1 — an open, unlinked file is invisible to a directory walk** and still holds tmpfs RAM.
  On Linux the watchdog also adds the size of every descriptor in `/proc/self/fd` whose link
  names a file under the scratch dir with ` (deleted)` (`unlinkedOpenBytes`). After a kill,
  `cleanup` closes every descriptor still pointing under the dir (`closeFdsUnder`) before
  removing it, because a killed worker does not close what it opened and an unlinked file lives
  as long as a descriptor does. Where `/proc` is absent (macOS dev) both are no-ops and the wall
  clock is the bound.
- **M2** — the concurrency slot is released only after the worker and its scratch are gone.
- **M4** — the walk stats a directory's entries together and stops at 2 000 entries.

Residual, stated: the watchdog samples. A guest can write past the cap for as long as one
tick takes (100 ms plus the walk) before it is killed. This is a bound on overshoot in time, not
a hard quota.

## D5 (High) — the external adapters' output is unbounded

The Code-API adapter (`sandboxAdapter.ts`) and the E2B adapter read the whole response body
with `res.json()` and pass `stdout`, `stderr` and `files` through uncapped. The Code-API path
does not even check their types (`body.stdout ?? ''`). That output is recorded in the event
log, persisted as an artifact and returned to the model.

**Decision.** One `normalizeSandboxResult` in `sandboxAdapter.ts`, used by both adapters.
It coerces each field's type, caps `stdout`/`stderr` at `OPENWOP_CODE_EXEC_MAX_OUTPUT_BYTES`
(the knob WASI already uses, default 1 MB) with the same truncation marker, keeps at most 16
files and 8 MB of base64 in total, and drops the rest with a note in `stderr`. The response
body is read through a byte-capped reader (4 × the output cap plus the file cap). A larger
body is a `sandbox_transport_error`.

## D6 (High) — the daily budget is charged only on success, and checked before it is taken

`createSandboxRunner` checks the budget, runs, then records. An execution that throws (a
far-end timeout, a transport error) is never counted, so code that always runs out the
120-second clock runs without limit. And because the check and the record are separate, N
concurrent calls at `max − 1` all pass the check.

**Decision.** Reserve before dispatch: an atomic CAS increment that succeeds only while the
count is below the max (`reserveCodeExec`). Every dispatched execution is charged, whatever
its outcome. A refusal raised before anything reached a sandbox (`validation_error`,
`content_too_long`, the concurrency cap's `resource_exhausted`, `capability_not_provided`)
releases its reservation. Platform-seconds metering moves to a `finally` so failed runs are
metered too; a metering failure is logged and never masks the run's own result or error.

## D7 (Improvement, closes `CEWF-2` / `CEC-3`) — a tenantless runner skips the toggle and the budget

`createSandboxRunner(tenantId?)` returns the bare executor when no tenant is given, with no
toggle check and no budget. Both production callers pass a tenant today, so this is a
convention, not an enforced invariant.

**Decision.** `createSandboxRunner(tenantId: string)`. The tenantless branch is deleted. The
tests that pin which executor is selected call an exported `selectSandboxExecutor()` instead.

## D8 (Improvement) — whether production runs code in-process depends on the deploy checkout

ADR 0146 made the WASI runtime on-by-default whenever the asset is present. `.gcloudignore`
ships the asset when it exists. `scripts/ci.sh` and the Tracegate daemon sync it, but
`deploy.sh` does not. So a deploy from a checkout that ran the gate turns in-process code
execution on in production, and a deploy from a clean worktree turns it off. Nobody chooses.
The Dockerfile comment (`Dockerfile:208`) already describes the asset as "needed ONLY when an
operator sets `OPENWOP_CODE_EXEC_RUNTIME=wasi`", which the code does not honour.

**Decision.** Under `NODE_ENV=production` the WASI rung requires `OPENWOP_CODE_EXEC_RUNTIME=wasi`.
Outside production the asset-present default stays, so local dev and the escape suite are
unchanged. This makes the Dockerfile comment true.

## D9 (Improvement) — a re-run of the same code in chat shows the first run's artifact

The chat tool keys the artifact on `(conversation, hash(language, stdin, code))` and the
write is insert-only. Code whose output varies (random numbers, the clock) gets the fresh
stdout in the tool result and the stale first result in the workbench. **Decision:** the key
also hashes the result, so an identical retry still dedupes and a different result is a new
artifact.

## D10 (Improvement, UX) — the result artifact renders as raw JSON

There is no renderer for `code.execution-result`, so the workbench shows a JSON blob with
escaped newlines. **Decision:** register a read-only renderer: an exit-code chip (`ok` /
`error` / `timed out`), then stdout and stderr in separate `<pre>` blocks, all text-only
(the payload is untrusted).

## Filed, not fixed here

- **`CE62-F1` (High, cross-feature).** Chat-produced run artifacts (`chat-code:` here,
  `chat-viz:` in interactive-artifacts) are keyed to the workspace and listed to every
  member with `workspace:read` (`artifactProjection.ts:408`). The conversation they come from
  may be private to its owner (`conversationStore.ts:114`). Code-exec output often contains
  data the user pasted inline. This is the platform's Library visibility model, shared with
  another feature, so it needs its own decision. It is not a sandbox boundary and is not
  changed here.
- **`CE62-F2` (Nice-to-have).** The size caps count UTF-16 code units, not bytes. Harmless at
  these magnitudes.
- **`CE62-F3` (High, executor-wide; architect AR-5).** The executor persists an approval's gate
  preview under `runArtifactKey(runId, nodeId)` (`executor.ts:2657`/`:2671`, insert-only CAS)
  and terminal capture writes the node's output under the same key (`executor.ts:3110`). For a
  node that suspends on ITSELF, like this one, the preview wins and the `code.execution-result`
  never lands. The key scheme is shared by every self-suspending node and has a replay-fork
  reader (`gatePreview.ts` `inheritedPreview`), so it needs its own decision. The chat lane is
  unaffected (it persists under its own `chat-code:` run id).
- **`CE62-F4` (Improvement, `CEU-1` carried).** The gate's `prompt` and `title` are authored in
  the node pack, in English. The evidence block's heading and note are localized ×4; the prompt
  line above it is not. Localizing pack-authored interrupt copy is a platform question.

## Architect pass (adversarial, before code) — findings folded in

Track A, plus a Track B check because the node's suspend payload reaches `interrupt.requested`.
No Blocker in the decision text. Six Highs, each now part of a decision above or filed:

- **AR-1 (High, D3) — a per-execution cap does not bound the instance.** 8 concurrent WASI
  runs (`OPENWOP_CODE_EXEC_MAX_CONCURRENT`, default 8) × 256 MB is 2 GB on a 1 GiB instance.
  **Folded into D3:** the WASI rung gets its own concurrency cap,
  `OPENWOP_CODE_EXEC_WASI_MAX_CONCURRENT`, default **2**. The aggregate bound an operator
  must size against is `concurrency × (mem cap + scratch cap + ~40 MB worker/module overhead)`,
  about 0.7 GB at the defaults. The external adapters keep the shared cap of 8, since their
  memory is not ours.
- **AR-2 (High, D6) — the reservation needs a failure rule and a day it belongs to.** A CAS
  that loses 12 times must **refuse** (`resource_exhausted`), not run uncharged. The refund
  decrements the SAME `tenant:day` key the reservation incremented (captured, not recomputed:
  a run that crosses midnight must not refund tomorrow). A refund that loses its CAS overcharges
  by one; that residual is stated. SSRF/config refusals (`sandbox_transport_error` before the
  fetch) stay charged: they share the transport code, and charging a misconfigured host's
  attempts is the conservative choice.
- **AR-3 (High, D1) — in-flight suspended runs.** A pack-version bump changes the code a resumed
  run executes. **Measured instead of assumed:** the node throws `capability_not_provided`
  BEFORE it suspends when no runner is bound (`index.mjs:43` precedes `:52`), and production
  binds none (Baseline). So no production run can be suspended at this gate today. Where one
  could exist (an operator with a sandbox), the resumed node's `suspend` short-circuits to the
  seeded resolution by its unchanged fallback key, and the canonical `{action:'approve'}` it
  returns is exactly what the new code reads. Replay (not resume) serves the recorded outcome
  (ADR 0686, the node is in the served floor). The witness is a route-level test that resolves
  through `POST /runs/:id/interrupts/:node` (P-NODE), not a faked `suspend`.
- **AR-4 (High, D4) — the watchdog must not become the DoS.** It walks a guest-controlled tree.
  It is async, never overlaps itself (a tick is skipped while one runs), stops counting at the
  entry cap, and measures the whole host-owned dir (the capture files included, so a print loop
  is bounded too). `cleanup` awaits `worker.terminate()` before removing the dir.
- **AR-5 (High, filed as `CE62-F3`) — the node's typed result never lands for a terminal gated
  node.** The executor persists the approval's gate preview under `runArtifactKey(runId, nodeId)`
  (`executor.ts:2657`/`:2671`, insert-only CAS), and terminal capture later writes the node's
  `code.execution-result` under the SAME key (`executor.ts:3110`). The CAS returns the preview,
  so the workbench shows "Approve running…" instead of the result. That key scheme is shared by
  every node that suspends on itself, so changing it is an executor decision with its own
  replay-fork reader (`gatePreview.ts:inheritedPreview`). Filed, not changed here.
- **AR-6 (High, D8) — a posture change must be visible to the operator it changes.** An
  adopter who ships the asset and relied on the default loses code execution on upgrade.
  **Folded into D8:** at boot, when `NODE_ENV=production`, the asset is present and no opt-in
  is set, log `code_exec_wasi_requires_optin` once; FEATURES.md and the Dockerfile comment say
  the same thing.
- **Medium, D3:** the rewrite refuses anything but exactly one defined memory with flags `0` or
  `1` (no memory64, no shared memory), and the compiled-module cache is keyed by the cap.
- **Wire (Track B): none.** The approval projector (`interruptRequestedPayload.ts:73`) builds a
  closed `ApprovalData` (`artifactId`, `title`, `actions`, …), so `codeExec` never reaches the
  wire. It stays in the host interrupt row the cards read. `actions: ['approve','reject']`
  projects to `['accept','reject']`, the same set the wire carried before. A string `prompt`
  makes the wire `title` "Run code?" instead of the `Approve run` fallback.

## Wire

None. Every change is host-internal: the node's suspend payload (`actions` is already an
interrupt.md field; `codeExec` is opaque host data inside `data`), adapter internals, the
budget store, a frontend renderer. No RFC.

## Post-deploy (2026-10-28)

Live on rev `01069-9m5` at `9ed40639d`, verified 06:12Z by the team lead's read-only posture
check: no code-exec, E2B or WASI env, no sandbox capability advertised, 0 errors, 0
`code_exec_wasi_requires_optin` warnings. Production posture is unchanged: code execution stays
honest-off.

## Ops notes

- Code execution must not be enabled in prod (OPENWOP_CODE_EXEC_RUNTIME / E2B env) until the CE62-F1 fix (ADR 0996) is live.
- In production the in-process WASI runtime needs `OPENWOP_CODE_EXEC_RUNTIME=wasi` and the
  vendored asset (D8). Enabling it is a user decision, not part of this ADR.

## Residue (after merge)

- **`CE62-R1` (follow-up, not blocking).** Pin the WASI concurrency default (2) and the
  slot-release-after-cleanup ordering (`wasiSandbox.ts` `cleanup`) with a test. Neither was
  sabotage-witnessed.
- **`CE62-R2`.** `POST /interrupts/:token` (`routes/interrupts.ts`) does not call
  `validateResumeValue`; only `POST /runs/:id/interrupts/:node` does. The node fails closed
  (it accepts only `approve`/`accept`). This is the same lane as `ISWF-23` (approverRefs is not
  subject binding on the token lane).
- **`CE62-F1`** is fixed separately in #5347 / ADR 0996.

## Closing grades (round 2, row 62)

| Lens | Baseline | Closing | Held below A by |
|---|---|---|---|
| WF | C | **A−** | `CE62-F3` (the node's typed result is shadowed by the gate preview; executor-wide) |
| UX | D | **A−** | `CE62-F4` (the gate's prompt line is English-only); no live click-through yet (light/dark, the inbox card and the chat card with a long program) |
| CODE | C | **A−** | the watchdog samples (overshoot bounded in time, not a quota); the Linux `/proc/self/fd` accounting is unit-witnessed with a stand-in directory, not on Linux end to end |

Every new test was sabotage-witnessed: fifteen sabotages (legacy approval shape, twice, through
the unit and the route; object prompt; no memory cap; no watchdog; no host cleanup; no
normalization; no charge on throw; no release; no production opt-in; a check-then-record race;
the frontend evidence lane dropped; the approval not bound to the code; the fd close a no-op;
unlinked files not counted), each red, each restored.

## Phases

| Phase | Decisions | Witness |
|---|---|---|
| P1 | D1, D2 | `test/code-exec-node.test.ts`, `test/adr0995-code-exec-bounds.test.ts` (P-NODE, through `createApp` and the interrupt route), `frontend/react/src/interrupts/__tests__/codeExecGate.adr0995.test.tsx` |
| P2 | D3, D4 | `adr0995-code-exec-bounds.test.ts` (capWasmMemory, P-WASI, fd scans) |
| P3 | D5, D6, D7 | `adr0995-code-exec-bounds.test.ts` (P-API), `code-exec-budget.test.ts` (the former `it.fails` race is a plain `it`) |
| P4 | D8, D9, D10 | `adr0995-code-exec-bounds.test.ts` (D8), `codeExecGate.adr0995.test.tsx` (renderer) |
