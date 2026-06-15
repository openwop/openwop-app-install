# ADR 0035 — Async / durable A2A Tasks (durable Task persistence + resubscribe + push)

**Status:** Accepted
**Date:** 2026-06-13
**Depends on:** RFC 0100 (`Active` — Async / Durable A2A Tasks, the gating wire),
`spec/v1/a2a-integration.md` (`FINAL` — the run-status ↔ TaskState projection
this persists), RFC 0093 (`Active` — the webhook-egress SSRF guard the push
reuses), RFC 0076 §A (the existing live A2A server endpoint this extends), ADR
0033 §Deferrals (the motivating host — work-twin suite explicitly deferred async
A2A to "an upstream OpenWOP RFC", which is now RFC 0100).
**Surface:** `backend/typescript/src/host/a2aServer.ts` +
`src/host/a2aTaskStore.ts` (NEW) + `routes/agents.ts` (the `POST
/v1/host/openwop-app/a2a` JSON-RPC endpoint) + `routes/discovery.ts` (the `a2a`
capability slot) + `bootstrap/registerAllRoutes.ts` (the push sink).
**NON-NORMATIVE host wiring.** This ADR adds NO openwop wire event, no
`eventLogSchemaVersion` change, and no new normative `MUST`. It implements the
host side of the composition RFC 0100 specifies; the normative A2A surface stays
the A2A v0.3 JSON-RPC methods (`tasks/get`, `tasks/resubscribe`,
push-notification config). The `POST /v1/host/openwop-app/a2a` route is a
host-extension surface (`host.openwop-app.*`) and never touches the openwop wire.

## Why this exists

RFC 0076 §A gave the reference host a live A2A **server** endpoint: a peer can
`agent/getCard` to discover it and `message/send` a task, routed to a real
manifest-agent dispatch. That endpoint is **synchronous-only and keeps no task
store** — `tasks/get` is hard-coded not-found, and there is no
`tasks/resubscribe` or push. ADR 0033's work-twin suite hands long-running,
HITL-gated, resumable work across hosts; an OpenWOP-backed A2A agent's Task is a
*whole run* that may pause at an approval gate for hours. The caller disconnects;
the synchronous round-trip cannot carry that. ADR 0033 explicitly deferred async
A2A to an upstream RFC. That RFC — **RFC 0100** — is now `Active`, so this is
host work (a feature riding an already-Active RFC needs no new RFC; CLAUDE.md
§"A spec change needs an RFC").

RFC 0100 closes the gap **additively**: a NEW `a2a` capability slot, a persisted
`A2ATaskState` per backing run (durable across caller disconnect / HITL pause),
durable `tasks/get`, `tasks/resubscribe` re-attachment, and SSRF-guarded push on
the terminal/blocking transitions — and it changes **nothing** about the sync
round-trip. This ADR wires exactly that, gated so the advertisement never
outruns the implementation.

## Decision

Extend the EXISTING `host/a2aServer.ts` + its route — do **not** fork the A2A
surface or the run lifecycle. The run-status → TaskState mapping is the one
`a2a-integration.md` §"State projection (forward)" already specifies, **persisted
verbatim**, not edited.

### Persistence model — `A2ATaskState` via `DurableCollection`

