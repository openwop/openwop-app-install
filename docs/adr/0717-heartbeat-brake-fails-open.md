# ADR 0717 — The heartbeat emergency brake fails OPEN, and the env pin does not save it

Status: **implemented** (the fix ships in the same PR as this decision)

**Feature:** Heartbeat admin settings (`FEATURES.md` ordinal 214) · ADR 0313/0318 · feature-loop 2026-09 it.46
**Closes:** `HBC-1` (refines `HB-4`) · **Corrects:** `HBC-1`'s stated mitigation

## Context

ADR 0318 gives a superadmin a global kill switch for the ADR 0313 autonomous work loop.
`ResolvedHeartbeatConfig.masterOff` is documented as:

> Global kill switch: master off, OR an enabled window that has elapsed. When true, the
> resolver returns 0 for EVERY member (**overrides per-agent cadence**).

The config is resolved once per pass through a provider seam, and that resolution
deliberately fails OPEN:

```ts
} catch (err) {
  log.warn('heartbeat admin config provider failed — inheriting env default', …);
  return null;   // ← the brake is discarded with it
}
```

The rationale is sound on its face — *"a config-store hiccup must never wedge or silently
kill the loop"*. But `masterOff` rides in the same object, so a transient provider fault
discards the **safety** control along with the **availability** controls.

### The filed mitigation is FALSE, and that is the substance of this ADR

`HBC-1` records the hole as *"safe only while `OPENWOP_HEARTBEAT_DEFAULT_MS=0`"*, and
proposes as one remedy *"assert the env OFF-pin as an invariant so the brake can't be
revived by a config hiccup"*.

**Measured — that remedy does not work.** `effectiveHeartbeatIntervalMs` consults the env
only for members with no explicit cadence:

```ts
if (admin?.masterOff) return 0;          // gone when admin === null
const configured = entry.heartbeatIntervalMs ?? 0;
if (configured > 0) return configured;   // ← returns BEFORE the env is read
```

Probe, with the claimed mitigation in place (`OPENWOP_HEARTBEAT_DEFAULT_MS=0`):

```
BRAKE_HEALTHY      = 0       ← brake works while the provider is healthy
ON_FAULT_PER_AGENT = 60000   ← brake LOST on a throw; the agent keeps beating
ON_FAULT_ENV_ONLY  = 0       ← the env pin protects ONLY env-inheriting members
```

So the env pin protects exactly the members that were never the risk. **Any agent with an
explicit per-agent cadence resumes its autonomous loop during a config fault, regardless
of the env.** Setting a per-agent cadence is a first-class, route-reachable operation
(`routes/roster.ts:253`, validated at `:107-116`).

The `masterOff` docblock is therefore also wrong in the way that matters: it "overrides
per-agent cadence" only while the store is healthy. An operator reading that line would
reasonably believe the brake holds.

### Severity — and a reassurance of my own that was FALSE

This is the highest-severity shape in this feature: an **emergency control that fails
open**. It is not a data leak and it is not silent (the fault is logged), but the whole
point of a kill switch is that it holds precisely when things are going wrong — and a
storage hiccup is exactly "things going wrong".

**The first draft of this ADR said "the loop ships env-pinned OFF, so a default deployment
has no beating agents to revive." That is false, and it is false for the SAME reason the
tracker's mitigation is false — both of us assumed a pin nobody applied.** Measured:

| fact | value | evidence |
|---|---|---|
| fallback host cadence | **600_000 ms (10 min)** | `heartbeatService.ts:429` |
| `OPENWOP_HEARTBEAT_DEFAULT_MS` in deploy config | **set nowhere** | repo-wide grep; only docs/comments |
| roster entries default | `enabled: true` | `rosterService.ts:157` |
| daemon start | **unconditional** | `index.ts:935` — unlike the retention sweep 3 lines below, which IS env-gated |

`rosterService.ts:71` states it plainly: *"`OPENWOP_HEARTBEAT_DEFAULT_MS`, default 10 min
— the daemon DOES run it."*

So the brake's failure mode does not return the fleet to 0. **It returns the fleet to a
10-minute cadence, in the default configuration.** The scenario is: an operator hits the
emergency brake on a beating fleet → the config store hiccups → the brake silently
releases and the fleet resumes.

**Blocker-candidate**, and the qualifier is only that it needs a provider fault to be
reachable — not that the deployment is safe by default. It is not.

## Decision

### D1 — Fail open on CADENCE, fail closed on the BRAKE

A transient provider fault keeps ADR 0318's availability posture for everything that is
about *how often* the loop runs, and preserves the one control that is about *whether it
runs at all*.

