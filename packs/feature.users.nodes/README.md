# feature.users.nodes

Host-account lifecycle nodes over `ctx.features.users` (ADR 0617 D2). Two
side-effect nodes; both are served their recorded outcome on a replay/fork.

| typeId | role | what it does |
|---|---|---|
| `feature.users.nodes.deactivate` | `side-effect` | Disables one durable account in the run's tenant (status → `disabled`, live sessions end — ADR 0621). Emits `host.users.user.deactivated` (`reason: workflow`) on the transition only. |
| `feature.users.nodes.reactivate` | `side-effect` | Re-enables one disabled account (status → `active`; old sessions stay dead). Emits `host.users.user.reactivated` on the transition only. |

## Authority (all in the host surface, none in the node)

1. The run MUST carry an acting user (`ctx.actingUserId`, ADR 0024 §4). A
   system run — schedule, inbound webhook, or a **host-event-started** run —
   has none and is refused `403 forbidden_scope` with `reason:
   no_acting_user`. That is by design: on the SCIM-leaver lane the account is
   already disabled at the identity write; this node is for the human-started
   lane.
2. The acting user must be `active` (the ADR 0621 session authority).
3. The acting user must hold `host:members:manage` in the run's tenant — the
   same `assertTenantScope` predicate the `/users` admin routes use. A `*`
   operator's run and a SAML/deployment-tenant "personal" claim do not
   short-circuit it.
4. The target must be in the run's tenant (uniform `not_found`).
5. `deactivate` refuses the acting user's own row (`409 self_lockout`).

## Where `userId` comes from

`inputs.userId` → `triggerData.payload.userId` (ONLY when
`triggerData.eventName` is a `host.users.user.*` event — the event that started
the run; a manual run's `inputs.payload` is never honoured, since the executor
mirrors `run.inputs` into `triggerData` on the manual lane and no schema
declares that input — 1.0.1) → `config.userId` (`{{params.userId}}`). An empty
result is a typed `validation_error`.

## Self-trigger guard

The emit carries `origin: { runId, workflowId, chainId }`; the host-event
dispatcher skips any binding whose `workflowId` equals the emitting run's AND
any binding whose workflow was expanded from the same chain (`chainId`), so a
chain bound to `host.users.user.deactivated` cannot restart itself — or a
sibling instance of itself minted for another employee — from its own
deprovision step (ADR 0617 D1a + its review correction).