`src/host/a2aTaskStore.ts` (NEW) persists one `A2aTaskRecord` per backing run in
the **same `DurableCollection` every other host-extension store uses** (NOT a
parallel store — MEMORY.md §"No parallel architecture"). The collection is
read-through + per-entity + synchronously-written, so a durable Task is correct
across instances and survives restart within retention (RFC 0100 §2). The record
is **content-free of run internals**: `{ taskId, runId, contextId?, state,
interruptKind?, updatedAt, pushConfig? }` — no inputs/outputs/artifacts/credential
material inline (SR-1 / the `a2a-integration.md` trust boundary). `taskId == runId`
(the 1:1 binding `a2a-integration.md` §2 mandates — "the returned runId becomes
the A2A Task.id"). The wire/persisted `state` is the A2A v0.3 lowercase-hyphen
form (`a2a-integration.md` §"Wire-shape spelling drift").

### The state projection (the FINAL table, persisted)

`projectRunStatusToTaskState()` implements the `a2a-integration.md` §"State
projection (forward)" table verbatim: `pending→submitted`, `running→working`,
`paused→working` (drift #1), `waiting-approval→input-required` (interruptKind
`approval`), `waiting-input→input-required` (interruptKind `clarification`,
drift #2 disambiguated via `Task.metadata.openwop.interrupt.kind` — the
`metadata.openwop.*` carrier RFC 0100 §2 codifies), `completed→completed`,
`failed→failed`, `cancelled→canceled` (spelling drift). The
deterministic agent dispatch the server backs Tasks with projects: `completed →
completed`, `escalated → input-required`/`clarification` (a HITL-style block —
the agent asking the caller for input, matching the `waiting-input` row),
`failed → failed`. `message/send` persists `working` BEFORE the turn so a caller
that disconnects mid-turn `tasks/get`s a live `working`, then persists the
projected outcome — `working` → terminal/blocking is the spec table, not a new
lifecycle. `auth-required` stays in the persisted enum for reverse-direction
fidelity (RFC 0100 Unresolved-Q4) but the forward projection never emits it
(openwop v1 has no `auth` interrupt — drift #3).

### Async lifecycle — `tasks/get`, `tasks/resubscribe`

- **`tasks/get`** returns the persisted Task projected to an A2A `Task` envelope
  (`{ kind:'task', id, status:{state,timestamp}, contextId?, metadata? }`) —
  live state after disconnect, no held connection (RFC 0100 §3). Not-found when
  durable tasks are off (back-compat) or the task id is unknown.
- **`tasks/resubscribe`** re-delivers the current state as a
  `TaskStatusUpdateEvent` from the current state forward — **read-only
  re-attachment**, no run re-execution, the backing `runId` unchanged (RFC 0100
  §3). Because the deterministic dispatch is synchronous-terminal, resubscribe
  re-emits the persisted terminal/blocking state; a production host backing a
  long-running run streams the live run SSE forward (the run event stream
  already exists — resubscribe is a re-attach, not a new run).

### Push-notification config — SSRF-guarded, fires on the four transitions

`tasks/pushNotificationConfig/set` registers a `PushConfig { url,
tokenFingerprint? }` on an existing Task. The `url` is validated through the
**RFC 0093 webhook-egress SSRF guard** (`isDeniedWebhookHost` + scheme check)
before persist — a push URL is the same SSRF surface as a webhook (RFC 0100 §4).
A push fires a `TaskStatusUpdateEvent` on each push-eligible transition —
`input-required`, `completed`, `failed`, `canceled` (the RFC 0100 §4 floor) —
carrying the same content-free projection (SR-1; no run-internal content). The
default sink (wired only when durable tasks are on) POSTs through the same
egress-guarded `undici` dispatcher every webhook delivery uses (the resolved
address is re-validated at connect time). Push delivery is best-effort — a sink
failure never rolls back the durable state transition. The A2A push HMAC details
stay inside the A2A layer (`a2a-integration.md` §"What openwop does NOT specify").

### Capability advertisement — only when wired

The `a2a` capability slot (RFC 0100 §1: `{ supported, agentCardUrl, streaming?,
pushNotifications?, durableTasks? }`) is advertised in `/.well-known/openwop`
**only when `OPENWOP_A2A_SERVER_ENABLED=true`** (the host actually exposes A2A —
otherwise a caller would feature-detect a 404ing surface). `streaming` /
`pushNotifications` / `durableTasks` are `true` **only when
`OPENWOP_A2A_DURABLE_TASKS=true`** (the durable wiring is on); with it off the
slot advertises the synchronous round-trip already specified (no regression, the
async conformance subtests soft-skip). The synthesized AgentCard's `capabilities`
and the `host.a2a` surface note flip in lockstep so the three advertisements
can't drift.

## What's wired vs deferred

**Wired:** durable `A2ATaskState` persistence (`message/send` persists; survives
disconnect); durable `tasks/get` (live projected state); `tasks/resubscribe`
(read-only re-attach as a `TaskStatusUpdateEvent`); `tasks/pushNotificationConfig/set`
+ SSRF-guarded push on the four transitions; the `a2a` capability slot +
AgentCard `capabilities` + surface note, advertised only when wired; full
back-compat with the synchronous core (durable off ⇒ today's behavior exactly).

**Deferred (honestly):** the server backs Tasks with the deterministic
**manifest-agent dispatch** (RFC 0070 seam — replay-safe, synchronous-terminal),
not a long-lived multi-step workflow run, so in this reference the durable Task
reaches its terminal/blocking state immediately; the persistence + resubscribe +
push machinery is real and exercised, but the *hours-long pause* is demonstrated
via the escalation→`input-required`→resume path, not a real wall-clock HITL gate.
A production host projects from a live long-running `run.status` and streams the
run SSE on resubscribe — the seam is in place (`projectRunStatusToTaskState`
already maps the full run-status enum). Also deferred: a
`/.well-known/agent-card.json` well-known path (the card is fetched via
`agent/getCard` over JSON-RPC today) and multi-subscriber resubscribe fan-out
(RFC 0100 Unresolved-Q3 — safe because resubscribe is read-only).

## Alternatives considered

1. **A parallel async task store separate from `DurableCollection`.** Rejected —
   MEMORY.md §"No parallel architecture": a feature that "is" a durable record
   MUST instantiate the existing primitive, not shadow it. The A2A Task store is
   one more `DurableCollection('a2a:task', …)`, identical in posture to the
   trigger-bridge / roster / approval stores.
2. **A new openwop `run.*` event carrying the A2A Task.** Rejected — RFC 0100
   §Alternatives #2 rejects re-specifying A2A's wire on openwop's event log
   (SR-1 + content-bloat; couples `eventLogSchemaVersion` to A2A). The Task is a
   host-side persisted projection read via the A2A `tasks/get` method.
3. **Make durable Tasks unconditional whenever the A2A server is on.** Rejected —
   RFC 0100 §Alternatives #4: a host may legitimately expose only short
   synchronous skills; forcing persistence is a breaking expansion of the sync
   contract. `OPENWOP_A2A_DURABLE_TASKS` is the additive opt-in (mirrors RFC
   0083's `webhooks.durable`).
4. **Make `handleA2aRequest` keep a synchronous signature + a side store.**
   Rejected — `DurableCollection` is async; a mixed sync/async handler is a
   footgun. The handler is now `async`; the one route call site `await`s it and
   the existing tests were updated. The behavior with no store injected is
   byte-identical to before.

## Tests

`backend/typescript/test/a2a-durable-tasks.test.ts` (unit, store + handler) and
`test/a2a-durable-route.test.ts` (HTTP, both env flags on):

- `message/send` persists an `A2ATaskState` with `taskId == runId` + `contextId`.
- `tasks/get` returns the persisted Task with the projected state after
  "disconnect" (response discarded, queried later).
- the state advances as the run progresses (`input-required` → `completed` on a
  resume re-send into the same task id).
- an escalation projects to durable `input-required` with
  `metadata.openwop.interrupt.kind = clarification`.
- `tasks/resubscribe` re-attaches a `status-update` event read-only (backing
  `runId` + `updatedAt` unchanged — no re-execution).
- a push fires on the terminal transition to the registered config; an SSRF
  push URL (`http://10.0.0.5/…`, loopback, link-local, non-http) is refused
  (`-32602`) and not persisted.
- the `a2a` capability slot advertises `durableTasks/streaming/push = true` when
  wired, `false` when only the sync server is on (`test/a2a-server-route.test.ts`).
- back-compat: durable off ⇒ nothing persists, `tasks/get` not-found
  (`test/a2a-server.test.ts` + the route test, unchanged sync assertions).
- `projectRunStatusToTaskState` unit-checks the full `a2a-integration.md` FINAL
  table; `assertPushUrlAllowed` unit-checks the SSRF guard.

| Phase | Commit | Tests |
| ----- | ------ | ----- |
| Durable store + handler + route + capability + push sink | this PR | `a2a-durable-tasks.test.ts` (16), `a2a-durable-route.test.ts` (3), `a2a-server*.test.ts` updated (back-compat) — 27 passing |

## Correction note (P2-APP, 2026-06-14) — durable-task conformance seams

The durable Task store + the `message/send`/`tasks/get`/`tasks/resubscribe`
JSON-RPC methods on `POST /v1/host/openwop-app/a2a` shipped as designed. The
`@openwop/openwop-conformance` **1.25.0** RFC-0100 behavioral legs, however,
drive three **REST host-sample seams** the original implementation did not
serve:

- `POST /v1/host/openwop-app/a2a/tasks/start` `{scenario:'paused-at-approval'}` → `{taskId}`
- `GET  /v1/host/openwop-app/a2a/tasks/{id}` → the `A2ATaskState` record (top-level `state` + `runId`)
- `POST /v1/host/openwop-app/a2a/tasks/push-config` `{taskId,url}` → SSRF-guarded

Without them the `a2a.durableTasks` + `a2a.pushNotifications` legs were
**soft-skipping on 404** (vacuous passes) even though the capabilities advertised
`true`. Fix (no spec/wire change): added the three seams in `routes/agents.ts`
as **adapters over the real `a2aTaskStore`** (ADR 0035's `DurableCollection`),
gated on the same `OPENWOP_A2A_SERVER_ENABLED && OPENWOP_A2A_DURABLE_TASKS`
predicate that flips the advertisement (advertise/enforce parity). `tasks/start`
starts a **genuine `openwop-app.approval-gate` run** and persists its projection
with `taskId == runId` (no shadow id — MEMORY.md §"No parallel architecture");
`tasks/get` reads the persisted record; `push-config` runs the caller URL through
the same `assertPushUrlAllowed` egress guard the push path uses, refusing a
private target with `400` before the task lookup. Verified non-vacuously:
`a2a-task-roundtrip` 10/10 under `OPENWOP_REQUIRE_BEHAVIOR=true` (two real
approval-gate runs started, `tasks/get` returned live `input-required`), plus
`test/host-sample-conformance-seams.test.ts` (7).

## Correction note (P2-APP follow-up, 2026-06-14) — honest `agentCardUrl` origin

Post-deploy steward verify caught that the live discovery advertised
`a2a.agentCardUrl = "http://localhost:8080/v1/host/openwop-app/a2a"` — a `localhost`
stub, making `a2a.supported:true` a **dishonest cross-host advertisement**
(`capabilities.md` advertise-honestly). Root cause: `discovery.ts` derived the
base from `OPENWOP_PUBLIC_BASE_URL || 'http://localhost:8080'`, and
`buildAdvertisement` was called with **no request context** (`(_req, …)`), so it
could only fall back to the localhost literal when that env was unset (it was).

The naive fix (set `OPENWOP_PUBLIC_BASE_URL`) is **wrong**: that var is the
SPA/OAuth origin (`features/connections/oauthFlow.ts` `appBaseUrl`/`callbackBaseUrl`
— the browser bounce-back + OAuth redirect URI + inbound-connection ingest base),
and the SPA host (`app.openwop.dev`) routes only `/api/**` to this backend, not
the bare `/v1/...` A2A path (firebase.json). Pointing it at the backend origin
would break OAuth callbacks.

Fix (no wire-shape change — only the *value* of an existing field becomes honest):
the a2a base now derives, in precedence order, from (1) a dedicated
`OPENWOP_A2A_PUBLIC_BASE_URL` override (custom-domain backends), (2) the
forwarded request origin the caller actually reached us on
(`X-Forwarded-Proto`/`-Host`, sanitized), (3) `http://localhost:8080` (local-dev
only). The derivation lives in ONE shared helper `host/requestOrigin.ts` (also
now backing `features/featureRoute.ts` `publicBaseUrl` and the synthesized
AgentCard `url` in `routes/agents.ts` — same `localhost`/`http` bug, same fix),
so the host-token/scheme policy can't drift. We deliberately do **not** flip a
global `trust proxy` (it would change `req.ip` rate-limit keying + `req.secure`
cookie semantics app-wide) — the forwarded headers are read locally.
Verified: `test/a2a-agentcardurl-origin.test.ts` (4) + live curl on the redeploy.

## References

- RFC 0100 `RFCS/0100-async-durable-a2a-tasks.md` (`Active`) — the gating wire.
- `spec/v1/a2a-integration.md` (`FINAL`) — the run-status ↔ TaskState projection
  this persists, the spelling-drift + `metadata.openwop.*` notes.
- RFC 0093 `RFCS/0093-…webhooks-tokens-idempotency.md` — the egress SSRF guard
  the push reuses (`host/webhookEgressGuard.ts`).
- ADR 0033 §Deferrals — the motivating host; async A2A deferred to this RFC.
- MEMORY.md §"No parallel architecture" — why the Task store is a real
  `DurableCollection`, not a shadow.
