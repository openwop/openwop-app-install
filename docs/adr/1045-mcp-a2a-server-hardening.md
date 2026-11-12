# ADR 1045 — MCP and A2A server hardening

Status: Accepted (David, 2026-11-03: "do the full implementation of all of these features in waves")

Phase P6 of [ADR 1041](1041-all-surfaces-channels-program.md) (D3 security floor,
D4 off by default). Tracker items `CHAN-P6-1` … `CHAN-P6-4`.

## Context

The MCP server mount (`POST /host/openwop-app/mcp`, RFC 0020 / RFC 0153, ADR 0553
and ADR 0788) and the A2A server (`POST /host/openwop-app/a2a` and
`/.well-known/agent-card.json`, RFC 0076 / RFC 0100 / RFC 0152, ADR 0035 and
ADR 0552) are env-gated. ADR 1041 assumed both were off in production and made
"production enable" the user's decision after this phase.

> **CORRECTED 2026-11-03, before merge: both servers are ON in production.**
> Read-only, `gcloud run services describe openwop-app-backend` (revision
> `01134-vgc`): `OPENWOP_A2A_SERVER_ENABLED=true`, `OPENWOP_A2A_DURABLE_TASKS=true`,
> `OPENWOP_MCP_SERVER_ENABLED=true`, `OPENWOP_ANON_ACTOR_ENABLED` unset. The live
> discovery note is the "server + DURABLE Tasks" variant. An anonymous POST to
> `/api/v2/host/openwop-app/a2a` answers 401, so anonymous callers were already
> refused there. Any signed-in principal of any tenant reached the server. The
> earlier audit read only `deploy.env` and `DEPLOY.md`, and the flags were set on
> the service directly. So D1–D4 and D6 below fix defects that are LIVE: the
> shared 0.3 task id and the id-only seam reads are cross-tenant in production
> today, and the push residual in D6 is live too. This ship is a security fix to a
> running service, not a hardening step before an enable.

A read-only audit of `main` (`c1f72df8d`, 2026-11-03) found:

1. **A2A identity.** The A2A route took `req.tenantId ?? 'default'` as the tenant
   and `req.principal?.principalId ?? 'anon'` as the peer. It never asked
   whether the caller was authenticated. In the cookie posture the auth
   middleware mints an `anon:<sid>` principal for a credential-less caller, so an
   unauthenticated POST reached the server. That is the exact defect RFC 0153 §E
   found on the MCP mount on 2026-08-17 (H43).
2. **A2A rate limit.** None beyond the per-IP floor. MCP has a per-principal
   budget on its run-starting methods (ADR 0087 / ADR 0788 D4).
3. **A2A cross-tenant writes on the 0.3 codec.** `message/send` derived the task
   id `a2a:<agentId>`, the same for every tenant, and read the existing record
   by id without the tenant check. Tenant B's send overwrote tenant A's task
   and carried A's push config forward, so B's task transitions were pushed to
   A's URL. A peer-supplied `params.id` could resume into any tenant's task.
4. **A2A conformance seams without a tenant.** `GET …/a2a/tasks/:taskId` and
   `POST …/a2a/tasks/push-config` read and wrote by id alone, and
   `POST …/a2a/tasks/start` wrote an unbound record. These seams are served
   whenever durable tasks are on, not only behind the test seam.
5. **Four `ctx.a2a` server-side stubs** (`host/a2aSurface.ts`):
   `publishAgentCard` stored the card in process memory (lost on restart, not
   shared between instances) and the live server served it on the 0.3 card;
   `emitStatus` and `emitArtifact` were no-ops that reported success;
   `pushSend` always answered `delivered: false`. With the server on, the
   `host.a2a` surface note dropped the "demo stub" caveat, so the advertisement
   claimed more than the host did.
6. **MCP audit tenant.** Audit rows for refusals were stamped
   `principal.tenants[0]`, which is `*` for a wildcard operator key, while every
   MCP decision is made in `mcpCallerFor(req).tenantId` (`tenantOf(req)`,
   `default` for that key).
7. **MCP mount warning.** The boot log said "NEVER enable in production without
   auth review". No review was recorded.

## Decisions

### D1. The A2A server refuses unauthenticated and anonymous callers (CHAN-P6-1)

One resolver, `resolveA2aCaller(req)` (`host/a2aCaller.ts`), runs before the
body is dispatched on every A2A server route (the JSON-RPC endpoint and the
durable-task seams):

- No principal: `401 unauthenticated`. Never a JSON-RPC frame, so an
  unauthenticated caller learns nothing about the methods served.
- An anonymous principal (`req.anonymousPrincipal`, the cookie posture's minted
  `anon:<sid>`): `401 unauthenticated`, `details.reason:
  anonymous_principal_refused`, unless the host advertises `anonymousActor`
  (RFC 0132). This mirrors the MCP mount (RFC 0153 §E). The A2A server has no
  test-seam exception: every in-repo caller authenticates with a bearer.
