# ADR 0318 — Heartbeat admin settings (runtime control of the autonomous work loop)

Status: implemented

## Context

ADR 0313 activated the autonomous work loop (the "heartbeat"): a 30-second daemon
that, for each roster agent whose effective cadence is due, runs a "Check now" pass
that **proposes** work (never auto-executes — bare cards become `PendingApproval`s).
Its host-wide default cadence lives in **one env var**, `OPENWOP_HEARTBEAT_DEFAULT_MS`,
read by the single resolver `effectiveHeartbeatIntervalMs` (`host/heartbeatService.ts`).

That env-only control has two operational gaps:

1. **No runtime toggle.** Turning the loop on/off host-wide (or changing the cadence)
   requires a Cloud Run env update + a new revision. When we deployed the loop
   (ADR 0313) we pinned it off with `OPENWOP_HEARTBEAT_DEFAULT_MS=0` precisely because
   there was no safer, reversible way for an operator to flip it.
2. **No bounded "run for a while" mode.** An operator who wants to try the loop for an
   afternoon has to remember to turn it back off — an autonomous loop with no
   auto-expiry is easy to leave running unattended.

The request: a superadmin admin setting to **toggle the heartbeat on/off, set a timer
for how long it runs, and tune related config** — without a redeploy.

## Decision

Add a **host-wide, superadmin-owned durable config** (`features/heartbeat-admin`) that
governs the loop at runtime, layered **above** the `OPENWOP_HEARTBEAT_DEFAULT_MS` env
default via the existing single resolver. No new daemon, store type, autonomy level, or
wire surface.

- **Master switch (`status: 'on' | 'off'`).** `off` is a **hard kill** — the resolver
  returns 0 for *every* member, overriding per-agent cadence (the operator emergency
  brake). `on` applies the configured host-default cadence fleet-wide (a per-agent
  cadence, and the `-1` opt-out, still win). Absent config ⇒ inherit the env exactly as
  pre-0318.
- **Auto-disabling "run for N hours" window (`enabledUntil`).** Chosen (over a plain
  toggle or a recurring active-hours schedule) so an operator can enable the loop for a
  bounded window and have it **flip itself off** — a safety rail against unattended
  runaway. Evaluated **at read time** in the resolver (`now >= enabledUntil ⇒ treated as
  off`), so no timer/job is needed; `null` ⇒ run indefinitely.
- **Editable cadence (`hostDefaultIntervalMs`)** and an **optional run-budget override
  (`runBudgetPerHour`)** — the "other config" knobs (bounded 1 min–24 h; the budget
  supersedes the `OPENWOP_AUTONOMOUS_RUN_LIMIT` env cap when set, `0 ⇒ unlimited`).

**Enforcement path.** The core resolver stays sync and reads config **per pass**: the
async admin config is resolved **once** at the top of `processDueHeartbeats` and threaded
into the (still-sync) `effectiveHeartbeatIntervalMs(entry, admin?)` for every due-check +
slot-quantization + roster display decoration — so the whole pass agrees, and a change
takes effect on the next 30-second tick with **no redeploy**. The feature registers its
resolver into core via the ADR 0313 **fill-a-seam** pattern (`registerHeartbeatConfigProvider`);
core never imports the feature, and an unregistered/failed provider **fails open** to the
env default (a config-store hiccup must never wedge or silently kill the loop).

**Scope: host-wide superadmin** (matches the env var it replaces). Not per-tenant — a
per-tenant layer is a clean future extension (the `navigation-settings` tenant/host
layering is the template) but out of scope here.

**Surface.** A `features/heartbeat-admin` package: a `DurableCollection<HeartbeatAdminConfig>`
singleton row (`hostext:heartbeat-admin:default`), `GET/PUT
/v1/host/openwop-app/heartbeat/settings` gated by `requireSuperadmin`, and a
`tier:'admin'` Settings → Platform → **Heartbeat** page showing the live effective state
(incl. the auto-disable countdown) with a master toggle, cadence, "run for" duration, and
run-budget controls (4-locale i18n).