**The cache holds the SETTINGS, and the window is RE-DERIVED at fault time.** This is the
correction that matters most: an earlier draft cached the resolved `masterOff` boolean,
and that is wrong because `masterOff` is **time-derived**, not stored —
`masterOff = !(cfg.status === 'on' && !elapsed)` with `elapsed = now >= windowAtMs`
(`features/heartbeat-admin/service.ts:43-58`). Caching the boolean pins a time decision in
BOTH unsafe directions:

- the auto-disable window elapses *during* a fault → a cached `masterOff:false` would
  **never apply the window brake** — silently disabling the very control this ADR exists
  to protect;
- the operator re-opens the window during a fault → a cached `masterOff:true` would keep
  the fleet dead with no way to revive it.

So the seam caches the last successfully-read `HeartbeatAdminConfig` and, on a provider
throw, re-runs the existing `resolveWindow(cfg, now)` — the SAME resolver `resolveForCore`
and `getView` already share, so the fault path cannot drift from the healthy path. From
that re-derivation it returns a config that:

- **preserves the brake** — an explicit `status:'off'`, or a window that has now elapsed,
  both still produce `masterOff:true` through the fault;
- **drops the cadence override** (`hostDefaultIntervalMs → null`), which still inherits the
  env exactly as today;
- **keeps the TIGHTER run budget** (see below).

**`runBudgetPerHour` is a SAFETY bound, and classifying it as availability was an error in
the first draft.** It overrides the per-tenant autonomous-run cap, whose env default is
**120 runs/hour** (`runBudgetService.ts:37-44`). An operator who tightens it to 5/hour is
applying a spend control; dropping it on a fault restores 120 — a **24× loosening under
fault**, which is the identical "a stated bound evaporates" defect as ADR 0707 and as the
brake this ADR is fixing. On a fault the budget therefore fails to the **tighter** of
{cached admin limit, env default}. Note `<= 0 ⇒ unlimited`, so "tighter" is not a naive
`Math.min` — unlimited must lose to any finite cap.

This is deliberately asymmetric, and the asymmetry is the decision: **a control that fails
open is not a control**, whereas a cadence override that fails to the env is merely a
deployment running at its default speed.

When there is no last-known-good state (a fault on the very first resolution, before any
successful read), the result is `null` — today's behaviour. Only NON-null successes are
cached, so an operator who has never saved a config is unaffected: `resolveForCore`
returns `null` on success in that case too. **This ADR does not invent a brake that was
never set.**

Two equivalences the implementation must keep, both pinned by tests because they are easy
to break silently:

- `{masterOff:false, hostDefaultIntervalMs:null, runBudgetPerHour:null}` must behave
  identically to `admin === null` at BOTH consumers — `effectiveHeartbeatIntervalMs:501`
  and the budget selection at `heartbeatService.ts:560`, where `null` and absent both
  yield `undefined`. Verified equivalent today; a test keeps it so.
- The admin **GET** (`getView`) reads the store directly and is deliberately NOT served
  from this cache. During a fault it therefore shows the SAVED config while the core
  enforces the last-known-good one. That is the intended split — *saved* vs *enforced* —
  and is called out here so it is not mistaken for two sources of truth.

### D2 — Correct the `masterOff` docblock

The type says it "overrides per-agent cadence" full stop. After D1 that is true across a
transient fault; the docblock records the fault behaviour explicitly so the next reader
does not have to re-derive it.

## Alternatives weighed

- **Assert the env OFF-pin as an invariant** (`HBC-1`'s own suggestion). **Rejected on
  measurement** — proved above not to cover per-agent cadences, which is the reachable
  case. Recorded because a plausible-sounding prescription that does not close the hole is
  worth naming.
- **Cache the resolved `masterOff` boolean** (this ADR's own first draft). **Rejected on
  measurement** — `masterOff` is time-derived, so caching it pins a stale window decision
  in both directions, including silently never applying the auto-disable brake. Recorded
  because it is the intuitive design and it is wrong.
- **Cache the WHOLE resolved config.** Rejected: it would also preserve a stale
  `hostDefaultIntervalMs`, silently running the fleet at a cadence the store no longer
  says, and it reverses ADR 0318's availability call for no safety gain.
- **Fail CLOSED entirely (treat a fault as masterOff).** Rejected: it hands any storage
  hiccup a fleet-wide kill, which is exactly the wedge ADR 0318 refused. It would also be
  a silent behaviour change for deployments that never set a brake at all.

## Not in scope

- **`HBC-2`** (the `FEATURES.md` descriptor says `/heartbeat-admin/*` while the code uses
  `/heartbeat/settings`) — a real doc/route mismatch, fixed here since it is one line and
  in the same feature.
- **`HBU-1`** — a live keyboard/disabled-state check static analysis cannot perform.