- The tenant is `req.tenantId` when the auth middleware set it, which it does
  for every scoped lane. A wildcard operator key (`tenants: ['*']`) leaves it
  unset by design, and the tenant is then `default`: the operator posture
  `tenantOf(req)` already defines and `POST /workflows` and the MCP mount
  (`mcpCallerFor`) already use. Any other principal with no tenant is refused
  `403`. There is no `'default'` fallback for a non-wildcard caller and no
  `'anon'` principal id: the principal id is always the authenticated one.

The public `GET /.well-known/agent-card.json` stays unauthenticated (A2A
discovery, RFC 0076 / RFC 0202). After D3 it serves only the host card, which
names no tenant, so it needs no tenant.

### D2. A per-principal A2A rate limit (CHAN-P6-2)

`enforceA2aPrincipalRateLimit` (`middleware/rateLimit.ts`), the same sliding
60-second window and canonical `429 rate_limited` envelope as the MCP limiter,
with its own bucket and reason `a2a_principal_rate` (scope `tenant`). Budget
`OPENWOP_A2A_PRINCIPAL_REQS_PER_MIN`, default 60, `0` disables. It applies to
the methods that start work: 0.3 `message/send`, 1.0 `SendMessage` and
`SendStreamingMessage`. Reads stay on the per-IP floor, as on MCP. The bucket is
keyed on tenant and principal, so one principal id in two workspaces does not
share a budget.

### D3. The four `ctx.a2a` server stubs are withdrawn, not implemented (CHAN-P6-3)

Each was weighed against what the wire contract requires. The honesty rule
decides each one.

| Stub | Decision | Why |
|---|---|---|
| `publishAgentCard` | **Withdrawn.** The method is removed from the surface, the in-memory card map is deleted, and both card routes serve only the host-synthesized card. | `a2a-integration.md` §C: "A skill absent from routing MUST NOT appear". The served card is generated from the routing SSoT (`a2aListedAgents()` for 0.3, `a2aInvocableWorkflowId()` for 1.0) so the card never claims what the router refuses. A workflow-authored card can claim skills, security schemes and capability flags (`streaming`, `pushNotifications`) the host does not honour. Persisting it durably would make that dishonest claim durable. RFC 0202 (Accepted) is the corpus's answer to per-agent cards and is generated, not authored. The `agent-card-publish` pack node already reports `published: false` when the method is absent. |
| `emitStatus` | **Withdrawn.** | A task's status is the forward projection of its run's status (`a2a-integration.md` §"State projection", RFC 0100 §2: "persists this table, it does not edit the mapping"). The 1.0 codec re-projects from the live run on every read (`refreshTaskFromRun`). A workflow writing arbitrary task state would fork the lifecycle the RFC forbids forking, and the next refresh would overwrite it. The pack node throws `host_capability_missing` when the method is absent: a typed failure instead of a success that did nothing. |
| `emitArtifact` | **Withdrawn.** | No served A2A operation carries a `TaskArtifactUpdateEvent` stream: `SendStreamingMessage` and `SubscribeToTask` answer the current task only and are unadvertised unless `OPENWOP_A2A_STREAMING=true`. An artifact event with no subscriber reaches nobody. Same typed failure from the pack node. |
| `pushSend` | **Withdrawn.** | Push is not a workflow-callable send. With durable tasks on, a push fires from the task store on each push-eligible transition (`upsertA2aTask` → the sink wired in `registerAllRoutes.ts` through the webhook egress guard, RFC 0100 §4). A `configId`-addressed send from inside a run has no contract (RFC 0214 binds the push credential to one destination and one purpose) and no caller. Same typed failure. |

The `host.a2a` surface note says the server-side methods are absent in both
postures.

### D4. A2A tenant isolation on the 0.3 codec and the seams

- 0.3 `message/send` derives `a2a:<agentId>:<tenant digest>`, a task id per
  tenant, and reads an existing record only through `getA2aTaskFor(…,
  'legacy')`. A peer-supplied id held by another tenant answers `-32001 task not
  found`, the same answer as a missing id (`a2a-integration.md` §E). A push
  config is carried forward only from a record the caller may read.
- The durable-task seams take the D1 caller, stamp `tenantId` and `principalId`
  on `tasks/start`, and read and write through `getA2aTaskFor(…, 'strict')`. A
  foreign task is `404`, the same as a missing one.

### D5. MCP audit rows carry the resolved tenant (CHAN-P6-4)

Both refusal audit rows on the mount use the tenant every other decision on the
request uses: `tenantOf(req)` for the anonymous refusal, which happens before
the caller is resolved, and `caller.tenantId` for the version refusal. They
never use `principal.tenants[0]`.

### D6. The auth review

