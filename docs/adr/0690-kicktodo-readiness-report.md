# ADR 0690 — the KickTodo readiness report: a route existing is not enough

Status: Accepted (implemented; see § Implementation record)

## Context

PRD §8.2 promised `GET /v1/host/openwop-app/kicktodo/readiness`, a host-private
operator route deriving status "from the included feature registry, actual
provider readiness, and the same capability sources used by discovery", and it
listed what Wave 1 activation requires: scheduler persistence *operational* ("a
route existing is not enough"), packs loaded at their pinned versions, a working
provider with budget enforcement, and for the Factory a real web-search adapter.
Production answered 404; no route existed in source.

What it cost, measured on kicktodo.com in the week of 2026-09-08, all found by
hand, each by a different session:

| gap | how it was found |
| --- | --- |
| the nine `kicktodo-*` toggles ON only as per-tenant overrides, so auto-join resolved OFF for every stranger | a live stranger sign-in, then a retraction |
| the default org provisioned with `tenantId: host:kicktodo` against a corrected declaration of `host-kicktodo` — provisioned, joined, and not a workspace | three sessions and an ADR correction |
| `webSearch.configured: false` — the Factory's evidence gate cannot pass | reading `/readiness` and knowing what the line meant |
| blob surface in memory across five instances | reading the Cloud Run env by hand |
| no minimum instance, CPU throttled — the daemon that fires every reminder starved | reading DEPLOY.md's incident |

Every one of these is a boolean this host already knows. Nothing asked.

## Decision

**`GET /kicktodo/readiness` returns one report, superadmin-gated, NOT
toggle-gated, same envelope on 200 and 503.** A report that 404s when the feature
is off cannot say the feature is off; a report whose 503 body differs from its
200 body cannot be read by one smoke script (the `/readiness` precedent).

**`status` is the conjunction of what blocks a participant loop; `blockers`
names each, in the order a stranger hits it:**

1. every declared default workspace is provisioned AND enterable — the org row
   exists and `isWorkspaceOrg(org) && org.tenantId === declared`;
2. `kicktodo-core` resolves ON *where the default workspace lives* — the
   auto-join gate's view, not the caller's;
3. every `feature.kicktodo.*` pin is present (`installed` or `mounted`);
4. the managed provider is ready;
5. the schedule daemon has started on this instance and its last tick is not
   stale (four poll intervals);
6. storage round-trips.

**Reported, never gating `status`:** web search, the surface implementations and
the in-memory allowance, `kicktodo-creator` where the default lives. They fold
into `checks.factory.ready` with their own reasons — a host running the loop
without the Factory is genuinely healthy.

**Liveness is a real signal.** `scheduleDaemonLiveness()` exposes
`startedAt` / `lastTickAt` / `ageMs` from the daemon itself. A started daemon whose
last tick is minutes old is the CPU-throttled, scale-to-zero shape; the report
says "starved", not "running".

**Toggles resolved in three scopes per feature:** `global`, `callerTenant`, and
`defaultWorkspace`. The third is what made the September override mistake
visible as a field instead of a stranger's 403.

## Alternatives considered

- **Fold into `/readiness`.** Rejected: the host readiness is product-agnostic
  and gates deploy verification; a KickTodo-specific 503 there would fail every
  deploy of every other distribution.
- **Gate on `requireKicktodoManage`.** Rejected: it runs the toggle gate first and
  404s when the feature is off — the report's own first finding would be
  unreadable. Superadmin is the operator surface the toggles console already uses.
- **A capability advert.** Rejected by the PRD itself: "it is not a new OpenWOP
  capability". Host-local, non-normative, no RFC.

## Consequences

- One curl answers "can a stranger enroll here today?" and "can the Factory
  publish here today?" with named reasons.
- The route reads the declared defaults through a new host getter
  (`declaredDefaultWorkspaceTargets`) rather than importing the feature index —
  no `feature → features/index` cycle.
- The daemon gains two module-level timestamps. One daemon per process, so this
  is the honest scope.

## Implementation record

- `kicktodo-core/readinessService.ts` (`buildKicktodoReadiness`,
  `KICKTODO_FEATURE_IDS`), route in `kicktodo-core/routes.ts`.
- `host/scheduleDaemon.ts` `scheduleDaemonLiveness()`;
  `host/workspaceJoinLedger.ts` `declaredDefaultWorkspaceTargets()`.
- Tests: `test/kicktodo-readiness.test.ts` — the pre-correction org shape reads
  provisioned-but-not-enterable; the corrected shape reads enterable; a
  caller-tenant override does not light the default workspace; a missing pin
  blocks and a present one does not; the daemon must have ticked; web search and
  blob fold into `factory.ready` only.
