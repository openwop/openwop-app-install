# core.openwop.workflows.people-hr

The People / HR cluster (RFC 0013, ADR 0149): **Employee Onboarding
Orchestrator** (`people-hr.onboarding`), **Offboarding & Access Revocation**
(`people-hr.offboarding`) and **Leave / PTO Request Routing**
(`people-hr.pto-routing`). Every account/HRIS mutation and every team-facing
send sits behind a `core.chat.approvalGate`; every tenant-specific value is a
run parameter (replay-deterministic).

## `people-hr.onboarding` — invite the new hire into THIS workspace (ADR 0622 D3)

`people-hr.onboarding` **1.1.0** provisions a new hire everywhere it used to
(M365 `createUser`, HRIS `create-worker`, ticketing) AND — behind the SAME
`approve` gate, via exactly ONE `{truthy approved}` edge — invites them into
this workspace: `invite-host` (`feature.orgs.nodes.invite`) mints an
email-token invitation and delivers the accept link through the approving
admin's own brokered email connection, then joins the provisioning fan-in on
its own port (`invite-host → track.inviteHost`) so `notify` stays the sole
primary terminal.

### Recipe (human-started lane)

1. Prerequisites, once per host/workspace: `OPENWOP_PUBLIC_BASE_URL` set on
   the host (the accept link has no request to derive it from in a run);
   Access & data → Email: a sender address for the workspace; Access & data →
   Connections: the approving admin's transactional-email connection
   (SendGrid/…). The `orgs` toggle ON for the workspace.
2. Builder gallery → *Employee Onboarding Orchestrator* → **Use**; fill
   `newHireName` and **`newHireEmail`** (required — frozen into this instance,
   one instance per hire) and optionally `orgId` (empty ⇒ the workspace root).
3. Run it as a workspace admin (`host:members:manage` in the target org). The
   plan runs; the approval gate is the human decision; on approve the three
   provisioners AND `invite-host` fire in parallel; on reject none of them do.
   `invite-host` outputs `{ inviteId, orgId, delivery }` — never the token.

What `invite-host` refuses, typed (never `success` over a dead row): a system
run (no acting user), a disabled/erased actor, an actor without
`host:members:manage` in the org, an unknown/foreign org (uniform 404), a
missing `OPENWOP_PUBLIC_BASE_URL`, and an undeliverable invite (rolled back —
the run never echoes the token, so a skipped delivery would be a zombie row).
A `:fork` is served the recorded outcome (a re-mint would kill the emailed link).