Every method on both servers, as served after this ADR. "Shares the HTTP
predicate" means the same function the HTTP sibling route calls.

**MCP mount** `POST /host/openwop-app/mcp` (both codecs: legacy 2025 and
current 2026-07-28, ADR 0553):

| Method | Auth | Tenant source | Authorization predicate | Rate limit | Audit |
|---|---|---|---|---|---|
| any, no principal | refused `401` before parse | none | none | per-IP | structured log only (no tenant to write into, H53) |
| any, anonymous principal, `anonymousActor` not advertised | refused `401` | `tenantOf(req)` | none | per-IP | `mcp.decided` `unauthenticated` (D5) |
| any, unsupported `MCP-Protocol-Version` | refused | `caller.tenantId` | none | per-IP | `mcp.decided` `version_refused` (D5) |
| `initialize`, `ping`, `logging/setLevel`, `server/discover`, `completion/complete`, `resources/subscribe`, `resources/unsubscribe` | principal required | `caller.tenantId` | none needed: protocol housekeeping, no tenant data | per-IP | none (no decision) |
| `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list` | principal required | `caller.tenantId` | per entry `isToolAllowedWith`: workspace tools take `workspaceLaunch` (`requireWorkflowWrite` + the `runs:create` key narrowing, the predicates of `POST /workflows` and `POST /runs`); gated pack tools take `requiredScopeForTool`, the scope the RFC 0078 `/v1/tools` descriptor advertises (ADR 0601), resolved by `credentialScopesIn` | per-IP | none: a list is not a decision; refused entries are absent |
| `tools/call`, `resources/read`, `prompts/get` | principal required | `caller.tenantId` | the same per-entry predicate, re-checked at call time; workflow launch through `caller.resolveLaunch` (`resolveLaunchWorkflow`, the `POST /runs` resolver, feature gate included) | per-principal (ADR 0788 D4) on top of per-IP | `mcp.decided` per decision (ADR 0553 P3) and the run's own event log |
| `sampling/createMessage`, `elicitation/create` (legacy bridges) | principal required | `caller.tenantId` | bridge workflow resolved through the same launch path | per-principal + per-IP | run event log; inbound content `<UNTRUSTED>`-fenced |
| `GET` and `PATCH /host/openwop-app/mcp/exposure` (admin) | person required (no anon) | `tenantOf(req)` | `requireTenantScope` `workspace:read` / `host:mcp:manage`, the predicate of every workspace-settings route | per-IP read / write budgets | `mcp.exposure.updated` workspace audit row on PATCH |

Result: passes after D5. The `principal.tenants[0]` reads that remain in
`host/mcpServerRegistry.ts` (gated pack tools) equal `caller.tenantId` by
construction: every non-wildcard lane sets `tenants: [active]`
(`middleware/auth.ts`), and a wildcard principal is refused gated tools by
`isAnonymousPrincipal` before the read.

**A2A server** `POST /host/openwop-app/a2a`:

| Method | Auth | Tenant source | Authorization predicate | Rate limit | Audit |
|---|---|---|---|---|---|
| any, no principal or anonymous principal | refused `401` before dispatch (D1) | none | none | per-IP | structured log |
| any, unsupported `A2A-Version` | refused, `VersionNotSupportedError` | none read | none | per-IP | structured log + `openwop_a2a_requests` metric |
| 0.3 `agent/getCard`, 1.0 `GetExtendedAgentCard` | principal required | not read: host card only (D3) | none needed: the public GET serves the same card | per-IP | metric |
| 0.3 `message/send` | principal required | D1 caller | `runs:create` via `requireProtocolScope` (the `POST /runs` predicate); dispatch limited to `isA2aDispatchable` pack agents (ADR 0962 D8) | per-principal (D2) + per-IP | durable task record (tenant, principal) + metric |
| 1.0 `SendMessage`, `SendStreamingMessage` | principal required | D1 caller; `params.tenant` hint neutralized (§E) | `runs:create` (as above); the run starts through `startWorkflowRun` | per-principal (D2) + per-IP | the run's event log + task record + metric |
| 0.3 `tasks/get`, `tasks/resubscribe`; 1.0 `GetTask`, `ListTasks`, `SubscribeToTask` | principal required | D1 caller | `runs:read` (the `GET /runs/{id}` predicate); the record re-authorized against its tenant (`getA2aTaskFor`, strict at 1.0) | per-IP | metric |
| 1.0 `CancelTask` | principal required | D1 caller | `runs:cancel` (the `POST /runs/{id}/cancel` predicate) + tenant re-authorization | per-IP | the run's cancel events + metric |
| 0.3 `tasks/pushNotificationConfig/set`; 1.0 push-config operations | principal required | D1 caller | `webhooks:manage` for create and delete (a push config is a webhook egress registration, `interop.md`: "treats each push as a webhook egress", so it takes the `POST /webhooks` predicate); `runs:read` for get and list; tenant re-authorization; SSRF egress guard | per-IP | metric |
| seams `POST …/a2a/tasks/start`, `GET …/a2a/tasks/:id`, `POST …/a2a/tasks/push-config` | principal required (D1) | D1 caller | the same scope as the matching JSON-RPC method; strict tenant read (D4) | per-IP | none (conformance seams) |
| `GET /.well-known/agent-card.json` | public by design (discovery) | none | none: host card only, no tenant data (D3, RFC 0202 §D) | per-IP read | none |