## Alternatives considered

- **A plain toggle with no auto-expiry.** Rejected: an autonomous loop with no bound is
  the exact "left it running unattended" hazard the operator asked to avoid.
- **A recurring active-hours schedule** (e.g. weekdays 9–5). More powerful, but more
  surface (a schedule model + timezone) than the ask; the one-shot auto-disabling window
  covers "try it for a while" and can be superseded later.
- **Per-tenant config now.** Deferred — the ask is host-wide, and per-tenant multiplies
  the persistence + tenant-admin gating surface. The seam (resolver + store) accommodates
  it later.
- **A second daemon / a stored "kill flag" separate from the resolver.** Rejected —
  ADR 0313's invariant is ONE resolver for the due-check and the slot quantization; a
  parallel control path could make them disagree. The override layers into that one
  resolver.
- **Making the config read async in the resolver.** Rejected — it would ripple `async`
  through `isHeartbeatDue`/`processDueHeartbeats` and the roster route; resolving once
  per pass and threading the plain value keeps the resolver sync + total.

## Compatibility / safety

- **No wire change.** Host-extension routes under `/v1/host/openwop-app/*` are
  non-normative — no OpenWOP RFC needed. The heartbeat is host-managed and **outside the
  replay envelope** (ADR 0313), so nothing here is stamped on a run or read at replay.
- **Backward compatible.** With no saved config the resolver is **byte-identical** to
  pre-0318 (env default). The `effectiveHeartbeatIntervalMs(entry, admin?)` `admin` param
  is optional; all existing callers that omit it keep env behavior.
- **Superadmin-gated + fail-closed** on the mutation; **fail-open** on the read (to the
  env default) so the loop can never be wedged by a config error.

## Implementation

| Phase | What | Where |
|---|---|---|
| Core seam | `ResolvedHeartbeatConfig` + `registerHeartbeatConfigProvider` / `resolveHeartbeatAdminConfig`; `effectiveHeartbeatIntervalMs(entry, admin?)`; thread through `isHeartbeatDue` + `processDueHeartbeats` (once/pass) + `withHeartbeat` | `host/heartbeatService.ts`, `routes/roster.ts` |
| Budget override | `runBudgetConfigWithLimit(limit)` helper; the pass passes it when `runBudgetPerHour` is set | `host/runBudgetService.ts` |
| Feature | durable config + window resolution + validation + routes + provider registration | `features/heartbeat-admin/{types,service,routes,feature}.ts`, `features/index.ts` |
| UI | superadmin `tier:'admin'` Settings page + client + 4-locale i18n | `settings/HeartbeatSettingsPage.tsx`, `client/heartbeatAdminClient.ts`, `settings/i18n/*`, `i18n/locales/*/nav.ts`, `chrome/features.tsx` |
| Tests | resolver override (master kill / cadence override / per-agent precedence / absent-⇒-env), window auto-disable, PUT validation | `test/heartbeat-admin.test.ts` |

Backend: tsc clean; `heartbeat-admin` + `heartbeat-default-cadence` + daemon/roster/budget
suites green. Frontend: `npm run build` green (tsc + i18n parity + token/CSS + budget).

## Open questions / follow-ups

1. **Per-tenant layer.** A tenant admin overriding the host default for their workspace —
   the `navigation-settings` host/tenant layering is the template. Deferred until asked.
2. **Poll interval.** `POLL_INTERVAL_MS = 30_000` stays a hardcoded const (the cadence
   floor is 1 min, well above it); expose it only if a real need appears.
3. **Deploy default.** The live env stays `OPENWOP_HEARTBEAT_DEFAULT_MS=0`; the loop stays
   dark until a superadmin turns it on here (or the operator flips the env). This ADR does
   not change the deployed default — it makes flipping it a runtime, reversible action.
