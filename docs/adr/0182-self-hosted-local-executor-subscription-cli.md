# ADR 0182 — Self-hosted local executor for subscription-CLI dispatch

**Status:** implemented (Phases 1–4; Phase 5 remote-runner gated on Draft RFC 0122 reaching Accepted) *(Status-corrected 2026-07-21 — header lagged the shipped work)* — 2026-07-01 · **all phases worked through** 2026-07-01. Phase 1 (detection + honest-off advertisement) in `backend/typescript/`; Phases 2–4 (the shim) in `clients/subscription-provider/` (`node --test` green, mocked CLI); Phase 5 (remote runner) authored as **Draft RFC 0122** in `../openwop` (openwop PR #812 — needs steward review to reach Accepted). See the phase table.
**Depends on / extends:** ADR 0180 (RFC 0121 subscription at-own-risk mechanism — the off-by-default flag, user-scope consent-gated bind, and the `OPENWOP_SUBSCRIPTION_ENDPOINT` dispatch seam this ADR points at a local shim). ADR 0179 (the §B.8 user-scope safety rail). ADR 0121 (self-hosted / OpenAI-compatible endpoint provider class — the compat wire the shim speaks). ADR 0114 §8 (the `resolveSandboxExecutor()` precedence pattern — the same "select an executor by config, honest-off when absent" shape reused here). ADR 0181 (the desktop shell that makes this turnkey).
**Surface:** a local **provider shim** (a small loopback daemon; later a `openwop provider serve` verb on the existing CLI) + operator config on a **self-hosted** deployment. **In-scope (local) case: NON-NORMATIVE — no new RFC.** It rides `OPENWOP_SUBSCRIPTION_ENDPOINT` (ADR 0180, itself on Active RFC 0121). **Out-of-scope (remote tunneled-host) case: NEEDS a new RFC** in `../openwop/` (a self-hosted-runner / reverse-tunnel protocol) — explicitly deferred, see Phase 5.

> **CORRECTED 2026-09-26 (ADR 0756).** The Claude Code harness is **removed**: the `/v1/messages` → `claude -p` route, `runClaude`, and the Claude login detection (backend and shim). Anthropic's terms prohibit routing requests through Free/Pro/Max plan credentials on behalf of an application's users. The Codex harness below is unchanged.

## The honesty constraint (load-bearing — read first)

This ADR inherits ADR 0180's constraint verbatim: **the host ships NO provider-private-API code** — no reverse-engineered endpoints, no session-cookie scraping, no token forwarding. The subscription credential (Claude Pro/Max, ChatGPT Plus) is **never extracted and never leaves the vendor CLI that owns it**. The only lawful, stable way to spend a consumer subscription is to run the vendor's **own official client** under the user's **own login** on the user's **own machine**. Accordingly:

- The shim **drives the vendor's official CLI non-interactively** (`claude -p …` / `codex exec …`), on the user's machine, under the login that CLI already holds.
- The shim **reads no token**. It detects login *presence* (read-only, local, no network) only to advertise honestly; the token stays in `~/.claude` / `~/.codex` / the macOS Keychain, used only by the CLI itself.
- **ToS risk R1 stands and is the user's at-own-risk bet.** A `claude -p`→compatible-API shim arguably reads *more* like "subscription as a metered API" than driving the interactive coding agent does — so R1 is, if anything, sharper here. It is un-changed and **user/operator-accepted**, exactly as ADR 0180 gates it (off by default, user scope, explicit consent).

## Why this exists

The question that motivated it: *"openwop-app has a CLI and a headless backend — so why can't subscription login work for us?"* It can — but only once we see the real distinction. Subscription reuse works when **execution happens on a user-controlled host** (their laptop) and the web server is just orchestration, connected to it by a tunnel. openwop-app's architecture is different: **the backend *is* the executor** (the run engine's `ctx.callAI` dispatches to providers in-process). So:

- The **public Cloud-Run demo** genuinely cannot: it has no vendor CLIs, no persistent user login/Keychain, and cannot reach a user's loopback. It stays **dark**.
- A **self-hosted backend on the user's own machine** absolutely can: it can reach a local shim that wraps the locally-logged-in `claude`/`codex`. And the seam already exists — ADR 0180 shipped `OPENWOP_SUBSCRIPTION_ENDPOINT` precisely as "the operator points this at whatever endpoint they accept the risk of."

This ADR fills the one missing piece: **the local shim** that turns a logged-in vendor CLI into that endpoint.

## Decision

Ship a **local, self-hosted subscription executor** — a loopback provider shim the self-hosted backend dispatches to — behind ADR 0180's existing gates.