**A refusal fails the whole run — after the other provisioners already ran.**
`track` is an `all_success` fan-in (the executor's default trigger rule), so a
typed refusal from `invite-host` (no `OPENWOP_PUBLIC_BASE_URL`, an undeliverable
invite, a disabled/erased/unbound acting user) marks the run **failed** even
though `itProvision`, `hris` and `tickets` have already
provisioned in parallel (side effects are not rolled back). A re-run
re-provisions all of them. So **before starting the run, confirm the
prerequisites in step 1** — the public base URL is set and the approving admin
has a connected email sender — rather than discovering it from a failed run.
(ADR 0622 D3 records this consequence; a fan-in rule that tolerates a failed
invite is a chain-format change, not a wiring one.)

### Recipe (event lane — a DIFFERENT, ids-only chain)

Do **not** bind `host.orgs.invitation.accepted` to THIS chain — its identity
comes from frozen parameters (the `UAUWF-7` lesson above). The event exists
and is bindable to any chain whose identity does NOT: e.g. a welcome chain
`core.trigger.event` (`host.orgs.invitation.accepted`
`{ inviteId, orgId, tenantId, memberId, userId, role, alreadyMember }`) →
`feature.notifications.nodes.notify` "a new member joined". The payload never
carries the email; a chain that needs the person's details reads them by id
under its own authority. `invite-host`'s own `created` emit carries the run's
`origin` (workflow + chain lineage), so a binding on `created` can never
restart this chain or a sibling instance from its own invite step.

### Registry

`core.openwop.workflows.people-hr` **1.4.0** / chain `people-hr.onboarding`
**1.1.0** — a registry republish is owed (the vendored copy is what this
checkout loads).

## `people-hr.offboarding` — the two lanes (ADR 0617 D3, corrected by review 2026-09-02)

> **REVIEW CORRECTION (2026-09-02, ADR 0617 review BLOCKER-1).** The recipe
> that used to sit here said "instantiate once, bind `host.users.user.deactivated`
> to it". **That recipe would run another employee's offboarding.** This chain's
> parameters identify a PERSON: `employeeName` is `required`, and
> `finalPay.config.workerName = {{params.employeeName}}` (the Workday
> `terminate-worker` action) is RFC 0013 Path-A **frozen at instantiation** —
> the expansion id folds the params in, so the product shape is ONE from-chain
> instance PER departing employee (`workflowId = chainId:expansionId`). The
> host-event dispatcher passes an event's payload as `triggerData` only; it
> forwards no run inputs. A binding on the instance minted for Alice would
> therefore start a run for EVERY later leaver whose `finalPay` fires with
> Alice's frozen name — and `finalPay`, `deprovision` and `accessTickets` are
> UNGATED entry nodes that fire on any run of the instance, event or manual.
> The event lane is **unbound as shipped**; see `UAUWF-7` below.

The chain has **two lanes** that share one graph. Only the first is shipped
as safe to use:

| Lane | Status | How it starts | Who is the acting user | What `deprovision-host` does |
|---|---|---|---|---|
| **Human-started** | **SHIPPED** | An HR admin instantiates the chain **for one employee** (Builder gallery → *Offboarding & Access Revocation* → **Use**, supplying `employeeName` and the host `userId` from Access & data → Users) and runs THAT instance from the gallery / `/` picker. | The admin (stamped at creation, survives `:fork`). | Disables THIS host's account **after** the compliance attestation approves — one `{truthy approved}` edge from `attest`. Requires `host:members:manage` in the run's tenant (the same predicate as the Users admin page); refuses the admin's own row. |
| **SCIM leaver (event)** | **NOT SAFE TO BIND — `UAUWF-7`** | The IdP deactivates the user; the host emits `host.users.user.deactivated` `{ userId, tenantId, source, reason:'scim' }`. The event exists and IS bindable — but **do not bind it to this chain as shipped**: its parameters are frozen per instance (see the correction above), so a bound instance would run its frozen employee's `finalPay` / `deprovision` / `accessTickets` for whoever left. | nobody — an event-started run is a SYSTEM run (no `actingUserId`). | Would fail closed (`403 forbidden_scope`, `reason: no_acting_user`) by design; the entry nodes ahead of it would NOT. |

### Recipe (human-started lane)

1. Access & data → Users: note the departing employee's host `userId`
   (`user:<id>`).
2. Builder gallery → *Offboarding & Access Revocation* → **Use**; fill
   `employeeName`, `userId`, and the ticketing params. This mints a
   tenant-owned, builder-editable instance for THIS employee.
3. Run it. The connector steps and the handoff draft run first; the
   compliance attestation (`attest`) is the human gate; on approval
   `deprovision-host` disables the host account and `notify` confirms.

Do **not** add a Settings → Event Bindings row for `host.users.user.deactivated`
→ this chain. `host.users.user.{provisioned,deactivated,reactivated,erased}` are
still bindable to any workflow whose identity does NOT come from frozen
parameters (an audit-log chain, a notify-only chain, …).

### Why the trigger root and `deprovision-host` stay in the graph

`trigger` (`core.trigger.event` on `host.users.user.deactivated`) is the sole
root and `deprovision-host` sits behind `attest`. Both are correct for the
future event lane and harmless on the manual lane (the witness in
`workflow-chain-people-hr-offboarding-host.test.ts`: `core.trigger.event`
passes through with `payload: null` on a manual run, and the node reads the
frozen `userId` param). The ungated entry nodes are ADR 0200's "revoke fast,
then attest" shape — correct by design for a per-employee instance, and
precisely why the event lane must not be bound to one.

### `UAUWF-7` — what the event lane needs (follow-on, not in this pack)

A **deferred** instance whose employee identity comes from the EVENT, not from
a frozen param: a `feature.users.nodes.get` read node (userId → the display
fields the connector steps need) plus dispatcher `triggerData.payload → inputs`
forwarding on the RFC 0013 deferred lane. Filed in
`docs/steward/WORKFLOWS-ASSESSMENT.md` § Users & Authentication (2026-09-01)
gaps; effort M.

### Why the host step cannot restart the chain — or a sibling instance

`deprovision-host` emits `host.users.user.deactivated` (`reason:'workflow'`)
with the run's `origin: { runId, workflowId, chainId }`. The host-event
dispatcher skips any binding whose `workflowId` equals the emitting run's
(ADR 0617 D1a) AND any binding whose workflow was expanded from the same chain
(the review correction — one instance per employee means the instance-id
compare alone could not see a sibling), so a human-started run produces exactly
ONE run of this chain family. The event still reaches webhooks and any
unrelated bound workflow.

### Parameters

`userId` is optional. On the manual lane the node reads the frozen
`{{params.userId}}` config; `triggerData.payload.userId` is honoured ONLY when
the run was started by a `host.users.user.*` event (`feature.users.nodes`
1.0.1 — a manual run's `inputs.payload` can no longer retarget it). An empty id
is a typed `validation_error`, never a silent success.

### Registry

`core.openwop.workflows.people-hr` **1.4.0** (was 1.3.0 for the offboarding
rewire) / chain `people-hr.offboarding` **1.1.0**. A registry republish is required for hosts that install from the
registry (the `chain-pack-fix-needs-registry-republish` lesson) — the vendored
copy under `examples/workflow-chain-packs/` is what this checkout loads.