Result: fails on `main` (items 1–5 of the Context), passes after D1–D4.

Audit residual, stated: an A2A decision writes no `mcp.decided`-style audit
chain row. Accepted run-starting calls are recorded by the run's own event log
and the durable task record (tenant + principal); refusals by the structured
log and the request metric. An A2A audit kind is a follow-up if the user wants
parity, not a precondition for enable.

Push residual, found in this review and NOT fixed here: with
`OPENWOP_A2A_DURABLE_TASKS=true` the host advertises `pushNotifications`, but
the push sink (`registerAllRoutes.ts` `a2a:pushSink`) sends no destination
credential (RFC 0214 §B, `a2a-push-delivery-authenticated`) and uses a fetch
that follows redirects (`interop.md`: "a `3xx` is a failed delivery").
Durable tasks are ON in production (see the correction in Context), so this
residual is live. Closing it is host work under the Accepted RFC 0214 (no new
RFC). Whether to turn `OPENWOP_A2A_DURABLE_TASKS` off until it closes is the
user's decision, tracked below.

> **UPDATED 2026-11-03 — the push residual is CLOSED in `380b95180`** (host
> work under the Accepted RFC 0214, no wire change). The sink is now
> `host/a2aPushDelivery.ts`. A delivery carries `Authorization: {scheme}
> {credentials}` from the registered 1.0 `authentication` (0.3: the first of
> `schemes`), or `Bearer <token>` when only `token` is set (RFC 0214 §C, a
> SHOULD). The credential is held only sealed (BYOK KMS envelope, AAD bound to
> the record's tenant and task), never returned, never logged, and dropped from
> the record once the task is terminal (§A). The original URL re-runs
> `assertPushUrlAllowed` and `assertEgressSchemeAllowed`, the dial uses the
> pinned `webhookEgressDispatcher()`, and `redirect: 'manual'` makes a 3xx a
> failed delivery (`a2a_push_delivery_failed`, reason `redirect`) that is never
> followed (§B). Two RFC 0214 obligations remain open on this host and are not
> part of this residual: the push body is still the 0.3 `TaskStatusUpdateEvent`
> as `application/json`, not a 1.0 `StreamResponse` as `application/a2a+json`
> (§C), and 1.0 Get/List/Delete push-config are still `UnsupportedOperation`, so
> discard-on-delete (§A) has no Delete to hang on. Neither is measured today:
> the v2 `a2a` record is withheld (`V2_PROJECT_A2A = false`), so the suite's
> `v2-a2a-push-delivery` rows are `inapplicable` here.
>
> > **CORRECTED 2026-11-10 (CHAN-F7) — both RFC 0214 obligations are now host
> > work done; the v2 `a2a` record stays withheld.** A config registered over 1.0
> > (`CreateTaskPushNotificationConfig`) is marked `protocol: '1.0'` and its pushes
> > carry a 1.0 `StreamResponse` (`{statusUpdate: <1.0 TaskStatusUpdateEvent>}`, no
> > `final`) as `application/a2a+json` (§C). A 0.3 registration
> > (`tasks/pushNotificationConfig/set`) keeps the 0.3 `TaskStatusUpdateEvent` as
> > `application/json`, which is what a 0.3 client parses. Each 1.0 config has an
> > id: the client's own when it is a plain token, else a random `pnc_` id that
> > encodes no tenant, workspace or principal. `GetTaskPushNotificationConfig`,
> > `ListTaskPushNotificationConfigs` and `DeleteTaskPushNotificationConfig` are
> > implemented: authorization of the task first, then the same `TASK_NOT_FOUND`
> > for an unknown task, a task the caller cannot read, or (Get) another config's
> > id; the credential is never returned; Delete is idempotent and takes the sealed
> > credential with the config, so no push follows a Delete (§A discard on delete).
> > This host still holds ONE config per task (a new Create replaces it), so List
> > has at most one entry. Projecting the v2 `a2a` record (`V2_PROJECT_A2A`) is a
> > separate decision this change does not make. Tests:
> > `adr1045-a2a-push-delivery.test.ts` (body and media type for both protocols;
> > the Get/List/Delete lifecycle and discard-on-delete) and `a2a-1-0-server.test.ts`.

### D7. The mount log tells the truth

The MCP mount's "NEVER enable in production without auth review" warning is
replaced by a log naming what the review established and what enable still
needs: an operator decision recorded in ADR 1041. This ADR changes no flag:
`deploy.env` and the live service's env are unchanged. Both servers were already
on in production when it shipped, so its fixes reach production with the deploy.

### D8. Operator doc

`DEPLOY.md` § "Optional: MCP and A2A servers (ADR 1045)" lists the flags for
each server and the checks to run after enable.

## Alternatives considered

- **Implement the four stubs.** Rejected per D3: each would either make a
  dishonest claim durable (`publishAgentCard`), fork the projected task
  lifecycle (`emitStatus`), emit to no subscriber (`emitArtifact`), or duplicate
  the store-driven push with no contract (`pushSend`).
- **Leave the stubs and add a note.** Rejected: a method that reports success
  for an action it did not take is a success-with-empty, which CLAUDE.md forbids
  regardless of the note.
- **A test-seam principal for A2A, like MCP's.** Rejected: no A2A test needs a
  credential-less caller, and a second named seam principal is one more
  authority to reason about.
- **Refuse wildcard operator keys on A2A.** Rejected: the conformance harness
  authenticates with one, and `default` is the documented operator tenant on
  every other route.
- **Rate-limit every A2A method per principal.** Rejected for parity with MCP
  (reads stay on the per-IP floor); the per-IP floor already bounds reads.

## Consequences

- A cookie-only anonymous visitor can no longer reach the A2A server. No
  in-repo caller did.
- 0.3 durable task ids change shape (`a2a:<agentId>:<digest>`). A 0.3 peer
  holding an old `a2a:<agentId>` id still reads it under the legacy arm when
  the row is unbound or its own.
- Workflows using `core.openwop.a2a` `emit-status`, `emit-artifact` or
  `push-send` now fail with `host_capability_missing` instead of reporting a
  success that did nothing. `agent-card-publish` reports `published: false`.
- Both servers stay on in production as they were. Any change to their flags
  remains the user's decision (ADR 1041).

> **Note on the plain storage form (security read of #5552).** `openPushAuthorization`
> still accepts the `PLAIN_PREFIX` form when KMS is configured. That is deliberate and
> safe: only storage can plant such a value, and an attacker who can write the task
> store already holds the credential. New writes never take the plain path in
> production: `sealPushAuthorization` writes plain only when `isKmsConfigured()` is
> false, and `bootstrapKmsFromEnv` (`byok/kmsEncryption.ts`) configures the KMS client
> at boot whenever `OPENWOP_BYOK_KMS_KEY` is set, which it is on `app.openwop.dev`
> (read from the live service 2026-11-03).

## Env-key principal collision (TST-FUD-GC-1, 2026-11-05)

**Defect.** `middleware/auth.ts` minted an operator env key's principal id as
`bearer:${key.slice(0, 8)}`. Two configured keys that share their first eight
characters (realistic: `openwop-…`, `sk-live-…`) were therefore one principal:

- one A2A per-principal budget inside a tenant (D2 keys on `tenant + principal`);
- one MCP per-principal budget across tenants (the MCP bucket has no tenant);
- indistinguishable audit rows (`mcp.decided`, run actors, every `principalId`
  audit field);
- worse, the operator-issuer check (`registerOperatorIssuerCheck`, read by
  `isConfiguredOperatorIssuer[For]` in `host/delegatedSubject.ts`) matched
  `key.slice(0, 8) === prefix` over ALL configured keys. After key A was
  removed, the `owk_` delegations A minted stayed OWNER (`viaDelegation`,
  `delegationIssuerIsLive`, `delegationIssuerScopes`) and A's run actors kept
  tenant-owner workflow scope (`hasWorkflowScope`) for as long as any key B
  shared A's prefix: a revocation bypass. The ADR 0822 WFAC-17 tenant binding
  was defeated the same way (B's tenant answered for A).

**Severity: MEDIUM.** Only an env key can mint a `bearer:` principal (checked:
the one writer is the env-key branch of `authMiddleware`; `owk_` keys are
`apikey:<id>`, sessions are `user:`/`oidc:`/`saml:`/`anon:`). So no
non-operator can obtain or forge the colliding identity, and this is not an
escalation for a member or an outsider. It is a confusion between operator
credentials: revocation of one env key not taking effect, a tenant-scoped key
borrowing a sibling's tenant binding, shared rate budgets, and an audit trail
that cannot say which key acted.

**Fix.**

- `middleware/envKeyPrincipal.ts` `envKeyPrincipalId(key)` = `bearer:` + the
  first 16 hex of SHA-256 over the full key. The auth middleware uses it; no
  other `src/` site derived `bearer:` from a key (grepped `slice(0, 8)` and
  `bearer:`). `host/index.ts`'s `sample-principal:${token.slice(0, 8)}` is the
  sample `identityResolver`, which nothing in `src/` calls
  (`resolveFromBearer` has no caller), so it was left alone.
- `isConfiguredEnvKeyIssuer(issuer, tenantId?)` replaces the prefix loop. A
  NEW-form issuer (`bearer:` + 16 lowercase hex) matches only the configured key
  whose `envKeyPrincipalId` it is, and with a tenant, only if that key is
  configured for the tenant or `*`. The lookup is an index built once per
  distinct key configuration (cached on the raw `OPENWOP_API_KEYS` /
  `OPENWOP_API_KEY` string, `apiKeyTenants.ts` `keyConfigSource`), so the
  per-request check never re-hashes every key; `readKeyTenants` itself is not
  cached and re-parses the env per call.
- **Tenant binding at the delegation readers (reviewer follow-up).**
  `viaDelegation`, `delegationIssuerIsLive` and `delegationIssuerScopes`
  (`host/accessControlService.ts`) asked the tenant-less
  `isConfiguredOperatorIssuer`, so a key re-scoped from tenant A to tenant B
  kept the delegations it minted in A as owner. All three now ask
  `isConfiguredOperatorIssuerFor(issuer, <the delegation's tenant>)`. Cheap and
  safe: an env key's request is pinned to its configured tenant (`*` keys act in
  `default`) and returns before any workspace switch, so every delegation an env
  key can mint lives in a tenant its configuration admits. Only a re-scoped key
  changes answer, which is the point. One existing test configured
  `<key>:ws:adr0795-op`; the last-colon split reads that as key `<key>:ws`,
  tenant `adr0795-op`, so an env key can never be configured for a `ws:` tenant
  at all. The test now uses `:*`, the only configuration that reaches one.

**Legacy compatibility rule.** Delegations (`ApiKeyRecord.createdBy`), run
actors (`metadata.actingUserId`) and scheduled jobs minted before this change
carry the legacy `bearer:<≤8 raw chars>` id. A legacy issuer matches ONLY when
EXACTLY ONE configured key has that raw prefix (tenant-bound: that one key must
be configured for the tenant or `*`). An ambiguous prefix fails CLOSED: with two
candidates there is no way to tell which key minted the record, and answering
yes for either is the defect itself.

**Known residual (corrected by the #5593 review, C1).** The legacy rule trusts
whichever configured key is the UNIQUE holder of a prefix, and nothing in a legacy
id says which key minted it. So it vouches for the wrong key in two cases, both
for as long as legacy-id records exist:

- two keys shared a prefix and one was removed before this change shipped: the
  survivor vouches for the removed key's records;
- **rotation with a same-prefix key**, at any time after this ships: replace key A
  with key C that starts with the same 8 characters (the normal `openwop-…`
  rotation pattern), and C becomes the unique holder. A's legacy-id records (its
  `owk_` delegations, run actors and scheduled-job actors) are then owner again in
  C's tenants. A rotation is supposed to retire exactly those.

This is operator-only: it needs an env key, which is already an operator
credential. Until it is cured, an operator who rotates env keys should revoke the
`owk_` keys whose issuer is a legacy `bearer:` id (`inventoryApiKeys`,
`issuerShape: operator`). **The cure is the user's decision:** a one-time rewrite
of every stored legacy `bearer:<8>` id to its key's new id (for prefixes unique
among the configured keys at rewrite time), then delete the legacy rule, so a
legacy id matches nothing.

> **UPDATED 2026-11-05.** Shipped in #5593, MERGED as 6c4e6bc36 (train 383) and
> LIVE in rev 01155-9w6, with the user's approval of the deploy consequences. The
> rewrite-then-delete cure above is still open as TODO `CHAN-F14`.
>
> **UPDATED 2026-11-10 (CHAN-F14, user decision "you build it and run it in
> prod") — the rewrite is built; the legacy rule is deleted only after it has
> run.** `host/legacyBearerIdRewrite.ts`, run as the background app job
> `legacy-bearer-id-rewrite` inside the deployed backend (it needs the configured
> keys, which nobody reads by hand). `OPENWOP_LEGACY_BEARER_REWRITE=report` logs
> the counts (`legacy_bearer_rewrite`) and writes nothing; `apply` rewrites and
> marks the job done when no row conflicted and nothing failed. Unset, it does
> nothing. Only prefixes exactly ONE configured key holds are mapped; an
> ambiguous prefix is counted and left.
>
> Rewritten: every string value equal to a mapped id in every registered
> `hostext:` collection and its `hostextidx:` markers (delegation `createdBy`,
> scheduled jobs and chats, owner-of-record fields), each row by compare-and-swap;
> org member subjects through `rekeyMemberSubject`; `actingUserId` of runs that
> carry an owner stamp. Left, and counted: audit-like collections (what was
> recorded stays recorded); run owner stamps, and `actingUserId` of UNSTAMPED runs,
> whose owner block derives from it and was echoed in the persisted `run.started`
> (a rewrite would make the snapshot disagree with the event log); object keys and
> row ids containing a legacy id; legacy ids no unique prefix accounts for. Ids are
> never logged: a legacy id is eight characters of a key.
>
> **The residual this cannot remove.** The rewrite attributes a legacy record to
> the unique holder of its prefix AT THE TIME OF THE RUN. A record minted by a key
> removed earlier, whose prefix a surviving key holds alone, is attributed to the
> survivor permanently. That is the ADR's own cure ("for prefixes unique among
> the configured keys at rewrite time"); the report's counts are what the operator
> reads before choosing `apply`.
>
> Order: merge, deploy, `report`, read the counts, `apply`, then a follow-up PR
> deletes the legacy branch of `isConfiguredEnvKeyIssuer` and removes the job.
> Test: `test/adr1045-legacy-bearer-rewrite.test.ts`.

**What a principal-id change does to stored state (inventory, nothing
rewritten).** The id an env key presents changes once, at deploy. Rotation
already changed it (ADR 0601), so no store treated it as permanent, but these
hold the old value:

| Store | Field | After deploy |
|---|---|---|
| Developer-key delegations | `ApiKeyRecord.createdBy` = issuer | **Works** through the legacy rule (unique prefix), tenant-bound. Ambiguous prefix: those keys lose operator standing (fail closed). The env key's self-service *list as mine / revoke / rotate* (`createdBy === callerSubject`) no longer matches its legacy keys unless it resolves as tenant admin/owner; the keys still authenticate. |
| Run actors | `metadata.actingUserId`, owner stamp | In-run writes (`hasWorkflowScope`, resumes, forks of old runs) **work** through the legacy rule. The RFC 0165 owner stamp (`opaquePrincipal(actingUserId)`) of old runs no longer equals the key's new projection: only "own runs" readers (`isRunOwnedBy`, `runPayloadAccess` in a membership-defined tenant) see a difference; tenant-gated run reads and mutations are unaffected. |
| Scheduled jobs / scheduled chats | `ownerUserId`, stored actor | Firing **works** (the actor reaches `hasWorkflowScope`, legacy rule). Owner-of-record management by the env key (`callerOwnerSpellings`) no longer matches; tenant-level arms still admit. |
| Org owner/member rows | `subject` (ADR 0910 D0: `POST /orgs` as an env key seeds the owner row with this id) | **Orphaned.** A member row keyed on the legacy id no longer matches the key. Gates that read `callerSubject` (org member management via `assertOrgScope`, webhooks `webhooks:manage`) stop granting that row's role to the key; lanes that read provenance (`credentialAuthority`: env key = tenant-owner) are unaffected. MEASURED: `adr0755-webhooks-target-tenant-scope` reddened exactly this way until its fixture was re-keyed. Not a security regression (it removes standing, never adds it), and D0 already treated such a row as an unintended seat. |
| Other owner-of-record rows | `ownerUserId` / `createdBy` stamped `req.userId ?? principalId` (chat sessions, conversations, approvals `decidedBy`, connections, …) | **Orphaned for owner match**, same shape as a rotation; tenant-scoped reads unaffected. Historical `decidedBy` / `createdBy` values stay as written (they are records). |
| Audit rows and audit filters | `principalId`, `mcp.decided.principal` | **Harmless.** Old rows keep the old id; new rows carry the new one. A filter for one key must name both ids for a period spanning the deploy. |
| Rate-limit state | MCP / A2A / api-key buckets | **Harmless.** In-memory per instance, reset by the deploy. The ADR 0771 env-key write bucket keys on its own 24-hex digest of the token and is unchanged. |
| MCP request-state tokens | claim `p` = principalId | Tokens in flight at deploy answer `principal_mismatch` once; the client re-requests. |
| Feature-toggle assignment | `userId` = principalId for MCP gating | An env key may land in a different variant bucket once. |

No migration or rewrite was written. Restoring owner-of-record and member-row
standing for legacy ids would need a one-time rewrite of `bearer:<8>` →
`envKeyPrincipalId(key)` (only for prefixes unique among configured keys); that
is a production data change and needs the user's approval. A broader alias
(matching legacy ids in member and owner lookups) was rejected: it re-introduces
prefix attribution in every RBAC read.

**Tests.** `test/adr1045-env-key-principal.test.ts` (9 cases, all keys share
the `sk-live-` prefix): distinct minted ids (read off the A2A task record the
real auth path wrote); separate A2A budgets in one tenant; separate MCP budgets
across tenants; distinct `mcp.decided` audit principals; new-form issuer matches
only its own key and tenant; removing A leaves A's id not operator although B
shares the prefix; legacy unique prefix matches and respects tenant binding;
legacy ambiguous prefix fails closed; a key re-scoped T1 → T2 stops vouching for
its T1 delegation at all three readers, and a `*` key still vouches.
`test/adr1045-a2a-server-hardening.test.ts`: its three keys all began
`adr1045-`, so its "per principal" budget leg was really per tenant; they are now
distinct in their first eight characters. Fixtures that spelled the old id were
moved to `envKeyPrincipalId` (`run-acting-user`, `auth-oidc`, `proposals`,
`assistant-feature`, `adr0942-p3-fork-waiter`, `adr0905-p2c`, `chat-export-*`,
`artifact-created-emission`, `channels-authz-route`,
`adr0822-workflow-author-authority`, `adr0755-webhooks-target-tenant-scope`).

**Sabotage witnesses** (each applied alone to the fixed tree, the new file run,
then restored by copying the saved file back and re-checked):

| # | Sabotage | Red in `adr1045-env-key-principal` |
|---|---|---|
| S1 | auth principal back to `bearer:${key.slice(0, 8)}` | 5 / 9: distinct ids, A2A budget, MCP budget, MCP audit, removal |
| S2 | legacy rule matches any candidate (`candidates.some(admits)`) | 1 / 9: ambiguous legacy fails closed |
| S3 | legacy rule drops the tenant binding | 1 / 9: legacy unique, tenant-bound |
| S4 | issuer check back to the old prefix loop | 4 / 9: new-form own key, removal, ambiguous legacy, re-scoped delegation |
| S5 | the three delegation readers back to tenant-less | 1 / 9 (re-scope case); each reader alone also reds it at its own assertion: `viaDelegation` (line 234), `delegationIssuerIsLive` (232), `delegationIssuerScopes` (233) |

## Implementation record

| Item | Change | Commit | Test (sabotage-witnessed) |
|---|---|---|---|
| ADR | this record | `996532944` | — |
| CHAN-P6-1 (D1, D6) | `host/a2aCaller.ts` (`resolveA2aCaller`, `authorizeA2aMethod`); `routes/agents.ts` | `c4447c433` | `test/adr1045-a2a-server-hardening.test.ts`: anon 401 (route + seam), anonymousActor admit, scoped tenant and principal, wildcard → `default`, owk `runs:read` key refused `runs:create` |
| CHAN-P6-2 (D2) | `enforceA2aPrincipalRateLimit` (`middleware/rateLimit.ts`) | `c4447c433` | same file: typed 429 `a2a_principal_rate`, reads unaffected, per principal |
| D4 | `host/a2aServer.ts` `derivedA2aTaskId` + tenant-checked resume; seams in `routes/agents.ts` | `c4447c433` | same file: per-tenant ids, B cannot get / resubscribe / push-config / resume A's task, A's record and push target untouched; seam GET and push-config 404 cross-tenant |
| CHAN-P6-3 (D3) | stubs removed from `host/a2aSurface.ts`; card routes serve the host card; `host.a2a` notes | `c4447c433` | `test/a2a-surface.test.ts` drives the real pack nodes: `host_capability_missing` ×3, `published: false` |
| CHAN-P6-4 (D5, D7) | `routes/mcp.ts` audit tenant + boot log | `a420ffff3` | `test/adr1045-mcp-audit-tenant.test.ts`: wildcard key's version refusal audited in `default`, none in `*` |
| D8 | `DEPLOY.md` § "Optional: MCP and A2A servers — ADR 1045" | (this commit) | — |
| D6 push residual (RFC 0214 §A–§C) | `host/a2aPushCredential.ts` (parse, seal, open), `host/a2aPushDelivery.ts` (the sink: credential header, SSRF re-check on the original URL, pinned dispatcher, `redirect: 'manual'`), `host/a2aTaskStore.ts` (sealed config, terminal discard, failure log), the 0.3 and 1.0 Create handlers and the push-config seam | `380b95180` | `test/adr1045-a2a-push-delivery.test.ts`: 1.0 `authentication` arrives as `Authorization`, held sealed, dropped on terminal; 0.3 `token` → `Bearer`, `schemes[0]`; CRLF credential refused without echo; a 307 recorded failed, redirect target 0 hits, credential in no log or outcome |

Each test was witnessed red with its fix reverted, then green restored
(details in each test header).

## Open questions (the user's)

- Keep the MCP and A2A servers on in production (they are on today), or turn
  either off (ADR 1041).
- ~~Close the push residual (RFC 0214 destination credential, no-redirect
  delivery).~~ Closed in `380b95180` (see the D6 update). It reaches production
  with the next backend deploy; until then the live sink is the old one.
- An A2A audit-chain kind for parity with `mcp.decided`, or the run log as the
  record (D6 audit residual).
- The `core.openwop.a2a` pack's `agent-card-publish` node returns
  `status: success, published: false` when the host has no publish method. A
  typed failure would be stricter; that is a pack change (version bump), not
  done here.