### 1. The shim (detection + local compat endpoint)
A small local component that:
- **Detects** the logged-in vendor CLI, read-only and local: `~/.claude/.credentials.json` (`claudeAiOauth`), `~/.codex/auth.json` (`OPENAI_API_KEY`/`personal_access_token`, or `tokens{access_token, refresh_token}`), and on macOS falls back to `claude auth status` (Keychain-aware). Presence-based; **no expiry judgement** (tokens self-refresh) and **no network probe**.
- **Exposes an OpenAI/Anthropic-compatible endpoint on loopback** (shape matched to the harness: Anthropic-messages for `claude`, OpenAI-completions/responses for `codex`).
- **Implements each request by shelling out** to the vendor CLI non-interactively (`claude -p`/`codex exec`), mapping the compat request in and the CLI's output (incl. streaming) back out. Token never touched.

### 2. Wire it via the existing dispatch seam
The self-hosted backend sets `OPENWOP_SUBSCRIPTION_ENDPOINT` → the loopback shim. Dispatch flows: executor `ctx.callAI` → subscription endpoint (loopback) → vendor CLI (user login) → provider. **No new dispatch path** — this reuses ADR 0180 / ADR 0121's compat endpoint class. The backend stays provider-agnostic and Cloud-Run-safe: it never spawns a CLI itself; the vendor-CLI subprocess lives entirely behind the endpoint seam, on the user's machine.

### 3. Honest, gated advertisement
Reuse ADR 0180's gates unchanged: **off by default** (`OPENWOP_SUBSCRIPTION_AT_OWN_RISK` + `OPENWOP_SUBSCRIPTION_PROVIDERS`), **user-scope** credential binding (§B.8), **explicit consent**. Advertise `subscription` for a provider **only when** the shim is reachable **and** a login is detected — a `needs-auth` / `binary-missing` readiness signal. The public demo leaves the flag unset and stays dark.

### 4. Execution locality is the whole model
This is inherently a **self-hosted / local-deployment** feature. It is turnkey when paired with the ADR 0181 desktop shell (which can launch the local backend + shim), and it is *not* offered on the hosted demo.

## Boundaries & duplication (architect self-review)

- **One dispatch seam.** Reuse `OPENWOP_SUBSCRIPTION_ENDPOINT`; do not add a second subscription dispatch path.
- **Backend stays provider-agnostic.** The vendor-CLI-spawning lives in the shim (a client/CLI-side component), **never** in the backend hot path — the backend only knows a compat endpoint URL. This keeps the Cloud-Run image free of CLI dependencies and preserves the "backend is authority, provider-neutral" contract.
- **Reuse the readiness/honest-off pattern** (ADR 0180 §B.9) rather than inventing a new advertisement mechanism.
- **No token custody change.** The shim reads presence, not material; SR-1 (credentials host-side, never on the wire/result) is preserved because the token never enters openwop at all.
- **Where it lives:** the shim is a CLI/client component (ADR 0168: "extend `@openwop/cli`, don't fork a second system"). Backend changes are limited to detection-driven *advertisement* honesty (already largely present from ADR 0180) — no new core route.

## Alternatives considered

| Option | Verdict |
|---|---|
| **Token extraction / forwarding** (copy the subscription OAuth into openwop and call the provider directly) | **Rejected.** It is the R1 harm in code, violates the ADR 0180 honesty constraint, and is technically futile — a vendor CLI's login is bound to the official client and cannot be reused outside it. |
| **Reverse-engineered provider web API** (§C shape 1 borrowed-session) | **Rejected** — the exact ToS-circumventing, brittle provider code ADR 0180 refuses to ship. |
| **Just require a vendor API key** (BYOK `apiKey`) | Already supported and honest, but it is **not the subscription** — it bills at API rates and doesn't meet the "use my Pro/Max plan" goal. Remains the recommended default; this ADR is the opt-in at-own-risk alternative. |
| **Remote server + tunneled local runner now** (a full server/host split) | **Deferred.** openwop's backend-is-executor model has no self-hosted-runner protocol; adding one is a **new RFC** (reverse-tunnel, run routing, host liveness) — Phase 5, not this ADR. |

## Phased implementation plan

