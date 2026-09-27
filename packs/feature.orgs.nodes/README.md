# feature.orgs.nodes

Org-invitation nodes over `ctx.features.orgs` (ADR 0622 D2). One side-effect
node and two action/read nodes; `invite` is served its recorded outcome on a
replay/fork.

| typeId | role | what it does |
|---|---|---|
| `feature.orgs.nodes.invite` | `side-effect` | Mints an email-token invitation into the run's workspace root (or `orgId`) and delivers the accept link through the ACTING USER's brokered email connection (send-once per `inviteId`). Emits `host.orgs.invitation.created` (with the run's `origin`). Outputs `{ inviteId, orgId, delivery }` — never the token. |
| `feature.orgs.nodes.list-invitations` | `read` | `{ inviteId, role, status, expiresAt }[]` for the org — never the recipient email. |
| `feature.orgs.nodes.revoke-invitation` | `action` (+ `side-effectful`) | Deletes one invitation (row, then index); the emailed link stops resolving. Emits nothing — `host.orgs.invitation.revoked` is the admin route's (one site). |

## Authority (all in the host surface, none in the node)

1. The run MUST carry an acting user (`ctx.actingUserId`, ADR 0024 §4). A
   system run — schedule, inbound webhook, or a **host-event-started** run —
   has none and is refused `403 forbidden_scope` with `reason: no_acting_user`.
   That is by design twice over: the scope cannot be checked, and delivery
   brokers the ACTOR's own email connection, so there is nobody's mailbox to
   send from.
2. The acting user must be `active` (the ADR 0621 session authority). A
   bearer-started run's `actingUserId` is a principalId, resolves to nothing
   here, and is refused `acting_user_erased`.
3. The acting user must hold `host:members:manage` in the TARGET org — the
   same `assertOrgScope` predicate `orgs/routes.ts` `requireMemberManage`
   wraps. `orgId` defaults to the run's workspace root (`orgId === tenantId`);
   a manager of org A cannot invite into org B, and a foreign/unknown org is a
   uniform `404`. The personal-owner short-circuit fires only for a
   `user:`/`anon:`-shaped tenant (USERS-19); the act-as header never reaches
   this lane.
4. `invite` needs `OPENWOP_PUBLIC_BASE_URL` on the host for the accept link —
   a run has no request to derive it from. Unset ⇒ `501 capability_not_provided`
   with `reason: no_public_base_url`, never a relative link.
5. Delivery is decided by the ONE composition owner
   (`invitationsService.createInvitationAndDeliver`, ADR 0622 D5): the invite
   is minted WITHOUT replacing a prior live invite for the same (org, email);
   on `sent` the prior row is superseded; on a skipped/failed send the NEW row
   is rolled back, the prior invite stays valid, and the node fails TYPED
   (`422 undeliverable` / `delivery_failed`) — never success over a zombie row.

## Where values come from

`inputs.<key>` (an edge-delivered value) → `config.<key>` (the chain parameter,
e.g. `{{params.newHireEmail}}` frozen at instantiation — RFC 0013 Path A). An
empty `email`/`inviteId` is a typed `validation_error`. Nothing is read from
`triggerData`: the `host.orgs.invitation.*` payloads carry no email by design.

## Self-trigger guard

`invite` emits with `origin: { runId, workflowId, chainId }`; the host-event
dispatcher skips any binding whose `workflowId` equals the emitting run's AND
any binding whose workflow was expanded from the same chain (ADR 0617 D1a +
its review correction), so a chain bound to `host.orgs.invitation.created`
cannot restart itself — or a sibling instance minted for another hire — from
its own invite step.

## The consumer at landing

`people-hr.onboarding` (`examples/workflow-chain-packs/people-hr`) `invite-host`:
behind the `approve` gate via ONE `{truthy approved}` edge, feeding the `track`
fan-in on its own port (`invite-host → track.inviteHost`); `newHireEmail` is a
required chain parameter. See that pack's README for the two recipes
(human-started onboarding, and an ids-only `invitation.accepted`-bound chain).