| Phase | Scope | RFC? | Gate |
|---|---|---|---|
| **1** ✅ *implemented 2026-07-01* | Read-only ambient **detection** of a logged-in `claude`/`codex` — **file-only** (`~/.claude/.credentials.json`, `~/.codex/auth.json`; honors `CLAUDE_CONFIG_DIR`/`CODEX_HOME`), **zero spawn** (macOS Keychain fallback deferred to the shim to honor the no-vendor-CLI-spawn gate). Feeds a new `subscriptionAdvertisedProviders()` that narrows the honest-off advertisement to detected logins **only when the operator opts in** via `OPENWOP_SUBSCRIPTION_REQUIRE_LOGIN` (default off ⇒ ADR 0180's deterministic advertisement contract unchanged). | No | tsc clean; 18-case fixture unit test (present/renewable/unexpired/expired/logged-out/malformed/absent, side-effect-free) + ADR 0180 discovery regression green. |
| **2** ✅ *implemented 2026-07-01* | The loopback **compat endpoint** in `clients/subscription-provider/` — `/v1/messages`→`claude -p` (Anthropic Messages), `/v1/chat/completions`→`codex exec` (OpenAI). Turn-atomic in v1 (streaming = OQ). No provider-private-API code. | No | 21 `node --test` assertions: `flattenMessages`, the `claude -p`/`codex exec` mapping (mocked CLI), auth-error→`subscription_login_required`, loopback-only bind. |
| **3** ✅ *implemented 2026-07-01* | Operator wiring documented (`OPENWOP_SUBSCRIPTION_ENDPOINT` → shim) in the shim README + backend Phase 1's readiness-gated advertisement (`OPENWOP_SUBSCRIPTION_REQUIRE_LOGIN`); reuses ADR 0180 off-by-default + user-scope + consent. | No | Phase-1 advertisement tests (dark with flags unset / no login); shim `/healthz` + bind tests. |
| **4** ✅ *implemented 2026-07-01* | Shim packaged with a `bin` entry (`openwop-subscription-provider`) that `@openwop/cli` can adopt as `openwop provider serve`; `clients/desktop` Phase E (`serverManager.js`) spawns/adopts/stops it. | No | `bin.js` readiness + endpoint print; desktop `ManagedProcesses` lifecycle tests. |
| **5** ✅ *RFC 0122 Active; reference-host runner arm wired 2026-07-02 (behind the gate)* | Remote server + **self-hosted runner** (drive local execution from a remote/hosted server or phone). RFC 0122 reached **Active** (openwop #813); the §19 conformance seam (`/v1/host/sample/runner/{register,dispatch}`) + `selfHostedRunner` capability (**honest-off, `supported:false`**) are now wired: `host/selfHostedRunner.ts` (subject-first match, at-most-once dedup via a `DurableCollection`) + `routes/runnerSeam.ts`. NO advertise `supported:true` until RFC 0122 is **Accepted** (Phase 3 dual-witness). | RFC 0122 Active. Witnessed **non-vacuous**: the published `@openwop/openwop-conformance@1.48.0` `self-hosted-runner.test.ts` passes **7/7 against the booted host under `OPENWOP_REQUIRE_BEHAVIOR=true`** (tier-2 advert honestly opted-out since `supported:false`; tier-3 seam runs, not 404-skipped), plus a hard-assertion route test. Accepted-flip + the full SSE product channel remain. |

Phases 1–4 are self-host-only and wire-neutral (Phase 2–4 live in `clients/subscription-provider/`, out of `backend/typescript/src` — honoring the no-vendor-CLI-spawn gate). Phase 5's Draft RFC opens the design; the reference-host arm stays parked until it is Accepted. **Residuals are gates, not gaps:** a live end-to-end round-trip needs a real subscription + the vendor CLIs installed (the shim tests mock them), and Phase 5 needs steward RFC acceptance.

## Open questions / decisions

- [ ] **Which harness first** — `claude` (Anthropic-messages) is the closest wire match to our dispatch; confirm `codex exec` as the second.
- [ ] **Streaming fidelity** — does `claude -p`/`codex exec` non-interactive output stream cleanly enough to map to SSE token deltas, or is it turn-atomic in v1?
- [ ] **Revocation** — login validity is only knowable at run time (local detection can't see a server-side revoke); confirm we surface a clear "sign in again" at dispatch failure by classifying the vendor CLI's auth-error output.
- [ ] **ToS posture** — record explicitly that the `-p`/`exec`→API-shim shape may be more ToS-exposed than interactive driving; it remains R1, user/operator-accepted, and gated. Does the operator (David Tufts) accept it for the self-host tier? (ADR 0180's acceptance covers the mechanism; this confirms the local-executor instantiation.)
- [ ] **Shim location** — `@openwop/cli` verb vs a standalone `clients/` daemon. Leaning CLI verb per ADR 0168.
- [ ] **Rate/abuse** — even user-scoped, confirm no unintended fan-out drives the subscription past its interactive-use envelope.

## Verification (when implemented)

- Detection unit tests over credential fixtures (present / logged-out / malformed / Keychain-fallback), side-effect-free.
- Compat-endpoint round-trip against a **mocked** vendor CLI (no real subscription in CI); a drift-guard `grep` asserting the shim ships no reverse-engineered provider endpoints (mirrors the ADR 0180 guard).
- Advertisement honesty: with flags unset the host is dark; with the shim reachable + a login detected, `subscription` advertises for the configured provider only.
- Backend `grep` gate: no vendor-CLI spawn in `backend/typescript/src` (the subprocess lives behind the endpoint seam).
